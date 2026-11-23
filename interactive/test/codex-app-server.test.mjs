import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCodexAppServerAdapter } from '../codex-app-server.mjs';
import { openCodexSession } from '../codex.mjs';
import { selectCliAdapters } from '../worker.mjs';

async function profile(t, scenario = 'lab-ok') {
  const root = await mkdtemp(join(tmpdir(), 'codex-app-server-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'fixture'), codexHome = join(root, 'profile');
  await Promise.all([mkdir(cwd), mkdir(codexHome)]);
  return () => ({ cwd, codexHome, executable: process.execPath, permissionProfile: 'paperclip-fixture',
    fixtureArgs: [fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)), scenario] });
}

test('selects only Codex App Server via explicit opt-in', () => {
  const defaults = selectCliAdapters();
  assert.equal(selectCliAdapters('exec'), defaults);
  const app = selectCliAdapters('app-server');
  assert.notEqual(app.codex, defaults.codex);
  assert.equal(app.claude, defaults.claude);
  assert.throws(() => selectCliAdapters(''), /INTERACTIVE_CODEX_BACKEND/);
});

test('probe checks containment before auth without submitting a turn', async t => {
  const adapter = createCodexAppServerAdapter();
  const ok = await profile(t);
  const denied = await profile(t, 'lab-bad-policy');
  const auth = await profile(t, 'lab-auth');
  assert.deepEqual(await adapter.probe(ok), { state: 'ready' });
  assert.deepEqual(await adapter.probe(denied), { state: 'policy_unverified' });
  assert.deepEqual(await adapter.probe(auth), { state: 'auth_unverified' });
  assert.deepEqual(await adapter.runTurn(denied, { input: 'complete' }), { outcome: 'failed', reason: 'policy_unverified' });
  for (const readProfile of [ok, denied, auth]) assert.deepEqual(await readdir(readProfile().cwd), []);
});

test('uses new processes for turns and resumes exactly the successful native thread', async t => {
  const readProfile = await profile(t);
  const turnIds = [], opened = [];
  const adapter = createCodexAppServerAdapter(options => {
    opened.push(options.threadId);
    return openCodexSession({ ...options, onEvent(event) {
      if (event.kind === 'terminal') turnIds.push(event.turnId);
      options.onEvent(event);
    } });
  });
  const progress = [];
  const first = await adapter.runTurn(readProfile, { input: 'complete', onProgress: text => progress.push(text) });
  assert.deepEqual(first, { outcome: 'completed', sessionId: 'native_lab_thread', text: 'fixture final' });
  assert.deepEqual(await adapter.runTurn(readProfile, { input: 'complete', sessionId: first.sessionId }), first);
  assert.deepEqual(progress, ['early fixture delta']);
  assert.deepEqual(opened, [undefined, first.sessionId]);
  assert.equal(new Set(turnIds).size, 2);
  assert.deepEqual(await adapter.runTurn(await profile(t, 'lab-bad-resume'), { input: 'complete', sessionId: first.sessionId }),
    { outcome: 'failed', reason: 'resume_unavailable' });
  assert.equal(opened.at(-1), first.sessionId);
  assert.equal(opened.length, 3);
});

test('rejects empty, oversized, and disconnected responses', async t => {
  const readProfile = await profile(t);
  const adapter = createCodexAppServerAdapter();
  assert.deepEqual(await adapter.runTurn(readProfile, { input: 'empty' }), { outcome: 'failed', reason: 'output_invalid' });
  assert.deepEqual(await adapter.runTurn(readProfile, { input: 'oversize' }), { outcome: 'failed', reason: 'output_limit' });
  assert.equal((await adapter.runTurn(readProfile, { input: 'disconnect' })).outcome, 'unknown');
});

test('setup cancellation does not submit; interrupt requires a terminal event', async t => {
  const readProfile = await profile(t);
  const adapter = createCodexAppServerAdapter();
  const cancelled = { outcome: 'interrupted', reason: 'cli_cancelled' };
  assert.deepEqual(await adapter.runTurn(() => assert.fail('opened after abort'), { input: 'complete', signal: AbortSignal.abort() }), cancelled);
  const duringSetup = new AbortController();
  const stalled = await profile(t, 'lab-stall');
  const starting = adapter.runTurn(stalled, { input: 'complete', signal: duringSetup.signal });
  setTimeout(() => duringSetup.abort(), 100);
  assert.deepEqual(await starting, cancelled);
  for (const input of ['interrupt', 'interrupt-no-terminal']) {
    const controller = new AbortController();
    const result = await adapter.runTurn(readProfile, { input, signal: controller.signal, onProgress: () => controller.abort() });
    assert.equal(result.outcome, input === 'interrupt' ? 'interrupted' : 'unknown');
  }
  assert.deepEqual(await readdir(stalled().cwd), []);
});

test('an unconfirmed process exit blocks later App Server work', async () => {
  let opens = 0;
  const adapter = createCodexAppServerAdapter(async () => { opens++; return { close: async () => false }; });
  assert.deepEqual(await adapter.probe(() => ({})), { state: 'policy_unverified' });
  assert.equal((await adapter.runTurn(() => ({}), { input: 'complete' })).outcome, 'unknown');
  assert.equal(opens, 1);
});
