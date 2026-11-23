import { openCodexSession } from './codex.mjs';
import { cliSessionId } from './cli-process.mjs';
import { fullFinalBytes, turnMaxMs } from './protocol.mjs';

export function createCodexAppServerAdapter(openSession = openCodexSession) {
  let exitUnverified = false;

  async function close(session) {
    if (!session) return true;
    try { if (await session.close() === true) return true; } catch { /* Không xác nhận được tiến trình đã thoát. */ }
    exitUnverified = true;
    return false;
  }

  async function probe(readProfile, { signal } = {}) {
    if (exitUnverified) return { state: 'policy_unverified' };
    const timeout = AbortSignal.timeout(20_000);
    try {
      const session = await openSession({ workspaceProfile: readProfile(), onEvent: () => {},
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      return { state: await close(session) ? 'ready' : 'policy_unverified' };
    } catch (error) {
      if (error.code === 'codex_cleanup_unverified') exitUnverified = true;
      return { state: error.code === 'codex_auth_unverified' ? 'auth_unverified' : 'policy_unverified' };
    }
  }

  async function runTurn(readProfile, { input, sessionId, signal = AbortSignal.timeout(turnMaxMs), onProgress = () => {} }) {
    if (exitUnverified) return { outcome: 'unknown', reason: 'cli_failed' };
    if (sessionId !== undefined && !cliSessionId(sessionId)) return { outcome: 'failed', reason: 'resume_unavailable' };
    let session, turnId, abortTimer, submitted = false, interruptSent = false;
    const unknown = { outcome: 'unknown', reason: 'cli_failed' };
    const cancelled = { outcome: 'interrupted', reason: 'cli_cancelled' };
    const terminal = Promise.withResolvers();
    const stop = Promise.withResolvers();
    function interrupt() {
      if (turnId && !interruptSent) {
        interruptSent = true;
        void session.interruptTurn({ turnId }).catch(() => stop.resolve(unknown));
      }
    }
    function abort() {
      abortTimer ??= setTimeout(() => stop.resolve(unknown), 1350);
      interrupt();
    }
    let result;
    try {
      signal?.throwIfAborted();
      session = await openSession({ workspaceProfile: readProfile(), threadId: sessionId,
        signal: signal ?? AbortSignal.timeout(20_000), onEvent(event) {
          // Driver đã lọc đúng thread/turn, kể cả notification đến trước reply turn/start.
          if (event.kind === 'delta' && !signal?.aborted) onProgress(event.text);
          else if (event.kind === 'terminal' || event.kind === 'unknown') terminal.resolve(event);
        } });
      if (!cliSessionId(session.threadId) || (sessionId && session.threadId !== sessionId)) {
        result = { outcome: 'failed', reason: 'resume_unavailable' };
      } else {
        signal?.throwIfAborted();
        signal?.addEventListener('abort', abort, { once: true });
        submitted = true;
        const started = await Promise.race([
          session.startTurn({ text: input, deadline: performance.now() + 4000 }), stop.promise,
        ]);
        if (!started.turnId) result = unknown;
        else {
          turnId = started.turnId;
          if (signal?.aborted) interrupt();
          const event = await Promise.race([terminal.promise, stop.promise]);
          if (event.kind !== 'terminal' || event.turnId !== turnId || event.threadId !== session.threadId) result = unknown;
          else if (event.outcome === 'interrupted') result = cancelled;
          else if (signal?.aborted || event.outcome === 'unknown') result = unknown;
          else if (event.outcome !== 'completed') result = { outcome: 'failed', reason: 'cli_failed' };
          else if (typeof event.text !== 'string' || !event.text.trim()) result = { outcome: 'failed', reason: 'output_invalid' };
          else if (Buffer.byteLength(event.text) > fullFinalBytes) result = { outcome: 'failed', reason: 'output_limit' };
          else result = { outcome: 'completed', sessionId: session.threadId, text: event.text };
        }
      }
    } catch (error) {
      if (error.code === 'codex_cleanup_unverified') { exitUnverified = true; result = unknown; }
      else if (submitted) result = unknown;
      else if (signal?.aborted) result = cancelled;
      else result = { outcome: 'failed', reason: error.code === 'codex_resume_unavailable' ? 'resume_unavailable' : 'policy_unverified' };
    } finally {
      signal?.removeEventListener('abort', abort);
      clearTimeout(abortTimer);
      if (!await close(session)) result = unknown;
    }
    return result;
  }

  return { probe, runTurn };
}
