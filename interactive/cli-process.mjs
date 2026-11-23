import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const systemKeys = new Set(['systemroot', 'windir', 'path', 'lang', 'lc_all', 'tmp', 'temp', 'tmpdir']);
export const cliSessionId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) && !value.startsWith('-');

export function validCliProfile(profile) {
  return !!profile && [profile.executable, profile.cwd, profile.profileDir].every(value => typeof value === 'string' && isAbsolute(value))
    && (process.platform !== 'win32' || /\.exe$/i.test(profile.executable));
}

export function cliEnvironment(profile, provider) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => systemKeys.has(key.toLowerCase())));
  // Chỉ dùng profile riêng và không truyền token của worker/Bridge vào tiến trình con.
  return { ...env, HOME: profile.profileDir, USERPROFILE: profile.profileDir,
    APPDATA: profile.profileDir, LOCALAPPDATA: profile.profileDir,
    ...(provider === 'codex' ? { CODEX_HOME: profile.profileDir } : { CLAUDE_CONFIG_DIR: profile.profileDir }) };
}

export function runCliProcess({ executable, args, cwd, env, input = '', signal, lines, timeoutMs, limit = 4 * 1024 * 1024 }) {
  if (signal?.aborted) return Promise.resolve({ failure: 'cli_cancelled' });
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let size = 0, failure, killTimer, pending = Buffer.alloc(0);
    const chunks = [];
    const stop = reason => {
      if (failure) return;
      failure = reason;
      child.kill('SIGKILL');
      // Không báo đã dừng nếu một tiến trình/pipe còn sống ngoài thời hạn.
      killTimer = setTimeout(() => {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        finish({ failure: 'deadline', unknown: true });
      }, 1000);
    };
    const abort = () => stop('cli_cancelled');
    const timer = timeoutMs ? setTimeout(() => stop('deadline'), timeoutMs) : undefined;
    function finish(result) {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      resolve(result);
    }
    child.on('error', () => stop('cli_failed'));
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      if (failure) return;
      size += chunk.length;
      if (size > limit) return stop('output_limit');
      if (!lines) { chunks.push(chunk); return; }
      pending = Buffer.concat([pending, chunk]);
      for (let end; (end = pending.indexOf(10)) !== -1;) {
        const line = pending.subarray(0, end);
        pending = pending.subarray(end + 1);
        try { lines(decoder.decode(line)); } catch { return stop('output_invalid'); }
      }
    });
    child.on('close', (code, exitSignal) => {
      try {
        if (!failure && lines && pending.length) lines(decoder.decode(pending));
        finish({ code, failure: failure ?? (exitSignal ? 'cli_failed' : undefined),
          stdout: failure || lines ? '' : decoder.decode(Buffer.concat(chunks)) });
      } catch { finish({ failure: 'output_invalid' }); }
    });
    child.stdin.on('error', () => stop('cli_failed'));
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.end(input, 'utf8');
  });
}

export async function readCliHelp(profile, provider, args, signal, run = runCliProcess) {
  const result = await run({ ...profile, env: cliEnvironment(profile, provider), args, signal, timeoutMs: 4000, limit: 128 * 1024 });
  return !result.failure && result.code === 0 ? result.stdout : '';
}

export async function verifyCliPolicy(profile, provider, signal, run = runCliProcess) {
  if (typeof profile.policyExecutable !== 'string' || !isAbsolute(profile.policyExecutable)
      || (process.platform === 'win32' && !/\.exe$/i.test(profile.policyExecutable))) return false;
  // Verifier do quản trị viên cài tại máy worker; không nhận lệnh, prompt hoặc token từ Broker.
  const result = await run({ executable: profile.policyExecutable, cwd: profile.cwd,
    env: cliEnvironment(profile, provider), args: [provider, profile.executable, profile.cwd, profile.profileDir],
    signal, timeoutMs: 4000, limit: 4096 });
  return !result.failure && result.code === 0 && result.stdout.trim() === 'paperclip-cli-policy-v2:verified';
}

export function cliFailure(result) {
  return { outcome: result.unknown ? 'unknown' : result.failure === 'cli_cancelled' ? 'interrupted' : 'failed',
    reason: result.failure ?? 'cli_failed' };
}
