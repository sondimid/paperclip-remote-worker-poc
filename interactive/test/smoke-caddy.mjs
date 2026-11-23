// Explicit loopback smoke; not part of npm test. Requires the two cached images.
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { verifyCliFinal } from '../protocol.mjs';

const cliMode = process.argv.includes('--v2');
const wireVersion = cliMode ? 2 : 1;
const dir = mkdtempSync(join(tmpdir(), 'pc-wss-proxy-'));
const id = `pc-wss-smoke-${randomUUID().slice(0, 8)}`, network = `${id}-net`, proxy = `${id}-caddy`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (name, data) => { const path = join(dir, name); writeFileSync(path, data); return path; };
const compose = (...args) => docker('compose', '-p', id, '--env-file', join(dir, '.compose.wss.env'), '-f', join(dir, 'compose.wss.yaml'), ...args);
const scope = { companyId: randomUUID(), projectId: randomUUID(), agentId: randomUUID(), issueId: randomUUID(), workspaceId: 'interactive-sample' };
const worker = randomUUID(), bridge = randomUUID(), operator = randomUUID();
const caPath = join(dir, 'root.crt');
const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SYSTEMROOT|WINDIR|SYSTEMDRIVE|PATH|PATHEXT|COMSPEC|TEMP|TMP)$/i.test(key)));
let child, networkCreated = false, composeStarted = false, proxyStarted = false;

async function wait(probe, reason) {
  for (let i = 0; i < 45; i++) {
    const result = await probe();
    if (result) return result;
    await delay(120);
  }
  throw new Error(`Timed out: ${reason}`);
}

