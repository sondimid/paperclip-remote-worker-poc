import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { createInteractiveBroker } from '../broker.mjs';
import { runInteractiveIssue } from '../bridge.mjs';
import { runInteractiveWorker } from '../worker.mjs';
import { fullFinalBytes, parseWorkerFrame, sha256 } from '../protocol.mjs';

const send = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const longAnswer = '﻿' + `${'a'.repeat(3067)}🧪 Tiếng Việt – đã ghi đầy đủ\n`.repeat(83);
const base = server => `http://127.0.0.1:${server.address().port}`;
async function listen(server, t) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return server;
}
async function wait(check) {
  for (let i = 0; i < 250; i++) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  throw new Error('CLI fixture deadline');
}

async function lab(t, { capability = { codex: 'ready', claude: 'ready' }, pause } = {}) {
  const [companyId, projectId, agentId, issueId, workerToken, bridgeToken, operatorToken] = Array.from({ length: 7 }, () => randomUUID());
  const binding = { companyId, projectId, agentId, issueId, workspaceId: 'interactive-sample' };
  const broker = createInteractiveBroker({ workerBinding: { ...binding, workerToken, workerId: 'fixture' }, bridgeToken, operatorToken,
    wireVersion: 2, limits: { leaseMs: 1200, turnMs: 3000, reconcileMs: 300, tickMs: 20 } });
  // Đăng ký cleanup trước HTTP server để socket không giữ process test.
  const workers = [], peers = [], calls = [];
  t.after(async () => {
    for (const worker of workers) worker.abort.abort();
    for (const peer of peers) peer.terminate();
    await Promise.all(workers.map(({ task }) => task));
  });
  await listen(broker, t);
  const brokerUrl = `${base(broker).replace('http:', 'ws:')}/worker/connect`;
  const api = async (path, token, body) => {
    const res = await fetch(`${base(broker)}${path}`, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: res.status, ...(await res.json()) };
  };
  function startWorker(url = brokerUrl) {
    const abort = new AbortController();
    const adapters = Object.fromEntries(['codex', 'claude'].map(provider => [provider, {
      async probe(_profile, { signal }) { if (pause === 'probe') await delay(120, undefined, { signal }); return { state: capability[provider] }; },
      async runTurn(_profile, { input, sessionId, onProgress, signal }) {
        calls.push({ provider, input, sessionId });
        onProgress('synthetic progress');
        if (pause === 'turn') await delay(150, undefined, { signal });
        else if (pause === 'until-abort') await delay(10000, undefined, { signal });
        return { outcome: 'completed', sessionId: sessionId ?? `${provider}_${calls.length}`, text: input === 'long' ? longAnswer
          : input === 'oversize' ? 'x'.repeat(fullFinalBytes + 1) : `final ${input}` };
      },
    }]));
    const task = runInteractiveWorker({ brokerUrl: url, workerToken, workspaceProfile: binding, cliProfiles: {}, adapters, signal: abort.signal });
    const worker = { task, abort };
    workers.push(worker);
    return worker;
  }
  const status = () => api('/worker/status', operatorToken);
  const arm = () => api('/arm', operatorToken, { issueId });
  const submit = (provider, input, runId = randomUUID(), inputRef = randomUUID()) => api('/runs', bridgeToken, { ...binding, provider, input, runId, inputRef });
  const events = runId => api(`/runs/${runId}/events?after=0`, bridgeToken);
  const final = runId => wait(async () => { const result = await events(runId); return ['completed', 'failed', 'unknown'].includes(result.state) && result; });
  async function connectRaw(v = 2, bootId = randomUUID()) {
    const peer = new WebSocket(brokerUrl, { headers: { Authorization: `Bearer ${workerToken}` } });
    peers.push(peer);
    const received = [], errors = [];
    peer.on('message', data => received.push(parseWorkerFrame(data)));
    peer.on('error', error => errors.push(error));
    await once(peer, 'open');
    peer.send(JSON.stringify({ v, type: 'resume', bootId, active: null }));
    return { peer, received, errors, write: frame => peer.send(JSON.stringify({ v, ...frame })) };
  }
  return { binding, bridgeToken, broker, brokerUrl, api, calls, startWorker, status, arm, submit, final, events, connectRaw };
}

