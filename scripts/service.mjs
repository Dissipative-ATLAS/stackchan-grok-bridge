#!/usr/bin/env node
// Run with the same Node 22+ used by ./stackchan. `prepare` only writes inside
// this project; install/uninstall change this user's single LaunchAgent.
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const label = 'local.stackchan.grokbridge';
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const stateDir = join(projectDir, '.state');
const serviceLogDir = join(homedir(), 'Library', 'Logs', 'StackchanGrokBridge');
const preparedDir = join(projectDir, '.local', 'launchd');
const preparedPath = join(preparedDir, `${label}.plist`);
const agentsDir = join(homedir(), 'Library', 'LaunchAgents');
const installedPath = join(agentsDir, `${label}.plist`);
const uid = process.getuid?.();
const domain = `gui/${uid}`;
const serviceTarget = `${domain}/${label}`;
const log = message => process.stdout.write(`${message}\n`);

function run(file, args, { allowFailure = false } = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw new Error(`无法执行 ${file}。`);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${file} 操作失败（退出码 ${result.status ?? 'unknown'}）。`);
  }
  return result;
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function plistSource() {
  const nodePath = await realpath(process.execPath);
  await access(nodePath, constants.X_OK);
  await access(join(projectDir, 'bridge.mjs'), constants.R_OK);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(join(projectDir, 'bridge.mjs'))}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(homedir())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(join(serviceLogDir, 'service.stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(serviceLogDir, 'service.stderr.log'))}</string>
</dict>
</plist>
`;
}

