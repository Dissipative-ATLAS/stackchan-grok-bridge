import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, readiness, dataDir } from './lib/config.mjs';
import { createCallbackServer } from './lib/http.mjs';
import { acquireBridgeLock } from './lib/instance.mjs';

const runtimePath = join(dataDir, 'runtime.json');
const BRIDGE_VERSION = '0.4.1';
const BRIDGE_TOOLS = new Set(['ask_grok_bot', 'check_grok_task', 'cancel_grok_wait']);
const SAFE_RPC_METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call', 'notifications/initialized']);
function automaticWaitMode(config) {
  return config.replyWaitMs > 0 ? config.automaticWaitMode : 'bounded';
}
function print(value) { process.stdout.write(`${value}\n`); }
const label = value => value ? '已配置' : '待配置';

async function doctor() {
  const config = await loadConfig();
  const ready = readiness(config);
  print(`Node ${process.version}`);
  print(`Stackchan MCP：${label(ready.mcpConfigured)}`);
  print(`Grok Bot webhook：${label(ready.grokConfigured)}`);
  print(`Grok 结果 HTTPS 回调：${label(ready.callbackConfigured)}`);
  print(`回调方式：${config.callbackMode === 'relay' ? 'Cloudflare 中继，Mac 主动取回结果' : '本机 HTTPS 反向代理回调'}`);
  print(automaticWaitMode(config) === 'until_result'
    ? '本轮自动等待 Grok 回复：无总时长或续查次数上限；单次工具等待最多 4.5 秒。说“停止等待格洛克”可停止本机等待，不撤销 Bot 任务。'
    : `本轮自动等待 Grok 回复：最多 ${Math.round(config.replyWaitMs / 1000)} 秒，最多 12 次续查；单次工具等待最多 4.5 秒。`);
  print('自动续查通过原厂云的当前会话完成。');
  print('原厂固件、模型、音色和唤醒词由设备继续管理。');
  if (!(ready.mcpConfigured && ready.grokConfigured && ready.callbackConfigured)) {
    print('配置未齐全：可以验证 MCP 连接，暂不能转交真实 Grok 任务。');
  }
}

async function status() {
  let value;
  try { value = JSON.parse(await readFile(runtimePath, 'utf8')); }
  catch { print('桥接尚未运行。'); return; }
  if (value.stopped) { print('桥接已停止。'); return; }
  const heartbeatAge = Date.now() - Date.parse(value.updatedAt);
  if (!Number.isFinite(heartbeatAge) || heartbeatAge > 20000 || heartbeatAge < -5000) {
    print('状态心跳已过期，无法确认桥接是否仍在运行。');
    return;
  }
  print(JSON.stringify({
    pid: value.pid, mcp: value.mcp, initialized: value.initialized, toolsListed: value.toolsListed, grokConfigured: value.grokConfigured,
    callbackConfigured: value.callbackConfigured, callbackMode: value.callbackMode,
    version: value.version ?? null, spokenProgress: value.spokenProgress ?? false,
    replyWaitMs: value.replyWaitMs ?? null, automaticChecks: value.automaticChecks ?? null,
    automaticWaitMode: value.automaticWaitMode ?? 'bounded', singleToolWaitMs: value.singleToolWaitMs ?? null,
    toolCalls: value.toolCalls ?? 0,
    rpc: value.rpc ?? null,
    activeToolCall: value.activeToolCall, lastToolCall: value.lastToolCall, recentToolCalls: value.recentToolCalls, updatedAt: value.updatedAt,
  }, null, 2));
}

