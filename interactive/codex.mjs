import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { once } from 'node:events';
import { verifyCodexLabSandbox } from './codex-lab-profile.mjs';

const providerId = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);
const maxLine = 1024 * 1024;

function threadStartDiagnostic(error) {
  const code = Number.isInteger(error?.code) && error.code >= -32768 && error.code <= -32000
    ? error.code : 'unknown';
  const message = typeof error?.message === 'string' ? error.message.slice(0, 4096) : '';
  // Chỉ xuất nhãn cố định; message/data/stderr của App Server không được đưa vào log.
  const hints = [
    ['rpc-field', /\b(?:unknown|unrecognized|unexpected|unsupported) field\b|deserializ/i],
    ['experimental-api', /experimental(?:\s+api|Api)|feature flag/i],
    ['permission-profile', /permission.{0,3}profile|named permissions|\bpermissions\b|default_permissions/i],
    ['windows-sandbox', /\b(?:mxc|sandbox|appcontainer)\b|container runner/i],
    ['workspace-path', /\bcwd\b|working directory|workspace path/i],
    ['configuration', /\b(?:config|toml)\b|configuration/i],
    ['local-access', /access (?:is )?denied|permission denied|os error|file not found/i],
    ['state-store', /\bsqlite\b|state (?:db|database)|rollout/i],
    ['authentication', /not logged in|unauthenticated|unauthorized|authentication/i],
  ].filter(([, pattern]) => pattern.test(message)).map(([label]) => label);
  return ` [rpc_code=${code}; hints=${hints.join(',') || 'unclassified'}]`;
}