async function prepare() {
  await mkdir(preparedDir, { recursive: true, mode: 0o700 });
  const temporary = `${preparedPath}.tmp`;
  await writeFile(temporary, await plistSource(), { mode: 0o600 });
  await chmod(temporary, 0o600);
  try {
    run('/usr/bin/plutil', ['-lint', temporary]);
    await rename(temporary, preparedPath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  log(`模板已生成并通过 plutil：${preparedPath}`);
  return preparedPath;
}

function serviceState() {
  const result = run('/bin/launchctl', ['print', serviceTarget], { allowFailure: true });
  if (result.status !== 0) {
    if (/could not find service|service could not be found|no such (?:process|service)/i.test(`${result.stdout}\n${result.stderr}`)) return { loaded: false };
    throw new Error('无法确认该 LaunchAgent 是否已加载，已停止操作。');
  }
  return {
    loaded: true,
    state: result.stdout.match(/^\s*state = (.+)$/m)?.[1]?.trim() ?? 'unknown',
    pid: Number(result.stdout.match(/^\s*pid = (\d+)$/m)?.[1]) || null,
    plistPath: result.stdout.match(/^\s*path = (.+)$/m)?.[1]?.trim() ?? null,
  };
}

// Never print ps output: only expose candidate PIDs. This deliberately errs on
// the side of refusing install if another bridge.mjs start process is present.
async function activeBridgePids() {
  const result = run('/bin/ps', ['-axo', 'pid=,command=']);
  const pids = new Set();
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match || Number(match[1]) === process.pid) continue;
    if (/(?:^|[\s/])bridge\.mjs["']?\s+start(?:\s|$)/.test(match[2])) pids.add(Number(match[1]));
  }
  // Also honor the state file if a process cannot be identified from ps.
  try {
    const runtime = JSON.parse(await readFile(join(stateDir, 'runtime.json'), 'utf8'));
    if (!runtime.stopped && Number.isInteger(runtime.pid) && runtime.pid > 0) {
      try { process.kill(runtime.pid, 0); pids.add(runtime.pid); }
      catch (error) { if (error.code === 'EPERM') pids.add(runtime.pid); }
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return [...pids].sort((a, b) => a - b);
}

async function validateInstalledLabel() {
  if (!await exists(installedPath)) return false;
  const result = run('/usr/bin/plutil', ['-extract', 'Label', 'raw', '-o', '-', installedPath], { allowFailure: true });
  if (result.status !== 0 || result.stdout.trim() !== label) {
    throw new Error('目标 plist 的 Label 无法确认，已拒绝覆盖或删除。');
  }
  return true;
}

async function ownsNewPlist(created, source) {
  try {
    const current = await lstat(installedPath);
    if (!current.isFile() || current.dev !== created.dev || current.ino !== created.ino) return false;
    const contents = await readFile(installedPath);
    // A write failure may leave only the prefix written by this transaction.
    // Once complete, require the whole validated plist to remain unchanged.
    return created.complete ? contents.equals(source)
      : contents.length <= source.length && contents.equals(source.subarray(0, contents.length));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function rollbackInstall(created, source, bootstrapAttempted) {
  if (!await ownsNewPlist(created, source)) throw new Error('本次 plist 已被替换或修改，已保留现场，未删除文件或停止服务。');
  let service = serviceState();
  if (service.loaded) {
    if (service.plistPath !== installedPath) {
      // Another job won the label race. Its different plist is never touched.
      if (!await ownsNewPlist(created, source)) throw new Error('本次 plist 已变化，未删除。');
      await unlink(installedPath);
      return '已撤销本次 plist；同名的其他服务未被停止。';
    }
    if (!bootstrapAttempted) throw new Error('该 plist 已由其他操作加载，已保留，未停止服务。');
    // bootstrap can load successfully even if its caller sees an error. Only
    // stop a job demonstrably loaded from our unchanged, newly created plist.
    run('/bin/launchctl', ['bootout', serviceTarget], { allowFailure: true });
    service = serviceState();
    if (service.loaded) throw new Error('本次服务仍在加载，已保留 plist，未删除运行中的服务文件。');
  }
  if (!await ownsNewPlist(created, source)) throw new Error('本次 plist 已变化，未删除。');
  await unlink(installedPath);
  return '已撤销本次安装文件。';
}

async function install() {
  const service = serviceState();
  if (service.loaded) throw new Error(`该服务已加载（PID ${service.pid ?? '尚未启动'}）；请先运行 uninstall，再安装。`);
  const pids = await activeBridgePids();
  if (pids.length) {
    throw new Error(`发现活动中转进程 PID ${pids.join(', ')}。请先核验并正常停止本项目的手动中转，再运行 install；本脚本不会替你停止这些进程。`);
  }
  if (await validateInstalledLabel()) throw new Error('安装位置已有同名 plist；请先运行 uninstall，再安装。');
  const source = await prepare();
  const contents = await readFile(source);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(agentsDir, { recursive: true, mode: 0o700 });
  await mkdir(serviceLogDir, { recursive: true, mode: 0o700 });
  // Exclusive creation prevents overwriting a plist installed after our check.
  const handle = await open(installedPath, 'wx', 0o600);
  let created;
  let bootstrapAttempted = false;
  try {
    const identity = await handle.stat();
    created = { dev: identity.dev, ino: identity.ino, complete: false };
    await handle.writeFile(contents);
    created.complete = true;
    await handle.close();
    run('/bin/launchctl', ['enable', serviceTarget]);
    bootstrapAttempted = true;
    run('/bin/launchctl', ['bootstrap', domain, installedPath]);
    const loaded = serviceState();
    if (!loaded.loaded || loaded.plistPath !== installedPath) throw new Error('安装后未确认服务从本次 plist 加载。');
  } catch (error) {
    await handle.close().catch(() => {});
    if (!created) throw new Error(`${error.message} 本次文件身份未确认，已保留现场。`);
    let rollback;
    try { rollback = await rollbackInstall(created, contents, bootstrapAttempted); }
    catch (rollbackError) { throw new Error(`${error.message} 回滚未完成：${rollbackError.message}`); }
    throw new Error(`${error.message} ${rollback}`);
  }
  log('登录常驻服务已安装；登录后启动，退出后由 launchd 重启。');
  log(`日志：${join(serviceLogDir, 'service.stdout.log')} 和 ${join(serviceLogDir, 'service.stderr.log')}`);
  await status();
}

async function uninstall() {
  const hasFile = await validateInstalledLabel();
  const service = serviceState();
  if (service.loaded) run('/bin/launchctl', ['bootout', serviceTarget]);
  if (hasFile) await unlink(installedPath);
  log(service.loaded || hasFile ? '该常驻服务已卸载；本地配置、任务和日志保留。' : '该常驻服务未安装。');
}

async function status() {
  const service = serviceState();
  const hasFile = await validateInstalledLabel();
  log(`服务 ${label}：${service.loaded ? `已加载，${service.state}，PID ${service.pid ?? '无'}` : '未加载'}；plist ${hasFile ? '已安装' : '未安装'}。`);
  const active = await activeBridgePids();
  log(`检测到的中转 PID：${active.join(', ') || '无'}。`);
  log('该服务依赖当前用户登录、Mac 保持唤醒和联网，以及项目目录可用；若项目位于外置磁盘，需保持挂载。');
}

try {
  if (process.platform !== 'darwin' || !Number.isInteger(uid)) throw new Error('该脚本仅支持 macOS 当前用户的 LaunchAgent。');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或以上。');
  switch (process.argv[2]) {
    case 'prepare': await prepare(); break;
    case 'install': await install(); break;
    case 'uninstall': await uninstall(); break;
    case 'status': await status(); break;
    default:
      log('用法：node scripts/service.mjs prepare | install | uninstall | status');
      log('prepare 仅生成工作区内模板并校验；install/uninstall 会变更当前用户的 LaunchAgent。');
      process.exitCode = process.argv[2] ? 1 : 0;
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
