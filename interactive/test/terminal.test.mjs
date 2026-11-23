import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, get } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import { createTerminalBroker } from '../terminal/broker.mjs';
import { terminalFrame, workerPath } from '../terminal/protocol.mjs';
import { readWorkerConfig, startTerminalWorker } from '../terminal/worker.mjs';

const workerId = 'terminal-fixture';
const workerToken = 'synthetic-terminal-worker-token';
const operatorToken = 'synthetic-terminal-operator-token';
const workerOptions = { headers: { Authorization: `Bearer ${workerToken}` } };
const spawned = { status: 'spawned', reason: null };
const operatorFile = fileURLToPath(new URL('../terminal/operator.mjs', import.meta.url));
const run = promisify(execFile);
const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(SYSTEMROOT|WINDIR|SYSTEMDRIVE|PATH|PATHEXT|COMSPEC|TEMP|TMP)$/i.test(key)));

async function until(check) {
  const deadline = performance.now() + 4000;
  do {
    const result = await check();
    if (result) return result;
    await delay(20);
  } while (performance.now() < deadline);
  assert.fail('Fixture condition not reached');
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `127.0.0.1:${server.address().port}`;
}

async function fixture(t, options = {}) {
  const available = spawnSync('openssl', ['version'], { stdio: 'ignore' });
  if (available.error?.code === 'ENOENT') { t.skip('OpenSSL is required for the temporary TLS fixture'); return; }
  assert.equal(available.status, 0);
  const dir = await mkdtemp(join(tmpdir(), 'terminal-wss-'));
  const certFile = join(dir, 'cert.pem');
  const keyFile = join(dir, 'key.pem');
  const connections = new Set();
  const stops = [];
  const servers = [];
  const dropConnections = () => { for (const socket of connections) socket.destroy(); };
  t.after(async () => {
    stops.forEach(stop => stop());
    dropConnections();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await rm(dir, { recursive: true, force: true });
  });
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyFile, '-out', certFile],
  { encoding: 'utf8', timeout: 8000 });
  assert.equal(generated.status, 0, generated.error?.message ?? generated.stderr);
  const ca = await readFile(certFile);
  const tls = createServer({ cert: ca, key: await readFile(keyFile) }, (_req, res) => res.writeHead(404).end());
  const broker = createTerminalBroker({ workerId, workerToken, operatorToken, ...options });
  let connectionCount = 0;
  tls.on('connection', socket => {
    connectionCount++;
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
  const upgrades = [];
  const defaultUpgrade = (req, socket, head) => broker.emit('upgrade', req, socket, head);
  let upgrade = defaultUpgrade;
  tls.on('upgrade', (req, socket, head) => { upgrades.push(req.url); upgrade(req, socket, head); });
  servers.push(broker, tls);
  const [httpAddr, tlsAddr] = await Promise.all([listen(broker), listen(tls)]);
  const workspace = join(dir, 'Dữ liệu có dấu cách');
  const other = join(dir, 'other');
  const link = join(dir, 'selected');
  await mkdir(workspace);
  await mkdir(other);
  await symlink(workspace, link, process.platform === 'win32' ? 'junction' : 'dir');
  const codex = join(dir, 'Codex fixture.exe');
  const claude = join(dir, 'Claude fixture.exe');
  await Promise.all([codex, claude].map(file => writeFile(file, 'fixture: never execute')));
  const base = `http://${httpAddr}`;
  const endpoint = `wss://${tlsAddr}${workerPath}`;
  const env = { TERMINAL_WORKER_URL: endpoint, TERMINAL_WORKER_ID: workerId, TERMINAL_WORKER_TOKEN: workerToken,
    TERMINAL_WORKER_CA_FILE: certFile, TERMINAL_CODEX_EXE: codex, TERMINAL_CLAUDE_EXE: claude,
    TERMINAL_WORKSPACES: JSON.stringify({ work: workspace, selected: link, spare: other }) };
  const api = async (path, body, token = operatorToken) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(4000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { code: response.status, value: await response.json() };
  };
  const list = () => api('/terminal/worker');
  const open = body => api('/terminal/open', body);
  const status = id => api(`/terminal/open/${id}`);
  const result = id => until(async () => {
    const { code, value } = await status(id);
    return code === 200 && value.status !== 'pending' && value;
  });
  const start = (launcher, overrides = {}, onReady) => {
    const stop = startTerminalWorker(readWorkerConfig({ ...env, ...overrides }), { launch: launcher, reconnectMs: 30, onReady });
    stops.push(stop);
    return stop;
  };
  return { dir, base, endpoint, tlsAddr, ca, api, list, open, status, result, start, env, workspace, other, link, codex, claude,
    upgrades, connectionCount: () => connectionCount, dropConnections, setUpgrade: fn => { upgrade = fn ?? defaultUpgrade; } };
}

const selection = (provider = 'codex', workspace = 'work') => ({ id: randomUUID(), provider, workspace });

function expectUpgradeRejection(url, options, code) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { ...options, handshakeTimeout: 2000 });
    ws.once('unexpected-response', (request, res) => {
      request.destroy();
      if (res.statusCode === code) resolve();
      else reject(new Error(`Unexpected upgrade status: ${res.statusCode}`));
    });
    ws.once('error', reject);
    ws.once('open', () => { ws.terminate(); reject(new Error('Upgrade was accepted')); });
  });
}

