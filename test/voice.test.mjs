import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createVoiceJobs } from '../lib/voice.mjs';
import { createMcpHandler, readToolSummary } from '../lib/mcp.mjs';

function fixture({ initialStatus = 'accepted', sync = () => {} } = {}) {
  let current = { id: 'voice-job-1', status: initialStatus, spokenReply: null };
  const calls = { submit: 0, sync: 0, reads: [], submissions: [] };
  const jobs = {
    async submit(question, options) {
      calls.submit++;
      calls.submissions.push({ question, options });
      return { ...current };
    },
    get(id) { calls.reads.push(id); return current && id === current.id ? { ...current } : null; },
    latest() { return current ? { ...current } : null; },
    hasPendingRelay() { return current && ['accepted', 'dispatching', 'unknown'].includes(current.status); },
    async syncRelay() { calls.sync++; await sync(calls.sync, update); },
  };
  function update(fields) { current = fields === null ? null : { ...current, ...fields }; }
  return { jobs, calls, update };
}

test('a delayed Bot reply is returned in the original call with exactly one submission', async () => {
  const { jobs, calls } = fixture({ sync(count, update) {
    if (count === 3) update({ status: 'completed', spokenReply: '小方块语音测试收到。' });
  } });
  const voice = createVoiceJobs({ jobs, relayEnabled: true, replyWaitMs: 30, pollIntervalMs: 2 });
  const result = await voice.submit('测试', { requestKey: 'voice-turn-1' });
  assert.equal(result.status, 'completed');
  assert.equal(result.spokenReply, '小方块语音测试收到。');
  assert.equal(calls.submit, 1);
  assert.deepEqual(calls.submissions, [{ question: '测试', options: { requestKey: 'voice-turn-1' } }]);
  assert.ok(calls.reads.every((id) => id === 'voice-job-1'));
});

test('expiry returns the true pending state without inventing a completion or retrying', async () => {
  const { jobs, calls } = fixture({ initialStatus: 'unknown' });
  const voice = createVoiceJobs({ jobs, relayEnabled: true, replyWaitMs: 10, pollIntervalMs: 2 });
  const result = await voice.submit('查询');
  assert.equal(result.status, 'unknown');
  assert.equal(result.spokenReply, null);
  assert.equal(calls.submit, 1);
  assert.ok(calls.sync >= 1);
});

test('needs_input and failed replies stop waiting and preserve the Bot text', async () => {
  for (const status of ['needs_input', 'failed']) {
    const { jobs, calls } = fixture({ sync(_count, update) {
      update({ status, spokenReply: '请补充日期。' });
    } });
    const result = await createVoiceJobs({ jobs, relayEnabled: true, replyWaitMs: 30 }).submit('查询');
    assert.equal(result.status, status);
    assert.equal(result.spokenReply, '请补充日期。');
    assert.equal(calls.sync, 1);
  }
});

test('aborting a pending wait does not cancel or resubmit an already dispatched task', async () => {
  const controller = new AbortController();
  let finishSync;
  const { jobs, calls, update } = fixture({ sync: () => new Promise((resolve) => { finishSync = resolve; }) });
  const voice = createVoiceJobs({ jobs, relayEnabled: true, replyWaitMs: 30, signal: controller.signal });
  const pending = voice.submit('安排一次');
  await delay(2);
  controller.abort();
  const result = await pending;
  assert.equal(result.status, 'accepted');
  assert.equal(calls.submit, 1);
  update({ status: 'completed', spokenReply: '后台照常完成。' });
  finishSync();
  assert.equal(jobs.get(result.id).spokenReply, '后台照常完成。');
  await assert.rejects(voice.submit('不应再派发'), { name: 'AbortError' });
  assert.equal(calls.submit, 1);
});

test('a blocked mailbox sync cannot extend the local reply budget', async () => {
  let finishSync;
  const { jobs, calls } = fixture({ sync: () => new Promise((resolve) => { finishSync = resolve; }) });
  const result = await createVoiceJobs({ jobs, relayEnabled: true, replyWaitMs: 10 }).submit('查询');
  assert.equal(result.status, 'accepted');
  assert.equal(calls.submit, 1);
  finishSync();
});

test('existing terminal results and missing tasks return immediately without a mailbox request', async () => {
  const { jobs, calls, update } = fixture({ initialStatus: 'completed' });
  update({ spokenReply: '现有结果。' });
  const voice = createVoiceJobs({ jobs, relayEnabled: true, replyWaitMs: 30,
    sleep: () => assert.fail('a terminal result must not sleep') });
  assert.equal((await voice.get('voice-job-1')).spokenReply, '现有结果。');
  assert.equal((await voice.latest()).status, 'completed');
  assert.equal((await voice.submit('已有结果')).status, 'completed');
  assert.equal(await voice.get('missing-id'), null);
  update(null);
  assert.equal(await voice.latest(), null);
  assert.equal(calls.sync, 0);
});

