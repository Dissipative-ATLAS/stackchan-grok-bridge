import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler, connectMcp, readToolSummary } from '../lib/mcp.mjs';

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const call = (id, name, args = {}) => rpc(id, 'tools/call', { name, arguments: args });
const decode = readToolSummary;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for test condition.');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

function fakeJobs(overrides = {}) {
  return {
    submissions: [],
    async submit(question, options) {
      this.submissions.push({ question, options });
      return { id: 'job-1', status: 'accepted', spokenReply: '' };
    },
    get(id) { return { id, status: 'completed', spokenReply: 'Grok Bot 的真实答复。' }; },
    latest() { return { id: 'latest-1', status: 'running' }; },
    ...overrides,
  };
}

class FakeSocket extends EventTarget {
  static instances = [];
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.instances.push(this);
  }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: value })); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  fail() { this.dispatchEvent(new Event('error')); }
}

function connect(options = {}) {
  FakeSocket.instances = [];
  return connectMcp({
    endpoint: 'wss://example.invalid/mcp/?token=FAKE_SECRET_NEVER_LOG',
    handler: createMcpHandler({ jobs: fakeJobs() }),
    WebSocketImpl: FakeSocket,
    retryBaseMs: 10,
    retryMaxMs: 30,
    connectTimeoutMs: 1000,
    random: () => 0.5,
    ...options,
  });
}

test('initialize negotiates a known version and preserves original control instructions', async () => {
  const handle = createMcpHandler({ jobs: fakeJobs(), version: 'test-version' });
  const answer = await handle(rpc(1, 'initialize', { protocolVersion: '2024-11-05' }));
  assert.equal(answer.result.protocolVersion, '2024-11-05');
  assert.equal(answer.result.serverInfo.version, 'test-version');
  assert.deepEqual(answer.result.capabilities, { tools: { listChanged: false } });
  assert.match(answer.result.instructions, /只有用户明确/);
  assert.match(answer.result.instructions, /转头、灯光/);
  const newer = await handle(rpc(2, 'initialize', { protocolVersion: 'unsupported' }));
  assert.equal(newer.result.protocolVersion, '2025-06-18');
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual((await handle(rpc(3, 'ping'))).result, {});
});

test('tool schema exposes only Grok delegation and checking', async () => {
  const handle = createMcpHandler({ jobs: fakeJobs() });
  const answer = await handle(rpc('list', 'tools/list'));
  assert.deepEqual(answer.result.tools.map(tool => tool.name), ['ask_grok_bot', 'check_grok_task']);
  assert.equal(answer.result.tools[0].inputSchema.properties.question.maxLength, 4000);
  answer.result.tools[0].name = 'mutated';
  assert.equal((await handle(rpc(3, 'tools/list'))).result.tools[0].name, 'ask_grok_bot');
});

test('submission acknowledges pending work and forwards explicit idempotency key', async () => {
  const jobs = fakeJobs();
  const handle = createMcpHandler({ jobs });
  const answer = await handle(call(3, 'ask_grok_bot', { question: '  帮我问问 Grok Bot 周末安排  ', request_key: 'weekend-1' }));
  const text = decode(answer);
  assert.equal(text.task_id, 'job-1');
  assert.equal(text.status, 'accepted');
  assert.equal(answer.result.isError, false);
  assert.match(text.speech, /不是完成确认/);
  assert.deepEqual(jobs.submissions, [{ question: '帮我问问 Grok Bot 周末安排', options: { requestKey: 'weekend-1' } }]);
});

test('same-session duplicate requests submit once, changed payload conflicts, initialize starts new session', async () => {
  const jobs = fakeJobs();
  const handle = createMcpHandler({ jobs });
  const request = call(7, 'ask_grok_bot', { question: '同一任务' });
  const [one, two] = await Promise.all([handle(request), handle(request)]);
  assert.deepEqual(one, two);
  assert.equal(jobs.submissions.length, 1);
  await handle(request);
  assert.equal(jobs.submissions.length, 1);
  const firstKey = jobs.submissions[0].options.requestKey;
  assert.match(firstKey, /^mcp:/);
  assert.equal((await handle(call(7, 'ask_grok_bot', { question: '另一个任务' }))).error.code, -32600);
  await handle(rpc(1, 'initialize', { protocolVersion: '2024-11-05' }));
  await handle(request);
  assert.equal(jobs.submissions.length, 2);
  assert.notEqual(jobs.submissions[1].options.requestKey, firstKey);
});

test('a repeated status query refreshes settled results while conflicting request ids stay rejected', async () => {
  let job = { id: 'job-1', status: 'accepted' };
  let lookups = 0;
  const jobs = fakeJobs({
    get() { lookups += 1; return job; },
  });
  const handle = createMcpHandler({ jobs });
  const request = call(9, 'check_grok_task', { task_id: 'job-1' });
  assert.equal(decode(await handle(request)).status, 'accepted');
  job = { ...job, status: 'completed', spokenReply: '查询已取得最终结果。' };
  const refreshed = await handle(request);
  assert.equal(decode(refreshed).status, 'completed');
  assert.equal(refreshed.result.content[0].text, 'Grok Bot 已回复：\n查询已取得最终结果。');
  assert.equal(lookups, 2);
  assert.equal((await handle(call(9, 'check_grok_task', { task_id: 'another-job' }))).error.code, -32600);
  assert.equal((await handle(call(9, 'ask_grok_bot', { question: '不能替换原查询' }))).error.code, -32600);
  assert.equal(jobs.submissions.length, 0);
  assert.equal(lookups, 2);
});

test('concurrent duplicate status queries share one lookup until it settles', async () => {
  let release;
  let lookups = 0;
  const jobs = fakeJobs({
    get() {
      lookups += 1;
      return new Promise(resolve => { release = resolve; });
    },
  });
  const handle = createMcpHandler({ jobs });
  const request = call(10, 'check_grok_task', { task_id: 'job-1' });
  const first = handle(request);
  const duplicate = handle(request);
  assert.equal(lookups, 1);
  release({ id: 'job-1', status: 'completed', spokenReply: '共同查询结果。' });
  const answers = await Promise.all([first, duplicate]);
  assert.deepEqual(answers[0], answers[1]);
  assert.equal(decode(answers[0]).status, 'completed');
});