async function mockPaperclip(t, f, { runId = randomUUID(), input = '/codex long', author = 'test-human', mode } = {}) {
  const { binding, bridgeToken, broker } = f;
  const { companyId, agentId, issueId } = binding;
  const commentId = randomUUID(), replyId = randomUUID(), attachmentId = randomUUID();
  const path = `/api/issues/${issueId}`;
  const run = { id: runId, agentId, companyId, invocationSource: mode === 'assignment' ? 'assignment' : 'automation', contextSnapshot: mode === 'assignment'
    ? { issueId, wakeReason: 'issue_assigned' } : { issueId, wakeReason: 'issue_commented', wakeCommentId: commentId } };
  const issue = { ...binding, id: issueId, assigneeAgentId: agentId, status: 'backlog' };
  let comment, attachment, finalBytes;
  const writes = [];
  const server = await listen(createServer(async (req, res) => {
    assert.equal(req.headers['x-paperclip-run-id'], runId);
    assert.equal(req.headers.authorization, 'Bearer synthetic-api');
    if (req.url === `/api/heartbeat-runs/${runId}`) return send(res, run);
    if (req.url === path && req.method === 'GET') {
      if (comment && mode === 'assignee-changed') issue.assigneeAgentId = 'other-agent';
      if (comment && mode === 'status-changed') issue.status = 'in_review';
      return send(res, issue);
    }
    if (req.url === `${path}/comments/${commentId}`) return send(res, { id: commentId, issueId, authorUserId: author, authorType: 'user', body: input });
    if (req.url.startsWith(`${path}/comments?`)) return send(res, comment ? [comment] : []);
    if (req.url === `${path}/attachments`) return send(res, attachment ? [attachment] : []);
    if (req.url === `/api/attachments/${attachmentId}/content`) {
      if (mode === 'wrong-download') return res.end(Buffer.alloc(finalBytes.length));
      return res.end(finalBytes);
    }
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const bytes = Buffer.concat(buffers);
    if (req.url === `/api/companies/${companyId}/issues/${issueId}/attachments`) {
      writes.push('attachment');
      if (mode === 'upload-failed') return send(res, {}, 422);
      const form = await new Response(bytes, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const file = form.get('file');
      assert.equal(file.name, 'remote-cli-reply.txt');
      finalBytes = Buffer.from(await file.arrayBuffer());
      attachment = { id: attachmentId, issueId, companyId, issueCommentId: null, originatingRunId: runId,
        createdByAgentId: agentId, byteSize: finalBytes.length, sha256: sha256(finalBytes) };
      return send(res, attachment, 201);
    }
    if (req.url === `${path}/checkout`) { writes.push('checkout'); issue.status = 'in_progress'; return send(res, issue); }
    if (req.url === path && req.method === 'PATCH') {
      writes.push('park'); issue.status = JSON.parse(bytes).status; return send(res, issue);
    }
    if (req.url === `${path}/comments` && req.method === 'POST') {
      writes.push('comment');
      if (mode === 'lost-not-saved') return res.destroy();
      const { body, attachmentIds } = JSON.parse(bytes);
      comment = { id: replyId, issueId, authorAgentId: agentId, createdByRunId: runId, body };
      if (attachmentIds) { assert.deepEqual(attachmentIds, [attachmentId]); attachment.issueCommentId = replyId; }
      if (mode === 'lost-saved') return res.destroy();
      return send(res, comment, 201);
    }
    return send(res, {}, 404);
  }), t);
  const execute = () => runInteractiveIssue({ PAPERCLIP_RUN_ID: runId, PAPERCLIP_COMPANY_ID: companyId, PAPERCLIP_AGENT_ID: agentId,
    PAPERCLIP_API_URL: base(server), PAPERCLIP_API_KEY: 'synthetic-api', INTERACTIVE_BROKER_URL: base(broker), INTERACTIVE_BRIDGE_TOKEN: bridgeToken,
    INTERACTIVE_WIRE_VERSION: '2', INTERACTIVE_CHAT_USER_ID: 'test-human' }, binding);
  return { execute, writes, runId, issue, get comment() { return comment; }, get bytes() { return finalBytes; } };
}

test('V2 ready is separate from capability and role credentials stay separate', async t => {
  const f = await lab(t, { capability: { codex: 'policy_unverified', claude: 'unsupported' }, pause: 'probe' });
  f.startWorker();
  const ready = await wait(async () => { const s = await f.status(); return s.online && s; });
  assert.equal(ready.capabilities?.codex, 'checking');
  assert.equal((await f.api('/worker/status', f.bridgeToken)).status, 401);
  assert.equal((await f.api('/readiness?provider=codex', 'wrong-token')).status, 401);
  assert.equal((await f.arm()).status, 200);
  const check = await wait(async () => { const s = await f.status(); return s.capabilities?.codex === 'policy_unverified' && s; });
  assert.equal(check.online, true);
  const task = await mockPaperclip(t, f, { input: '/codex first' });
  await assert.rejects(task.execute(), /policy_unverified/);
  assert.deepEqual(task.writes, []);
  assert.equal((await f.submit('codex', 'fixture')).status, 409);
  assert.deepEqual(f.calls, []);
});

test('V2 chat resumes exact session, switches provider and returns the full Unicode attachment once', async t => {
  const f = await lab(t, { pause: 'turn' });
  f.startWorker();
  await wait(async () => (await f.status()).capabilities?.claude === 'ready');
  assert.equal((await f.arm()).status, 200);
  const assignment = await mockPaperclip(t, f, { mode: 'assignment' });
  await assignment.execute();
  assert.deepEqual(assignment.writes, []);
  const noPrefix = await mockPaperclip(t, f, { input: 'no provider yet' });
  await assert.rejects(noPrefix.execute(), /Select \/codex or \/claude/);
  const other = await mockPaperclip(t, f, { author: 'other-user' });
  await assert.rejects(other.execute(), /author is not allowed/);
  assert.deepEqual(other.writes, []);

  const first = await mockPaperclip(t, f, { input: '/codex first' });
  const task = first.execute();
  await wait(async () => (await f.events(first.runId)).state === 'running');
  await task;
  assert.equal(first.issue.status, 'backlog');
  assert.match(first.comment.body, /final first/);
  const next = await mockPaperclip(t, f, { input: 'second' });
  await next.execute();
  const newProvider = await mockPaperclip(t, f, { input: '/claude long', mode: 'lost-saved' });
  await newProvider.execute();
  assert.deepEqual(newProvider.bytes, Buffer.from(longAnswer));
  assert.deepEqual(newProvider.writes, ['checkout', 'attachment', 'comment', 'park']);
  const third = await f.events(newProvider.runId);
  assert.ok(third.events.filter(event => event.type === 'final_part').length > 60);
  assert.equal(third.result.sha256, sha256(Buffer.from(longAnswer)));
  const before = await f.events(first.runId), after = await f.events(next.runId);
  assert.equal(before.conversationId, after.conversationId);
  assert.notEqual(after.conversationId, third.conversationId);
  assert.notEqual(before.turnId, after.turnId);
  assert.deepEqual(f.calls, [{ provider: 'codex', input: 'first', sessionId: undefined },
    { provider: 'codex', input: 'second', sessionId: 'codex_1' }, { provider: 'claude', input: 'long', sessionId: undefined }]);
});

for (const [mode, input, error, writes] of [
  ['upload-failed', '/claude long', /HTTP 422/, ['checkout', 'attachment']],
  ['wrong-download', '/claude long', /Attachment content mismatch/, ['checkout', 'attachment']],
  ['lost-not-saved', '/claude short', /Reply reconciliation failed/, ['checkout', 'comment']],
  ['oversize', '/claude oversize', /output_limit/, ['checkout']],
]) {
  test(`V2 does not park or claim success on ${mode}`, async t => {
    const f = await lab(t);
    f.startWorker();
    await wait(async () => (await f.status()).capabilities?.claude === 'ready');
    await f.arm();
    const turn = await mockPaperclip(t, f, { input, mode });
    await assert.rejects(turn.execute(), error);
    assert.deepEqual(turn.writes, writes);
    assert.equal(turn.issue.status, 'in_progress');
  });
}

test('V2 reconciles a lost ACK and replays only the uncommitted final frames', async t => {
  const f = await lab(t, { pause: 'turn' });
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(relay, 'listening');
  const upstreams = new Set(), resumes = [], starts = [], finalIndices = [];
  let lostSeq, dropped = false;
  relay.on('connection', (client, req) => {
    const upstream = new WebSocket(f.brokerUrl, { headers: { Authorization: req.headers.authorization } });
    upstreams.add(upstream);
    client.on('error', () => client.terminate());
    upstream.on('error', () => client.terminate());
    client.on('close', () => upstream.terminate());
    upstream.on('close', () => { upstreams.delete(upstream); client.terminate(); });
    const ready = once(upstream, 'open').catch(() => {});
    client.on('message', async data => {
      await ready;
      if (upstream.readyState !== WebSocket.OPEN) return;
      const frame = parseWorkerFrame(data);
      if (frame.type === 'resume') resumes.push(frame);
      if (frame.type === 'final_part') finalIndices.push(frame.index);
      // Deliver part zero to Broker, withhold later frames and drop its ACK on the wire.
      if (!dropped && lostSeq !== undefined) return;
      if (!dropped && frame.type === 'final_part') lostSeq = frame.seq;
      upstream.send(data, { binary: false });
    });
    upstream.on('message', data => {
      const frame = parseWorkerFrame(data);
      if (frame.type === 'start') starts.push(frame);
      if (!dropped && frame.type === 'ack' && frame.seq === lostSeq) {
        dropped = true;
        client.terminate();
        upstream.terminate();
      } else if (client.readyState === WebSocket.OPEN) client.send(data, { binary: false });
    });
  });
  t.after(async () => {
    for (const client of relay.clients) client.terminate();
    for (const upstream of upstreams) upstream.terminate();
    await new Promise(resolve => relay.close(resolve));
  });
  f.startWorker(`ws://127.0.0.1:${relay.address().port}/worker/connect`);
  await wait(async () => (await f.status()).capabilities?.codex === 'ready');
  assert.equal((await f.arm()).status, 200);
  const turn = await mockPaperclip(t, f);
  await turn.execute();
  const receipt = await f.events(turn.runId);
  assert.equal(dropped, true);
  assert.equal(resumes.length, 2);
  assert.equal(resumes[0].bootId, resumes[1].bootId);
  assert.deepEqual(resumes[1].active, { runId: turn.runId, attemptId: starts[0].attemptId });
  assert.equal(starts.length, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(finalIndices.filter(index => index === 0).length, 1);
  assert.ok(finalIndices.filter(index => index === 1).length >= 2);
  assert.equal(receipt.events.filter(event => event.type === 'terminal').length, 1);
  assert.deepEqual(turn.bytes, Buffer.from(longAnswer));
  assert.deepEqual(turn.writes, ['checkout', 'attachment', 'comment', 'park']);
});

for (const [mode, status] of [['assignee-changed', 'in_progress'], ['status-changed', 'in_review']]) {
  test(`V2 keeps the audited reply without parking when ${mode}`, async t => {
    const f = await lab(t);
    f.startWorker();
    await wait(async () => (await f.status()).capabilities?.codex === 'ready');
    assert.equal((await f.arm()).status, 200);
    const turn = await mockPaperclip(t, f, { input: '/codex short', mode });
    await assert.rejects(turn.execute(), /Issue binding or ownership changed/);
    assert.match(turn.comment.body, /final short/);
    assert.deepEqual(turn.writes, ['checkout', 'comment']);
    assert.equal(turn.issue.status, status);
  });
}

test('Broker rejects mixed versions and a wrong final checksum', async t => {
  const f = await lab(t);
  const old = await f.connectRaw(1);
  assert.equal((await once(old.peer, 'close'))[0], 1008);
  const w = await f.connectRaw();
  await wait(() => w.received.some(frame => frame.type === 'ready'));
  w.write({ type: 'capabilities', codex: 'ready', claude: 'unsupported' });
  await f.arm();
  const run = await f.submit('codex', 'fixture');
  const job = await wait(() => w.received.find(frame => frame.type === 'start'));
  const ids = { runId: run.runId, attemptId: job.attemptId, threadId: job.conversationId, turnId: job.attemptId };
  const first = { ...ids, seq: 1, type: 'event', kind: 'started', text: '' };
  w.write(first);
  w.write(first);
  w.write({ ...ids, seq: 2, type: 'final_part', index: 0, chunk: 'YQ==' });
  w.write({ ...ids, seq: 3, type: 'terminal', outcome: 'completed', bytes: 1, sha256: 'a'.repeat(64), reason: null });
  assert.equal((await once(w.peer, 'close'))[0], 1008);
  const view = await f.events(run.runId);
  assert.notEqual(view.state, 'completed');
  assert.equal(view.cursor, 2);
});

test('Worker restart while running becomes unknown and never starts the turn again', async t => {
  const f = await lab(t, { pause: 'until-abort' });
  const first = f.startWorker();
  await wait(async () => (await f.status()).capabilities?.codex === 'ready');
  await f.arm();
  const run = await f.submit('codex', 'fixture');
  await wait(() => f.calls.length === 1);
  first.abort.abort();
  await first.task;
  f.startWorker();
  const terminal = await f.final(run.runId);
  assert.equal(terminal.state, 'unknown');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.submit('codex', 'fixture')).status, 409);
});
