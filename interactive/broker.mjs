import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { exactKeys } from '../protocol.mjs';
import { boundedText, finalPartBytes, frameBytes, fullFinalBytes, inputBytes, leaseMaxMs, matchesId, maxCliFrames,
  maxProgressFrames, parseWorkerFrame, providers, turnMaxMs, verifyCliFinal, workerPath } from './protocol.mjs';

const scope = ['companyId', 'projectId', 'agentId', 'issueId', 'workspaceId'];
const hasToken = (req, token) => {
  const received = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
};
const reply = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
async function readBody(req) {
  if (req.headers['content-type'] !== 'application/json') throw new Error('content_type');
  const chunks = [];
  let size = 0;
  if (Number(req.headers['content-length']) > frameBytes) {
    req.resume();
    throw new Error('body_size');
  }
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > frameBytes) {
      req.resume();
      throw new Error('body_size');
    }
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

export function createInteractiveBroker({ workerBinding, bridgeToken, operatorToken, limits = {}, wireVersion = 1 }) {
  if (![1, 2].includes(wireVersion)) throw new Error('Invalid wire version');
  const cliMode = wireVersion === 2;
  const { workerToken, workerId } = workerBinding;
  if (![workerToken, bridgeToken, operatorToken].every(token => typeof token === 'string' && token.length >= 24)
      || new Set([workerToken, bridgeToken, operatorToken]).size !== 3 || !workerId
      || !scope.slice(0, 4).every(key => matchesId(workerBinding[key])) || workerBinding.workspaceId !== 'interactive-sample') {
    throw new Error('Invalid lab binding or role credentials');
  }
  const { queueMs = 15_000, leaseMs = leaseMaxMs, turnMs = turnMaxMs, reconcileMs = 10_000, maxRuns = 32, tickMs = 200 } = limits;
  const runs = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: frameBytes, perMessageDeflate: false });
  let currentSocket, workerBoot, active, conversation;
  let armed = false;
  const now = () => performance.now();
  const online = () => currentSocket?.ready === true && currentSocket.socket.readyState === WebSocket.OPEN;
  const workerStatus = () => ({ armed, workerId, online: online(), capabilities: currentSocket?.capabilities ?? null });
  const view = run => ({ runId: run.runId, workerId, state: run.state, interruptRequested: !!run.interruptRequested,
    threadId: run.threadId ?? null, turnId: run.turnId ?? null, result: run.result ?? null,
    ...(cliMode && { provider: run.provider, conversationId: run.conversationId }) });
  const send = (peer, frame) => {
    if (peer?.socket.readyState !== WebSocket.OPEN) return;
    if (peer.socket.bufferedAmount > frameBytes * 2) return peer.socket.terminate();
    const wire = JSON.stringify({ v: wireVersion, ...frame });
    if (Buffer.byteLength(wire) > frameBytes) return peer.socket.terminate();
    peer.socket.send(wire, error => { if (error) peer.socket.terminate(); });
  };
  function maintain() {
    if (!active) return;
    const run = active;
    if (run.state === 'queued') {
      if (now() >= run.queueUntil) { run.state = 'expired'; active = undefined; return; }
      if (armed && online() && now() < run.bridgeUntil && (!cliMode || currentSocket.capabilities?.[run.provider] === 'ready')) {
        // Reserve trước khi gửi; nếu mất ACK thì không phát start lần nữa.
        run.state = 'dispatched';
        run.attemptId = randomUUID();
        run.hardUntil = now() + turnMs;
        if (cliMode) conversation = { provider: run.provider, id: run.conversationId };
        send(currentSocket, { type: 'start', runId: run.runId, attemptId: run.attemptId, issueId: run.issueId,
          workspaceId: run.workspaceId, input: run.input, leaseMs: Math.max(1, Math.floor(run.bridgeUntil - now())), turnMs,
          ...(cliMode && { provider: run.provider, conversationId: run.conversationId, resume: run.resume }) });
      }
    } else if (run.state !== 'unknown') {
      if (now() >= Math.min(run.bridgeUntil, run.hardUntil) && !run.interruptRequested) requestInterrupt(run);
      if (run.interruptRequested && now() >= run.reconcileUntil) run.state = 'unknown';
    }
  }
  function requestInterrupt(run) {
    if (run.interruptRequested) return;
    run.interruptRequested = true;
    run.reconcileUntil = now() + reconcileMs;
    send(currentSocket, { type: 'interrupt', runId: run.runId, attemptId: run.attemptId });
  }
  function acknowledge(peer, run) {
    const remaining = run === active && !run.interruptRequested && run.state !== 'unknown'
      ? Math.max(0, Math.floor(Math.min(run.bridgeUntil, run.hardUntil) - now())) : 0;
    send(peer, { type: 'ack', runId: run.runId, attemptId: run.attemptId, seq: run.events.length, leaseMs: remaining });
  }
  function receive(peer, frame) {
    if (frame.type === 'resume' && !peer.ready) {
      if (workerBoot && workerBoot !== frame.bootId) {
        armed = false;
        if (active) active.state = 'unknown';
        if (!cliMode || active || frame.active) throw new Error('changed_worker_epoch');
        // Idle reconnect từ process mới không khôi phục native session của process cũ.
      }
      if (frame.active) {
        const prior = runs.get(frame.active.runId);
        if (!prior || prior.attemptId !== frame.active.attemptId || (active?.attemptId && active !== prior)) {
          throw new Error('unknown_attempt');
        }
      } else if (active?.attemptId) {
        throw new Error('attempt_not_reported');
      }
      workerBoot = frame.bootId;
      peer.ready = true;
      send(peer, { type: 'ready' });
      if (frame.active) acknowledge(peer, runs.get(frame.active.runId));
      maintain();
      return;
    }
    if (cliMode && peer.ready && frame.type === 'capabilities') {
      peer.capabilities = { codex: frame.codex, claude: frame.claude };
      maintain();
      return;
    }
    if (!peer.ready || !['event', 'terminal', ...(cliMode ? ['final_part'] : [])].includes(frame.type)) throw new Error('unexpected_frame');
    const run = runs.get(frame.runId);
    if (!run || frame.attemptId !== run.attemptId) throw new Error('wrong_attempt');
    if (frame.seq <= run.events.length) {
      if (JSON.stringify(run.events[frame.seq - 1]) !== JSON.stringify(frame)) throw new Error('conflicting_replay');
      acknowledge(peer, run);
      return;
    }
    if (run !== active || run.state === 'unknown' || frame.seq !== run.events.length + 1
        || frame.seq > (cliMode ? maxCliFrames : 67)) throw new Error('invalid_sequence');
    if (cliMode && (frame.threadId !== run.conversationId || frame.turnId !== run.attemptId)) throw new Error('wrong_cli_turn');
    if (frame.type === 'event' && frame.kind === 'started') {
      if (run.threadId || frame.seq !== 1) throw new Error('duplicate_turn');
      run.threadId = frame.threadId;
      run.turnId = frame.turnId;
      run.state = 'running';
    } else if (run.threadId) {
      if (run.threadId !== frame.threadId || run.turnId !== frame.turnId) throw new Error('wrong_turn');
    } else if (frame.type !== 'terminal' || frame.threadId !== null) throw new Error('turn_not_started');
    if (cliMode) {
      if (frame.type === 'event' && (run.parts.length || frame.seq > maxProgressFrames)) throw new Error('invalid_progress');
      if (frame.type === 'final_part') {
        const priorPart = run.parts.at(-1), part = Buffer.from(frame.chunk, 'base64');
        if (frame.index !== run.parts.length || (priorPart && priorPart.length !== finalPartBytes)
            || run.partBytes + part.length > fullFinalBytes) throw new Error('invalid_final_part');
        run.parts.push(part);
        run.partBytes += part.length;
      }
      if (frame.type === 'terminal') {
        if (frame.outcome === 'completed') verifyCliFinal(run.parts, frame);
        else if (run.parts.length) throw new Error('partial_final_without_success');
        const late = frame.outcome === 'completed' && (run.interruptRequested || now() >= Math.min(run.bridgeUntil, run.hardUntil));
        run.state = late ? 'unknown' : frame.outcome;
        run.result = late ? { reason: 'deadline' } : { bytes: frame.bytes, sha256: frame.sha256, reason: frame.reason };
        run.parts = undefined;
        if (run.state !== 'unknown') active = undefined;
      }
    } else {
      if (frame.type === 'event' && frame.seq === 67) throw new Error('terminal_slot_reserved');
      if (frame.type === 'terminal') {
        run.state = frame.outcome;
        run.result = { text: frame.text };
        if (frame.outcome !== 'unknown') active = undefined;
      }
    }
    run.events.push(frame);
    acknowledge(peer, run);
    maintain();
  }

  const server = createServer({ requestTimeout: 5_000, headersTimeout: 5_000 }, async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local.invalid');
      const route = /^\/runs\/([0-9a-f-]+)\/(events|status|interrupt)$/.exec(url.pathname);
      const readiness = cliMode && req.method === 'GET' && url.pathname === '/readiness';
      const bridgeRoute = readiness || (req.method === 'POST' && req.url === '/runs') || (req.method === 'GET' && route?.[2] === 'events');
      const workerStatusRoute = cliMode && req.method === 'GET' && req.url === '/worker/status';
      const operatorRoute = workerStatusRoute || (req.method === 'POST' && req.url === '/arm') || (req.method === 'GET' && route?.[2] === 'status')
        || (req.method === 'POST' && route?.[2] === 'interrupt');
      if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true });
      if (!bridgeRoute && !operatorRoute) return reply(res, 404, { error: 'not_found' });
      if (!hasToken(req, bridgeRoute ? bridgeToken : operatorToken)) return reply(res, 401, { error: 'unauthorized' });
      maintain();
      if (workerStatusRoute) return reply(res, 200, workerStatus());
      if (readiness) {
        const requested = url.searchParams.get('provider');
        if (requested !== 'current' && !providers.includes(requested)) return reply(res, 400, { error: 'provider' });
        const provider = requested === 'current' ? conversation?.provider : requested;
        const capability = currentSocket?.capabilities?.[provider] ?? null;
        return reply(res, 200, { provider: provider ?? null, online: online(), capability,
          dispatchable: !!(provider && !active && armed && online() && capability === 'ready') });
      }
      if (req.url === '/arm') {
        const body = await readBody(req);
        if (!exactKeys(body, ['issueId']) || body.issueId !== workerBinding.issueId) return reply(res, 400, { error: 'binding' });
        if (!currentSocket?.ready || active) return reply(res, 409, { error: 'not_idle' });
        armed = true;
        return reply(res, 200, { armed, workerId });
      }
      if (req.url === '/runs') {
        const body = await readBody(req);
        if (!exactKeys(body, [...scope, 'runId', 'input', 'inputRef', ...(cliMode ? ['provider'] : [])])
            || !scope.every(key => body[key] === workerBinding[key]) || !matchesId(body.runId)
            || (!matchesId(body.inputRef) && (cliMode || body.inputRef !== 'assignment'))
            || !boundedText(body.input, inputBytes) || !body.input.trim()
            || (cliMode && ((body.provider !== null && !providers.includes(body.provider))
              || Buffer.byteLength(JSON.stringify(body.input)) > frameBytes - 1024))) return reply(res, 400, { error: 'submit_shape' });
        const previous = runs.get(body.runId);
        if (previous) return previous.input === body.input && previous.inputRef === body.inputRef && previous.requestedProvider === body.provider
          ? reply(res, 200, view(previous)) : reply(res, 409, { error: 'run_conflict' });
        if (!armed || active || [...runs.values()].some(run => run.inputRef === body.inputRef)) return reply(res, 409, { error: 'not_dispatchable' });
        if (runs.size >= maxRuns) return reply(res, 503, { error: 'run_capacity' });
        const provider = body.provider ?? conversation?.provider;
        if (cliMode && (!provider || !online() || currentSocket.capabilities?.[provider] !== 'ready')) {
          return reply(res, 409, { error: provider ? 'provider_unavailable' : 'select_provider' });
        }
        const resume = cliMode && provider === conversation?.provider;
        active = { ...body, state: 'queued', events: [], queueUntil: now() + queueMs, bridgeUntil: now() + leaseMs,
          ...(cliMode && { provider, requestedProvider: body.provider, conversationId: resume ? conversation.id : randomUUID(),
            resume, parts: [], partBytes: 0 }) };
        runs.set(body.runId, active);
        maintain();
        return reply(res, 201, view(runs.get(body.runId)));
      }
      const run = runs.get(route[1]);
      if (!run) return reply(res, 404, { error: 'unknown_run' });
      if (route[2] === 'status') return reply(res, 200, view(run));
      if (route[2] === 'interrupt') {
        if (await readBody(req).then(body => !exactKeys(body, []))) return reply(res, 400, { error: 'interrupt_shape' });
        if (run === active && run.state === 'queued') { run.state = 'cancelled_before_start'; active = undefined; }
        else if (run === active && run.state !== 'unknown') requestInterrupt(run);
        return reply(res, 200, view(run));
      }
      const raw = url.searchParams.get('after') ?? '0';
      const after = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(after) || after > run.events.length) return reply(res, 400, { error: 'cursor' });
      if (run === active && !run.interruptRequested && run.state !== 'unknown') {
        run.bridgeUntil = now() + leaseMs;
        if (run.attemptId) acknowledge(currentSocket, run);
      }
      return reply(res, 200, { ...view(run), cursor: run.events.length, events: run.events.slice(after) });
    } catch { if (!res.destroyed) reply(res, 400, { error: 'request_rejected' }); }
  });
  server.on('upgrade', (req, socket, head) => {
    const status = req.url !== workerPath ? '404 Not Found' : !hasToken(req, workerToken) ? '401 Unauthorized'
      : currentSocket ? '409 Conflict' : null;
    if (status) { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const peer = { socket: ws, ready: false, pong: true };
      currentSocket = peer;
      const readyTimer = setTimeout(() => { if (!peer.ready) ws.terminate(); }, 4000);
      ws.on('pong', () => { peer.pong = true; });
      ws.on('error', () => ws.terminate());
      ws.on('close', () => { clearTimeout(readyTimer); if (currentSocket === peer) currentSocket = undefined; });
      ws.on('message', (raw, binary) => {
        if (currentSocket !== peer || binary) return ws.close(1008);
        try {
          const frame = parseWorkerFrame(raw);
          if (frame.v !== wireVersion) throw new Error('wire_version');
          receive(peer, frame);
        } catch { ws.close(1008, 'protocol_rejected'); }
      });
    });
  });
  const timer = setInterval(maintain, tickMs).unref();
  const ping = setInterval(() => {
    if (!currentSocket) return;
    if (!currentSocket.pong) return currentSocket.socket.terminate();
    currentSocket.pong = false;
    if (currentSocket.socket.readyState === WebSocket.OPEN) currentSocket.socket.ping();
  }, 5000).unref();
  server.on('close', () => { clearInterval(timer); clearInterval(ping); currentSocket?.socket.terminate(); wss.close(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const server = createInteractiveBroker({ workerBinding: { ...JSON.parse(env.INTERACTIVE_BINDING), workerToken: env.INTERACTIVE_WORKER_TOKEN },
    bridgeToken: env.INTERACTIVE_BRIDGE_TOKEN, operatorToken: env.INTERACTIVE_OPERATOR_TOKEN,
    wireVersion: Number(env.INTERACTIVE_WIRE_VERSION ?? 1) });
  server.listen(3113, '0.0.0.0');
}
