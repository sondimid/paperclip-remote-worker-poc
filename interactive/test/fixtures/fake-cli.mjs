import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const [provider, scenario, ...args] = process.argv.slice(2);
const emit = event => console.log(JSON.stringify(event));
const expectedText = ' --resume not-an-option; $(& no-shell)\nTiếng Việt 🧪';
const get = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

if (provider === 'policy') {
  assert.equal(args.length, 4);
  console.log(scenario === 'policy-failed' ? 'not verified' : 'paperclip-cli-policy-v2:verified');
} else if (args.at(-1) === '--help') {
  if (scenario === 'unsupported') console.log('old help');
  else if (provider === 'codex') console.log(args[1] === 'resume' ? 'SESSION_ID' : args[0] === 'exec'
    ? '--json --output-last-message --sandbox' : '--ask-for-approval');
  else console.log('--print --output-format --input-format --tools --setting-sources --strict-mcp-config --mcp-config --disable-slash-commands --no-chrome --resume'
    + (scenario === 'no-stream' ? '' : ' stream-json --verbose --include-partial-messages'));
} else if (args[1] === 'status') {
  if (scenario === 'auth-failed') process.exitCode = 1;
  else console.log(provider === 'codex' ? 'Logged in using ChatGPT' : '{"loggedIn":true}');
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  assert.equal(input, expectedText);
  const resumed = get(provider === 'codex' ? 'resume' : '--resume');
  if (resumed) assert.equal(resumed, `${provider}_fixture`);
  const id = scenario === 'wrong-session' ? `${provider}_wrong` : `${provider}_fixture`;
  const text = scenario === 'large' ? '🧪'.repeat(65537) : `﻿${provider} trả lời ${resumed ? 'lượt hai' : 'lượt một'}\n`;
  if (scenario === 'malformed') { console.log('{not json'); process.exit(0); }
  if (scenario === 'exit') { console.error('FIXTURE_PRIVATE_MARKER'); process.exit(1); }
  if (provider === 'codex') {
    assert.deepEqual(args.slice(0, 7), ['--ask-for-approval', 'never', 'exec', '--sandbox', 'read-only', '--json', '--output-last-message']);
    assert.equal(args.at(-1), '-');
    assert.equal(args.length, resumed ? 11 : 9);
    emit({ type: 'thread.started', thread_id: id });
    emit({ type: 'turn.started' });
    emit({ type: 'item.updated', item: { type: 'agent_message', text: 'preview only' } });
    emit({ type: 'turn.completed', ...(scenario === 'truncated' && { stop_reason: 'length' }) });
    writeFileSync(get('--output-last-message'), text);
  } else {
    for (const flag of ['--print', '--tools=', '--setting-sources=', '--strict-mcp-config', '--disable-slash-commands', '--no-chrome']) assert.ok(args.includes(flag));
    assert.equal(args.length, 12 + (get('--output-format') === 'stream-json' ? 2 : 0) + (resumed ? 2 : 0));
    if (get('--output-format') === 'stream-json') {
      emit({ type: 'system', subtype: 'init', session_id: id });
      emit({ type: 'stream_event', session_id: 'other', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ignore foreign delta' } } });
      emit({ type: 'stream_event', session_id: id, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'preview only' } } });
    }
    emit({ type: 'result', session_id: id, subtype: 'success', is_error: false, result: text,
      ...(scenario === 'truncated' && { stop_reason: 'max_tokens' }) });
  }
}
