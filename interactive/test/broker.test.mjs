import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createInteractiveBroker } from '../broker.mjs';
import { parseWorkerFrame } from '../protocol.mjs';

async function lab(t, limits = {}) {
  const scope = { companyId: randomUUID(), projectId: randomUUID(), agentId: randomUUID(), issueId: randomUUID(), workspaceId: 'interactive-sample' };
  const bridge = 'test-bridge-'.repeat(4), operator = 'test-operator-'.repeat(4), worker = 'test-worker-'.repeat(4);
  const server = createInteractiveBroker({ workerBinding: { ...scope, workerId: 'fixture', workerToken: worker }, bridgeToken: bridge, operatorToken: operator, limits });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  async function http(path, token, body) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  function connect(token = worker, path = '/worker/connect') {
    const ws = new WebSocket(base.replace('http:', 'ws:') + path, { headers: { Authorization: `Bearer ${token}` } });
    sockets.push(ws);
    const frames = [];
    ws.on('error', () => {});
    ws.on('message', data => frames.push(parseWorkerFrame(data)));
    return { ws, frames, send: frame => ws.send(JSON.stringify({ v: 1, ...frame })),
      next: async type => {
        for (let i = 0; i < 200; i++) {
          const index = frames.findIndex(frame => frame.type === type);
          if (index >= 0) return frames.splice(index, 1)[0];
          await delay(5);
        }
        throw new Error(`Missing ${type} frame`);
      } };
  }
  const bootId = randomUUID();
  async function ready(active = null, boot = bootId) {
    const peer = connect();
    await once(peer.ws, 'open');
    peer.send({ type: 'resume', bootId: boot, active });
    await peer.next('ready');
    return peer;
  }
  return { http, connect, ready, bridge, operator, worker, bootId, scope, arm: () => http('/arm', operator, { issueId: scope.issueId }),
    request: { ...scope, runId: randomUUID(), inputRef: 'assignment', input: 'fixture' } };
}
const identity = ({ runId, attemptId }) => ({ runId, attemptId });
const started = start => ({ type: 'event', ...identity(start), seq: 1, kind: 'started', threadId: 'thread_1', turnId: 'turn_1', text: '' });
const completed = start => ({ type: 'terminal', ...identity(start), seq: 2, outcome: 'completed', threadId: 'thread_1', turnId: 'turn_1', text: 'done' });
async function disconnect(peer) {
  const closed = once(peer.ws, 'close');
  peer.ws.close();
  await closed;
}

test('rejectUnauthorizedRolesAndFrames', async t => {
  const l = await lab(t);
  assert.equal((await l.http('/runs', l.worker, l.request)).status, 401);
  assert.equal((await l.http('/arm', l.bridge, { issueId: l.scope.issueId })).status, 401);
  await assert.rejects(once(l.connect(l.operator).ws, 'open'), /401/);
  await assert.rejects(once(l.connect(l.worker, '/worker/connect?token=test').ws, 'open'), /404/);
  assert.throws(() => parseWorkerFrame(Buffer.from([0xff])));
  assert.throws(() => parseWorkerFrame(JSON.stringify({ v: 1, type: 'ready', command: 'fixture' })), /frame_shape/);
  const peer = await l.ready();
  await assert.rejects(once(l.connect().ws, 'open'), /409/);
  const closed = once(peer.ws, 'close');
  peer.send({ type: 'ready' });
  assert.equal((await closed)[0], 1008);
});

test('dispatchOnlyOncePerRun', async t => {
  const l = await lab(t);
  const peer = await l.ready();
  assert.equal((await l.arm()).status, 200);
  assert.equal((await l.http('/runs', l.bridge, { ...l.request, issueId: randomUUID() })).status, 400);
  assert.equal((await l.http('/runs', l.bridge, { ...l.request, input: '\u0000'.repeat(4000) + 'fixture' })).status, 400);
  assert.equal((await l.http('/runs', l.bridge, l.request)).status, 201);
  const start = await peer.next('start');
  assert.equal((await l.http('/runs', l.bridge, l.request)).status, 200);
  assert.equal((await l.http('/runs', l.bridge, { ...l.request, input: 'different' })).status, 409);
  peer.send(started(start));
  peer.send(completed(start));
  await peer.next('ack');
  assert.equal((await peer.next('ack')).seq, 2);
  assert.equal((await l.http('/runs', l.bridge, { ...l.request, runId: randomUUID() })).status, 409);
  assert.equal((await l.http(`/runs/${start.runId}/events?after=1`, l.bridge)).data.events.length, 1);
  assert.ok(peer.frames.every(frame => frame.type !== 'start'));
});

test('replayWithoutSecondStart', async t => {
  const l = await lab(t);
  let peer = await l.ready();
  await l.arm();
  await l.http('/runs', l.bridge, l.request);
  const start = await peer.next('start');
  peer.send(started(start));
  await peer.next('ack');
  await disconnect(peer);
  peer = await l.ready(identity(start));
  assert.equal((await peer.next('ack')).seq, 1);
  peer.send(started(start));
  peer.send(completed(start));
  await peer.next('ack');
  assert.equal((await peer.next('ack')).seq, 2);
  await disconnect(peer);
  peer = await l.ready(identity(start));
  assert.equal((await peer.next('ack')).seq, 2);
  assert.ok(peer.frames.every(frame => frame.type !== 'start'));
});

test('interruptOrExpireWithoutFalseSuccess', async t => {
  const l = await lab(t, { leaseMs: 150, reconcileMs: 100, tickMs: 10 });
  const peer = await l.ready();
  await l.arm();
  await l.http('/runs', l.bridge, l.request);
  const start = await peer.next('start');
  const statusPath = `/runs/${start.runId}/status`;
  const interrupted = await l.http(`/runs/${start.runId}/interrupt`, l.operator, {});
  assert.equal(interrupted.data.interruptRequested, true);
  assert.equal(interrupted.data.state, 'dispatched');
  assert.deepEqual(identity(await peer.next('interrupt')), identity(start));
  for (let i = 0; i < 100; i++) {
    if ((await l.http(statusPath, l.operator)).data.state === 'unknown') break;
    await delay(5);
  }
  assert.equal((await l.http(statusPath, l.operator)).data.state, 'unknown');
  assert.equal((await l.http('/runs', l.bridge, { ...l.request, runId: randomUUID(), inputRef: randomUUID() })).status, 409);
});

test('bridgeLeaseExpiresDespiteOperatorStatusReads', async t => {
  const l = await lab(t, { leaseMs: 350, reconcileMs: 100, tickMs: 10 });
  const peer = await l.ready();
  await l.arm();
  await l.http('/runs', l.bridge, l.request);
  const start = await peer.next('start');
  peer.send(started(start));
  await peer.next('ack');
  const path = `/runs/${start.runId}/status`;
  let state;
  for (let i = 0; i < 100; i++) {
    state = (await l.http(path, l.operator)).data.state;
    if (state === 'unknown') break;
    await delay(10);
  }
  assert.deepEqual(identity(await peer.next('interrupt')), identity(start));
  assert.equal(state, 'unknown');
  assert.ok(peer.frames.every(frame => frame.type !== 'start'));
});

test('stayDisarmedAfterRestart', async t => {
  const l = await lab(t);
  await l.ready();
  assert.equal((await l.http('/runs', l.bridge, l.request)).status, 409);
});
