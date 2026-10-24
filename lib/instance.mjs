import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const helperPath = fileURLToPath(new URL('../scripts/bridge-lock.py', import.meta.url));
const messages = {
  BRIDGE_ALREADY_RUNNING: '已有中转进程正在使用此状态目录。',
  BRIDGE_LOCK_UNSAFE: '中转锁目录或文件不是当前用户拥有的普通私有路径。',
  BRIDGE_LOCK_UNAVAILABLE: '无法取得中转进程锁。',
  BRIDGE_LOCK_LOST: '中转进程锁已意外释放；必须停止当前中转。',
};

function lockError(code) {
  return Object.assign(new Error(messages[code] || messages.BRIDGE_LOCK_UNAVAILABLE), {
    code: Object.hasOwn(messages, code) ? code : 'BRIDGE_LOCK_UNAVAILABLE',
  });
}

// The stable file is never unlinked: flock belongs to its inode. A dedicated
// helper holds the lock until this process closes its pipe (including a crash).
export async function acquireBridgeLock({ dataDir, pythonPath = process.env.STACKCHAN_PYTHON || '/usr/bin/python3' } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.includes('\0') ||
      typeof pythonPath !== 'string' || !isAbsolute(pythonPath) || pythonPath.includes('\0')) {
    throw lockError('BRIDGE_LOCK_UNSAFE');
  }
  const directory = resolve(dataDir);
  try { await mkdir(directory, { recursive: true, mode: 0o700 }); }
  catch { throw lockError('BRIDGE_LOCK_UNAVAILABLE'); }

  const child = spawn(pythonPath, ['-I', helperPath, directory, String(process.pid), randomUUID()], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  // A close/error can race an attempted release after the helper has exited.
  child.stdin.on('error', () => {});
  let releasing = false;
  let ready = false;
  let releasePromise;
  let settleLost;
  const lost = new Promise((resolveLost) => { settleLost = resolveLost; });
  let closed;
  const exited = new Promise((resolveExit) => {
    child.once('close', () => {
      closed = true;
      settleLost(ready && !releasing ? lockError('BRIDGE_LOCK_LOST') : null);
      resolveExit();
    });
  });

  try {
    await new Promise((resolveReady, rejectReady) => {
      let response = '';
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        if (error) rejectReady(error);
        else { ready = true; resolveReady(); }
      };
      const onData = (chunk) => {
        response += chunk.toString('utf8');
        if (response.length > 256) return finish(lockError('BRIDGE_LOCK_UNAVAILABLE'));
        if (!response.includes('\n')) return;
        let result;
        try { result = JSON.parse(response.slice(0, response.indexOf('\n'))); }
        catch { return finish(lockError('BRIDGE_LOCK_UNAVAILABLE')); }
        finish(result.ready === true ? null : lockError(result.code));
      };
      const timer = setTimeout(() => finish(lockError('BRIDGE_LOCK_UNAVAILABLE')), 5000);
      child.stdout.on('data', onData);
      child.once('error', () => finish(lockError('BRIDGE_LOCK_UNAVAILABLE')));
      child.once('close', () => finish(lockError('BRIDGE_LOCK_UNAVAILABLE')));
    });
  } catch (error) {
    releasing = true;
    child.stdin.end();
    if (!closed) child.kill();
    await exited;
    throw error;
  }

  const release = () => {
    if (!releasePromise) {
      releasing = true;
      child.stdin.end();
      releasePromise = exited;
    }
    return releasePromise;
  };
  // Resolve rather than reject, so startup code can subscribe without risking
  // an unhandled rejection. A non-null result requires shutting the bridge down.
  release.lost = lost;
  return release;
}
