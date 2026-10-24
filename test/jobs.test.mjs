import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobManager } from '../lib/jobs.mjs';

const config = {
  callbackMode: 'direct',
  grokWebhookUrl: 'https://bot.example.invalid/webhook',
  grokWebhookKey: 'test-webhook-key-do-not-log',
  callbackBaseUrl: 'https://callback.example.invalid',
  mcpEndpoint: 'wss://mcp.example.invalid/mcp/?token=test-mcp-token-do-not-log',
};

function fixture(t, fetchImpl = async () => ({ ok: true, status: 200 }), settings = config, extra = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'stackchan-jobs-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return { manager: new JobManager({ config: settings, dataDir, fetchImpl, ...extra }), dataDir };
}

test('webhook acceptance is not completion, and outward values omit all secrets', async (t) => {
  let sent;
  const { manager, dataDir } = fixture(t, async (url, options) => {
    sent = { url, ...options, payload: JSON.parse(options.body) };
    return { ok: true, status: 200 };
  });
  const result = await manager.submit('帮我问 Grok Bot 今天的安排', { requestKey: 'voice-turn-1' });
  assert.equal(result.status, 'accepted');
  assert.equal(result.spokenReply, null);
  assert.equal(sent.headers.Authorization, `Bearer ${config.grokWebhookKey}`);
  assert.equal(sent.redirect, 'error');
  assert.ok(sent.signal instanceof AbortSignal);
  assert.equal(sent.payload.callback_url, `${config.callbackBaseUrl}/callbacks/grok/${result.id}`);
  assert.equal(sent.payload.request_id, result.id);
  assert.equal(sent.payload.callback_contract.body.request_id, result.id);
  assert.match(sent.payload.instructions, /request_id/);
  for (const outward of [result, manager.get(result.id), manager.latest()]) {
    const text = JSON.stringify(outward);
    assert.ok(!text.includes(config.grokWebhookKey));
    assert.ok(!text.includes(sent.payload.callback_token));
    assert.ok(!text.includes('callbackToken'));
  }
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dataDir, 'jobs-state.json')).mode & 0o777, 0o600);
});

test('callbacks require the job token, validate content, and protect final results', async (t) => {
  let payload;
  const { manager } = fixture(t, async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, status: 202 };
  });
  const submitted = await manager.submit('请处理我的安排');
  await assert.rejects(manager.acceptCallback(submitted.id, 'bad-token', {
    request_id: submitted.id, status: 'completed', spoken_reply: '已经完成。',
  }), { code: 'CALLBACK_UNAUTHORIZED' });
  await assert.rejects(manager.acceptCallback(submitted.id, payload.callback_token, {
    request_id: submitted.id, status: 'accepted', spoken_reply: '已经完成。',
  }), { code: 'INVALID_CALLBACK' });
  await assert.rejects(manager.acceptCallback(submitted.id, payload.callback_token, {
    request_id: 'another-request', status: 'completed', spoken_reply: '已经完成。',
  }), { code: 'INVALID_CALLBACK' });
  const needsInput = await manager.acceptCallback(submitted.id, payload.callback_token, {
    request_id: submitted.id, status: 'needs_input', spoken_reply: '请提供日期。',
  });
  assert.equal(needsInput.status, 'needs_input');
  const completed = await manager.acceptCallback(submitted.id, payload.callback_token, {
    request_id: submitted.id, status: 'completed', spoken_reply: '已经为你安排好了。',
  });
  const duplicate = await manager.acceptCallback(submitted.id, payload.callback_token, {
    request_id: submitted.id, status: 'completed', spoken_reply: '已经为你安排好了。',
  });
  assert.deepEqual(duplicate, completed);
  await assert.rejects(manager.acceptCallback(submitted.id, payload.callback_token, {
    request_id: submitted.id, status: 'failed', spoken_reply: '更改先前结果。',
  }), { code: 'CALLBACK_CONFLICT' });
  assert.deepEqual(manager.get(submitted.id), completed);
});

