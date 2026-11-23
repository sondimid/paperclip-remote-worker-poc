import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const permissionProfile = 'paperclip-fixture';
const systemKeys = new Set(['SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'PROGRAMDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']);
const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
export const quoteLabPath = path => JSON.stringify(path.replaceAll('\\', '/'));

export function labCodexConfig(fixture) {
  return `default_permissions = "${permissionProfile}"
approval_policy = "never"
cli_auth_credentials_store = "file"
web_search = "disabled"

[analytics]
enabled = false

[windows]
sandbox = "mxc"

[permissions.${permissionProfile}.filesystem]
":root" = "deny"
":minimal" = "read"
${quoteLabPath(fixture)} = "read"
${quoteLabPath(process.execPath)} = "read"

[permissions.${permissionProfile}.network]
enabled = false
`;
}

export function readCodexLabProfile(env = process.env) {
  const { INTERACTIVE_CODEX_EXE: executable, INTERACTIVE_CODEX_ROOT: root,
    INTERACTIVE_CODEX_WORKSPACE: cwd, LOCALAPPDATA: hostLocal } = env;
  if (process.platform !== 'win32' || ![executable, root, cwd, hostLocal].every(p => p && isAbsolute(p) && existsSync(p))
      || !basename(root).startsWith('Paperclip-Codex-Chat-') || !samePath(dirname(root), hostLocal)
      || !samePath(cwd, join(root, 'fixture')) || !samePath(realpathSync(cwd), cwd)) {
    throw new Error('Dedicated Windows Codex profile is not accessible; default home will not be used');
  }
  const codexHome = join(root, 'profile');
  const user = join(root, 'test-user');
  const local = join(user, 'AppData', 'Local'), roaming = join(user, 'AppData', 'Roaming');
  if (![root, codexHome, local, roaming].every(p => existsSync(p) && samePath(realpathSync(p), p))) {
    throw new Error('Dedicated Codex lab paths changed');
  }
  const configured = readFileSync(join(codexHome, 'config.toml'), 'utf8').split('\n');
  const expected = labCodexConfig(cwd).split('\n');
  const pathRules = new Set([cwd, process.execPath].map(p => `${quoteLabPath(p)} = "read"`));
  if (configured.length !== expected.length || expected.some((line, i) => pathRules.has(line)
    ? line.toLowerCase() !== configured[i].toLowerCase() : line !== configured[i])) {
    throw new Error('Dedicated Codex lab policy differs from the fixture template for this Node executable');
  }
  return { executable, cwd, codexHome, permissionProfile, environment: {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => systemKeys.has(key.toUpperCase()))),
    CODEX_HOME: codexHome, HOME: user, USERPROFILE: user, LOCALAPPDATA: local, APPDATA: roaming,
  } };
}

// Probe cố định; không có input của issue, credential hoặc tên đường dẫn cá nhân do broker cung cấp.
export async function verifyCodexLabSandbox(rpc, { cwd, codexHome, permissionProfile: profile }) {
  const nonce = randomUUID();
  const marker = join(codexHome, `.lab-probe-${nonce}`);
  const target = join(cwd, `.lab-probe-${nonce}`);
  const server = createServer(socket => socket.destroy());
  await writeFile(marker, 'synthetic-only', { flag: 'wx' });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const probe = `const fs=require('node:fs'),net=require('node:net');
      const [fixture,outside,target,port]=process.argv.slice(1);
      const attempt=f=>{try{return f()}catch(e){return e.code}};
      const result={read:attempt(()=>fs.readFileSync(fixture,'utf8').trim()==='PAPERCLIP-CODEX-LAB'),
        outside:attempt(()=>{fs.readFileSync(outside);return 'allowed'}),
        write:attempt(()=>{fs.writeFileSync(target,'probe',{flag:'wx'});return 'allowed'})};
      const socket=net.connect({host:'127.0.0.1',port:Number(port)});
      const report=net=>{console.log(JSON.stringify({...result,net}));socket.destroy()};
      socket.on('connect',()=>report('allowed'));socket.on('error',e=>report(e.code));
      socket.setTimeout(1300,()=>report('timeout'));`;
    const result = await rpc('command/exec', { cwd, permissionProfile: profile, timeoutMs: 4500,
      command: [process.execPath, '-e', probe, join(cwd, 'fixture.txt'), marker, target, String(server.address().port)] }, 6500);
    const observed = JSON.parse(result?.stdout ?? 'null');
    const denied = code => ['EACCES', 'EPERM'].includes(code);
    if (result?.exitCode !== 0 || observed?.read !== true || !denied(observed.outside) || !denied(observed.write)
        || !denied(observed.net) || existsSync(target)) throw new Error('App Server sandbox probe did not prove required isolation');
  } finally {
    server.close();
    await rm(marker, { force: true });
    await rm(target, { force: true });
  }
}
