import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { labCodexConfig, quoteLabPath, readCodexLabProfile } from './codex-lab-profile.mjs';

// Chạy ở PowerShell của người dùng để profile nằm trên máy thật, không ở filesystem sandbox của shell công cụ.
const action = process.argv[2];
if (action === 'prepare') {
  const envFile = fileURLToPath(new URL('./evidence/.codex-chat.env', import.meta.url));
  try {
    const hostLocal = process.env.LOCALAPPDATA;
    const { INTERACTIVE_CODEX_EXE: exe, INTERACTIVE_CODEX_ROOT: oldRoot, INTERACTIVE_CODEX_WORKSPACE: oldCwd, ...extra }
      = parseEnv(readFileSync(envFile, 'utf8'));
    if (process.platform !== 'win32' || !hostLocal || !isAbsolute(hostLocal) || !exe || !isAbsolute(exe) || !existsSync(exe)
        || Object.keys(extra).length || Boolean(oldRoot) !== Boolean(oldCwd)) {
      throw new Error('Expected the lab-only env-file with a local Codex executable and both profile paths set or blank');
    }
    if (oldRoot) {
      if (!isAbsolute(oldRoot) || !isAbsolute(oldCwd) || !/^Paperclip-Codex-Chat-[^\\/]+$/.test(resolve(oldRoot).split(/[\\/]/).at(-1))
          || resolve(dirname(oldRoot)).toLowerCase() !== resolve(hostLocal).toLowerCase()
          || resolve(oldCwd).toLowerCase() !== join(resolve(oldRoot), 'fixture').toLowerCase()) {
        throw new Error('Expected dedicated profile paths under local Windows app-data');
      }
      if (existsSync(oldRoot) || existsSync(oldCwd)) {
        throw new Error('Existing lab directory is accessible; refusing to replace its profile');
      }
    }
    const root = mkdtempSync(join(hostLocal, 'Paperclip-Codex-Chat-'));
    const fixture = join(root, 'fixture');
    const home = join(root, 'profile');
    mkdirSync(fixture);
    mkdirSync(home);
    for (const name of ['Local', 'Roaming']) mkdirSync(join(root, 'test-user', 'AppData', name), { recursive: true });
    writeFileSync(join(fixture, 'fixture.txt'), 'PAPERCLIP-CODEX-LAB\n', { flag: 'wx' });
    writeFileSync(join(home, 'config.toml'), labCodexConfig(fixture), { flag: 'wx' });
    const staged = `${envFile}.${process.pid}.tmp`;
    writeFileSync(staged, `INTERACTIVE_CODEX_EXE=${quoteLabPath(exe)}\nINTERACTIVE_CODEX_ROOT=${quoteLabPath(root)}\nINTERACTIVE_CODEX_WORKSPACE=${quoteLabPath(fixture)}\n`, { flag: 'wx' });
    renameSync(staged, envFile);
    console.log('Prepared the dedicated Codex lab profile on this Windows host. No login started.');
  } catch (error) {
    console.error(`Codex lab setup stopped: ${error.code ?? error.message}`);
    process.exitCode = 2;
  }
  process.exit(process.exitCode ?? 0);
}

// Profile này chỉ dùng đăng nhập chính thức cho lab; không mở worker hoặc chạy turn.
const { INTERACTIVE_CODEX_EXE: executable, INTERACTIVE_CODEX_ROOT: root, INTERACTIVE_CODEX_WORKSPACE: cwd } = process.env;
const paths = { INTERACTIVE_CODEX_EXE: executable, INTERACTIVE_CODEX_ROOT: root, INTERACTIVE_CODEX_WORKSPACE: cwd };
const errors = [];
if (process.platform !== 'win32') errors.push(`Windows Node required (found ${process.platform})`);
if (!['login', 'status'].includes(action)) errors.push('expected login or status argument');
for (const [name, value] of Object.entries(paths)) {
  if (!value) errors.push(`${name} missing from env-file`);
  else if (!isAbsolute(value)) errors.push(`${name} is not an absolute path`);
  else if (!existsSync(value)) errors.push(`${name} not accessible`);
}
if (!errors.length) {
  if (!existsSync(join(root, 'profile', 'config.toml'))) errors.push('lab profile config.toml not accessible');
  if (!existsSync(join(root, 'test-user', 'AppData', 'Local'))) errors.push('lab user AppData not accessible');
}
if (errors.length) {
  console.error(`Codex lab profile: ${errors.join('; ')}. Default Codex home will not be used.`);
  process.exit(2);
}
try {
  const { environment } = readCodexLabProfile();
  const result = spawnSync(executable, ['login', action === 'login' ? '--device-auth' : 'status'], {
    cwd, env: environment, shell: false, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) console.error('Could not start the installed Codex login command.');
  process.exitCode = result.status ?? 2;
} catch {
  console.error('Dedicated Codex profile validation failed. Default Codex home will not be used.');
  process.exitCode = 2;
}