try {
  write('.compose.wss.env', `INTERACTIVE_PAPERCLIP_NETWORK=${network}\n`);
  write('.broker.wss.env', `INTERACTIVE_BINDING='${JSON.stringify({ ...scope, workerId: 'caddy-smoke' })}'\nINTERACTIVE_WORKER_TOKEN=${worker}\nINTERACTIVE_BRIDGE_TOKEN=${bridge}\nINTERACTIVE_OPERATOR_TOKEN=${operator}\nINTERACTIVE_WIRE_VERSION=${wireVersion}\n`);
  let composeFile = readFileSync(new URL('../compose.wss.yaml', import.meta.url), 'utf8').replace('127.0.0.1:3113:3113', '127.0.0.1::3113');
  if (cliMode) {
    // Use the cached image for Node/ws, but exercise the current V2 sources without replacing the image.
    const mounts = [
      ['broker.mjs', '../broker.mjs', 'interactive/broker.mjs'],
      ['protocol.mjs', '../protocol.mjs', 'interactive/protocol.mjs'],
      ['shared-protocol.mjs', '../../protocol.mjs', 'protocol.mjs'],
    ];
    for (const [name, source] of mounts) write(name, readFileSync(new URL(source, import.meta.url)));
    composeFile = composeFile.replace('    read_only: true', '    read_only: true\n    volumes:\n'
      + mounts.map(([name, , target]) => `      - './${name}:/opt/remote-worker-poc/${target}:ro'`).join('\n'));
  }
  write('compose.wss.yaml', composeFile);
  compose('config', '--quiet');
  docker('network', 'create', network);
  networkCreated = true;
  composeStarted = true;
  compose('up', '-d', '--wait', '--no-build', 'broker');
  const brokerAddr = compose('port', 'broker', '3113');
  assert.match(brokerAddr, /^127\.0\.0\.1:\d+$/);
  const conf = write('Caddyfile', '{\n  auto_https disable_redirects\n  skip_install_trust\n}\n'
    + readFileSync(new URL('../Caddyfile.wss.example', import.meta.url), 'utf8')
      .replace('worker.example.com {', 'https://localhost {\n\ttls internal')
      .replace('reverse_proxy 127.0.0.1:3113', 'reverse_proxy paperclip-interactive-wss-broker:3113'));
  docker('run', '-d', '--pull', 'never', '--name', proxy, '--network', network, '-p', '127.0.0.1::443',
    '--mount', `type=bind,src=${conf},dst=/etc/caddy/Caddyfile,readonly`, 'caddy:2.11.2-alpine');
  proxyStarted = true;
  const proxyBind = docker('port', proxy, '443/tcp');
  assert.match(proxyBind, /^127\.0\.0\.1:\d+$/);
  // Use the certificate's DNS name so the TLS client sends SNI for Caddy.
  const proxyAddr = proxyBind.replace('127.0.0.1', 'localhost');
  await wait(() => {
    try { docker('cp', `${proxy}:/data/caddy/pki/authorities/local/root.crt`, caPath); return true; }
    catch { return false; }
  }, 'Caddy test CA');
  const ca = readFileSync(caPath);
  const httpsStatus = (path, method, token) => new Promise((resolve, reject) => {
    const req = request(`https://${proxyAddr}${path}`, { ca, method, headers: { Authorization: `Bearer ${token}` }, timeout: 3000 }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('HTTPS probe timed out')));
    req.end();
  });
  const probeRunId = randomUUID();
  for (const [path, method, token] of [
    ['/health', 'GET', operator], ['/arm', 'POST', operator], ['/runs', 'POST', bridge],
    [`/runs/${probeRunId}/status`, 'GET', operator], [`/runs/${probeRunId}/events`, 'GET', bridge],
    [`/runs/${probeRunId}/interrupt`, 'POST', operator], ['/worker/connect', 'GET', worker],
    ...(cliMode ? [['/worker/status', 'GET', operator], ['/readiness?provider=codex', 'GET', bridge]] : []),
  ]) {
    assert.equal(await httpsStatus(path, method, token), 404, `${method} ${path}`);
  }
  const uri = `wss://${proxyAddr}/worker/connect`;
  const rejected = new WebSocket(uri, { ca, headers: { Authorization: `Bearer ${operator}` }, handshakeTimeout: 3000 });
  await assert.rejects(once(rejected, 'open', { signal: AbortSignal.timeout(3500) }), /401/);
  const workerEnv = write('.worker.wss.env', `INTERACTIVE_WORKER_URL=${uri}\nINTERACTIVE_WORKER_TOKEN=${worker}\nINTERACTIVE_WORKSPACE_PROFILE='${JSON.stringify({ issueId: scope.issueId, workspaceId: scope.workspaceId })}'\nINTERACTIVE_WORKER_CA_FILE='${caPath.replaceAll('\\', '/')}'\nINTERACTIVE_WIRE_VERSION=${wireVersion}\n`);
  child = fork(fileURLToPath(new URL('./fixtures/wss-worker.mjs', import.meta.url)), [],
    { execArgv: [`--env-file=${workerEnv}`], env: fixtureEnv, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const api = async (path, token, body) => {
    const res = await fetch(`http://${brokerAddr}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(2500),
    });
    return { status: res.status, value: await res.json() };
  };
  await wait(async () => (await api('/arm', operator, { issueId: scope.issueId })).status === 200, 'fixture worker ready through Caddy');
  if (cliMode) await wait(async () => (await api('/readiness?provider=codex', bridge)).value.dispatchable, 'Codex fixture capability ready');
  const results = [];
  for (const input of ['Caddy fixture one', 'Caddy fixture two']) {
    const runId = randomUUID();
    const provider = results.length ? null : 'codex';
    assert.equal((await api('/runs', bridge, { ...scope, runId, input, inputRef: randomUUID(), ...(cliMode && { provider }) })).status, 201);
    const result = await wait(async () => {
      const out = (await api(`/runs/${runId}/events?after=0`, bridge)).value;
      return out.state === 'completed' && out;
    }, 'fixture terminal');
    if (cliMode) {
      const parts = result.events.filter(event => event.type === 'final_part').map(event => Buffer.from(event.chunk, 'base64'));
      assert.equal(verifyCliFinal(parts, result.events.at(-1)), `${provider ? 'new' : 'resumed'}: ${input}`);
      assert.deepEqual(result.events.map(event => event.kind ?? event.outcome ?? event.type), ['started', 'delta', 'final_part', 'completed']);
    } else {
      assert.equal(result.result.text, input);
      assert.deepEqual(result.events.map(event => event.kind ?? event.outcome), ['started', 'delta', 'completed']);
    }
    results.push(result);
  }
  assert.equal(results[0].threadId, results[1].threadId);
  assert.notEqual(results[0].turnId, results[1].turnId);
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(3500) });
  child.disconnect();
  assert.deepEqual(await exited, [0, null]);
  child = undefined;
  console.log(`PASS: Caddy TLS, broker Compose V${wireVersion}, two fixture turns on one thread; operator token 401; ${cliMode ? 9 : 7} HTTP probes 404.`);
} catch (error) {
  if (error.stderr) console.error(error.stderr.trim());
  throw error;
} finally {
  child?.kill();
  const cleanup = [];
  const remove = fn => { try { fn(); } catch (error) { cleanup.push(error.message); } };
  if (proxyStarted) remove(() => docker('rm', '-fv', proxy));
  if (composeStarted) remove(() => compose('down'));
  if (networkCreated) remove(() => docker('network', 'rm', network));
  remove(() => rmSync(dir, { recursive: true, force: true }));
  if (cleanup.length) throw new Error(`Fixture cleanup failed: ${cleanup.join('; ')}`);
  console.log('Isolated smoke resources removed.');
}
