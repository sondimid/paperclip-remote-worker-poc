import { randomUUID, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { openCodexSession } from './codex.mjs';
import { readCodexLabProfile } from './codex-lab-profile.mjs';
import { capabilityStates, failureReasons, finalBytes, finalPartBytes, frameBytes, fullFinalBytes, matchesId,
  maxProgressFrames, parseWorkerFrame, providers, sha256, workerPath } from './protocol.mjs';
import { cliSessionId } from './cli-process.mjs';
import * as codexCli from './codex-cli.mjs';
import * as claudeCli from './claude-cli.mjs';

const cliAdapters = { codex: codexCli, claude: claudeCli };
const sameAttempt = (a, b) => a?.runId === b?.runId && a?.attemptId === b?.attemptId;
const identity = ({ runId, attemptId }) => ({ runId, attemptId });
const safeEndpoint = value => {
  const url = new URL(value);
  if (url.href !== `${url.protocol}//${url.host}${workerPath}`
      || !(url.protocol === 'wss:' || (url.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw new Error('Invalid worker endpoint');
  }
  return url;
};

function clipText(value, maxTextBytes, maxEncodedBytes) {
  let bytes = 0, encoded = 0, result = '';
  for (const char of value) {
    bytes += Buffer.byteLength(char);
    encoded += Buffer.byteLength(JSON.stringify(char)) - 2;
    if (bytes > maxTextBytes || encoded > maxEncodedBytes) break;
    result += char;
  }
  return result;
}

export async function runInteractiveWorker({ brokerUrl, workerToken, workspaceProfile, tlsCa, signal, log = () => {},
  openSession = openCodexSession, cliProfiles, adapters = cliAdapters }) {
  const cliMode = cliProfiles !== undefined;
  const version = cliMode ? 2 : 1;
  const encode = frame => JSON.stringify({ v: version, ...frame });
  const endpoint = safeEndpoint(brokerUrl);
  if (tlsCa !== undefined && endpoint.protocol !== 'wss:') throw new Error('A worker certificate requires wss:');
  if (typeof workerToken !== 'string' || workerToken.length < 24 || !matchesId(workspaceProfile.issueId)
      || workspaceProfile.workspaceId !== 'interactive-sample') throw new Error('Invalid local worker binding');
  const bootId = randomUUID();
  let peer, active, session, threadId, probeTask, cliTask, stopped = false;
  const probeController = new AbortController();
  const capabilities = { codex: { state: 'checking' }, claude: { state: 'checking' } };
  const nativeSessions = new Map();

  function send(frame) {
    if (peer?.socket.readyState !== WebSocket.OPEN) return false;
    const socket = peer.socket;
    if (socket.bufferedAmount > frameBytes * 64) { socket.terminate(); return false; }
    const wire = encode(frame);
    if (Buffer.byteLength(wire) > frameBytes) throw new Error('Outbound frame exceeds limit');
    socket.send(wire, error => { if (error) socket.terminate(); });
    return true;
  }
  function flush() {
    if (!active || !peer?.ready || peer.awaitingResumeAck) return;
    while (peer.sent < active.frames.length && send(active.frames[peer.sent])) peer.sent++;
  }
  function enqueue(job, fields) {
    job.frames.push({ ...identity(job), seq: job.frames.length + 1, ...fields });
    flush();
  }
  function finish(job, outcome, text = '') {
    if (job !== active || job.terminal) return;
    clearInterval(job.timer);
    job.terminal = outcome;
    const terminal = { type: 'terminal', threadId: job.turnId ? job.threadId : null,
      turnId: job.turnId ?? null, outcome, text: '' };
    if (outcome === 'completed') {
      const budget = frameBytes - Buffer.byteLength(encode({ ...identity(job), seq: job.frames.length + 1, ...terminal }));
      terminal.text = clipText(text, finalBytes, budget);
      if (terminal.text !== text) {
        const note = '\n[Phản hồi đã được rút gọn]';
        terminal.text = clipText(text, finalBytes - Buffer.byteLength(note), budget - (Buffer.byteLength(JSON.stringify(note)) - 2)) + note;
      }
    }
    enqueue(job, terminal);
    log({ event: 'worker_terminal', ...identity(job), threadId: terminal.threadId, turnId: terminal.turnId, outcome });
    if (outcome === 'unknown') {
      const closing = session;
      session = undefined;
      void closing?.close().catch(() => {});
    }
  }
  function announceCapabilities() {
    if (peer?.ready) send({ type: 'capabilities', codex: capabilities.codex.state, claude: capabilities.claude.state });
  }
  async function probeCli() {
    await Promise.all(providers.map(async provider => {
      let capability;
      try { capability = await adapters[provider].probe(cliProfiles[provider], { signal: probeController.signal }); } catch { /* Profile không dùng được. */ }
      if (stopped) return;
      capabilities[provider] = capabilityStates.includes(capability?.state) ? capability : { state: 'unsupported' };
      log({ event: 'worker_cli_capability', provider, state: capabilities[provider].state });
      announceCapabilities();
    }));
  }
  function finishCli(job, result) {
    if (job !== active || job.terminal) return;
    const { conversationId, provider } = job;
    const ids = { threadId: conversationId, turnId: job.attemptId };
    let { outcome, reason } = result;
    let bytes;
    if (outcome === 'completed') {
      const expected = nativeSessions.get(conversationId)?.sessionId;
      if (!cliSessionId(result.sessionId) || (expected && result.sessionId !== expected)
          || typeof result.text !== 'string' || !result.text.trim()) {
        outcome = 'failed'; reason = 'output_invalid';
      } else {
        bytes = Buffer.from(result.text, 'utf8');
        if (bytes.length > fullFinalBytes) { outcome = 'failed'; reason = 'output_limit'; }
        else if (bytes.toString('utf8') !== result.text) { outcome = 'failed'; reason = 'output_invalid'; }
      }
    }
    clearInterval(job.timer);
    job.terminal = outcome;
    if (outcome === 'completed') {
      nativeSessions.clear(); // Một hội thoại hiện hành; đổi provider không giữ phiên cũ.
      nativeSessions.set(conversationId, { provider, sessionId: result.sessionId });
      for (let offset = 0; offset < bytes.length; offset += finalPartBytes) {
        enqueue(job, { type: 'final_part', ...ids, index: offset / finalPartBytes, chunk: bytes.subarray(offset, offset + finalPartBytes).toString('base64') });
      }
      enqueue(job, { type: 'terminal', ...ids, outcome, bytes: bytes.length, sha256: sha256(bytes), reason: null });
    } else {
      // CLI có thể đã thay đổi phiên trước khi lỗi; không tạo lại hoặc thử lại phiên đó.
      nativeSessions.delete(conversationId);
      enqueue(job, { type: 'terminal', ...ids, outcome, bytes: 0, sha256: null, reason: failureReasons.includes(reason) ? reason : 'cli_failed' });
    }
    log({ event: 'worker_terminal', ...identity(job), ...ids, outcome });
  }
  async function runCli(job, input) {
    const { provider, conversationId, resume } = job;
    const capability = capabilities[provider];
    const previous = nativeSessions.get(conversationId);
    const ids = { threadId: conversationId, turnId: job.attemptId };
    enqueue(job, { type: 'event', kind: 'started', ...ids, text: '' });
    if (resume ? previous?.provider !== provider : !!previous) return finishCli(job, { outcome: 'failed', reason: 'resume_unavailable' });
    if (capability.state !== 'ready') return finishCli(job, { outcome: 'failed', reason: 'policy_unverified' });
    try {
      const result = await adapters[provider].runTurn(cliProfiles[provider], { input, sessionId: previous?.sessionId, capability,
        signal: job.controller.signal, onProgress(value) {
          if (job !== active || job.terminal || job.gap || job.controller.signal.aborted || typeof value !== 'string') return;
          const text = clipText(value, 1024, 6144);
          if (job.frames.length < maxProgressFrames - 1 && text) enqueue(job, { type: 'event', kind: 'delta', ...ids, text });
          if (job.frames.length >= maxProgressFrames - 1 || text !== value) {
            job.gap = true;
            enqueue(job, { type: 'event', kind: 'gap', ...ids, text: '' });
          }
        } });
      if (!['completed', 'interrupted', 'failed', 'unknown'].includes(result?.outcome)) {
        return finishCli(job, { outcome: 'unknown', reason: 'output_invalid' });
      }
      if (job.stopBy && result.outcome === 'completed') return finishCli(job, { outcome: 'unknown', reason: 'deadline' });
      if (result.reason === 'policy_unverified') {
        capabilities[provider] = { state: 'policy_unverified' };
        announceCapabilities();
      }
      finishCli(job, result);
    } catch {
      finishCli(job, { outcome: 'unknown', reason: 'cli_failed' });
    }
  }
  function stopAttempt(job) {
    if (job.terminal) return;
    job.stopBy ??= performance.now() + 2500;
    if (cliMode) { job.controller.abort(); return; }
    if (!job.turnId || job.interruptSent) return;
    job.interruptSent = true;
    // ACK không chứng minh turn đã ngắt; chỉ finish khi có terminal tương ứng hoặc hết hạn.
    void session?.interruptTurn({ turnId: job.turnId }).catch(() => {});
  }
  function onEvent(job, event) {
    if (job !== active || job.terminal) return;
    if (event.kind === 'unknown') { finish(job, 'unknown'); return; }
    if (!job.turnId) {
      if (job.early.length >= 32) finish(job, 'unknown');
      else job.early.push(event);
      return;
    }
    if (event.threadId !== job.threadId || event.turnId !== job.turnId) return;
    if (event.kind === 'terminal') {
      const valid = ['completed', 'interrupted', 'failed', 'unknown'].includes(event.outcome);
      finish(job, valid && (event.outcome !== 'completed' || typeof event.text === 'string') ? event.outcome : 'unknown', event.text);
    } else if (event.kind === 'delta' && typeof event.text === 'string' && !job.gap) {
      const text = clipText(event.text, 1024, 6144);
      const eventIds = { threadId: job.threadId, turnId: job.turnId };
      if (job.frames.length < 65 && text) enqueue(job, { type: 'event', kind: 'delta', ...eventIds, text });
      if (job.frames.length >= 65 || text !== event.text) {
        job.gap = true;
        enqueue(job, { type: 'event', kind: 'gap', ...eventIds, text: '' });
      }
    }
  }
  async function attachSession(job) {
    const opened = await openSession({ workspaceProfile, threadId, onEvent: event => { if (active) onEvent(active, event); } });
    if (stopped || signal?.aborted || (job && (job.terminal || job !== active))) {
      await opened.close();
      return false;
    }
    if (threadId && threadId !== opened.threadId) { await opened.close(); throw new Error('Thread mismatch'); }
    session = opened;
    threadId = opened.threadId;
    return true;
  }
  async function run(job, input) {
    let submitted = false;
    try {
      if (!session && !await attachSession(job)) return;
      job.threadId = threadId;
      if (performance.now() >= Math.min(job.lease, job.deadline) || job.stopBy) { finish(job, 'failed'); return; }
      submitted = true;
      const { turnId } = await session.startTurn({ text: input, deadline: Math.min(job.lease, job.deadline) });
      if (job !== active || job.terminal || stopped) return;
      if (!/^[\w-]{1,128}$/.test(turnId ?? '') || !/^[\w-]{1,128}$/.test(threadId ?? '')) { finish(job, 'unknown'); return; }
      job.turnId = turnId;
      enqueue(job, { type: 'event', kind: 'started', threadId, turnId, text: '' });
      for (const event of job.early.splice(0)) onEvent(job, event);
      if (job.stopBy) stopAttempt(job);
    } catch {
      finish(job, submitted ? 'unknown' : 'failed');
    }
  }
  function receive(frame) {
    if (!peer.ready && frame.type === 'ready') {
      peer.ready = true;
      peer.awaitingResumeAck = !!active;
      log({ event: 'worker_ready', bootId });
      if (cliMode) { announceCapabilities(); probeTask ??= probeCli(); }
      return;
    }
    if (!peer.ready) throw new Error('Worker expected ready');
    if (frame.type === 'start') {
      if (active || frame.issueId !== workspaceProfile.issueId || frame.workspaceId !== workspaceProfile.workspaceId) {
        throw new Error('Attempt outside idle worker binding');
      }
      const now = performance.now();
      const job = active = { ...identity(frame), frames: [], early: [], ack: 0, lease: now + frame.leaseMs, deadline: now + frame.turnMs,
        ...(cliMode && { provider: frame.provider, conversationId: frame.conversationId, resume: frame.resume, controller: new AbortController() }) };
      peer.sent = 0;
      job.timer = setInterval(() => {
        const now = performance.now();
        if (now >= Math.min(job.lease, job.deadline)) stopAttempt(job);
        if (job.stopBy && now >= job.stopBy) {
          if (cliMode) finishCli(job, { outcome: 'unknown', reason: 'deadline' });
          else finish(job, 'unknown');
        }
      }, 20);
      if (cliMode) cliTask = runCli(job, frame.input);
      else void run(job, frame.input);
    } else if (sameAttempt(active, frame) && frame.type === 'ack') {
      if (frame.seq > active.frames.length || frame.seq < active.ack) throw new Error('Unexpected ack cursor');
      active.ack = frame.seq;
      if (peer.awaitingResumeAck) { peer.awaitingResumeAck = false; peer.sent = frame.seq; }
      if (active.terminal && frame.seq === active.frames.length && active.terminal !== 'unknown') active = undefined;
      if (active && !active.terminal) {
        if (frame.leaseMs > 0 && !active.stopBy && performance.now() < active.lease) active.lease = performance.now() + frame.leaseMs;
        else stopAttempt(active);
      }
      flush();
    } else if (sameAttempt(active, frame) && frame.type === 'interrupt') stopAttempt(active);
    else throw new Error('Unexpected broker frame');
  }

  const abort = () => { stopped = true; probeController.abort(); active?.controller?.abort(); peer?.socket.terminate(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (!cliMode && workspaceProfile.permissionProfile) {
      if (!await attachSession()) return;
      log({ event: 'codex_preflight_passed' });
    }
    let backoff = 100;
    while (!stopped && !signal?.aborted) {
      await new Promise(resolve => {
        const socket = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${workerToken}` },
          ...(tlsCa === undefined ? {} : { ca: tlsCa }),
          rejectUnauthorized: true, followRedirects: false, handshakeTimeout: 4000, maxPayload: frameBytes, perMessageDeflate: false });
        peer = { socket, ready: false, sent: 0 };
        const readyTimer = setTimeout(() => { if (peer?.socket === socket && !peer.ready) socket.terminate(); }, 4500);
        socket.on('open', () => send({ type: 'resume', bootId, active: active ? identity(active) : null }));
        socket.on('error', () => socket.terminate());
        socket.on('message', (raw, binary) => {
          try {
            if (binary) throw new Error('Unexpected binary frame');
            const frame = parseWorkerFrame(raw);
            if (frame.v !== version) throw new Error('Unexpected wire version');
            receive(frame);
          } catch { socket.terminate(); }
        });
        socket.on('close', () => {
          clearTimeout(readyTimer);
          if (peer.ready) backoff = 100;
          peer = undefined;
          resolve();
        });
      });
      if (!stopped && !signal?.aborted) {
        await delay(backoff, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
        backoff = Math.min(1000, backoff * 2);
      }
    }
  } finally {
    stopped = true;
    signal?.removeEventListener('abort', abort);
    probeController.abort();
    if (active) { clearInterval(active.timer); active.controller?.abort(); }
    await Promise.allSettled([probeTask, cliTask, session?.close()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [, , mode, ...extra] = process.argv;
    const cliMode = mode === '--cli-wss';
    if (extra.length || !['--codex-preflight', '--codex-lab', '--codex-wss', '--cli-wss'].includes(mode)) {
      throw new Error('Choose --codex-preflight, --codex-lab, --codex-wss or --cli-wss explicitly');
    }
    if (mode === '--codex-preflight') {
      const session = await openCodexSession({ workspaceProfile: readCodexLabProfile(), onEvent: () => {}, diagnoseThreadStart: true });
      await session.close();
      console.log('Codex lab preflight passed: sandbox and dedicated sign-in; no turn started.');
    } else {
      const configuredEndpoint = process.env.INTERACTIVE_WORKER_URL;
      if (mode === '--codex-lab' && configuredEndpoint !== `ws://127.0.0.1:3113${workerPath}`) {
        throw new Error('Codex lab requires the fixed loopback broker');
      }
      const endpoint = safeEndpoint(configuredEndpoint);
      if ((mode === '--codex-wss' || cliMode) && endpoint.protocol !== 'wss:') throw new Error('Remote worker requires wss:');
      let binding;
      try { binding = JSON.parse(process.env.INTERACTIVE_WORKSPACE_PROFILE ?? 'null'); } catch { /* invalid binding */ }
      if (!binding || Object.keys(binding).length !== 2 || !matchesId(binding.issueId) || binding.workspaceId !== 'interactive-sample') {
        throw new Error('Invalid Codex lab issue binding');
      }
      const workerToken = process.env.INTERACTIVE_WORKER_TOKEN;
      if (typeof workerToken !== 'string' || workerToken.length < 24) throw new Error('Missing or invalid worker token');
      let tlsCa;
      const caFile = process.env.INTERACTIVE_WORKER_CA_FILE;
      if (caFile) {
        if (mode !== '--codex-wss' && !cliMode) throw new Error('A worker certificate requires --codex-wss or --cli-wss');
        try {
          tlsCa = new X509Certificate(await readFile(caFile)).toString();
        } catch {
          throw new Error('Cannot load the WSS lab certificate');
        }
      }
      const controller = new AbortController();
      for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => controller.abort());
      let cliProfiles;
      if (cliMode) {
        const profile = prefix => ({ executable: process.env[`${prefix}_EXECUTABLE`], cwd: process.env.INTERACTIVE_CLI_CWD,
          profileDir: process.env[`${prefix}_PROFILE_DIR`], policyExecutable: process.env.INTERACTIVE_CLI_POLICY_EXECUTABLE });
        cliProfiles = { codex: profile('INTERACTIVE_CODEX'), claude: profile('INTERACTIVE_CLAUDE') };
      }
      await runInteractiveWorker({ brokerUrl: endpoint, workerToken, tlsCa, cliProfiles,
        workspaceProfile: cliMode ? binding : { ...readCodexLabProfile(), ...binding },
        signal: controller.signal, log: record => console.log(JSON.stringify(record)) });
    }
  } catch (error) {
    const safe = error.constructor === Error && !error.code ? error.message : 'Local profile or App Server check failed';
    console.error(`Codex lab stopped: ${safe}`);
    process.exitCode = 1;
  }
}