export async function openCodexSession({ workspaceProfile, threadId, onEvent, diagnoseThreadStart = false, signal }) {
  signal?.throwIfAborted();
  const { executable, cwd, codexHome, environment = {}, fixtureArgs, permissionProfile } = workspaceProfile;
  if (![executable, cwd, codexHome].every(value => typeof value === 'string' && isAbsolute(value))
      || (threadId != null && !providerId(threadId)) || (!fixtureArgs && permissionProfile !== 'paperclip-fixture')) {
    throw new Error('Invalid local App Server profile');
  }
  // fixtureArgs chỉ được truyền in-process bởi test; không được đọc từ job hay CLI env-file.
  const args = fixtureArgs ?? ['app-server', '--strict-config', '--listen', 'stdio://'];
  const localEnv = permissionProfile ? {} : Object.fromEntries(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'LANG'].flatMap(key =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  const child = spawn(executable, args, { cwd, shell: false, windowsHide: true,
    env: { ...localEnv, ...environment, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume(); // Không chuyển stderr CLI hay credential vào log Paperclip.
  let pendingBytes = Buffer.alloc(0), nextId = 0, closed = false, current, resolvedThread;
  const pending = new Map();
  function fail() {
    if (closed) return;
    closed = true;
    for (const { finish } of pending.values()) finish(new Error('App Server connection lost'));
    if (current) onEvent({ kind: 'unknown' });
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  child.on('error', fail);
  child.on('exit', fail);
  child.stdin.on('error', fail);

  function write(message) {
    if (closed || !child.stdin.writable) throw new Error('App Server is not writable');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  function rpc(method, params, timeout = 4000) {
    if (closed) return Promise.reject(new Error('App Server is closed'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer);
        pending.delete(id);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error(`App Server response timed out: ${method}`)), timeout);
      pending.set(id, { finish, method });
      try { write({ id, method, params }); } catch (error) { finish(error); }
    });
  }
  function handleEvent({ method, params }) {
    if (!current || params?.threadId !== resolvedThread) return;
    const id = method === 'turn/completed' ? params.turn?.id : params.turnId;
    if (!['item/agentMessage/delta', 'item/completed', 'turn/completed'].includes(method) || !providerId(id)) return;
    if (!current.id) {
      if (current.early.length >= 32) return fail();
      current.early.push({ method, params });
      return;
    }
    if (id !== current.id) return;
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      onEvent({ kind: 'delta', threadId: resolvedThread, turnId: id, text: params.delta });
    } else if (method === 'item/completed' && params.item?.type === 'agentMessage'
      && typeof params.item.text === 'string' && params.item.phase !== 'commentary') {
      current.final = params.item.text;
    } else if (method === 'turn/completed') {
      const outcome = params.turn.status;
      const final = current.final;
      current = undefined;
      onEvent({ kind: 'terminal', threadId: resolvedThread, turnId: id,
        outcome: outcome === 'completed' ? (final === undefined ? 'unknown' : 'completed')
          : (['failed', 'interrupted'].includes(outcome) ? outcome : 'unknown'), text: outcome === 'completed' ? final ?? '' : '' });
    }
  }
  function receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid App Server response');
    if (Object.hasOwn(message, 'id') && typeof message.method === 'string') {
      // Không tự phê duyệt tool, nâng quyền hoặc input từ RPC ngoài hợp đồng.
      write({ id: message.id, error: { code: -32601, message: 'Server request not allowed by lab policy' } });
    } else if (Object.hasOwn(message, 'id')) {
      const request = pending.get(message.id);
      if (!request) return;
      if (Object.hasOwn(message, 'error') || !Object.hasOwn(message, 'result')) {
        const diagnostic = diagnoseThreadStart && request.method === 'thread/start' ? threadStartDiagnostic(message.error) : '';
        request.finish(new Error(`App Server RPC rejected: ${request.method}${diagnostic}`));
      } else request.finish(null, message.result);
    } else if (typeof message.method === 'string') {
      handleEvent(message);
    } else throw new Error('Invalid App Server message');
  }
  child.stdout.on('data', chunk => {
    if (closed) return;
    pendingBytes = Buffer.concat([pendingBytes, chunk]);
    let newline;
    while ((newline = pendingBytes.indexOf(10)) >= 0) {
      if (newline > maxLine) return fail();
      const line = pendingBytes.subarray(0, newline);
      pendingBytes = pendingBytes.subarray(newline + 1);
      try { receive(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))); } catch { return fail(); }
      if (closed) return;
    }
    if (pendingBytes.length > maxLine) fail();
  });

  async function close() {
    current = undefined;
    fail();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await once(child, 'exit', { signal: AbortSignal.timeout(1000) }).catch(() => {});
    }
    return !child.pid || child.exitCode !== null || child.signalCode !== null;
  }
  signal?.addEventListener('abort', fail, { once: true });
  try {
    signal?.throwIfAborted();
    await rpc('initialize', {
      clientInfo: { name: 'paperclip_interactive_lab', title: 'Paperclip Interactive Lab', version: '1.0.0' },
      ...(permissionProfile && { capabilities: { experimentalApi: true } }),
    });
    write({ method: 'initialized', params: {} });
    const policy = { cwd, approvalPolicy: 'never', ...(permissionProfile
      ? { permissions: permissionProfile } : { sandbox: 'read-only' }) };
    let result;
    try {
      result = await (threadId ? rpc('thread/resume', { threadId, excludeTurns: true, ...policy }) : rpc('thread/start', policy));
      resolvedThread = result?.thread?.id;
      if (!providerId(resolvedThread) || (threadId && resolvedThread !== threadId)) throw new Error('App Server thread mismatch');
    } catch (error) {
      if (threadId) error.code = 'codex_resume_unavailable';
      throw error;
    }
    if (permissionProfile) {
      if (result?.activePermissionProfile?.id !== permissionProfile || result.activePermissionProfile.extends !== null
          || result.approvalPolicy !== 'never') throw new Error('App Server thread policy mismatch');
      await verifyCodexLabSandbox(rpc, workspaceProfile);
      const { account } = await rpc('account/read', { refreshToken: false });
      if (account?.type !== 'chatgpt') {
        throw Object.assign(new Error('Dedicated Codex lab sign-in not confirmed'), { code: 'codex_auth_unverified' });
      }
    }
    signal?.throwIfAborted();
  } catch (error) {
    if (!await close() && signal) {
      throw Object.assign(new Error('App Server exit not confirmed'), { code: 'codex_cleanup_unverified' });
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', fail);
  }
  return {
    get threadId() { return resolvedThread; },
    async startTurn({ text, deadline }) {
      if (closed || current || deadline <= performance.now()) throw new Error('App Server is not ready for a turn');
      current = { early: [] };
      try {
        const result = await rpc('turn/start', { threadId: resolvedThread, input: [{ type: 'text', text }] },
          Math.min(4000, Math.max(1, Math.ceil(deadline - performance.now()))));
        const turnId = result?.turn?.id;
        if (!current || !providerId(turnId) || closed) throw new Error('Invalid turn identity');
        current.id = turnId;
        const early = current.early.splice(0);
        for (const event of early) handleEvent(event);
        return { turnId };
      } catch (error) {
        fail();
        throw error;
      }
    },
    async interruptTurn({ turnId }) {
      if (current?.id !== turnId || closed) throw new Error('No matching active turn');
      // RPC ACK khác terminal: caller chờ turn/completed đúng thread và turn.
      await rpc('turn/interrupt', { threadId: resolvedThread, turnId });
    },
    close,
  };
}
