// Live integration probe. Deliberately excluded from the offline test runner.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig, dataDir, readiness } from '../lib/config.mjs';
import { JobManager } from '../lib/jobs.mjs';
import { RelayClient } from '../lib/relay.mjs';
import { createMcpHandler, readToolSummary } from '../lib/mcp.mjs';
import { createVoiceJobs } from '../lib/voice.mjs';

const automaticReply = process.argv.includes('--wait-for-reply');
const question = automaticReply
  ? '这是一次自动读回复的连通测试。请直接回复“你好，小方块”。除本例行任务要求的结果回调外，不执行其他操作。'
  : '这是一次连通测试。请直接回复“我已收到小方块的测试请求”。除本例行任务要求的结果回调外，不执行其他操作。';
const requestKey = `stackchan-grok-probe-${randomUUID()}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const print = value => console.log(JSON.stringify(value));
let lastJob;
try {
  try {
    const runtime = JSON.parse(await readFile(join(dataDir, 'runtime.json'), 'utf8'));
    let alive = false;
    try { process.kill(runtime.pid, 0); alive = true; } catch (error) { if (error.code === 'EPERM') alive = true; }
    if (alive) throw Object.assign(new Error(), { code: 'BRIDGE_STILL_RUNNING' });
  } catch (error) {
    if (error.code === 'BRIDGE_STILL_RUNNING') throw error;
    if (error.code !== 'ENOENT') throw error;
  }
  const config = await loadConfig();
  if (Object.values(readiness(config)).some(value => !value)) throw Object.assign(new Error(), { code: 'CONFIG_REQUIRED' });
  const relay = new RelayClient({ baseUrl: config.callbackBaseUrl, masterToken: config.relayMasterToken });
  const jobs = new JobManager({ config, dataDir, relay });
  const handler = createMcpHandler({
    jobs: automaticReply ? createVoiceJobs({ jobs, relayEnabled: true, replyWaitMs: config.replyWaitMs, maxCallMs: 4500 }) : jobs,
    automaticChecks: automaticReply && config.replyWaitMs > 0 ? 4 : 0,
    automaticCheckBudgetMs: Math.max(1, Math.min(30000, config.replyWaitMs)),
  });
  await handler({ jsonrpc: '2.0', id: 'probe-init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'local-connectivity-test', version: '1' } } });
  const startedAt = Date.now();
  print({ phase: 'waiting_for_bot', automaticReply });
  const submitted = await handler({ jsonrpc: '2.0', id: 'probe-submit', method: 'tools/call', params: { name: 'ask_grok_bot', arguments: { question, request_key: requestKey } } });
  const summary = readToolSummary(submitted);
  if (!summary.task_id) throw Object.assign(new Error(), { code: 'SUBMISSION_NOT_CONFIRMED' });
  lastJob = jobs.get(summary.task_id);
  print({ phase: 'submitted', task_id: lastJob.id, status: lastJob.status });
  let chainedSummary = summary;
  let automaticQueryCalls = 0;
  while (chainedSummary.continuation_token && automaticQueryCalls < 4) {
    automaticQueryCalls++;
    const answer = await handler({ jsonrpc: '2.0', id: `probe-auto-${automaticQueryCalls}`, method: 'tools/call', params: {
      name: 'check_grok_task', arguments: { task_id: summary.task_id, continuation_token: chainedSummary.continuation_token },
    } });
    chainedSummary = readToolSummary(answer);
    lastJob = jobs.get(summary.task_id);
    print({ phase: 'automatic_check', call: automaticQueryCalls, task_id: lastJob.id, status: lastJob.status });
  }
  const finalInVoiceChain = chainedSummary.status === 'completed';
  let previous = lastJob.status;
  let syncFailed = false;
  while (Date.now() - startedAt < 120000 && !['completed', 'failed', 'needs_input'].includes(lastJob.status)) {
    try {
      await jobs.syncRelay();
      if (syncFailed) print({ phase: 'relay_recovered' });
      syncFailed = false;
    } catch {
      if (!syncFailed) print({ phase: 'relay_temporarily_unavailable' });
      syncFailed = true;
    }
    lastJob = jobs.get(lastJob.id);
    if (lastJob.status !== previous) {
      print({ phase: 'task_status', task_id: lastJob.id, status: lastJob.status });
      previous = lastJob.status;
    }
    if (!['completed', 'failed', 'needs_input'].includes(lastJob.status)) await wait(5000);
  }
  const checked = await handler({ jsonrpc: '2.0', id: 'probe-check', method: 'tools/call', params: { name: 'check_grok_task', arguments: { task_id: lastJob.id } } });
  const result = readToolSummary(checked);
  const report = { task_id: lastJob.id, status: lastJob.status, speech: result.speech, elapsed_seconds: Math.round((Date.now() - startedAt) / 1000), returned_final_in_submit_call: automaticReply && summary.status === 'completed', automatic_query_calls: automaticQueryCalls, returned_final_in_voice_chain: automaticReply && finalInVoiceChain, physical_speech_verified: false };
  await writeFile(join(dataDir, 'grok-probe-result.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  print(report);
  if (lastJob.status !== 'completed') process.exitCode = 1;
} catch (error) {
  print({ phase: 'test_incomplete', error_code: /^[A-Z_]{1,60}$/.test(error.code ?? '') ? error.code : 'TEST_ERROR', ...(lastJob ? { task_id: lastJob.id, status: lastJob.status } : {}) });
  process.exitCode = 1;
}
