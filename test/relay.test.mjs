import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RelayClient } from '../lib/relay.mjs';

const baseUrl = 'https://stackchan-mailbox.example.workers.dev';
const masterToken = 'test-independent-master-secret';
const callbackToken = 'a'.repeat(43);
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});

test('registration sends only callback credentials to the fixed authenticated relay origin', async () => {
  const jobId = randomUUID();
  const relay = new RelayClient({ baseUrl, masterToken, fetchImpl: async (url, options) => {
    assert.equal(url, `${baseUrl}/v1/jobs/${jobId}`);
    assert.equal(options.headers.Authorization, `Bearer ${masterToken}`);
    assert.deepEqual(JSON.parse(options.body), { callback_token: callbackToken });
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return json({ callback_url: `${baseUrl}/callbacks/grok/${jobId}` }, 201);
  } });
  assert.deepEqual(await relay.register(jobId, callbackToken), {
    callback_url: `${baseUrl}/callbacks/grok/${jobId}`,
  });
});

test('listResults unwraps the batch and acknowledgment uses its exact revision', async () => {
  const jobId = randomUUID();
  const results = [{ job_id: jobId, revision: 3,
    payload: { request_id: jobId, status: 'completed', spoken_reply: '已经处理好了。' } }];
  const relay = new RelayClient({ baseUrl, masterToken, fetchImpl: async (url, options) => {
    if (url.endsWith('/v1/results')) return json({ results });
    assert.equal(url, `${baseUrl}/v1/jobs/${jobId}/ack`);
    assert.deepEqual(JSON.parse(options.body), { revision: 3 });
    return json({ ok: true });
  } });
  assert.deepEqual(await relay.listResults(), results);
  await relay.ack(jobId, 3);
});

test('unsafe configuration and a callback URL outside the registered origin are rejected', async () => {
  for (const value of ['http://example.invalid', 'file:///tmp/mail', 'https://localhost',
    'https://127.0.0.1', 'https://[::1]', `${baseUrl}/subpath`, `${baseUrl}?secret=x`]) {
    assert.throws(() => new RelayClient({ baseUrl: value, masterToken }), { code: 'CONFIG_REQUIRED' });
  }
  const relay = new RelayClient({ baseUrl, masterToken, fetchImpl: async () => json({
    callback_url: 'https://different.example.invalid/callback',
  }) });
  await assert.rejects(relay.register(randomUUID(), callbackToken), { code: 'RELAY_UNAVAILABLE' });
});

test('network, HTTP and malformed responses produce fixed errors without remote secrets', async () => {
  for (const fetchImpl of [
    async () => { throw new Error(`timeout ${masterToken}`); },
    async () => json({ error: masterToken }, 401),
    async () => new Response(masterToken, { headers: { 'Content-Type': 'application/json' } }),
    async () => json({ results: [{ job_id: randomUUID(), revision: 0, payload: {} }] }),
  ]) {
    const relay = new RelayClient({ baseUrl, masterToken, fetchImpl });
    await assert.rejects(relay.listResults(), (error) => {
      assert.equal(error.code, 'RELAY_UNAVAILABLE');
      assert.ok(!error.message.includes(masterToken));
      return true;
    });
  }
});

test('a response is capped at one MiB while allowing large Chinese reply batches', async () => {
  const jobId = randomUUID();
  const largeReply = '中'.repeat(16000);
  const results = [{ job_id: jobId, revision: 1,
    payload: { request_id: jobId, status: 'completed', spoken_reply: largeReply } }];
  const good = new RelayClient({ baseUrl, masterToken, fetchImpl: async () => json({ results }) });
  assert.deepEqual(await good.listResults(), results);
  const huge = new RelayClient({ baseUrl, masterToken, fetchImpl: async () => new Response('x'.repeat(1024 * 1024 + 1), {
    headers: { 'Content-Type': 'application/json' },
  }) });
  await assert.rejects(huge.listResults(), { code: 'RELAY_UNAVAILABLE' });
});