test('long-lived sessions keep accepting tools after bounded cache eviction and reuse stable request keys', async () => {
  const jobs = fakeJobs();
  const handle = createMcpHandler({ jobs });
  await handle(call(1, 'ask_grok_bot', { question: '任务一' }));
  const firstKey = jobs.submissions[0].options.requestKey;
  for (let id = 2; id <= 1026; id += 1) {
    const result = await handle(call(id, 'check_grok_task'));
    assert.ok(result.result);
  }
  await handle(call(1, 'ask_grok_bot', { question: '任务一' }));
  assert.equal(jobs.submissions[1].options.requestKey, firstKey);
});

test('queries return completed speech, latest status, failure, needs_input and absence correctly', async () => {
  const jobs = fakeJobs();
  const handle = createMcpHandler({ jobs });
  assert.equal(decode(await handle(call(1, 'check_grok_task', { task_id: 'job-2' }))).speech, 'Grok Bot 的真实答复。');
  assert.equal(decode(await handle(call(2, 'check_grok_task'))).task_id, 'latest-1');
  jobs.latest = () => ({ id: 'job-1', status: 'needs_input', spokenReply: '请问你想预订哪天？' });
  assert.match(decode(await handle(call(3, 'check_grok_task'))).speech, /哪天/);
  jobs.latest = () => ({ id: 'job-1', status: 'failed', spokenReply: '服务暂时不可用。' });
  assert.equal((await handle(call(4, 'check_grok_task'))).result.isError, true);
  jobs.latest = () => ({ id: 'job-1', status: 'unknown', spokenReply: '不能自动重试' });
  assert.match(decode(await handle(call(5, 'check_grok_task'))).speech, /不要自动再次提交/);
  jobs.latest = () => undefined;
  assert.match(decode(await handle(call(6, 'check_grok_task'))).speech, /没有找到/);
});

test('completed and needs-input tool results expose directly speakable Chinese with separate metadata', async () => {
  const jobs = fakeJobs({
    async submit() { return { id: 'job-1', status: 'completed', spokenReply: '小方块语音测试收到。' }; },
    latest() { return { id: 'job-1', status: 'needs_input', spokenReply: '请问你要查询哪个城市？' }; },
  });
  const handle = createMcpHandler({ jobs });
  const completed = await handle(call(1, 'ask_grok_bot', { question: '语音测试' }));
  assert.deepEqual(completed.result.content, [{ type: 'text', text: 'Grok Bot 已回复：\n小方块语音测试收到。' }]);
  assert.deepEqual(decode(completed), { task_id: 'job-1', status: 'completed', speech: '小方块语音测试收到。' });
  assert.equal(completed.result.structuredContent, undefined);
  assert.throws(() => JSON.parse(completed.result.content[0].text));
  const needsInput = await handle(call(2, 'check_grok_task'));
  assert.deepEqual(needsInput.result.content, [{ type: 'text', text: 'Grok Bot 需要你补充信息：\n请问你要查询哪个城市？' }]);
  assert.deepEqual(decode(needsInput), { task_id: 'job-1', status: 'needs_input', speech: '请问你要查询哪个城市？' });
  assert.equal(needsInput.result.isError, false);
});

test('tool summary reader accepts legacy JSON text and safely ignores missing or invalid summaries', () => {
  const legacy = { task_id: 'legacy-1', status: 'completed', speech: '旧版结果。' };
  assert.deepEqual(readToolSummary({ result: { content: [{ type: 'text', text: JSON.stringify(legacy) }] } }), legacy);
  assert.deepEqual(readToolSummary({ result: { _meta: { 'io.stackchan.grok.result': legacy }, content: [{ type: 'text', text: '中文正文' }] } }), legacy);
  for (const answer of [undefined, {}, { result: {} }, { result: { content: [{ type: 'text', text: '中文正文' }] } }, { result: { content: [{ type: 'text', text: '[]' }] } }]) {
    assert.deepEqual(readToolSummary(answer), {});
  }
});

function continuationArgs(answer) {
  const summary = decode(answer);
  assert.equal(typeof summary.continuation_token, 'string');
  return { task_id: summary.task_id, continuation_token: summary.continuation_token };
}

test('automatic checking is opt-in and leaves ordinary submissions and manual lookups unchanged', async () => {
  const jobs = fakeJobs();
  const handle = createMcpHandler({ jobs });
  const submitted = await handle(call(1, 'ask_grok_bot', { question: '默认模式' }));
  assert.equal(decode(submitted).continuation_token, undefined);
  assert.match(submitted.result.content[0].text, /稍后可以查询/);
  assert.equal(decode(await handle(call(2, 'check_grok_task', { task_id: 'job-1' }))).status, 'completed');
  assert.equal((await handle(call(3, 'check_grok_task', { task_id: 'job-1', continuation_token: 'not-issued' }))).error.code, -32602);
  assert.equal(jobs.submissions.length, 1);
});

test('one submission permits at most four automatic checks and manual checking still works afterward', async () => {
  let clock = 100;
  let completed = false;
  const lookups = [];
  const jobs = fakeJobs({
    async submit(question, options) {
      this.submissions.push({ question, options });
      clock += 2000;
      return { id: 'job-1', status: 'accepted' };
    },
    get(id, options) {
      lookups.push({ id, options });
      if (options) clock += 4500;
      return { id, status: completed ? 'completed' : 'accepted', spokenReply: completed ? '稍后取得的真实答复。' : null };
    },
  });
  const handle = createMcpHandler({ jobs, automaticChecks: 4, now: () => clock });
  let result = await handle(call(1, 'ask_grok_bot', { question: '一次任务' }));
  const budgets = [28000, 23500, 19000, 14500];
  for (let index = 0; index < 4; index += 1) {
    const args = continuationArgs(result);
    assert.equal(args.task_id, 'job-1');
    assert.equal(decode(result).automatic_checks_remaining, 4 - index);
    assert.match(result.result.content[0].text, new RegExp(args.continuation_token));
    result = await handle(call(index + 2, 'check_grok_task', args));
    assert.deepEqual(lookups[index], { id: 'job-1', options: { waitMs: budgets[index] } });
  }
  assert.equal(decode(result).continuation_token, undefined);
  assert.equal(decode(result).status, 'accepted');
  assert.match(result.result.content[0].text, /本轮自动等待已结束/);
  assert.equal(lookups.length, 4);
  assert.equal(jobs.submissions.length, 1);
  completed = true;
  const manual = await handle(call(9, 'check_grok_task', { task_id: 'job-1' }));
  assert.equal(decode(manual).speech, '稍后取得的真实答复。');
  assert.deepEqual(lookups.at(-1), { id: 'job-1', options: undefined });
  assert.equal(jobs.submissions.length, 1);
});

