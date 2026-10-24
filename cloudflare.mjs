import { spawn } from 'node:child_process';
import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig, configPath, projectDir } from './lib/config.mjs';

process.umask(0o077);
const localDir = join(projectDir, '.local');
const wrangler = join(projectDir, 'node_modules/wrangler/bin/wrangler.js');
const workerConfig = join(projectDir, 'cloudflare/wrangler.jsonc');
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
  XDG_CONFIG_HOME: join(localDir, 'wrangler/config'),
  XDG_CACHE_HOME: join(localDir, 'wrangler/cache'),
  WRANGLER_LOG_PATH: join(localDir, 'wrangler/logs'),
  WRANGLER_SEND_METRICS: 'false',
  WRANGLER_SEND_ERROR_REPORTS: 'false',
  WRANGLER_NO_SKILLS_UPDATE_PROMPTS: 'true',
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
};

async function run(file, args, { input, capture = false } = {}) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd: projectDir, env,
      stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
    });
    let output = '';
    if (capture) {
      const take = chunk => {
        const text = String(chunk);
        output += text;
        process.stdout.write(input ? text.replaceAll(input.trim(), '[密钥已隐藏]') : text);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
    }
    if (input !== undefined) child.stdin.end(input);
    child.once('error', () => reject(new Error('无法运行本项目的 Cloudflare 官方工具。')));
    child.once('close', code => code === 0 ? resolveRun(output) : reject(new Error('Cloudflare 工具未完成操作；请检查上面的提示。')));
  });
}

async function ensureTools() {
  try { await access(wrangler, constants.R_OK); }
  catch { throw new Error('未找到项目依赖 Wrangler。请先在项目目录运行 npm install，再重试。'); }
  await mkdir(localDir, { recursive: true, mode: 0o700 });
  await chmod(localDir, 0o700);
  await mkdir(join(localDir, 'wrangler'), { recursive: true, mode: 0o700 });
}

async function saveCallbackUrl(callbackBaseUrl) {
  // Re-read after deployment so local edits made during browser authorization
  // are preserved. Never print either local credential.
  const config = await loadConfig();
  config.callbackBaseUrl = callbackBaseUrl;
  config.callbackMode = 'relay';
  const temporary = `${configPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, configPath);
  await chmod(configPath, 0o600);
  const template = await readFile(join(projectDir, 'grok-routine.txt'), 'utf8');
  await writeFile(join(localDir, 'grok-routine-ready.txt'), template.replaceAll('https://你的固定回调域名', callbackBaseUrl), { mode: 0o600 });
}

try {
  const command = process.argv[2] ?? 'prepare';
  await ensureTools();
  if (command === 'prepare') {
    await run(wrangler, ['--version']);
  } else if (command === 'login') {
    await run(wrangler, ['login', '--scopes',
      'account:read', 'user:read', 'workers:write', 'workers_scripts:write',
      'workers_routes:write']);
  } else if (command === 'whoami') {
    await run(wrangler, ['whoami']);
  } else if (command === 'check') {
    await run(wrangler, ['deploy', '--config', workerConfig, '--dry-run', '--outdir', join(localDir, 'cloudflare-build')]);
  } else if (command === 'deploy') {
    const config = await loadConfig();
    if (!config.relayMasterToken) throw new Error('尚未配置独立的中继密钥；请先完成本地配置。');
    const text = await readFile(workerConfig, 'utf8');
    const workerName = /"name"\s*:\s*"([a-z0-9-]+)"/.exec(text)?.[1];
    if (!workerName) throw new Error('无法确定本项目的 Worker 名称。');
    const output = await run(wrangler, ['deploy', '--config', workerConfig], { capture: true });
    const escaped = workerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const callbackUrl = new RegExp(`https://${escaped}\\.[a-z0-9-]+\\.workers\\.dev\\b`, 'i').exec(output)?.[0];
    if (!callbackUrl) throw new Error('Worker 已上传，但尚未取得 workers.dev 地址；请在控制台启用该地址后重跑部署。');
    await run(wrangler, ['secret', 'put', 'RELAY_MASTER_TOKEN', '--config', workerConfig], {
      input: `${config.relayMasterToken}\n`, capture: true,
    });
    await saveCallbackUrl(callbackUrl);
    process.stdout.write('固定回调地址已写入本地配置；已生成 .local/grok-routine-ready.txt。\n');
  } else {
    throw new Error('用法：./stackchan cloudflare prepare | login | check | deploy | whoami');
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
