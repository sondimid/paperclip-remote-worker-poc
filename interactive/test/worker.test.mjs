import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { runInteractiveWorker } from '../worker.mjs';
import { parseWorkerFrame } from '../protocol.mjs';

async function fixture(t, { onStart, onTerminal } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const abort = new AbortController(), issueId = randomUUID();
  const results = [], resumes = [], received = new Map(), counters = { opens: 0, starts: 0, interrupts: 0, closes: 0 };
  let socket, fire;
  const send = frame => socket.send(JSON.stringify({ v: 1, ...frame }));
  const ack = (frame, seq) => send({ type: 'ack', runId: frame.runId, attemptId: frame.attemptId, leaseMs: 1000, seq });
  const addressed = { issueId, workspaceId: 'interactive-sample' };
  const start = (leaseMs = 1000, turnMs = 1000) => send({ type: 'start', ...addressed, runId: randomUUID(), attemptId: randomUUID(),
    input: 'fixture', leaseMs, turnMs });
  wss.on('connection', peer => {
    socket = peer;
    socket.on('message', data => {
      const frame = parseWorkerFrame(data);
      if (frame.type === 'resume') {
        resumes.push(frame);
        send({ type: 'ready' });
        if (frame.active) ack(frame.active, received.get(frame.active.runId) ?? 0);
      } else {
        if (frame.type === 'terminal') results.push(frame);
        if (frame.type === 'terminal' && onTerminal?.(frame, results, peer)) return;
        received.set(frame.runId, frame.seq);
        ack(frame, frame.seq);
      }
    });
  });
  const task = runInteractiveWorker({ brokerUrl: `ws://127.0.0.1:${wss.address().port}/worker/connect`,
    workerToken: 'test-worker-'.repeat(4), workspaceProfile: addressed, signal: abort.signal,
    openSession: async ({ onEvent }) => {
      counters.opens++;
      const threadId = 'same_thread';
      return { threadId, async startTurn() {
        const turnId = `turn_${++counters.starts}`;
        fire = (outcome = 'completed', text = 'result') => onEvent({ kind: 'terminal', threadId, turnId, outcome, text });
        onStart?.({ fire, socket });
        return { turnId };
      }, async interruptTurn() { counters.interrupts++; }, async close() { counters.closes++; } };
    },
  });
  t.after(async () => {
    abort.abort();
    for (const client of wss.clients) client.terminate();
    await task;
    await new Promise(resolve => wss.close(resolve));
  });
  async function wait(condition) {
    for (let i = 0; i < 400; i++) { if (condition()) return; await delay(10); }
    throw new Error('Worker fixture deadline');
  }
  await wait(() => resumes.length === 1);
  return { start, results, resumes, wait, counters, closeSocket: () => socket.terminate() };
}

test('reuseThreadAcrossTwoTurns', async t => {
  const f = await fixture(t, { onStart: ({ fire }) => fire() });
  f.start();
  await f.wait(() => f.results.length === 1);
  // The fixture sent the terminal ACK first on the same ordered socket.
  f.start();
  await f.wait(() => f.results.length === 2);
  assert.equal(f.counters.opens, 1);
  assert.equal(f.results[0].threadId, f.results[1].threadId);
  assert.notEqual(f.results[0].turnId, f.results[1].turnId);
});

test('replayTerminalAfterAckLoss', async t => {
  const f = await fixture(t, { onStart: ({ fire }) => fire('completed', '\u0000'.repeat(8192)),
    onTerminal: (_frame, results, peer) => { if (results.length !== 1) return false; peer.terminate(); return true; } });
  f.start();
  await f.wait(() => f.results.length === 2);
  assert.equal(f.counters.starts, 1);
  assert.equal(f.resumes[0].bootId, f.resumes[1].bootId);
  assert.deepEqual(f.results[0], f.results[1]);
  assert.match(f.results[0].text, /rút gọn/);
});

test('enforceLocalDeadlineWithoutBroker', async t => {
  const f = await fixture(t, { onStart: ({ socket }) => socket.terminate() });
  f.start(150, 150);
  await f.wait(() => f.counters.interrupts === 1);
  assert.equal(f.results.length, 0);
  await f.wait(() => f.results.length === 1);
  assert.equal(f.results[0].outcome, 'unknown');
  assert.equal(f.counters.starts, 1);
  assert.equal(f.counters.closes, 1);
});