test('automatic checks share a deadline measured before submission and stop exactly at its budget', async () => {
  let clock = 100;
  let lookups = 0;
  const jobs = fakeJobs({
    async submit() { clock += 4000; return { id: 'job-1', status: 'unknown' }; },
    get(id, { waitMs }) {
      lookups += 1;
      assert.equal(waitMs, 1000);
      clock += waitMs;
      return { id, status: 'unknown' };
    },
  });
  const handle = createMcpHandler({ jobs, automaticChecks: 4, now: () => clock });
  const submitted = await handle(call(1, 'ask_grok_bot', { question: '不确定是否接收，也不能重复提交' }));
  const args = continuationArgs(submitted);
  clock = 29100;
  const result = await handle(call(2, 'check_grok_task', args));
  assert.equal(decode(result).continuation_token, undefined);
  assert.equal(decode(result).status, 'unknown');
  assert.match(result.result.content[0].text, /本轮自动等待已结束/);
  assert.equal(lookups, 1);

  const exhaustedJobs = fakeJobs({ async submit() { clock += 30000; return { id: 'late-1', status: 'accepted' }; } });
  const exhausted = createMcpHandler({ jobs: exhaustedJobs, automaticChecks: 4, now: () => clock });
  const late = await exhausted(call(1, 'ask_grok_bot', { question: '提交已耗尽预算' }));
  assert.equal(decode(late).continuation_token, undefined);
  assert.match(late.result.content[0].text, /本轮自动等待已结束/);
});

test('expired continuation tokens never fall through to an ordinary lookup', async () => {
  let clock = 0;
  let lookups = 0;
  const jobs = fakeJobs({ get() { lookups += 1; throw new Error('Expired tokens must not query.'); } });
  const handle = createMcpHandler({ jobs, automaticChecks: 4, automaticCheckBudgetMs: 100, now: () => clock });
  const args = continuationArgs(await handle(call(1, 'ask_grok_bot', { question: '短预算' })));
  clock = 100;
  const expired = await handle(call(2, 'check_grok_task', args));
  assert.equal(decode(expired).continuation_token, undefined);
  assert.match(expired.result.content[0].text, /本轮自动等待已结束/);
  assert.equal(lookups, 0);
});

test('another ask for the same persisted task reuses its continuation and never resets the deadline', async () => {
  let clock = 0;
  const budgets = [];
  const jobs = fakeJobs({ get(id, options) { budgets.push(options.waitMs); return { id, status: 'accepted' }; } });
  const handle = createMcpHandler({ jobs, automaticChecks: 4, now: () => clock });
  const args = { question: '同一项持久化任务', request_key: 'same-persisted-task' };
  const first = await handle(call(1, 'ask_grok_bot', args));
  clock = 10000;
  const repeated = await handle(call(2, 'ask_grok_bot', args));
  assert.deepEqual(continuationArgs(repeated), continuationArgs(first));
  clock = 20000;
  const checked = await handle(call(3, 'check_grok_task', continuationArgs(repeated)));
  assert.deepEqual(budgets, [10000]);
  assert.equal(decode(checked).automatic_checks_remaining, 3);
  clock = 30000;
  const expired = await handle(call(4, 'ask_grok_bot', args));
  assert.equal(decode(expired).continuation_token, undefined);
  assert.match(expired.result.content[0].text, /本轮自动等待已结束/);
});

test('a continuation shares one in-flight lookup and cached result across different RPC ids', async () => {
  let release;
  let lookups = 0;
  const jobs = fakeJobs({
    get() {
      lookups += 1;
      return new Promise(resolve => { release = resolve; });
    },
  });
  const handle = createMcpHandler({ jobs, automaticChecks: 4, now: () => 0 });
  const args = continuationArgs(await handle(call(1, 'ask_grok_bot', { question: '不要重复查询' })));
  const one = handle(call(2, 'check_grok_task', args));
  const two = handle(call(3, 'check_grok_task', args));
  await tick();
  assert.equal(lookups, 1);
  release({ id: 'job-1', status: 'accepted' });
  const [first, duplicate] = await Promise.all([one, two]);
  assert.equal(first.id, 2);
  assert.equal(duplicate.id, 3);
  assert.deepEqual(first.result, duplicate.result);
  assert.equal(decode(first).automatic_checks_remaining, 3);
  const replay = await handle(call(4, 'check_grok_task', args));
  assert.deepEqual(replay.result, first.result);
  assert.equal(lookups, 1);
  assert.equal(jobs.submissions.length, 1);
});

test('continuations require their exact task and invalid arguments do not consume the valid token', async () => {
  let lookups = 0;
  const jobs = fakeJobs({ get(id) { lookups += 1; return { id, status: 'completed', spokenReply: '正确任务的答复。' }; } });
  const handle = createMcpHandler({ jobs, automaticChecks: 4 });
  const args = continuationArgs(await handle(call(1, 'ask_grok_bot', { question: '原任务' })));
  for (const invalid of [
    { ...args, task_id: 'another-job' },
    { continuation_token: args.continuation_token },
    { ...args, continuation_token: 'not-issued' },
    { ...args, continuation_token: '../invalid' },
  ]) {
    assert.equal((await handle(call(Math.random(), 'check_grok_task', invalid))).error.code, -32602);
  }
  assert.equal(lookups, 0);
  const completed = await handle(call(2, 'check_grok_task', args));
  assert.equal(decode(completed).speech, '正确任务的答复。');
  assert.equal(decode(completed).continuation_token, undefined);
  assert.equal(lookups, 1);
});