test('a transient mailbox failure recovers during the same wait', async () => {
  const { jobs, calls } = fixture({ sync(count, update) {
    if (count === 1) throw Object.assign(new Error('Temporary mailbox outage'), { code: 'RELAY_UNAVAILABLE' });
    update({ status: 'completed', spokenReply: '恢复后已收到。' });
  } });
  const result = await createVoiceJobs({ jobs, relayEnabled: true, replyWaitMs: 30, pollIntervalMs: 2 }).submit('查询');
  assert.equal(result.spokenReply, '恢复后已收到。');
  assert.equal(calls.submit, 1);
  assert.equal(calls.sync, 2);
});

test('a locally persisted reply survives a mailbox acknowledgment failure', async () => {
  const { jobs } = fixture({ sync(_count, update) {
    update({ status: 'completed', spokenReply: '结果已保存。' });
    throw Object.assign(new Error('Acknowledgment failed'), { code: 'RELAY_UNAVAILABLE' });
  } });
  const result = await createVoiceJobs({ jobs, relayEnabled: true, replyWaitMs: 30 }).submit('查询');
  assert.equal(result.status, 'completed');
  assert.equal(result.spokenReply, '结果已保存。');
});

test('get and latest refresh pending tasks without triggering a new Bot task', async () => {
  for (const method of ['get', 'latest']) {
    const { jobs, calls } = fixture({ sync(count, update) {
      if (count === 2) update({ status: 'completed', spokenReply: '原任务结果。' });
    } });
    const voice = createVoiceJobs({ jobs, relayEnabled: true, replyWaitMs: 30, pollIntervalMs: 2 });
    const result = await voice[method]('voice-job-1');
    assert.equal(result.spokenReply, '原任务结果。');
    assert.equal(calls.submit, 0);
    assert.equal(calls.sync, 2);
  }
});

test('direct callbacks can finish a wait with no relay calls', async () => {
  const { jobs, calls, update } = fixture();
  const voice = createVoiceJobs({ jobs, replyWaitMs: 30, pollIntervalMs: 2 });
  const pending = voice.submit('本地回调');
  await delay(2);
  update({ status: 'completed', spokenReply: '直接回调已收到。' });
  assert.equal((await pending).spokenReply, '直接回调已收到。');
  assert.equal(calls.sync, 0);
});

test('submission and permanent storage errors are not hidden or automatically retried', async () => {
  const { jobs, calls } = fixture();
  const submissionError = Object.assign(new Error('Invalid configuration'), { code: 'CONFIG_REQUIRED' });
  jobs.submit = async () => { calls.submit++; throw submissionError; };
  const voice = createVoiceJobs({ jobs, relayEnabled: true, replyWaitMs: 10 });
  await assert.rejects(voice.submit('查询'), (error) => error === submissionError);
  assert.equal(calls.submit, 1);
  assert.equal(calls.sync, 0);
  const permanent = fixture({ sync() {
    throw Object.assign(new Error('State storage failed'), { code: 'STATE_UNAVAILABLE' });
  } });
  await assert.rejects(createVoiceJobs({ jobs: permanent.jobs, relayEnabled: true, replyWaitMs: 10 }).latest(),
    { code: 'STATE_UNAVAILABLE' });
});

test('the MCP tool receives the actual speech reply rather than the accepted receipt', async () => {
  const { jobs, calls } = fixture({ sync(_count, update) {
    update({ status: 'completed', spokenReply: '小方块已经收到了。' });
  } });
  const handle = createMcpHandler({ jobs: createVoiceJobs({ jobs, relayEnabled: true, replyWaitMs: 30 }) });
  const response = await handle({ jsonrpc: '2.0', id: 'voice-tool-1', method: 'tools/call',
    params: { name: 'ask_grok_bot', arguments: { question: '问候测试' } } });
  const result = readToolSummary(response);
  assert.equal(result.status, 'completed');
  assert.equal(result.speech, '小方块已经收到了。');
  assert.match(response.result.content[0].text, /小方块已经收到了。/);
  assert.equal(calls.submit, 1);
});

test('wait budgets are bounded and zero disables waiting', async () => {
  const { jobs, calls } = fixture();
  for (const replyWaitMs of [-1, 90_001, Infinity, NaN]) {
    assert.throws(() => createVoiceJobs({ jobs, replyWaitMs }), TypeError);
  }
  assert.throws(() => createVoiceJobs({ jobs, pollIntervalMs: 0 }), TypeError);
  const result = await createVoiceJobs({ jobs, relayEnabled: true, replyWaitMs: 0 }).submit('立即返回');
  assert.equal(result.status, 'accepted');
  assert.equal(calls.sync, 0);
});