test('terminal selection through WSS launches only configured providers and local paths', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  if (!f) return;
  const calls = [];
  assert.equal((await f.open(selection())).value.error, 'worker_offline');
  assert.equal((await f.api('/terminal/worker', undefined, workerToken)).code, 401);
  assert.equal((await f.api('/arm', {})).code, 404);
  assert.equal((await f.api('/runs', {})).code, 404);
  for (const path of [workerPath, '/terminal/worker', '/terminal/open']) {
    const status = await new Promise((resolve, reject) => {
      get(`https://${f.tlsAddr}${path}`, { ca: f.ca, signal: AbortSignal.timeout(2000) }, res => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(status, 404);
  }
  await expectUpgradeRejection(f.endpoint, { ca: f.ca, headers: { Authorization: `Bearer ${operatorToken}` } }, 401);
  await expectUpgradeRejection(f.endpoint + '?extra=1', { ca: f.ca, ...workerOptions }, 404);
  f.start(async args => { calls.push(args); return spawned; });
  await until(async () => (await f.list()).value.online);
  assert.deepEqual((await f.list()).value, { workerId, online: true, providers: ['codex', 'claude'], workspaces: ['work', 'selected', 'spare'] });
  assert.equal(calls.length, 0, 'Handshake must not launch anything');
  for (const bad of [{ ...selection(), path: f.workspace }, { ...selection(), argv: [] }, selection('other'), selection('codex', 'unlisted')]) {
    assert.equal((await f.open(bad)).code, 400);
  }
  assert.equal(calls.length, 0);
  const req = selection();
  assert.equal((await f.open(req)).code, 202);
  assert.deepEqual(await f.result(req.id), { ...req, ...spawned });
  assert.equal((await f.open(req)).value.status, 'spawned');
  assert.equal((await f.open({ ...req, provider: 'claude' })).code, 409);
  const envFile = join(f.dir, '.operator.env');
  await writeFile(envFile, `TERMINAL_OPERATOR_URL=${f.base}/\nTERMINAL_OPERATOR_TOKEN=${operatorToken}\n`);
  const operator = (...args) => run(process.execPath, [`--env-file=${envFile}`, operatorFile, ...args], { env: fixtureEnv, timeout: 5000 });
  assert.deepEqual(JSON.parse((await operator('list')).stdout), (await f.list()).value);
  const opened = await operator('open', 'claude', 'selected');
  const [, id, body] = /^(?:Request ID: )([^\r\n]+)\r?\n([\s\S]+)$/.exec(opened.stdout);
  assert.equal(JSON.parse(body).id, id);
  await f.result(id);
  assert.equal(JSON.parse((await operator('status', id)).stdout).status, 'spawned');
  assert.deepEqual(calls, [
    { executable: realpathSync.native(f.codex), workspace: realpathSync.native(f.workspace) },
    { executable: realpathSync.native(f.claude), workspace: realpathSync.native(f.workspace) },
  ]);
  await rm(f.link);
  await symlink(f.other, f.link, process.platform === 'win32' ? 'junction' : 'dir');
  const redirected = selection('codex', 'selected');
  await f.open(redirected);
  assert.equal((await f.result(redirected.id)).reason, 'workspace_unavailable');
  await rm(f.other, { recursive: true });
  const missing = selection('codex', 'spare');
  await f.open(missing);
  assert.deepEqual(await f.result(missing.id), { ...missing, status: 'failed', reason: 'workspace_unavailable' });
  await rm(f.codex);
  const missingProvider = selection();
  await f.open(missingProvider);
  assert.equal((await f.result(missingProvider.id)).reason, 'provider_unavailable');
  assert.equal(calls.length, 2, 'Unavailable local paths must not fall back');
});

test('terminal disconnect and receipt timeout stay unknown without replay on reconnect', { timeout: 15000 }, async t => {
  const f = await fixture(t, { timeoutMs: 750 });
  if (!f) return;
  let launches = 0, ready = 0;
  const gates = [];
  f.start(() => { launches++; return new Promise(resolve => gates.push(resolve)); }, {}, () => { ready++; });
  await until(() => ready === 1);
  const first = selection();
  assert.equal((await f.open(first)).code, 202);
  await until(() => launches === 1);
  assert.equal((await f.open(first)).value.status, 'pending');
  assert.equal((await f.open(selection())).value.error, 'busy');
  f.dropConnections();
  assert.equal((await f.result(first.id)).reason, 'worker_disconnected');
  await until(() => ready === 2);
  gates.shift()(spawned);
  assert.equal((await f.open(first)).value.status, 'unknown');
  assert.equal(launches, 1);
  const second = selection();
  assert.equal((await f.open(second)).code, 202);
  await until(() => launches === 2);
  assert.deepEqual(await f.result(second.id), { ...second, status: 'unknown', reason: 'receipt_timeout' });
  gates.shift()(spawned);
  assert.equal((await f.open(second)).value.status, 'unknown');
  assert.equal(launches, 2);
});

test('terminal worker deduplicates in-flight open frames and rejects extra fields', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  if (!f) return;
  const wsServer = new WebSocketServer({ noServer: true });
  t.after(() => wsServer.close());
  let peer, release, launches = 0;
  const messages = [];
  f.setUpgrade((req, socket, head) => wsServer.handleUpgrade(req, socket, head, ws => {
    peer = ws;
    ws.on('message', raw => messages.push(JSON.parse(raw)));
  }));
  f.start(() => { launches++; return new Promise(resolve => { release = resolve; }); });
  await until(() => messages[0]?.type === 'hello');
  peer.send(terminalFrame('ready'));
  const req = selection();
  peer.send(terminalFrame('open', req));
  peer.send(terminalFrame('open', req));
  peer.send(terminalFrame('open', { ...req, provider: 'claude' }));
  await until(() => messages.some(message => message.reason === 'busy'));
  assert.equal(launches, 1);
  release(spawned);
  await until(() => messages.filter(message => message.status === 'spawned').length === 2);
  const closed = once(peer, 'close');
  peer.send(terminalFrame('open', { ...selection(), env: {} }));
  assert.equal((await closed)[0], 1008);
  assert.equal(launches, 1);
});

test('terminal client rejects plaintext, untrusted CA and redirects', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  if (!f) return;
  const launch = () => assert.fail('TLS misconfiguration must not launch');
  assert.throws(() => f.start(launch, { TERMINAL_WORKER_URL: f.endpoint.replace(/^wss:/, 'ws:') }));
  let ready = 0;
  const stopUntrusted = f.start(launch, { TERMINAL_WORKER_CA_FILE: '' }, () => { ready++; });
  await until(() => f.connectionCount() >= 2);
  stopUntrusted();
  assert.equal(f.upgrades.length, 0);
  f.setUpgrade((_req, socket) => socket.end('HTTP/1.1 302 Found\r\nLocation: /redirect-target\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  const stopRedirect = f.start(launch, {}, () => { ready++; });
  await until(() => f.upgrades.length >= 2);
  stopRedirect();
  assert(f.upgrades.every(path => path === workerPath));
  assert.equal(ready, 0);
});