test('completed, failed and needs-input results stop automatic checking without an extra readback call', async () => {
  for (const status of ['completed', 'failed', 'needs_input']) {
    const finalJob = { id: 'job-1', status, spokenReply: '最终答复或待补充问题。' };
    const alreadyDone = createMcpHandler({ jobs: fakeJobs({ async submit() { return finalJob; } }), automaticChecks: 4 });
    const direct = await alreadyDone(call(1, 'ask_grok_bot', { question: '已经结束' }));
    assert.equal(decode(direct).continuation_token, undefined);
    assert.match(direct.result.content[0].text, /最终答复或待补充问题/);

    let lookups = 0;
    const jobs = fakeJobs({ get() { lookups += 1; return finalJob; } });
    const handle = createMcpHandler({ jobs, automaticChecks: 4 });
    const args = continuationArgs(await handle(call(1, 'ask_grok_bot', { question: '即将结束' })));
    const finished = await handle(call(2, 'check_grok_task', args));
    assert.equal(decode(finished).status, status);
    assert.equal(decode(finished).continuation_token, undefined);
    assert.deepEqual((await handle(call(3, 'check_grok_task', args))).result, finished.result);
    assert.equal(lookups, 1);
    assert.equal(jobs.submissions.length, 1);
  }
});

test('session resets and flow LRU eviction invalidate old continuations without looking up a task', async () => {
  let sequence = 0;
  let lookups = 0;
  const jobs = fakeJobs({
    async submit() { return { id: `job-${++sequence}`, status: 'accepted' }; },
    get(id) { lookups += 1; return { id, status: 'completed', spokenReply: '完成。' }; },
  });
  const handle = createMcpHandler({ jobs, automaticChecks: 4, now: () => 0 });
  const old = continuationArgs(await handle(call(1, 'ask_grok_bot', { question: '最早任务' })));
  let latest;
  for (let id = 2; id <= 129; id += 1) latest = await handle(call(id, 'ask_grok_bot', { question: '其他任务' }));
  assert.equal((await handle(call(200, 'check_grok_task', old))).error.code, -32602);
  assert.equal(lookups, 0);
  const current = continuationArgs(latest);
  assert.equal(decode(await handle(call(201, 'check_grok_task', current))).status, 'completed');
  handle.resetSession();
  assert.equal((await handle(call(202, 'check_grok_task', current))).error.code, -32602);
  assert.equal(lookups, 1);
});

test('automatic checking validates its bounds and advertises the opt-in continuation instructions', async () => {
  for (const options of [{ automaticChecks: -1 }, { automaticChecks: 13 }, { automaticChecks: 0.5 }, { automaticCheckBudgetMs: 0 }, { automaticCheckBudgetMs: 90001 }, { now: 1 }]) {
    assert.throws(() => createMcpHandler({ jobs: fakeJobs(), ...options }), TypeError);
  }
  const handle = createMcpHandler({ jobs: fakeJobs(), automaticChecks: 4 });
  const initialized = await handle(rpc(1, 'initialize', { protocolVersion: '2025-06-18' }));
  assert.match(initialized.result.instructions, /累计时间/);
  const listed = await handle(rpc(2, 'tools/list'));
  assert.match(listed.result.tools[0].description, /有界自动续查/);
  assert.ok(listed.result.tools[1].inputSchema.properties.continuation_token);
});

test('a ninety-second flow can complete after thirty seconds without resubmitting its task', async () => {
  let clock = 0;
  const lookups = [];
  const jobs = fakeJobs({
    async submit(question, options) {
      this.submissions.push({ question, options });
      clock = 4500;
      return { id: 'job-90', status: 'accepted' };
    },
    get(id, options) {
      lookups.push({ id, options });
      return { id, status: 'completed', spokenReply: '超过三十秒后取得的真实答复。' };
    },
  });
  const handle = createMcpHandler({ jobs, automaticChecks: 12, automaticCheckBudgetMs: 90000, interimSpeech: true, now: () => clock });
  const pending = await handle(call(1, 'ask_grok_bot', { question: '较长任务只提交一次' }));
  const args = continuationArgs(pending);
  clock = 45000;
  const completed = await handle(call(2, 'check_grok_task', args));
  assert.deepEqual(lookups, [{ id: 'job-90', options: { waitMs: 45000 } }]);
  assert.equal(decode(completed).speech, '超过三十秒后取得的真实答复。');
  assert.equal(decode(completed).continuation_token, undefined);
  assert.deepEqual((await handle(call(3, 'check_grok_task', args))).result, completed.result);
  assert.equal(lookups.length, 1);
  assert.equal(jobs.submissions.length, 1);
});

test('ninety-second continuations retain the original deadline across replays and stop at expiry', async () => {
  let clock = 0;
  const lookups = [];
  const jobs = fakeJobs({
    get(id, options) {
      lookups.push({ id, options });
      clock += Math.min(4500, options.waitMs);
      return { id, status: 'accepted' };
    },
  });
  const handle = createMcpHandler({ jobs, automaticChecks: 12, automaticCheckBudgetMs: 90000, interimSpeech: true, now: () => clock });
  const firstArgs = continuationArgs(await handle(call(1, 'ask_grok_bot', { question: '保持同一任务及截止时间' })));
  clock = 35000;
  const first = await handle(call(2, 'check_grok_task', firstArgs));
  assert.equal(decode(first).automatic_checks_remaining, 11);
  clock = 70000;
  assert.deepEqual((await handle(call(3, 'check_grok_task', firstArgs))).result, first.result);
  assert.equal(lookups.length, 1);
  clock = 89999;
  const stopped = await handle(call(4, 'check_grok_task', continuationArgs(first)));
  assert.deepEqual(lookups, [
    { id: 'job-1', options: { waitMs: 55000 } },
    { id: 'job-1', options: { waitMs: 1 } },
  ]);
  assert.equal(clock, 90000);
  assert.equal(decode(stopped).continuation_token, undefined);
  assert.match(stopped.result.content[0].text, /本轮自动等待已结束/);
  assert.doesNotMatch(stopped.result.content[0].text, /我还在等格洛克/);
  assert.equal(jobs.submissions.length, 1);
});

test('twelve automatic checks are the maximum and replays never add queries or submissions', async () => {
  let lookups = 0;
  const jobs = fakeJobs({ get(id) { lookups += 1; return { id, status: 'accepted' }; } });
  const handle = createMcpHandler({ jobs, automaticChecks: 12, automaticCheckBudgetMs: 90000, interimSpeech: true, now: () => 0 });
  let result = await handle(call(1, 'ask_grok_bot', { question: '十二次查询仍只安排一次任务' }));
  const tokens = new Set();
  for (let index = 0; index < 12; index += 1) {
    const args = continuationArgs(result);
    assert.equal(args.task_id, 'job-1');
    assert.equal(decode(result).automatic_checks_remaining, 12 - index);
    assert.equal(tokens.has(args.continuation_token), false);
    tokens.add(args.continuation_token);
    result = await handle(call(2 + index * 2, 'check_grok_task', args));
    assert.deepEqual((await handle(call(3 + index * 2, 'check_grok_task', args))).result, result.result);
    assert.equal(lookups, index + 1);
  }
  assert.equal(decode(result).continuation_token, undefined);
  assert.match(result.result.content[0].text, /本轮自动等待已结束/);
  assert.doesNotMatch(result.result.content[0].text, /我还在等格洛克/);
  assert.equal((await handle(call(30, 'check_grok_task', { task_id: 'job-1', continuation_token: 'not-issued' }))).error.code, -32602);
  assert.equal(lookups, 12);
  assert.equal(jobs.submissions.length, 1);
});