test('request keys deduplicate in-flight and persisted submissions and reject different questions', async (t) => {
  let calls = 0;
  let resolveFetch;
  const fetchImpl = async () => {
    calls++;
    return await new Promise((resolve) => { resolveFetch = resolve; });
  };
  const { manager, dataDir } = fixture(t, fetchImpl);
  const first = manager.submit('帮我查询一次', { requestKey: 'stable-turn' });
  const persisted = manager.getByRequestKey('stable-turn');
  assert.equal(persisted.status, 'dispatching');
  assert.equal(persisted.question, '帮我查询一次');
  assert.equal(persisted.callbackToken, undefined);
  assert.equal(manager.getByRequestKey('missing-key'), null);
  assert.equal(manager.getByRequestKey(undefined), null);
  persisted.question = '不能修改内部任务';
  const inFlight = await manager.submit('帮我查询一次', { requestKey: 'stable-turn' });
  assert.equal(inFlight.status, 'dispatching');
  await assert.rejects(manager.submit('改成另一件事', { requestKey: 'stable-turn' }), {
    code: 'REQUEST_KEY_CONFLICT',
  });
  resolveFetch({ ok: true, status: 200 });
  const accepted = await first;
  const restarted = new JobManager({ config, dataDir, fetchImpl });
  assert.deepEqual(restarted.getByRequestKey('stable-turn'), accepted);
  assert.deepEqual(await restarted.submit('帮我查询一次', { requestKey: 'stable-turn' }), accepted);
  assert.equal(calls, 1);
});

test('a timeout or network error is unknown and is never automatically retried', async (t) => {
  let calls = 0;
  const { manager, dataDir } = fixture(t, async () => {
    calls++;
    throw new DOMException(`timeout with ${config.grokWebhookKey}`, 'TimeoutError');
  });
  const result = await manager.submit('帮我安排一次', { requestKey: 'one-arrangement' });
  assert.equal(result.status, 'unknown');
  assert.ok(!JSON.stringify(result).includes(config.grokWebhookKey));
  const restarted = new JobManager({ config, dataDir, fetchImpl: async () => { calls++; } });
  assert.deepEqual(await restarted.submit('帮我安排一次', { requestKey: 'one-arrangement' }), result);
  assert.equal(calls, 1);
});

test('a restart during dispatch recovers as unknown and preserves callback authentication', async (t) => {
  let payload;
  const { manager, dataDir } = fixture(t, async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, status: 200 };
  });
  const original = await manager.submit('查询进度', { requestKey: 'restart-turn' });
  const filename = join(dataDir, 'jobs-state.json');
  const saved = JSON.parse(readFileSync(filename, 'utf8'));
  saved.jobs[0].status = 'dispatching';
  writeFileSync(filename, JSON.stringify(saved));
  const restarted = new JobManager({ config, dataDir, fetchImpl: async () => assert.fail('must not redispatch') });
  assert.equal(restarted.latest().status, 'unknown');
  assert.equal((await restarted.submit('查询进度', { requestKey: 'restart-turn' })).id, original.id);
  const completed = await restarted.acceptCallback(original.id, payload.callback_token, {
    request_id: original.id, status: 'completed', spoken_reply: '查到了，今天没有其他安排。',
  });
  assert.equal(completed.status, 'completed');
});

test('a fast callback arriving during webhook dispatch is retained', async (t) => {
  let manager;
  ({ manager } = fixture(t, async (_url, options) => {
    const payload = JSON.parse(options.body);
    await manager.acceptCallback(payload.request_id, payload.callback_token, {
      request_id: payload.request_id, status: 'completed', spoken_reply: '已完成查询。',
    });
    return { ok: true, status: 200 };
  }));
  const job = await manager.submit('快速查询');
  assert.equal(job.status, 'completed');
  assert.equal(job.spokenReply, '已完成查询。');
});

test('missing or unsafe configuration never triggers Grok Bot', async (t) => {
  let calls = 0;
  for (const settings of [
    {},
    { ...config, grokWebhookUrl: 'file:///tmp/not-a-webhook' },
    { ...config, grokWebhookUrl: 'http://example.invalid' },
    { ...config, callbackBaseUrl: 'https://localhost' },
    { ...config, callbackBaseUrl: 'https://127.0.0.1' },
    { ...config, callbackBaseUrl: 'https://192.168.1.10' },
    { ...config, callbackBaseUrl: 'https://[::1]' },
    { ...config, callbackBaseUrl: 'https://example.invalid?secret=hidden' },
  ]) {
    const { manager } = fixture(t, async () => { calls++; }, settings);
    await assert.rejects(manager.submit('安全配置检查'), { code: 'CONFIG_REQUIRED' });
    assert.equal(manager.latest(), null);
  }
  assert.equal(calls, 0);
});

