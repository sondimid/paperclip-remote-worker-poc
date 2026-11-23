import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const event = (method, params) => emit({ method, params });
const scenario = process.argv[2];
let threadId, turnId, initialized, phase, policyProbed, accountChecked;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, error } = JSON.parse(line);
  const respond = result => emit({ id, result });
  if (method === 'initialize') respond({ serverInfo: { name: 'fixture' } });
  else if (method === 'initialized') initialized = true;
  else if (method === 'thread/start' || method === 'thread/resume') {
    assert.ok(initialized);
    if (method === 'thread/start' && process.argv[2] === 'reject-thread') {
      assert.equal(params.permissions, 'paperclip-fixture');
      assert.equal(params.approvalPolicy, 'never');
      emit({ id, error: { code: -32602, message: 'unknown field `permissions`: SYNTHETIC_PRIVATE_TEXT',
        data: { detail: 'SYNTHETIC_PRIVATE_DATA' } } });
      continue;
    }
    assert.equal(params.approvalPolicy, 'never');
    if (scenario?.startsWith('lab-')) {
      assert.equal(params.permissions, 'paperclip-fixture');
      assert.equal(params.sandbox, undefined);
      if (scenario === 'lab-bad-resume') assert.equal(method, 'thread/resume');
      threadId = scenario === 'lab-bad-resume' ? 'different_thread' : params.threadId ?? 'native_lab_thread';
      respond({ thread: { id: threadId }, activePermissionProfile: { id: 'paperclip-fixture', extends: null }, approvalPolicy: 'never' });
    } else {
      assert.equal(params.sandbox, 'read-only');
      threadId = params.threadId ?? 'thread_fixture';
      respond({ thread: { id: threadId } });
    }
  } else if (method === 'command/exec') {
    assert.equal(params.permissionProfile, 'paperclip-fixture');
    policyProbed = true;
    if (scenario !== 'lab-stall') respond({ exitCode: 0, stdout: JSON.stringify({ read: true,
      outside: scenario === 'lab-bad-policy' ? 'allowed' : 'EPERM', write: 'EPERM', net: 'EACCES' }) });
  } else if (method === 'account/read') {
    assert.ok(policyProbed);
    assert.equal(params.refreshToken, false);
    accountChecked = scenario !== 'lab-auth';
    respond({ account: accountChecked ? { type: 'chatgpt' } : null });
  } else if (method === 'turn/start') {
    assert.equal(params.threadId, threadId);
    if (scenario?.startsWith('lab-')) assert.ok(accountChecked);
    phase = params.input[0].text;
    turnId = scenario?.startsWith('lab-') ? randomUUID() : 'turn_fixture';
    if (phase === 'malformed') { process.stdout.write('{broken\n'); continue; }
    event('item/agentMessage/delta', { threadId, turnId: 'wrong_turn', delta: 'ignore' });
    event('item/agentMessage/delta', { threadId, turnId, delta: 'early fixture delta' });
    respond({ turn: { id: turnId } });
    if (phase === 'approval') emit({ id: 'a', method: 'item/commandExecution/requestApproval', params: {} });
    if (phase === 'disconnect') process.exit(0);
    if (['complete', 'empty', 'oversize'].includes(phase)) {
      const text = phase === 'empty' ? ' ' : phase === 'oversize' ? 'a'.repeat(256 * 1024 + 1) : 'fixture final';
      event('item/completed', { threadId, turnId: 'wrong_turn', item: { type: 'agentMessage', text: 'ignore' } });
      event('item/completed', { threadId, turnId, item: { type: 'agentMessage', text } });
      event('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
    }
  } else if (method === 'turn/interrupt') {
    assert.deepEqual(params, { threadId, turnId });
    respond({});
    if (phase !== 'interrupt-no-terminal') {
      setTimeout(() => event('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted' } }), 80);
    }
  } else if (!method && id === 'a') {
    assert.equal(error.code, -32601);
    event('turn/completed', { threadId, turn: { id: turnId, status: 'failed' } });
  } else throw new Error('Unexpected fixture RPC');
}