test('until-result mode validates its name, advertises cancellation and leaves bounded schemas unchanged', async () => {
  for (const automaticWaitMode of [null, false, 1, 'infinite', {}, []]) {
    assert.throws(() => createMcpHandler({ jobs: fakeJobs(), automaticWaitMode }), TypeError);
  }
  const handle = createMcpHandler({ jobs: fakeJobs(), automaticWaitMode: 'until_result', interimSpeech: true });
  const initialized = await handle(rpc(1, 'initialize', { protocolVersion: '2025-06-18' }));
  assert.match(initialized.result.instructions, /不设置.*总时长或次数上限/);
  assert.match(initialized.result.instructions, /云端可能结束或中断当前会话/);
  assert.match(initialized.result.instructions, /用户要求停止.*cancel_grok_wait/);
  assert.doesNotMatch(initialized.result.instructions, /工具限制了自动查询次数和累计时间|播报不增加查询次数/);
  const listed = await handle(rpc(2, 'tools/list'));
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ['ask_grok_bot', 'check_grok_task', 'cancel_grok_wait']);
  assert.match(listed.result.tools[0].description, /持续等待模式没有自动续查总时长或次数上限/);
  assert.match(listed.result.tools[0].description, /我还在等格洛克的回复，再查一下。/);
  assert.equal(listed.result.tools[2].annotations.destructiveHint, false);
  assert.equal(listed.result.tools[2].inputSchema.additionalProperties, false);
  const bounded = createMcpHandler({ jobs: fakeJobs(), automaticChecks: 4 });
  assert.equal((await bounded(call(3, 'cancel_grok_wait'))).error.code, -32602);
});

test('until-result mode continues beyond ninety seconds and twelve checks but submits only once', async () => {
  let clock = 0;
  let lookups = 0;
  const jobs = fakeJobs({
    get(id, options) {
      assert.equal(options, undefined, 'The voice adapter owns the finite per-call budget.');
      lookups += 1;
      clock += 10000;
      return { id, status: lookups === 20 ? 'completed' : 'running', spokenReply: '等待超过原有上限后取得的真实答复。' };
    },
  });
  const handle = createMcpHandler({ jobs, automaticWaitMode: 'until_result', automaticChecks: 0, automaticCheckBudgetMs: 1, now: () => clock });
  let result = await handle(call(1, 'ask_grok_bot', { question: '持续等待同一任务' }));
  for (let index = 0; index < 20; index += 1) {
    const args = continuationArgs(result);
    assert.equal(args.task_id, 'job-1');
    assert.equal(decode(result).automatic_checks_remaining, null);
    assert.equal(decode(result).automatic_wait_mode, 'until_result');
    result = await handle(call(index + 2, 'check_grok_task', args));
  }
  assert.equal(clock, 200000);
  assert.equal(lookups, 20);
  assert.equal(decode(result).status, 'completed');
  assert.equal(decode(result).continuation_token, undefined);
  assert.equal(decode(result).speech, '等待超过原有上限后取得的真实答复。');
  assert.equal(jobs.submissions.length, 1);
});

test('over a thousand token rotations retain another live flow while historical replays expire safely', async () => {
  let lookups = 0;
  const jobs = fakeJobs({
    async submit(question, options) {
      this.submissions.push({ question, options });
      return { id: question, status: 'running' };
    },
    get(id) { lookups += 1; return { id, status: 'running' }; },
  });
  const handle = createMcpHandler({ jobs, automaticWaitMode: 'until_result' });
  const parked = continuationArgs(await handle(call(1, 'ask_grok_bot', { question: 'parked' })));
  let result = await handle(call(2, 'ask_grok_bot', { question: 'rotating' }));
  const oldest = continuationArgs(result);
  let previous;
  let previousResult;
  for (let index = 0; index < 1100; index += 1) {
    previous = continuationArgs(result);
    result = await handle(call(index + 3, 'check_grok_task', previous));
    previousResult = result.result;
  }
  assert.equal(lookups, 1100);
  assert.equal((await handle(call(2000, 'check_grok_task', oldest))).error.code, -32602);
  assert.equal(lookups, 1100, 'An evicted historical token must not become a manual lookup.');
  assert.deepEqual((await handle(call(2001, 'check_grok_task', previous))).result, previousResult);
  assert.equal(lookups, 1100);
  assert.ok(continuationArgs(await handle(call(2002, 'check_grok_task', parked))).continuation_token);
  assert.equal(lookups, 1101, 'A parked current capability must survive unrelated historical rotations.');
  assert.equal(jobs.submissions.length, 2);
});

test('until-result concurrent token replays share one lookup and cannot branch the continuation', async () => {
  let release;
  let lookups = 0;
  const jobs = fakeJobs({ get() { lookups += 1; return new Promise(resolve => { release = resolve; }); } });
  const handle = createMcpHandler({ jobs, automaticWaitMode: 'until_result' });
  const args = continuationArgs(await handle(call(1, 'ask_grok_bot', { question: '不得分叉续查' })));
  const first = handle(call(2, 'check_grok_task', args));
  const concurrent = handle(call(3, 'check_grok_task', args));
  await tick();
  assert.equal(lookups, 1);
  release({ id: 'job-1', status: 'running' });
  const [one, two] = await Promise.all([first, concurrent]);
  assert.deepEqual(one.result, two.result);
  assert.deepEqual((await handle(call(4, 'check_grok_task', args))).result, one.result);
  const repeatAsk = await handle(call(5, 'ask_grok_bot', { question: '不得分叉续查', request_key: 'same-task' }));
  assert.deepEqual(continuationArgs(repeatAsk), continuationArgs(one));
  assert.equal(lookups, 1);
});