test('spoken replies containing an exact known secret are rejected without echoing it', async (t) => {
  let payload;
  const { manager } = fixture(t, async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, status: 200 };
  });
  const job = await manager.submit('查询进度');
  for (const secret of [payload.callback_token, config.grokWebhookKey, config.mcpEndpoint,
    new URL(config.mcpEndpoint).searchParams.get('token')]) {
    await assert.rejects(manager.acceptCallback(job.id, payload.callback_token, {
      request_id: job.id, status: 'completed', spoken_reply: `已完成，连接信息是 ${secret}`,
    }), (error) => {
      assert.equal(error.code, 'INVALID_CALLBACK');
      assert.ok(!error.message.includes(secret));
      return true;
    });
    assert.equal(manager.get(job.id).spokenReply, null);
    assert.equal(manager.get(job.id).status, 'accepted');
  }
  const completed = await manager.acceptCallback(job.id, payload.callback_token, {
    request_id: job.id, status: 'completed', spoken_reply: '已完成，正常回复中可以讨论 token 或 MCP。',
  });
  assert.equal(completed.status, 'completed');
});

const relayConfig = { ...config, callbackMode: 'relay', relayMasterToken: 'independent-mailbox-master-token' };

function mailbox() {
  const state = { results: [], registerCalls: 0, acknowledgments: [] };
  return Object.assign(state, {
    async register(id) {
      state.registerCalls++;
      return { callback_url: `${config.callbackBaseUrl}/callbacks/grok/${id}` };
    },
    async listResults() { return state.results; },
    async ack(id, revision) {
      state.acknowledgments.push({ id, revision });
      state.results = state.results.filter((entry) => entry.job_id !== id || entry.revision !== revision);
    },
  });
}

test('relay mode requires a client and never triggers Bot when registration fails', async (t) => {
  let botCalls = 0;
  const noRelay = fixture(t, async () => { botCalls++; }, relayConfig);
  await assert.rejects(noRelay.manager.submit('安排事项'), { code: 'CONFIG_REQUIRED' });
  assert.equal(noRelay.manager.latest(), null);
  const relay = mailbox();
  relay.register = async () => { relay.registerCalls++; throw new Error(relayConfig.relayMasterToken); };
  const { manager, dataDir } = fixture(t, async () => { botCalls++; }, relayConfig, { relay });
  const job = await manager.submit('安排事项', { requestKey: 'registration-failed' });
  assert.equal(job.status, 'failed');
  assert.match(job.error, /尚未向 Grok Bot 发送/);
  assert.ok(!JSON.stringify(job).includes(relayConfig.relayMasterToken));
  const restarted = new JobManager({ config: relayConfig, dataDir, relay });
  assert.deepEqual(await restarted.submit('安排事项', { requestKey: 'registration-failed' }), job);
  assert.equal(relay.registerCalls, 1);
  assert.equal(botCalls, 0);
});

test('relay registration is persisted before Bot dispatch and cannot redirect its callback', async (t) => {
  const relay = mailbox();
  let dataDir;
  relay.register = async (id, token) => {
    const saved = JSON.parse(readFileSync(join(dataDir, 'jobs-state.json'), 'utf8')).jobs[0];
    assert.equal(saved.id, id);
    assert.equal(saved.callbackToken, token);
    assert.equal(saved.dispatchPhase, 'registering');
    return { callback_url: `${config.callbackBaseUrl}/callbacks/grok/${id}` };
  };
  let botCalls = 0;
  const created = fixture(t, async (_url, options) => {
    botCalls++;
    const payload = JSON.parse(options.body);
    assert.equal(payload.callback_url, `${config.callbackBaseUrl}/callbacks/grok/${payload.request_id}`);
    return { ok: true, status: 200 };
  }, relayConfig, { relay });
  dataDir = created.dataDir;
  assert.equal((await created.manager.submit('查询情况')).status, 'accepted');
  assert.equal(botCalls, 1);
  relay.register = async () => ({ callback_url: 'https://different.example.invalid/callback' });
  assert.equal((await created.manager.submit('另一事项')).status, 'failed');
  assert.equal(botCalls, 1);
});

test('relay results are durably saved before revision acknowledgment', async (t) => {
  const relay = mailbox();
  const { manager, dataDir } = fixture(t, undefined, relayConfig, { relay });
  const job = await manager.submit('查询结果');
  relay.results = [{ job_id: job.id, revision: 4,
    payload: { request_id: job.id, status: 'completed', spoken_reply: '已完成。' } }];
  relay.ack = async (id, revision) => {
    const restored = new JobManager({ config: relayConfig, dataDir, relay });
    assert.equal(restored.get(id).spokenReply, '已完成。');
    assert.equal(restored.get(id).status, 'completed');
    assert.equal(revision, 4);
  };
  assert.equal(manager.hasPendingRelay(), true);
  assert.deepEqual(await manager.syncRelay(), { applied: 1, acknowledged: 1, rejected: 0 });
  assert.equal(manager.hasPendingRelay(), false);
});

