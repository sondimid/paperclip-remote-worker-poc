import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import tlsModule from 'node:tls';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createInteractiveBroker } from '../broker.mjs';

const workerFile = fileURLToPath(new URL('../worker.mjs', import.meta.url));
const fixtureFile = fileURLToPath(new URL('./fixtures/wss-worker.mjs', import.meta.url));
const workerPath = '/worker/connect';
// Không nạp secret hoặc trust override từ môi trường thật vào process test.
const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(SYSTEMROOT|WINDIR|SYSTEMDRIVE|PATH|PATHEXT|COMSPEC|TEMP|TMP)$/i.test(key)));

async function tempDir(t) {
  const path = await mkdtemp(join(tmpdir(), 'paperclip-wss-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function writeEnv(path, vars) {
  await writeFile(path, Object.entries(vars).map(([k, v]) => `${k}='${v}'`).join('\n') + '\n');
}

test('CLI isolates the WSS and fixed loopback modes before Codex preflight', async t => {
  const envFile = join(await tempDir(t), '.worker.env');
  for (const [mode, endpoint, expected] of [
    ['--codex-wss', 'ws://127.0.0.1:3113/worker/connect', /requires wss:/],
    ['--codex-wss', 'ws://worker.example.com/worker/connect', /Invalid worker endpoint/],
    ['--codex-wss', 'wss://worker.example.com/arm', /Invalid worker endpoint/],
    ['--codex-wss', 'wss://user:marker@worker.example.com/worker/connect', /Invalid worker endpoint/],
    ['--codex-wss', 'wss://worker.example.com/worker/connect?', /Invalid worker endpoint/],
    ['--codex-wss', 'wss://worker.example.com/worker/connect#', /Invalid worker endpoint/],
    ['--codex-wss', 'wss://worker.example.com/worker/connect', /Invalid Codex lab issue binding/],
    ['--codex-lab', 'wss://worker.example.com/worker/connect', /fixed loopback broker/],
    ['--codex-lab', 'ws://127.0.0.1:3113/worker/connect', /Invalid Codex lab issue binding/],
  ]) {
    await writeEnv(envFile, { INTERACTIVE_WORKER_URL: endpoint });
    const run = spawnSync(process.execPath, [`--env-file=${envFile}`, workerFile, mode], { env: fixtureEnv, encoding: 'utf8', timeout: 4000 });
    assert.equal(run.status, 1, run.error?.message);
    assert.match(run.stderr, expected);
    assert.doesNotMatch(run.stderr, /marker@/);
  }
});

test('lab certificate config fails before launching Codex in unsupported modes or with an invalid PEM', async t => {
  const dir = await tempDir(t);
  const file = join(dir, '.worker.env');
  const caFile = join(dir, 'invalid.pem');
  await writeFile(caFile, 'not a certificate');
  for (const [mode, endpoint, expected] of [
    ['--codex-lab', 'ws://127.0.0.1:3113/worker/connect', /requires --codex-wss/],
    ['--codex-wss', 'wss://worker.example.com/worker/connect', /Cannot load the WSS lab certificate/],
  ]) {
    await writeEnv(file, { INTERACTIVE_WORKER_URL: endpoint, INTERACTIVE_WORKER_TOKEN: 'synthetic-token'.repeat(3),
      INTERACTIVE_WORKSPACE_PROFILE: JSON.stringify({ issueId: randomUUID(), workspaceId: 'interactive-sample' }),
      INTERACTIVE_WORKER_CA_FILE: caFile.replaceAll('\\', '/') });
    const run = spawnSync(process.execPath, [`--env-file=${file}`, workerFile, mode], { env: fixtureEnv, encoding: 'utf8', timeout: 4000 });
    assert.equal(run.status, 1, run.error?.message);
    assert.match(run.stderr, expected);
    assert.doesNotMatch(run.stderr, /invalid\.pem/);
  }
});

test('prepare bootstraps a Windows profile and protects an existing profile', { skip: process.platform !== 'win32' }, async t => {
  const dir = await tempDir(t);
  for (const name of ['codex-lab-login.mjs', 'codex-lab-profile.mjs']) {
    await copyFile(new URL(`../${name}`, import.meta.url), join(dir, name));
  }
  await mkdir(join(dir, 'evidence'));
  const configPath = join(dir, 'evidence', '.codex-chat.env');
  const testEnv = join(dir, '.platform.env');
  const pathForEnv = path => path.replaceAll('\\', '/');
  await writeEnv(testEnv, { LOCALAPPDATA: pathForEnv(dir) });
  const prepare = () => spawnSync(process.execPath,
    [`--env-file=${testEnv}`, join(dir, 'codex-lab-login.mjs'), 'prepare'], { env: fixtureEnv, encoding: 'utf8', timeout: 4000 });
  const exe = pathForEnv(process.execPath); // Prepare must not execute it.
  await writeEnv(configPath, { INTERACTIVE_CODEX_EXE: exe, INTERACTIVE_CODEX_ROOT: pathForEnv(dir) });
  assert.equal(prepare().status, 2);
  await writeEnv(configPath, { INTERACTIVE_CODEX_EXE: exe, INTERACTIVE_CODEX_ROOT: '', INTERACTIVE_CODEX_WORKSPACE: '' });
  const first = prepare();
  assert.equal(first.status, 0, first.stderr);
  const config = await readFile(configPath, 'utf8');
  const root = JSON.parse(/^INTERACTIVE_CODEX_ROOT=(.+)$/m.exec(config)[1]);
  assert.equal((await readFile(join(root, 'fixture', 'fixture.txt'), 'utf8')).trim(), 'PAPERCLIP-CODEX-LAB');
  const second = prepare();
  assert.equal(second.status, 2);
  assert.match(second.stderr, /refusing to replace its profile/i);
  assert.equal(await readFile(configPath, 'utf8'), config);
});

test('TLS transport accepts only verified worker connections and keeps two turns on the same thread', { timeout: 30000 }, async t => {
  const available = spawnSync('openssl', ['version'], { stdio: 'ignore' });
  if (available.error?.code === 'ENOENT') { t.skip('OpenSSL CLI is needed for the temporary TLS fixture'); return; }
  assert.equal(available.status, 0);
  const dir = await tempDir(t);
  const certPath = join(dir, 'localhost.pem');
  const keyPath = join(dir, 'localhost-key.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath], { encoding: 'utf8', timeout: 8000 });
  assert.equal(generated.status, 0, generated.error?.message ?? generated.stderr);
  const cert = await readFile(certPath);
  const scope = { companyId: randomUUID(), projectId: randomUUID(), agentId: randomUUID(), issueId: randomUUID(), workspaceId: 'interactive-sample' };
  const workerToken = 'synthetic-worker-token-'.repeat(2);
  const bridgeToken = 'synthetic-bridge-token-'.repeat(2);
  const operatorToken = 'synthetic-operator-token-'.repeat(2);
  const broker = createInteractiveBroker({ workerBinding: { ...scope, workerId: 'wss-fixture', workerToken }, bridgeToken, operatorToken });
  const tls = createServer({ cert, key: await readFile(keyPath) }, (_req, res) => res.writeHead(404).end());
  const sockets = new Set();
  const children = new Set();
  let upgradeCount = 0;
  let redirectAttempts = 0;
  let redirectTarget = 0;
  let redirect = false;
  tls.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  tls.on('upgrade', (req, socket, head) => {
    upgradeCount++;
    if (!redirect) return broker.emit('upgrade', req, socket, head);
    if (req.url === '/redirect-target') redirectTarget++;
    else redirectAttempts++;
    socket.end('HTTP/1.1 302 Found\r\nLocation: /redirect-target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  t.after(async () => {
    for (const child of children) child.kill();
    for (const socket of sockets) socket.destroy();
    await Promise.all([tls, broker].map(server => new Promise(resolve => server.close(resolve))));
  });
  tls.listen(0, '127.0.0.1');
  broker.listen(0, '127.0.0.1');
  await Promise.all([once(tls, 'listening'), once(broker, 'listening')]);
  const url = `wss://127.0.0.1:${tls.address().port}${workerPath}`;
  const base = `http://127.0.0.1:${broker.address().port}`;
  const unrelatedCa = join(dir, 'unrelated.pem');
  await writeFile(unrelatedCa, tlsModule.rootCertificates[0]);
  let configNumber = 0;
  async function startClient({ endpoint = url, caFile = certPath, lowerTlsDefault = false } = {}) {
    const file = join(dir, `.worker-${++configNumber}.env`);
    await writeEnv(file, {
      INTERACTIVE_WORKER_URL: endpoint, INTERACTIVE_WORKER_TOKEN: workerToken,
      INTERACTIVE_WORKSPACE_PROFILE: JSON.stringify({ issueId: scope.issueId, workspaceId: scope.workspaceId }),
      ...(caFile ? { INTERACTIVE_WORKER_CA_FILE: caFile.replaceAll('\\', '/') } : {}),
      ...(lowerTlsDefault ? { NODE_TLS_REJECT_UNAUTHORIZED: '0' } : {}),
    });
    const child = fork(fixtureFile, [], { execArgv: [`--env-file=${file}`], env: fixtureEnv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.add(child);
    child.once('exit', () => children.delete(child));
    return child;
  }
  async function stopClient(child) {
    if (child.exitCode != null || child.signalCode != null) return;
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
    child.disconnect();
    assert.deepEqual(await exited, [0, null]);
  }
  async function request(path, token, body) {
    const res = await fetch(base + path, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(2000) });
    return { status: res.status, body: await res.json() };
  }
  async function until(probe) {
    for (let i = 0; i < 150; i++) {
      const result = await probe();
      if (result) return result;
      await delay(40);
    }
    throw new Error('Timed out waiting for TLS fixture');
  }
  const actor = { issueId: scope.issueId };
  for (const config of [{ caFile: null, lowerTlsDefault: true }, { caFile: unrelatedCa }, { endpoint: url.replace('127.0.0.1', 'localhost') }]) {
    const rejected = once(tls, 'tlsClientError', { signal: AbortSignal.timeout(6000) });
    const client = await startClient(config);
    await rejected;
    await stopClient(client);
    assert.equal(upgradeCount, 0);
  }
  for (const badToken of [bridgeToken, operatorToken, 'incorrect-worker-token']) {
    const client = new WebSocket(url, { ca: cert, headers: { Authorization: `Bearer ${badToken}` } });
    await assert.rejects(once(client, 'open', { signal: AbortSignal.timeout(3000) }), /401/);
  }
  redirect = true;
  const redirectedClient = await startClient();
  await until(() => redirectAttempts >= 2);
  await stopClient(redirectedClient);
  assert.equal(redirectTarget, 0);
  redirect = false;
  const worker = await startClient();
  try {
    await until(async () => (await request('/arm', operatorToken, actor)).status === 200);
    const turns = [];
    for (const input of ['first fixture turn', 'second fixture turn']) {
      const runId = randomUUID();
      const submitted = await request('/runs', bridgeToken, { ...scope, runId, inputRef: randomUUID(), input });
      assert.equal(submitted.status, 201);
      const events = await until(async () => {
        const page = await request(`/runs/${runId}/events?after=0`, bridgeToken);
        assert.equal(page.status, 200);
        return page.body.state === 'completed' && page.body.events;
      });
      assert.deepEqual(events.map(e => e.type === 'event' ? e.kind : e.outcome), ['started', 'delta', 'completed']);
      assert.equal(events.at(-1).text, input);
      turns.push(events.at(-1));
    }
    assert.equal(turns[0].threadId, turns[1].threadId);
    assert.notEqual(turns[0].turnId, turns[1].turnId);
  } finally { await stopClient(worker); }
});
