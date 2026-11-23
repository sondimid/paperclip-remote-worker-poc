import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { cliEnvironment, cliFailure, cliSessionId, readCliHelp, runCliProcess, validCliProfile, verifyCliPolicy } from './cli-process.mjs';
import { fullFinalBytes } from './protocol.mjs';

export async function probe(profile, { signal, runProcess = runCliProcess } = {}) {
  if (!validCliProfile(profile)) return { state: 'unsupported' };
  if (!await verifyCliPolicy(profile, 'codex', signal, runProcess)) return { state: 'policy_unverified' };
  const help = await readCliHelp(profile, 'codex', ['exec', '--help'], signal, runProcess);
  const resumeHelp = await readCliHelp(profile, 'codex', ['exec', 'resume', '--help'], signal, runProcess);
  const topHelp = await readCliHelp(profile, 'codex', ['--help'], signal, runProcess);
  if (!['--json', '--output-last-message', '--sandbox'].every(flag => help.includes(flag))
      || !resumeHelp.includes('SESSION_ID') || !topHelp.includes('--ask-for-approval')) return { state: 'unsupported' };
  const auth = await runProcess({ ...profile, env: cliEnvironment(profile, 'codex'), args: ['login', 'status'], signal,
    timeoutMs: 4000, limit: 8192 });
  return { state: !auth.failure && auth.code === 0 ? 'ready' : 'auth_unverified' };
}

export async function runTurn(profile, { input, sessionId, onProgress = () => {}, signal, runProcess = runCliProcess }) {
  if (sessionId !== undefined && !cliSessionId(sessionId)) return { outcome: 'failed', reason: 'resume_unavailable' };
  if (!await verifyCliPolicy(profile, 'codex', signal, runProcess)) return cliFailure({ failure: signal?.aborted ? 'cli_cancelled' : 'policy_unverified' });
  const dir = await mkdtemp(join(profile.profileDir, 'paperclip-final-'));
  const output = join(dir, 'turn.txt');
  let nativeId, turn, rejected = false, incomplete = false;
  try {
    const args = ['--ask-for-approval', 'never', 'exec', '--sandbox', 'read-only', '--json', '--output-last-message', output,
      ...(sessionId === undefined ? [] : ['resume', sessionId]), '-'];
    const result = await runProcess({ ...profile, env: cliEnvironment(profile, 'codex'), args, input, signal, lines(line) {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (typeof event?.type !== 'string') throw new Error('Invalid Codex event');
      if (event.type === 'thread.started') {
        if (nativeId || !cliSessionId(event.thread_id) || (sessionId && sessionId !== event.thread_id)) throw new Error('Wrong Codex session');
        nativeId = event.thread_id;
      } else if (event.type === 'turn.started') {
        if (!nativeId || turn) throw new Error('Unexpected Codex turn');
        turn = 'active';
      } else if (event.type === 'turn.completed') {
        if (turn !== 'active') throw new Error('Unexpected Codex terminal');
        turn = 'completed';
        incomplete ||= ['length', 'max_tokens', 'max_output_tokens'].includes(event.stop_reason);
      } else if (event.type === 'turn.failed' || event.type === 'error') rejected = true;
      else if (turn === 'active' && event.type === 'item.updated' && event.item?.type === 'agent_message'
          && typeof event.item.text === 'string') onProgress(event.item.text);
    } });
    if (result.failure || result.code !== 0 || rejected) return cliFailure(result);
    if (incomplete) return { outcome: 'failed', reason: 'output_limit' };
    if (turn !== 'completed') return { outcome: 'failed', reason: 'output_invalid' };
    const file = await open(output, 'r');
    try {
      const bytes = Buffer.alloc(fullFinalBytes + 1);
      let count = 0;
      while (count < bytes.length) {
        const { bytesRead } = await file.read(bytes, count, bytes.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > fullFinalBytes) return { outcome: 'failed', reason: 'output_limit' };
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count));
      if (!text.trim()) return { outcome: 'failed', reason: 'output_invalid' };
      return { outcome: 'completed', sessionId: nativeId, text };
    } finally { await file.close(); }
  } catch {
    return { outcome: 'failed', reason: 'output_invalid' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
