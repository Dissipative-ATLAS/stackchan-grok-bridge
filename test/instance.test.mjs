import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, lstat, chmod, rm, rename, symlink, mkdir, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireBridgeLock } from '../lib/instance.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'stackchan-lock-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, lockPath: join(dataDir, 'bridge.lock') };
}

test('kernel lock excludes another acquisition in the same Node process', async (t) => {
  const { dataDir, lockPath } = await fixture(t);
  const release = await acquireBridgeLock({ dataDir });
  t.after(release);
  const owner = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.match(owner.nonce, /^[\da-f-]{36}$/);
  await assert.rejects(acquireBridgeLock({ dataDir }), { code: 'BRIDGE_ALREADY_RUNNING' });
  await release();
  await release();
  assert.equal(await release.lost, null);
  assert.equal(await readFile(lockPath, 'utf8'), '');
  const secondRelease = await acquireBridgeLock({ dataDir });
  await secondRelease();
});

test('stale metadata and a reused PID do not block an unlocked inode', async (t) => {
  const { dataDir, lockPath } = await fixture(t);
  for (const pid of [2147483647, process.pid]) {
    await writeFile(lockPath, JSON.stringify({ pid, nonce: 'old-owner' }), { mode: 0o600 });
    const release = await acquireBridgeLock({ dataDir });
    assert.notEqual(JSON.parse(await readFile(lockPath, 'utf8')).nonce, 'old-owner');
    await release();
  }
});

test('concurrent stale-lock recovery elects exactly one holder', async (t) => {
  const { dataDir, lockPath } = await fixture(t);
  await writeFile(lockPath, JSON.stringify({ pid: 2147483647, nonce: 'stale' }), { mode: 0o600 });
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquireBridgeLock({ dataDir })));
  const owners = attempts.filter((result) => result.status === 'fulfilled');
  t.after(async () => { await Promise.all(owners.map((owner) => owner.value())); });
  assert.equal(owners.length, 1);
  for (const result of attempts.filter((item) => item.status === 'rejected')) {
    assert.equal(result.reason.code, 'BRIDGE_ALREADY_RUNNING');
  }
});

test('release cannot clear another nonce or unlink a replacement file', async (t) => {
  const { dataDir, lockPath } = await fixture(t);
  const release = await acquireBridgeLock({ dataDir });
  t.after(release);
  const replacement = JSON.stringify({ pid: process.pid, nonce: 'replacement' });
  await writeFile(lockPath, replacement);
  await release();
  assert.equal(await readFile(lockPath, 'utf8'), replacement);

  const nextRelease = await acquireBridgeLock({ dataDir });
  t.after(nextRelease);
  await rename(lockPath, join(dataDir, 'old-inode'));
  await writeFile(lockPath, replacement, { mode: 0o600 });
  await nextRelease();
  assert.equal(await readFile(lockPath, 'utf8'), replacement);
});

test('directories and stable lock files have private permissions', async (t) => {
  const { dataDir, lockPath } = await fixture(t);
  await chmod(dataDir, 0o755);
  await writeFile(lockPath, '', { mode: 0o666 });
  await chmod(lockPath, 0o666);
  const release = await acquireBridgeLock({ dataDir });
  t.after(release);
  assert.equal((await lstat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await lstat(lockPath)).mode & 0o777, 0o600);
});

test('symlink, hard-link, and non-file lock paths are refused without modifying their targets', async (t) => {
  const { dataDir, lockPath } = await fixture(t);
  const target = join(dataDir, 'private-target');
  await writeFile(target, 'preserve this', { mode: 0o600 });
  await symlink(target, lockPath);
  await assert.rejects(acquireBridgeLock({ dataDir }), { code: 'BRIDGE_LOCK_UNSAFE' });
  assert.equal(await readFile(target, 'utf8'), 'preserve this');
  await rm(lockPath);
  await link(target, lockPath);
  await assert.rejects(acquireBridgeLock({ dataDir }), { code: 'BRIDGE_LOCK_UNSAFE' });
  assert.equal(await readFile(target, 'utf8'), 'preserve this');
  await rm(lockPath);
  await mkdir(lockPath);
  await assert.rejects(acquireBridgeLock({ dataDir }), { code: 'BRIDGE_LOCK_UNSAFE' });
  assert.equal((await lstat(lockPath)).isDirectory(), true);
});

test('a symlink data directory is refused without changing the target permissions', async (t) => {
  const { dataDir } = await fixture(t);
  const real = join(dataDir, 'real');
  const alias = join(dataDir, 'alias');
  await mkdir(real, { mode: 0o755 });
  await symlink(real, alias);
  await assert.rejects(acquireBridgeLock({ dataDir: alias }), { code: 'BRIDGE_LOCK_UNSAFE' });
  assert.equal((await lstat(real)).mode & 0o777, 0o755);
});

test('parent exit closes its pipe and releases the lock without a manual stale-file reaper', async (t) => {
  const { dataDir, lockPath } = await fixture(t);
  const moduleUrl = new URL('../lib/instance.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireBridgeLock } from ${JSON.stringify(moduleUrl)};
    await acquireBridgeLock({ dataDir: process.argv[1] });
    process.stdout.write('locked\\n', () => process.exit(0));
  `, dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(exitCode, 0);
  assert.equal(output, 'locked\n');
  let release;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { release = await acquireBridgeLock({ dataDir }); break; }
    catch (error) {
      if (error.code !== 'BRIDGE_ALREADY_RUNNING') throw error;
      await delay(20);
    }
  }
  assert.ok(release, 'the orphaned helper must release its kernel lock');
  t.after(release);
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid);
});

test('invalid arguments and unavailable Python have fixed safe errors', async (t) => {
  const { dataDir } = await fixture(t);
  for (const value of [undefined, '', '\0']) {
    await assert.rejects(acquireBridgeLock({ dataDir: value }), { code: 'BRIDGE_LOCK_UNSAFE' });
  }
  await assert.rejects(acquireBridgeLock({ dataDir, pythonPath: '/nonexistent/stackchan-python' }),
    { code: 'BRIDGE_LOCK_UNAVAILABLE' });
});

test('unexpected helper exit reports lost ownership and remains safe to release', async (t) => {
  const { dataDir } = await fixture(t);
  const helper = join(dataDir, 'exiting-python');
  await writeFile(helper, '#!/usr/bin/python3\nimport os\nprint(\'{"ready":true}\', flush=True)\nos._exit(0)\n',
    { mode: 0o700 });
  const release = await acquireBridgeLock({ dataDir, pythonPath: helper });
  assert.equal((await release.lost).code, 'BRIDGE_LOCK_LOST');
  await release();
  await release();
});
