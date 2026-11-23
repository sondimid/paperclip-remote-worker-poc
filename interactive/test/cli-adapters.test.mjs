import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as codex from '../codex-cli.mjs';
import * as claude from '../claude-cli.mjs';
import { runCliProcess } from '../cli-process.mjs';

const file = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
const input = ' --resume not-an-option; $(& no-shell)\nTiếng Việt 🧪';
async function fixture(t, provider, scenario = 'ok') {
  const cwd = await mkdtemp(join(tmpdir(), 'cli-adapter-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const profile = { executable: process.execPath, cwd, profileDir: cwd, policyExecutable: join(cwd, 'fixture-policy.exe') };
  const runProcess = ({ executable, args, ...opts }) => {
    assert.equal(opts.env.HOME, cwd);
    assert.equal(opts.env.INTERACTIVE_WORKER_TOKEN, undefined);
    assert.equal(opts.env.PAPERCLIP_API_KEY, undefined);
    return runCliProcess({ executable: process.execPath, args: [file, executable === profile.policyExecutable ? 'policy' : provider, scenario, ...args], ...opts });
  };
  return { profile, runProcess };
}

for (const [provider, adapter] of Object.entries({ codex, claude })) {
  test(`${provider}: probe without model, stdin as verbatim data, final and exact resume`, async t => {
    const { profile, runProcess } = await fixture(t, provider);
    const config = { runProcess, input };
    const capability = await adapter.probe(profile, config);
    assert.equal(capability.state, 'ready');
    const progress = [];
    const first = await adapter.runTurn(profile, { ...config, capability, onProgress: text => progress.push(text) });
    assert.deepEqual(first, { outcome: 'completed', sessionId: `${provider}_fixture`, text: `﻿${provider} trả lời lượt một\n` });
    assert.deepEqual(progress, ['preview only']);
    const second = await adapter.runTurn(profile, { ...config, capability, sessionId: first.sessionId });
    assert.deepEqual(second, { outcome: 'completed', sessionId: first.sessionId, text: `﻿${provider} trả lời lượt hai\n` });
    assert.deepEqual(await adapter.runTurn(profile, { ...config, capability, sessionId: '--last' }), { outcome: 'failed', reason: 'resume_unavailable' });
  });
  test(`${provider}: reject unverified profile, auth, unsupported versions and invalid finals`, async t => {
    assert.deepEqual(await adapter.probe(), { state: 'unsupported' });
    for (const [scenario, state] of Object.entries({ 'policy-failed': 'policy_unverified', unsupported: 'unsupported', 'auth-failed': 'auth_unverified' })) {
      const { profile, runProcess } = await fixture(t, provider, scenario);
      assert.equal((await adapter.probe(profile, { runProcess })).state, state);
    }
    for (const [scenario, reason] of Object.entries({ malformed: 'output_invalid', exit: 'cli_failed',
      'wrong-session': 'output_invalid', large: 'output_limit', truncated: 'output_limit' })) {
      const { profile, runProcess } = await fixture(t, provider, scenario);
      const result = await adapter.runTurn(profile, { input, runProcess, capability: { stream: true }, sessionId: `${provider}_fixture` });
      assert.deepEqual(result, { outcome: 'failed', reason });
    }
  });
}

test('Claude JSON fallback returns the official result without preview', async t => {
  const { profile, runProcess } = await fixture(t, 'claude', 'no-stream');
  const capability = await claude.probe(profile, { runProcess });
  assert.deepEqual(capability, { state: 'ready', stream: false });
  const result = await claude.runTurn(profile, { runProcess, input, capability, onProgress: () => assert.fail('not streaming') });
  assert.equal(result.outcome, 'completed');
});