test('cancelling until-result waiting never cancels the Bot or revives the chain on a repeated ask', async () => {
  let lookups = 0;
  const jobs = fakeJobs({ get(id) { lookups += 1; return { id, status: 'completed', spokenReply: '任务仍可完成和手动查询。' }; } });
  const handle = createMcpHandler({ jobs, automaticWaitMode: 'until_result' });
  const submitted = await handle(call(1, 'ask_grok_bot', { question: '只停止本机等待', request_key: 'same-task' }));
  const args = continuationArgs(submitted);
  const cancelled = await handle(call(2, 'cancel_grok_wait', { task_id: 'job-1' }));
  assert.equal(decode(cancelled).status, 'wait_cancelled');
  assert.equal(decode(cancelled).task_id, 'job-1');
  assert.match(decode(cancelled).speech, /任务本身未取消/);
  assert.equal(lookups, 0);
  for (const result of [
    await handle(call(3, 'check_grok_task', args)),
    await handle(call(4, 'cancel_grok_wait', { task_id: 'job-1' })),
    await handle(call(5, 'ask_grok_bot', { question: '只停止本机等待', request_key: 'same-task' })),
  ]) {
    assert.equal(decode(result).status, 'wait_cancelled');
    assert.equal(decode(result).continuation_token, undefined);
  }
  assert.equal(lookups, 0);
  const manual = await handle(call(6, 'check_grok_task', { task_id: 'job-1' }));
  assert.equal(decode(manual).speech, '任务仍可完成和手动查询。');
  assert.equal(decode(manual).continuation_token, undefined);
  assert.equal(lookups, 1);
});

test('cancelling an in-flight query stops its pending response from offering another token', async () => {
  let release;
  let lookups = 0;
  const jobs = fakeJobs({ get() { lookups += 1; return new Promise(resolve => { release = resolve; }); } });
  const handle = createMcpHandler({ jobs, automaticWaitMode: 'until_result' });
  const args = continuationArgs(await handle(call(1, 'ask_grok_bot', { question: '查询中也可停止等待' })));
  const pending = handle(call(2, 'check_grok_task', args));
  await tick();
  const cancelled = await handle(call(3, 'cancel_grok_wait'));
  assert.equal(decode(cancelled).status, 'wait_cancelled');
  release({ id: 'job-1', status: 'completed', spokenReply: '取消后到达的内容不能重启自动播报。' });
  assert.deepEqual((await pending).result, cancelled.result);
  assert.deepEqual((await handle(call(4, 'check_grok_task', args))).result, cancelled.result);
  assert.equal(lookups, 1);
  assert.equal(decode(await handle(call(5, 'ask_grok_bot', { question: '查询中也可停止等待' }))).status, 'wait_cancelled');
});

test('until-result manual queries never create a chain and cancellation validates exact task arguments', async () => {
  const lookups = [];
  const jobs = fakeJobs({
    async submit(question) { return { id: question, status: 'running' }; },
    get(id) { lookups.push(id); return { id, status: 'running' }; },
  });
  const handle = createMcpHandler({ jobs, automaticWaitMode: 'until_result' });
  const manual = await handle(call(1, 'check_grok_task', { task_id: 'manual-only' }));
  assert.equal(decode(manual).continuation_token, undefined);
  assert.deepEqual(lookups, ['manual-only']);
  assert.match(decode(await handle(call(2, 'cancel_grok_wait', { task_id: 'manual-only' }))).speech, /没有找到正在自动等待/);
  const first = continuationArgs(await handle(call(3, 'ask_grok_bot', { question: 'first' })));
  const second = continuationArgs(await handle(call(4, 'ask_grok_bot', { question: 'second' })));
  for (const invalid of [{ task_id: '../bad' }, { task_id: '' }, { task_id: 1 }, { extra: true }]) {
    assert.equal((await handle(call(Math.random(), 'cancel_grok_wait', invalid))).error.code, -32602);
  }
  assert.equal(decode(await handle(call(5, 'cancel_grok_wait'))).task_id, 'second');
  assert.equal(decode(await handle(call(6, 'check_grok_task', second))).status, 'wait_cancelled');
  assert.ok(continuationArgs(await handle(call(7, 'check_grok_task', first))).continuation_token);
  assert.deepEqual(lookups, ['manual-only', 'first']);
});

test('until-result terminal replies and errors end the chain without resubmission or extra lookups', async () => {
  for (const status of ['completed', 'failed', 'needs_input', 'error']) {
    let lookups = 0;
    const jobs = fakeJobs({
      get(id) {
        lookups += 1;
        if (status === 'error') throw new Error('Private transport failure.');
        return { id, status, spokenReply: '真实的结束回复或待补充问题。' };
      },
    });
    const handle = createMcpHandler({ jobs, automaticWaitMode: 'until_result' });
    const args = continuationArgs(await handle(call(1, 'ask_grok_bot', { question: '终态和错误都应停止' })));
    const ended = await handle(call(2, 'check_grok_task', args));
    assert.equal(decode(ended).continuation_token, undefined);
    if (status === 'error') {
      assert.equal(ended.result.isError, true);
      assert.match(ended.result.content[0].text, /请停止自动查询/);
    } else assert.equal(decode(ended).status, status);
    assert.deepEqual((await handle(call(3, 'check_grok_task', args))).result, ended.result);
    const repeatAsk = await handle(call(4, 'ask_grok_bot', { question: '终态和错误都应停止' }));
    assert.deepEqual(repeatAsk.result, ended.result);
    assert.equal(lookups, 1);
  }
});

test('session reset invalidates an until-result token even while its lookup is in flight', async () => {
  let release;
  let lookups = 0;
  const jobs = fakeJobs({ get() { lookups += 1; return new Promise(resolve => { release = resolve; }); } });
  const handle = createMcpHandler({ jobs, automaticWaitMode: 'until_result' });
  const args = continuationArgs(await handle(call(1, 'ask_grok_bot', { question: '会话重置不能恢复旧续查' })));
  const pending = handle(call(2, 'check_grok_task', args));
  await tick();
  handle.resetSession();
  release({ id: 'job-1', status: 'running' });
  assert.equal(decode(await pending).continuation_token, undefined);
  assert.equal((await handle(call(3, 'check_grok_task', args))).error.code, -32602);
  assert.equal(lookups, 1);
});

