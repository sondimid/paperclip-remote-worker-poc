import { cliEnvironment, cliFailure, cliSessionId, readCliHelp, runCliProcess, validCliProfile, verifyCliPolicy } from './cli-process.mjs';
import { fullFinalBytes } from './protocol.mjs';

const fixedFlags = ['--print', '--output-format', '--input-format', '--tools', '--setting-sources', '--strict-mcp-config',
  '--mcp-config', '--disable-slash-commands', '--no-chrome', '--resume'];
const stopIsLimit = value => ['length', 'max_tokens', 'max_output_tokens', 'model_context_window_exceeded'].includes(value);

export async function probe(profile, { signal, runProcess = runCliProcess } = {}) {
  if (!validCliProfile(profile)) return { state: 'unsupported' };
  if (!await verifyCliPolicy(profile, 'claude', signal, runProcess)) return { state: 'policy_unverified' };
  const help = await readCliHelp(profile, 'claude', ['--help'], signal, runProcess);
  if (!fixedFlags.every(flag => help.includes(flag))) return { state: 'unsupported' };
  const stream = ['stream-json', '--verbose', '--include-partial-messages'].every(flag => help.includes(flag));
  const result = await runProcess({ ...profile, env: cliEnvironment(profile, 'claude'), args: ['auth', 'status'], signal,
    timeoutMs: 4000, limit: 8192 });
  try {
    if (!result.failure && result.code === 0 && JSON.parse(result.stdout).loggedIn === true) return { state: 'ready', stream };
  } catch { /* Không đưa stdout xác thực vào log. */ }
  return { state: 'auth_unverified' };
}

export async function runTurn(profile, { input, sessionId, onProgress = () => {}, signal, capability, runProcess = runCliProcess }) {
  if (sessionId !== undefined && !cliSessionId(sessionId)) return { outcome: 'failed', reason: 'resume_unavailable' };
  if (!await verifyCliPolicy(profile, 'claude', signal, runProcess)) return cliFailure({ failure: signal?.aborted ? 'cli_cancelled' : 'policy_unverified' });
  const stream = capability?.stream === true;
  const args = ['--print', '--input-format', 'text', '--output-format', stream ? 'stream-json' : 'json',
    '--tools=', '--setting-sources=', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--no-chrome', ...(stream ? ['--verbose', '--include-partial-messages'] : []),
    ...(sessionId === undefined ? [] : ['--resume', sessionId])];
  let nativeId, final, incomplete = false;
  function receive(event) {
    if (typeof event?.type !== 'string' || final) throw new Error('Invalid Claude event');
    if (event.type === 'system' && event.subtype === 'init') {
      if (nativeId || !cliSessionId(event.session_id) || (sessionId && sessionId !== event.session_id)) throw new Error('Wrong Claude session');
      nativeId = event.session_id;
    }
    if (event.type === 'stream_event' && nativeId && event.session_id === nativeId) {
      incomplete ||= stopIsLimit(event.event?.delta?.stop_reason);
      if (event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta'
          && typeof event.event.delta.text === 'string') onProgress(event.event.delta.text);
    }
    if (event.type === 'result') final = event;
  }
  const result = await runProcess({ ...profile, env: cliEnvironment(profile, 'claude'), args, input, signal,
    ...(stream ? { lines: text => { if (text.trim()) receive(JSON.parse(text)); } } : {}) });
  if (result.failure || result.code !== 0) return cliFailure(result);
  if (!stream) {
    try { receive(JSON.parse(result.stdout)); } catch { return { outcome: 'failed', reason: 'output_invalid' }; }
  }
  if (incomplete || stopIsLimit(final?.stop_reason) || final?.subtype === 'error_max_output_tokens') {
    return { outcome: 'failed', reason: 'output_limit' };
  }
  if (!cliSessionId(final?.session_id) || (stream && nativeId !== final.session_id) || (sessionId && sessionId !== final.session_id)
      || final.subtype !== 'success' || final.is_error !== false || typeof final.result !== 'string' || !final.result.trim()) {
    return { outcome: 'failed', reason: 'output_invalid' };
  }
  if (Buffer.byteLength(final.result) > fullFinalBytes) return { outcome: 'failed', reason: 'output_limit' };
  return { outcome: 'completed', sessionId: final.session_id, text: final.result };
}
