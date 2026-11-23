import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const event = (method, params) => emit({ method, params });
let threadId, turnId, initialized, phase;
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
    assert.equal(params.sandbox, 'read-only');
    assert.equal(params.approvalPolicy, 'never');
    threadId = params.threadId ?? 'thread_fixture';
    respond({ thread: { id: threadId } });
  } else if (method === 'turn/start') {
    assert.equal(params.threadId, threadId);
    phase = params.input[0].text;
    turnId = 'turn_fixture';
    if (phase === 'malformed') { process.stdout.write('{broken\n'); continue; }
    event('item/agentMessage/delta', { threadId, turnId: 'wrong_turn', delta: 'ignore' });
    event('item/agentMessage/delta', { threadId, turnId, delta: 'early fixture delta' });
    respond({ turn: { id: turnId } });
    if (phase === 'approval') emit({ id: 'a', method: 'item/commandExecution/requestApproval', params: {} });
    if (phase === 'complete') {
      event('item/completed', { threadId, turnId, item: { type: 'agentMessage', text: 'fixture final' } });
      event('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
    }
  } else if (method === 'turn/interrupt') {
    assert.deepEqual(params, { threadId, turnId });
    respond({});
    setTimeout(() => event('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted' } }), 80);
  } else if (!method && id === 'a') {
    assert.equal(error.code, -32601);
    event('turn/completed', { threadId, turn: { id: turnId, status: 'failed' } });
  } else throw new Error('Unexpected fixture RPC');
}