test('an acknowledgment failure is retried after restart without repeating Bot dispatch', async (t) => {
  const relay = mailbox();
  let botCalls = 0;
  const { manager, dataDir } = fixture(t, async () => { botCalls++; return { ok: true, status: 200 }; }, relayConfig, { relay });
  const job = await manager.submit('只安排一次', { requestKey: 'relay-one-dispatch' });
  relay.results = [{ job_id: job.id, revision: 2,
    payload: { request_id: job.id, status: 'completed', spoken_reply: '已经安排好了。' } }];
  const successfulAck = relay.ack;
  relay.ack = async () => { throw new Error(relayConfig.relayMasterToken); };
  await assert.rejects(manager.syncRelay(), (error) => {
    assert.equal(error.code, 'RELAY_UNAVAILABLE');
    assert.ok(!error.message.includes(relayConfig.relayMasterToken));
    return true;
  });
  assert.equal(manager.get(job.id).status, 'completed');
  assert.equal(manager.hasPendingRelay(), true);
  relay.ack = successfulAck;
  const restored = new JobManager({ config: relayConfig, dataDir, relay });
  assert.deepEqual(await restored.syncRelay(), { applied: 1, acknowledged: 1, rejected: 0 });
  assert.equal(relay.results.length, 0);
  assert.equal(botCalls, 1);
});

test('revision acknowledgments retain a newer result arriving during synchronization', async (t) => {
  const relay = mailbox();
  const { manager } = fixture(t, undefined, relayConfig, { relay });
  const job = await manager.submit('分阶段结果');
  relay.results = [{ job_id: job.id, revision: 1,
    payload: { request_id: job.id, status: 'needs_input', spoken_reply: '请提供日期。' } }];
  relay.ack = async (_id, revision) => {
    if (revision === 1) {
      relay.results = [{ job_id: job.id, revision: 2,
        payload: { request_id: job.id, status: 'completed', spoken_reply: '日期已经确认。' } }];
    } else relay.results = [];
  };
  await manager.syncRelay();
  assert.equal(manager.get(job.id).status, 'needs_input');
  assert.equal(manager.hasPendingRelay(), true);
  await manager.syncRelay();
  assert.equal(manager.get(job.id).status, 'completed');
  assert.equal(manager.get(job.id).spokenReply, '日期已经确认。');
});

test('a restart during relay registration reports unsent, while Bot timeout remains unknown', async (t) => {
  const relay = mailbox();
  let calls = 0;
  const { manager, dataDir } = fixture(t, async () => { calls++; throw new DOMException('timeout', 'TimeoutError'); }, relayConfig, { relay });
  const job = await manager.submit('安排事项', { requestKey: 'relay-timeout' });
  assert.equal(job.status, 'unknown');
  assert.equal((await manager.submit('安排事项', { requestKey: 'relay-timeout' })).status, 'unknown');
  assert.equal(calls, 1);
  const filename = join(dataDir, 'jobs-state.json');
  const saved = JSON.parse(readFileSync(filename, 'utf8'));
  saved.jobs[0].status = 'dispatching';
  saved.jobs[0].dispatchPhase = 'registering';
  writeFileSync(filename, JSON.stringify(saved));
  const restored = new JobManager({ config: relayConfig, dataDir, relay });
  assert.equal(restored.get(job.id).status, 'failed');
  assert.match(restored.get(job.id).error, /尚未向 Grok Bot 发送/);
});

test('relay secrets cannot become spoken replies and rejected results are not acknowledged', async (t) => {
  const relay = mailbox();
  const { manager } = fixture(t, undefined, relayConfig, { relay });
  const job = await manager.submit('查询结果');
  relay.results = [{ job_id: job.id, revision: 1,
    payload: { request_id: job.id, status: 'completed', spoken_reply: relayConfig.relayMasterToken } }];
  assert.deepEqual(await manager.syncRelay(), { applied: 0, acknowledged: 0, rejected: 1 });
  assert.equal(manager.get(job.id).spokenReply, null);
  assert.equal(relay.acknowledgments.length, 0);
  assert.equal(manager.hasPendingRelay(), true);
});