test('interim speech is a validated opt-in and leaves default instructions unchanged', async () => {
  for (const interimSpeech of [null, 0, 1, 'true', {}]) {
    assert.throws(() => createMcpHandler({ jobs: fakeJobs(), interimSpeech }), TypeError);
  }
  for (const automaticChecks of [0, 4]) {
    const omitted = createMcpHandler({ jobs: fakeJobs(), automaticChecks });
    const disabled = createMcpHandler({ jobs: fakeJobs(), automaticChecks, interimSpeech: false });
    const enabled = createMcpHandler({ jobs: fakeJobs(), automaticChecks, interimSpeech: true });
    for (const request of [rpc(1, 'initialize', { protocolVersion: '2025-06-18' }), rpc(2, 'tools/list')]) {
      const original = await omitted(request);
      assert.deepEqual(await disabled(request), original);
      assert.doesNotMatch(JSON.stringify(original), /等待期间的语音衔接|我还在等格洛克/);
      const withSpeech = await enabled(request);
      if (!automaticChecks) assert.deepEqual(withSpeech, original);
      else if (request.method === 'initialize') assert.match(withSpeech.result.instructions, /原有音色只朗读一句/);
      else {
        for (const tool of withSpeech.result.tools) assert.match(tool.description, /等待期间的语音衔接/);
        assert.deepEqual(withSpeech.result.tools.map(tool => tool.inputSchema), original.result.tools.map(tool => tool.inputSchema));
      }
    }
  }
});

test('interim speech keeps exact continuation arguments, replay protection and query limits', async () => {
  const queried = [];
  const jobs = fakeJobs({ get(id, options) { queried.push({ id, waitMs: options.waitMs }); return { id, status: 'accepted' }; } });
  const handle = createMcpHandler({ jobs, automaticChecks: 2, interimSpeech: true, now: () => 0 });
  const submitted = await handle(call(1, 'ask_grok_bot', { question: '同一个任务，等待时简短播报' }));
  const firstArgs = continuationArgs(submitted);
  assert.match(submitted.result.content[0].text, /先用 StackChan 原有音色只朗读一句“我还在等格洛克的回复，再查一下。”/);
  assert.ok(submitted.result.content[0].text.includes(JSON.stringify(firstArgs)));
  assert.equal((await handle(call(2, 'check_grok_task', { ...firstArgs, task_id: 'another-task' }))).error.code, -32602);
  assert.equal(queried.length, 0);
  const first = await handle(call(3, 'check_grok_task', firstArgs));
  assert.deepEqual((await handle(call(4, 'check_grok_task', firstArgs))).result, first.result);
  const secondArgs = continuationArgs(first);
  assert.equal(secondArgs.task_id, firstArgs.task_id);
  assert.notEqual(secondArgs.continuation_token, firstArgs.continuation_token);
  assert.equal(decode(first).automatic_checks_remaining, 1);
  const stopped = await handle(call(5, 'check_grok_task', secondArgs));
  assert.equal(decode(stopped).continuation_token, undefined);
  assert.match(stopped.result.content[0].text, /本轮自动等待已结束/);
  assert.doesNotMatch(stopped.result.content[0].text, /我还在等格洛克/);
  assert.deepEqual(queried, [{ id: 'job-1', waitMs: 30000 }, { id: 'job-1', waitMs: 30000 }]);
  assert.equal(jobs.submissions.length, 1);
});

test('interim speech never extends the deadline or changes terminal replies', async () => {
  let clock = 0;
  let lookups = 0;
  const budgeted = createMcpHandler({
    jobs: fakeJobs({ get() { lookups += 1; throw new Error('Expired speech continuation must not query.'); } }),
    automaticChecks: 4, automaticCheckBudgetMs: 100, interimSpeech: true, now: () => clock,
  });
  const args = continuationArgs(await budgeted(call(1, 'ask_grok_bot', { question: '短预算也不能延长' })));
  clock = 100;
  const expired = await budgeted(call(2, 'check_grok_task', args));
  assert.equal(lookups, 0);
  assert.doesNotMatch(expired.result.content[0].text, /我还在等格洛克/);
  assert.equal(decode(expired).continuation_token, undefined);
  for (const status of ['completed', 'failed', 'needs_input']) {
    const finalJob = { id: 'job-1', status, spokenReply: '原有的真实答复或待补充问题。' };
    const baseline = createMcpHandler({ jobs: fakeJobs({ async submit() { return finalJob; } }), automaticChecks: 4 });
    const handle = createMcpHandler({ jobs: fakeJobs({ get() { return finalJob; } }), automaticChecks: 4, interimSpeech: true });
    const continuation = continuationArgs(await handle(call(1, 'ask_grok_bot', { question: '终态答复保持原样' })));
    const actual = await handle(call(2, 'check_grok_task', continuation));
    const original = await baseline(call(2, 'ask_grok_bot', { question: '终态答复保持原样' }));
    assert.deepEqual(actual.result, original.result);
    assert.doesNotMatch(actual.result.content[0].text, /等待期间的语音衔接|我还在等格洛克/);
  }
});

test('invalid requests and excessive inputs never submit jobs', async () => {
  const jobs = fakeJobs();
  const handle = createMcpHandler({ jobs });
  for (const args of [{}, { question: '' }, { question: ' ' }, { question: 'a'.repeat(4001) }, { question: 'ok', request_key: 'bad key' }, { question: 'ok', unexpected: true }]) {
    assert.equal((await handle(call(Math.random(), 'ask_grok_bot', args))).error.code, -32602);
  }
  assert.equal((await handle(call(1, 'check_grok_task', { task_id: '../secret' }))).error.code, -32602);
  assert.equal((await handle(call(2, 'does-not-exist'))).error.code, -32602);
  assert.equal((await handle(rpc(3, 'unknown'))).error.code, -32601);
  assert.equal((await handle(rpc(4, 'tools/list', []))).error.code, -32602);
  assert.equal((await handle([])).error.code, -32600);
  assert.equal((await handle({ jsonrpc: '2.0', id: {}, method: 'ping' })).error.code, -32600);
  assert.equal((await handle(rpc(5, 'tools/list', { large: 'a'.repeat(65536) }))).error.code, -32600);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'ask_grok_bot', arguments: { question: 'must not submit notification' } } }), null);
  assert.equal(await handle({ jsonrpc: '2.0', id: 1, result: {} }), null);
  assert.equal(jobs.submissions.length, 0);
});

