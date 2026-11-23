import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { alias, frameBytes, maxRequests, maxWorkspaces, parseTerminalFrame, providers, removeExpired, retentionMs,
  sameSelection, terminalFrame, validToken, workerPath } from './protocol.mjs';

function localAbsolute(value) {
  return typeof value === 'string' && path.isAbsolute(value)
    && (process.platform !== 'win32' || /^[a-z]:[/\\][^:]*$/i.test(value));
}

function pin(value, executable) {
  if (!localAbsolute(value)) throw new Error('invalid_local_path');
  const target = realpathSync.native(value);
  if (!localAbsolute(target) || (executable ? !/\.exe$/i.test(target) || !statSync(target).isFile()
    : !statSync(target).isDirectory())) throw new Error('invalid_local_target');
  return { value, target };
}

function resolvePinned(pinned, executable) {
  if (!pinned) return;
  try {
    const { target } = pin(pinned.value, executable);
    if (target === pinned.target) return target;
  } catch { /* Missing or changed: do not substitute another path. */ }
}

export function readWorkerConfig(env) {
  const { TERMINAL_WORKER_URL, TERMINAL_WORKER_ID: workerId, TERMINAL_WORKER_TOKEN: token,
    TERMINAL_WORKER_CA_FILE: caFile, TERMINAL_WORKSPACES } = env;
  const url = new URL(TERMINAL_WORKER_URL);
  if (url.protocol !== 'wss:' || url.pathname !== workerPath || url.href !== url.origin + workerPath
    || !alias(workerId) || !validToken(token)) throw new Error('invalid_terminal_connection');
  const configured = JSON.parse(TERMINAL_WORKSPACES);
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) throw new Error('invalid_workspaces');
  const entries = Object.entries(configured);
  if (entries.length < 1 || entries.length > maxWorkspaces || entries.some(([name]) => !alias(name))) {
    throw new Error('invalid_workspace_aliases');
  }
  const workspaces = new Map(entries.map(([name, value]) => [name, pin(value, false)]));
  const executables = new Map();
  for (const provider of providers) {
    const value = env[`TERMINAL_${provider.toUpperCase()}_EXE`];
    if (value) executables.set(provider, pin(value, true));
  }
  if (!executables.size) throw new Error('no_terminal_provider');
  if (caFile && !localAbsolute(caFile)) throw new Error('invalid_ca_path');
  return { url, workerId, token, workspaces, executables, ca: caFile ? readFileSync(caFile) : undefined };
}

const launcher = fileURLToPath(new URL('./open-terminal.ps1', import.meta.url));

export function launchTerminal({ executable, workspace }) {
  const systemRoot = process.env.SystemRoot;
  if (process.platform !== 'win32' || !localAbsolute(systemRoot)) return Promise.resolve({ status: 'failed', reason: 'launcher_failed' });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(TERMINAL_|INTERACTIVE_|PAPERCLIP_)/i.test(name)));
  return new Promise(resolve => {
    const child = spawn(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', launcher, '-Executable', executable, '-Workspace', workspace],
      { shell: false, windowsHide: true, stdio: 'ignore', env });
    const timer = setTimeout(() => {
      resolve({ status: 'unknown', reason: 'launcher_timeout' });
      child.kill();
    }, 5000);
    const failed = { status: 'failed', reason: 'launcher_failed' };
    child.once('error', () => { clearTimeout(timer); resolve(failed); });
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code === 0 ? { status: 'spawned', reason: null } : failed);
    });
  });
}

export function startTerminalWorker(config, { launch = launchTerminal, onReady = () => {}, reconnectMs = 250 } = {}) {
  const { url, token, workerId, workspaces, executables, ca } = config;
  const inventory = { workerId, providers: [...executables.keys()], workspaces: [...workspaces.keys()] };
  const requests = new Map();
  let stopped = false, socket, retryTimer, delay = reconnectMs, launching = false;

  async function getReceipt(frame) {
    const now = performance.now();
    removeExpired(requests, now);
    const prior = requests.get(frame.id);
    if (prior) return sameSelection(prior, frame) ? prior.result : { status: 'failed', reason: 'busy' };
    if (requests.size >= maxRequests) return { status: 'failed', reason: 'busy' };
    const entry = { provider: frame.provider, workspace: frame.workspace, expiresAt: Infinity };
    requests.set(frame.id, entry);
    entry.result = (async () => {
      if (launching) return { status: 'failed', reason: 'busy' };
      const workspace = resolvePinned(workspaces.get(frame.workspace), false);
      if (!workspace) return { status: 'failed', reason: 'workspace_unavailable' };
      const executable = resolvePinned(executables.get(frame.provider), true);
      if (!executable) return { status: 'failed', reason: 'provider_unavailable' };
      launching = true;
      try { return await launch({ executable, workspace }); }
      catch { return { status: 'failed', reason: 'launcher_failed' }; }
      finally { launching = false; }
    })();
    const result = await entry.result;
    entry.expiresAt = performance.now() + retentionMs;
    return result;
  }

  function connect() {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, ca,
      rejectUnauthorized: true, followRedirects: false, handshakeTimeout: 4000, maxPayload: frameBytes, perMessageDeflate: false });
    socket = ws;
    let ready = false, watchdog;
    const armWatchdog = ms => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => ws.terminate(), ms);
    };
    const send = (type, fields) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(terminalFrame(type, fields), error => { if (error) ws.terminate(); });
    };
    ws.on('open', () => { armWatchdog(4500); send('hello', inventory); });
    ws.on('ping', () => { if (ready) armWatchdog(40_000); });
    ws.on('error', () => ws.terminate());
    ws.on('message', (raw, binary) => {
      if (stopped || ws.readyState !== WebSocket.OPEN) return;
      try {
        if (binary) throw new Error('binary_frame');
        const frame = parseTerminalFrame(raw, false);
        if (!ready && frame.type === 'ready') {
          ready = true;
          delay = reconnectMs;
          armWatchdog(40_000);
          onReady();
        } else if (ready && frame.type === 'open') {
          void getReceipt(frame).then(result => send('receipt', { id: frame.id, ...result }));
        } else throw new Error('unexpected_frame');
      } catch { ws.close(1008, 'protocol_rejected'); }
    });
    ws.once('close', () => {
      clearTimeout(watchdog);
      if (stopped) return;
      retryTimer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 15_000);
    });
  }
  connect();
  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    socket.terminate();
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.platform !== 'win32') throw new Error('windows_required');
    const config = readWorkerConfig(process.env);
    const stop = startTerminalWorker(config, { onReady: () => console.log('terminal_worker_ready') });
    console.log('Terminal worker connecting');
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch { console.error('Terminal worker requires Windows and valid local configuration'); process.exitCode = 1; }
}