test('a total call budget returns the exact persisted dispatch while submission continues once', async () => {
  let finish;
  let submissions = 0;
  let current;
  const jobs = {
    async submit(question, { requestKey }) {
      submissions++;
      current = { id: 'slow-submit', question, requestKey, status: 'dispatching' };
      await new Promise(resolve => { finish = resolve; });
      current.status = 'accepted';
      return { ...current };
    },
    getByRequestKey(key) { return current?.requestKey === key ? { ...current } : null; },
    get() { return { ...current }; },
    latest() { assert.fail('a slow submission must never fall back to another latest task'); },
  };
  const voice = createVoiceJobs({ jobs, replyWaitMs: 100, maxCallMs: 10 });
  const result = await voice.submit('查询', { requestKey: 'exact-turn' });
  assert.equal(result.id, 'slow-submit');
  assert.equal(result.status, 'dispatching');
  assert.equal(submissions, 1);
  finish();
  await voice.drain();
  assert.equal(current.status, 'accepted');
  assert.equal(submissions, 1);
});

test('dispatch time and reply polling share one total deadline', async () => {
  let clock = 0;
  const pauses = [];
  const { jobs, calls } = fixture();
  jobs.getByRequestKey = () => null;
  jobs.submit = async () => { calls.submit++; clock += 8; return jobs.get('voice-job-1'); };
  const voice = createVoiceJobs({ jobs, relayEnabled: true, replyWaitMs: 100, maxCallMs: 10, pollIntervalMs: 7,
    now: () => clock, sleep: async ms => { pauses.push(ms); clock += ms; } });
  assert.equal((await voice.submit('查询', { requestKey: 'time-budget' })).status, 'accepted');
  assert.deepEqual(pauses, [2]);
  assert.equal(clock, 10);
  assert.equal(calls.submit, 1);
});

test('automatic queries can use a smaller remaining budget and terminal cached replies stay immediate', async () => {
  let clock = 0;
  const pauses = [];
  const { jobs, calls, update } = fixture();
  jobs.getByRequestKey = () => null;
  const voice = createVoiceJobs({ jobs, replyWaitMs: 100, maxCallMs: 10, pollIntervalMs: 8,
    now: () => clock, sleep: async ms => { pauses.push(ms); clock += ms; } });
  assert.equal((await voice.get('voice-job-1', { waitMs: 3 })).status, 'accepted');
  assert.deepEqual(pauses, [3]);
  update({ status: 'completed', spokenReply: '已完成。' });
  assert.equal((await voice.get('voice-job-1', { waitMs: 0 })).spokenReply, '已完成。');
  assert.equal(calls.submit, 0);
  await assert.rejects(voice.get('voice-job-1', { waitMs: -1 }), TypeError);
});

test('a bounded dispatch preserves immediate errors and never substitutes an unrelated task', async () => {
  const { jobs, calls } = fixture();
  jobs.getByRequestKey = () => ({ id: 'unrelated', question: '另一件事', status: 'accepted' });
  const error = Object.assign(new Error('Request key conflict'), { code: 'REQUEST_KEY_CONFLICT' });
  jobs.submit = async () => { calls.submit++; throw error; };
  const voice = createVoiceJobs({ jobs, maxCallMs: 10 });
  await assert.rejects(voice.submit('查询', { requestKey: 'conflict' }), e => e === error);
  let finish;
  jobs.submit = () => { calls.submit++; return new Promise(resolve => { finish = resolve; }); };
  await assert.rejects(voice.submit('查询', { requestKey: 'missing' }), { code: 'STATE_UNAVAILABLE' });
  finish(null);
  await voice.drain();
  assert.equal(calls.submit, 2);
});

test('bounded MCP continuation reads the original background dispatch and returns its final reply', async () => {
  let finish;
  const { jobs, calls, update } = fixture({ sync(_count, change) {
    change({ status: 'completed', spokenReply: '短查询取得的真实回复。' });
  } });
  jobs.submit = async (question, options) => {
    calls.submit++;
    update({ question, requestKey: options.requestKey, status: 'dispatching' });
    await new Promise(resolve => { finish = resolve; });
    update({ status: 'accepted' });
    return jobs.get('voice-job-1');
  };
  jobs.getByRequestKey = key => {
    const job = jobs.get('voice-job-1');
    return job.requestKey === key ? job : null;
  };
  const voice = createVoiceJobs({ jobs, relayEnabled: true, replyWaitMs: 100, maxCallMs: 5 });
  const handle = createMcpHandler({ jobs: voice, automaticChecks: 4 });
  const submitted = readToolSummary(await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'ask_grok_bot', arguments: { question: '原请求' } } }));
  assert.equal(submitted.status, 'dispatching');
  assert.equal(typeof submitted.continuation_token, 'string');
  finish();
  await voice.drain();
  const completed = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'check_grok_task', arguments: { task_id: submitted.task_id, continuation_token: submitted.continuation_token },
  } });
  assert.equal(readToolSummary(completed).status, 'completed');
  assert.equal(readToolSummary(completed).speech, '短查询取得的真实回复。');
  assert.equal(readToolSummary(completed).continuation_token, undefined);
  assert.equal(calls.submit, 1);
});