test('execution errors and credential-bearing result text are sanitized', async () => {
  const jobs = fakeJobs({
    async submit() { throw new Error('wss://secret.invalid/?token=SECRET'); },
    latest() { return { id: 'job-1', status: 'completed', spokenReply: '地址 wss://secret.invalid/?token=SECRET 和 https://x.invalid/?token=SECRET' }; },
  });
  const handle = createMcpHandler({ jobs });
  const submitAnswer = await handle(call(1, 'ask_grok_bot', { question: 'hello' }));
  assert.equal(submitAnswer.result.isError, true);
  assert.doesNotMatch(JSON.stringify(submitAnswer), /SECRET|secret.invalid/);
  assert.doesNotMatch(JSON.stringify(await handle(call(2, 'check_grok_task'))), /SECRET/);
});

test('endpoint validation only accepts secure WebSocket URLs and masks invalid input', () => {
  for (const endpoint of ['ws://x.invalid/?token=SECRET', 'https://x.invalid/?token=SECRET', 'SECRET', 'wss://user:SECRET@x.invalid/', 'wss://x.invalid/#SECRET']) {
    assert.throws(() => connectMcp({ endpoint, handler: () => {} }), error => !error.message.includes('SECRET') && /wss/.test(error.message));
  }
});

test('transport serializes line messages, returns parse errors and stops without reconnecting', async () => {
  const jobs = fakeJobs();
  const logs = [];
  const transport = connect({ handler: createMcpHandler({ jobs }), logger: event => logs.push(event) });
  try {
    const ws = FakeSocket.instances[0];
    ws.open();
    assert.equal(transport.status, 'connected');
    ws.receive(`${JSON.stringify(rpc(1, 'ping'))}\nnot json\n${JSON.stringify(call(2, 'ask_grok_bot', { question: 'test' }))}\n`);
    await until(() => ws.sent.length === 3);
    assert.deepEqual(ws.sent[0].result, {});
    assert.equal(ws.sent[1].error.code, -32700);
    assert.equal(decode(ws.sent[2]).status, 'accepted');
    assert.equal(jobs.submissions.length, 1);
    ws.receive(JSON.stringify(call(2, 'ask_grok_bot', { question: 'test' })));
    await until(() => ws.sent.length === 4);
    assert.equal(jobs.submissions.length, 1);
    transport.stop();
    await transport.done;
    assert.equal(transport.status, 'stopped');
    assert.equal(FakeSocket.instances.length, 1);
    assert.doesNotMatch(logs.join(' '), /FAKE_SECRET|example.invalid|token/);
  } finally { transport.stop(); await transport.done; }
});

test('transport reconnects outbound and resets handler session; abort cancels retries', async () => {
  const jobs = fakeJobs();
  const handle = createMcpHandler({ jobs });
  const controller = new AbortController();
  const transport = connect({ handler: handle, signal: controller.signal });
  try {
    const request = JSON.stringify(call(8, 'ask_grok_bot', { question: 'same rpc id, a new session' }));
    const first = FakeSocket.instances[0];
    first.open();
    first.receive(request);
    await until(() => first.sent.length === 1);
    first.close();
    await until(() => FakeSocket.instances.length === 2);
    const second = FakeSocket.instances[1];
    second.open();
    second.receive(request);
    await until(() => second.sent.length === 1);
    assert.equal(jobs.submissions.length, 2);
    assert.notEqual(jobs.submissions[0].options.requestKey, jobs.submissions[1].options.requestKey);
    controller.abort();
    await transport.done;
    assert.equal(transport.status, 'stopped');
    assert.equal(second.readyState, 3);
  } finally { transport.stop(); await transport.done; }
});

test('transport drops queued work after a disconnect and never replays it on a new socket', async () => {
  let release;
  let count = 0;
  const handler = async message => {
    count += 1;
    await new Promise(resolve => { release = resolve; });
    return { jsonrpc: '2.0', id: message.id, result: {} };
  };
  const transport = connect({ handler });
  try {
    const first = FakeSocket.instances[0];
    first.open();
    first.receive(`${JSON.stringify(rpc(1, 'ping'))}\n${JSON.stringify(rpc(2, 'ping'))}`);
    await until(() => count === 1);
    first.close();
    release();
    await until(() => FakeSocket.instances.length === 2);
    assert.equal(count, 1);
    assert.equal(first.sent.length, 0);
    assert.equal(FakeSocket.instances[1].sent.length, 0);
  } finally { release?.(); transport.stop(); await transport.done; }
});

test('oversized frames close the socket without invoking the handler', async () => {
  let count = 0;
  const transport = connect({ handler: async () => { count += 1; } });
  try {
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.receive('a'.repeat(65537));
    await tick();
    assert.equal(ws.readyState, 3);
    assert.equal(count, 0);
  } finally { transport.stop(); await transport.done; }
});

test('constructor failures reconnect with sanitized events and can be stopped', async () => {
  const logs = [];
  let attempts = 0;
  class ThrowingSocket {
    constructor(url) { attempts += 1; throw new Error(`Cannot connect to ${url}`); }
  }
  const transport = connect({ WebSocketImpl: ThrowingSocket, logger: event => logs.push(event) });
  try {
    await until(() => attempts >= 2);
    assert.equal(transport.status, 'reconnecting');
    assert.doesNotMatch(logs.join(' '), /FAKE_SECRET|example.invalid|token/);
    assert.ok(logs.includes('mcp_connection_failed'));
  } finally { transport.stop(); await transport.done; }
});

test('an unopened socket times out and reconnects without leaking peer error data', async () => {
  const logs = [];
  const transport = connect({ connectTimeoutMs: 5, logger: event => logs.push(event) });
  try {
    await until(() => FakeSocket.instances.length === 2);
    assert.equal(FakeSocket.instances[0].readyState, 3);
    assert.ok(logs.includes('mcp_connect_timeout'));
    assert.doesNotMatch(logs.join(' '), /FAKE_SECRET|example.invalid|token/);
  } finally { transport.stop(); await transport.done; }
});

test('an already-aborted transport never opens a socket', async () => {
  const controller = new AbortController();
  controller.abort();
  const transport = connect({ signal: controller.signal });
  await transport.done;
  assert.equal(transport.status, 'stopped');
  assert.equal(FakeSocket.instances.length, 0);
});
