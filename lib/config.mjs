import { readFile, stat, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
export const configPath = join(projectDir, 'bridge.local.json');
export const dataDir = join(projectDir, '.state');

export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('本地配置必须是 JSON 对象。');
  }
  const config = {
    mcpEndpoint: '', grokWebhookUrl: '', grokWebhookKey: '', callbackBaseUrl: '',
    callbackMode: 'relay', relayMasterToken: '', replyWaitMs: 90000, automaticWaitMode: 'bounded',
    listenHost: '127.0.0.1', listenPort: 18771,
    ...value,
  };
  for (const key of ['mcpEndpoint', 'grokWebhookUrl', 'grokWebhookKey', 'callbackBaseUrl', 'relayMasterToken']) {
    if (typeof config[key] !== 'string') throw new Error(`配置 ${key} 必须是字符串。`);
    config[key] = config[key].trim();
  }
  for (const [key, protocol] of [['mcpEndpoint', 'wss:'], ['grokWebhookUrl', 'https:'], ['callbackBaseUrl', 'https:']]) {
    if (!config[key]) continue;
    let url;
    try { url = new URL(config[key]); } catch { throw new Error(`配置 ${key} 的地址格式不正确。`); }
    if (url.protocol !== protocol || url.username || url.password || url.hash) {
      throw new Error(`配置 ${key} 必须使用 ${protocol}，不能含用户名、密码或片段。`);
    }
    if (key === 'callbackBaseUrl' && (url.search || !['', '/'].includes(url.pathname))) {
      throw new Error('callbackBaseUrl 请填写 HTTPS 根地址，不带查询参数或路径。');
    }
  }
  if (!['127.0.0.1', '::1'].includes(config.listenHost)) {
    throw new Error('回调服务仅允许监听本机回环地址；公网接入请使用 HTTPS 反向代理。');
  }
  if (!Number.isInteger(config.listenPort) || config.listenPort < 1024 || config.listenPort > 65535) {
    throw new Error('listenPort 必须是 1024 到 65535 的整数。');
  }
  if (/[\r\n]/.test(config.grokWebhookKey)) throw new Error('Grok webhook key 格式不正确。');
  if (!['relay', 'direct'].includes(config.callbackMode)) throw new Error('callbackMode 必须是 relay 或 direct。');
  if (config.relayMasterToken && !/^[A-Za-z0-9_-]{32,128}$/.test(config.relayMasterToken)) {
    throw new Error('relayMasterToken 必须是至少 32 字符的随机密钥。');
  }
  if (config.relayMasterToken && config.relayMasterToken === config.grokWebhookKey) {
    throw new Error('Cloudflare 中继密钥必须与 Grok webhook key 分开。');
  }
  if (!Number.isInteger(config.replyWaitMs) || config.replyWaitMs < 0 || config.replyWaitMs > 90000) {
    throw new Error('replyWaitMs 必须是 0 到 90000 的整数毫秒数。');
  }
  if (!['bounded', 'until_result'].includes(config.automaticWaitMode)) {
    throw new Error('automaticWaitMode 必须是 bounded 或 until_result。');
  }
  return config;
}

export async function loadConfig() {
  let contents;
  try { contents = await readFile(configPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return validateConfig({});
    throw new Error('无法读取 bridge.local.json。');
  }
  let value;
  try { value = JSON.parse(contents); } catch { throw new Error('bridge.local.json 不是有效 JSON；不会展示配置内容。'); }
  const config = validateConfig(value);
  const info = await stat(configPath);
  if ((info.mode & 0o077) !== 0) await chmod(configPath, 0o600);
  return config;
}

export function readiness(config) {
  return {
    mcpConfigured: Boolean(config.mcpEndpoint),
    grokConfigured: Boolean(config.grokWebhookUrl && config.grokWebhookKey),
    callbackConfigured: Boolean(config.callbackBaseUrl && (config.callbackMode !== 'relay' || config.relayMasterToken)),
  };
}
