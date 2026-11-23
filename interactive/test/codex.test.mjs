import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openCodexSession } from '../codex.mjs';

async function fixture(t, threadId) {
  const events = [];
  const cwd = fileURLToPath(new URL('./fixtures/', import.meta.url));
  const session = await openCodexSession({
    workspaceProfile: { cwd, codexHome: cwd, executable: process.execPath, fixtureArgs: [`${cwd}fake-codex.mjs`] },
    threadId, onEvent: event => events.push(event),
  });
  t.after(() => session.close());
  const waitFor = async kind => {
    for (let i = 0; i < 100; i++) {
      const event = events.find(value => value.kind === kind);
      if (event) return event;
      await delay(10);
    }
    throw new Error(`Missing fixture event ${kind}`);
  };
  return { session, events, waitFor, start: text => session.startTurn({ text, deadline: performance.now() + 4000 }) };
}

test('classify thread/start rejection only for local diagnostics without exposing raw fields', async () => {
  const cwd = fileURLToPath(new URL('./fixtures/', import.meta.url));
  const options = {
    workspaceProfile: { cwd, codexHome: cwd, executable: process.execPath, permissionProfile: 'paperclip-fixture',
      fixtureArgs: [`${cwd}fake-codex.mjs`, 'reject-thread'] },
    onEvent: () => assert.fail('Preflight rejection must not emit a turn event'),
  };
  await assert.rejects(openCodexSession(options), { message: 'App Server RPC rejected: thread/start' });
  await assert.rejects(openCodexSession({ ...options, diagnoseThreadStart: true }), {
    message: 'App Server RPC rejected: thread/start [rpc_code=-32602; hints=rpc-field,permission-profile]',
  });
});

test('initializeAndStreamMatchedTurn', async t => {
  const f = await fixture(t);
  const { turnId } = await f.start('complete');
  assert.equal(turnId, 'turn_fixture');
  assert.equal((await f.waitFor('terminal')).text, 'fixture final');
  assert.deepEqual(f.events.filter(e => e.kind === 'delta').map(e => e.text), ['early fixture delta']);
});
test('resumeExactThread', async t => {
  const f = await fixture(t, 'thread_resumed');
  assert.equal(f.session.threadId, 'thread_resumed');
  await f.start('complete');
  assert.equal((await f.waitFor('terminal')).threadId, 'thread_resumed');
});
test('awaitTerminalAfterInterrupt', async t => {
  const f = await fixture(t);
  const { turnId } = await f.start('interrupt');
  await f.session.interruptTurn({ turnId });
  assert.equal(f.events.some(e => e.kind === 'terminal'), false);
  assert.equal((await f.waitFor('terminal')).outcome, 'interrupted');
});
test('denyApprovalAndFailClosedOnProtocolError', async t => {
  const approval = await fixture(t);
  await approval.start('approval');
  assert.equal((await approval.waitFor('terminal')).outcome, 'failed');
  const broken = await fixture(t);
  await assert.rejects(broken.start('malformed'));
  assert.equal((await broken.waitFor('unknown')).kind, 'unknown');
});