async function runBridge() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或以上。');
  const config = await loadConfig();
  if (!config.mcpEndpoint) throw new Error('请先在 bridge.local.json 配置 MCP 接入地址。');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const { JobManager } = await import('./lib/jobs.mjs');
  const { createMcpHandler, connectMcp, readToolSummary } = await import('./lib/mcp.mjs');
  const { createVoiceJobs } = await import('./lib/voice.mjs');
  let relay = null;
  if (config.callbackMode === 'relay' && readiness(config).callbackConfigured) {
    const { RelayClient } = await import('./lib/relay.mjs');
    relay = new RelayClient({ baseUrl: config.callbackBaseUrl, masterToken: config.relayMasterToken });
  }
  const jobs = new JobManager({ config, dataDir, relay });
  let server;
  if (config.callbackMode === 'direct') {
    server = createCallbackServer({ jobs });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.listenPort, config.listenHost, resolve);
    }).catch(() => { throw new Error('无法启动本机回调端口；可能已有桥接程序正在运行。'); });
    print('本机回调服务已启动。地址与 token 不写入日志。');
  }
  const abort = new AbortController();
  const logger = (...args) => {
    const words = args.filter(value => typeof value === 'string' && !/token|https?:|wss?:/i.test(value));
    if (words.length) print(words.join(' '));
  };
  const voiceJobs = createVoiceJobs({ jobs, relayEnabled: Boolean(relay), replyWaitMs: config.replyWaitMs, maxCallMs: 4500, signal: abort.signal });
  const baseHandler = createMcpHandler({
    jobs: voiceJobs, version: BRIDGE_VERSION, automaticChecks: config.replyWaitMs > 0 ? 12 : 0,
    automaticCheckBudgetMs: Math.max(1, config.replyWaitMs),
    automaticWaitMode: automaticWaitMode(config),
    interimSpeech: true,
  });
  const handshake = { initialized: false, toolsListed: false };
  let lastToolCall = null;
  const recentToolCalls = [];
  let activeToolCall = null;
  let toolCalls = 0;
  const rpc = { received: 0, toolRequests: 0, unknownToolRequests: 0, errors: 0, last: null };
  const handler = async message => {
    const method = message?.method;
    const toolName = message?.params?.name;
    const isBridgeTool = method === 'tools/call' && BRIDGE_TOOLS.has(toolName);
    rpc.received += 1;
    if (method === 'tools/call') {
      rpc.toolRequests += 1;
      if (!isBridgeTool) rpc.unknownToolRequests += 1;
    }
    const rpcEvent = {
      method: SAFE_RPC_METHODS.has(method) ? method : 'other',
      tool: method === 'tools/call' ? isBridgeTool ? toolName : 'other' : null,
      at: new Date().toISOString(), outcome: 'processing',
    };
    rpc.last = rpcEvent;
    const callStartedAt = Date.now();
    if (isBridgeTool) {
      activeToolCall = { name: message.params.name, startedAt: new Date(callStartedAt).toISOString() };
      logger(`mcp_tool_start ${message.params.name}`);
    }
    const result = await baseHandler(message);
    rpcEvent.outcome = result === null ? 'notification' : result?.error ? 'error' : 'result';
    if (result?.error) {
      rpc.errors += 1;
      rpcEvent.errorCode = [-32700, -32600, -32601, -32602, -32603].includes(result.error.code) ? result.error.code : 'other';
    }
    if (result?.result && method === 'initialize') {
      handshake.initialized = true;
    }
    if (result?.result && method === 'tools/list') {
      handshake.toolsListed = true;
    }
    if (isBridgeTool) {
      const summary = readToolSummary(result);
      lastToolCall = {
        name: message.params.name,
        taskId: /^[A-Za-z0-9_-]{1,128}$/.test(summary.task_id ?? '') ? summary.task_id : null,
        status: ['dispatching', 'accepted', 'unknown', 'completed', 'failed', 'needs_input', 'wait_cancelled'].includes(summary.status) ? summary.status : 'unconfirmed',
        at: new Date().toISOString(),
        elapsedMs: Date.now() - callStartedAt,
      };
      recentToolCalls.push(lastToolCall);
      if (recentToolCalls.length > 8) recentToolCalls.shift();
      activeToolCall = null;
      toolCalls += 1;
      logger(`mcp_tool ${lastToolCall.name} ${lastToolCall.status}`);
    }
    return result;
  };
  handler.resetSession = () => {
    handshake.initialized = false;
    handshake.toolsListed = false;
    baseHandler.resetSession();
  };
  const transport = connectMcp({ endpoint: config.mcpEndpoint, handler, signal: abort.signal, logger });
  let stopped = false;
  let writing = Promise.resolve();
  const saveRuntime = () => {
    const value = {
      pid: process.pid, version: BRIDGE_VERSION, mcp: transport.status, ...handshake, ...readiness(config), callbackMode: config.callbackMode,
      spokenProgress: config.replyWaitMs > 0, automaticWaitMode: automaticWaitMode(config), singleToolWaitMs: 4500,
      replyWaitMs: automaticWaitMode(config) === 'until_result' ? null : config.replyWaitMs,
      automaticChecks: automaticWaitMode(config) === 'until_result' ? null : config.replyWaitMs > 0 ? 12 : 0,
      toolCalls, lastToolCall, recentToolCalls, activeToolCall, rpc: structuredClone(rpc),
      updatedAt: new Date().toISOString(), stopped,
    };
    writing = writing.catch(() => {}).then(async () => {
      const temp = `${runtimePath}.tmp`;
      await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
      await rename(temp, runtimePath);
    });
    return writing;
  };
  await saveRuntime();
  const timer = setInterval(() => { void saveRuntime().catch(() => {}); }, 5000);
  let relaySyncing = false;
  let relayError = false;
  const syncRelay = async (force = false) => {
    if (!relay || stopped || relaySyncing || (!force && !jobs.hasPendingRelay())) return;
    relaySyncing = true;
    try {
      await jobs.syncRelay();
      if (relayError) logger('relay_recovered');
      relayError = false;
    } catch {
      if (!relayError) logger('relay_temporarily_unavailable');
      relayError = true;
    } finally { relaySyncing = false; }
  };
  const relayTimer = setInterval(() => { void syncRelay(); }, 5000);
  void syncRelay(true);
  let stopPromise;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopped = true;
      clearInterval(timer);
      clearInterval(relayTimer);
      abort.abort();
      transport.stop();
      // Finish already-dispatched work and any periodic mailbox sync before
      // another daemon may own the state file. All stop callers share this wait.
      await voiceJobs.drain();
      if (jobs.relaySyncPromise) await Promise.allSettled([jobs.relaySyncPromise]);
      if (server) await new Promise(resolve => server.close(resolve));
      await saveRuntime().catch(() => {});
    })();
    return stopPromise;
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  if (!readiness(config).grokConfigured || !readiness(config).callbackConfigured) {
    print('Grok Bot 尚待配置；目前只连接 MCP，不会触发 Bot 任务。');
  }
  await transport.done;
  await stop();
}

async function start() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const release = await acquireBridgeLock({ dataDir });
  void release.lost.then(error => {
    if (error) {
      process.stderr.write('中转互斥锁意外释放，正在停止以保护任务状态。\n');
      process.kill(process.pid, 'SIGTERM');
    }
  });
  try { await runBridge(); }
  finally { await release(); }
}

try {
  const command = process.argv[2] ?? 'doctor';
  if (command === 'doctor') await doctor();
  else if (command === 'status') await status();
  else if (command === 'start') await start();
  else {
    print('用法：./stackchan doctor | start | status | test');
    process.exitCode = 1;
  }
} catch (error) {
  const safe = typeof error.message === 'string' && !/https?:|wss?:|token=|Bearer /i.test(error.message)
    ? error.message : '操作失败，敏感错误详情已省略。';
  process.stderr.write(`${safe}\n`);
  process.exitCode = 1;
}
