import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MailboxCore, routeRelayRequest, JOB_TTL_MS, MAX_RESULTS_BYTES } from '../cloudflare/relay-core.mjs';

const MASTER = 'master_'.padEnd(48, 'M');
const CALLBACK = 'callback_'.padEnd(43, 'C');
const OTHER = 'another_'.padEnd(43, 'D');
const jobId = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

class MemoryStorage {
  constructor() { this.values = new Map(); this.alarm = null; this.reads = 0; }
  async get(key) { this.reads += 1; return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { return this.values.delete(key); }
  async list({ prefix = '', startAfter = '', limit = Infinity } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix) && key > startAfter).sort(([one], [two]) => one.localeCompare(two)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)]));
  }
  async getAlarm() { return this.alarm; }
  async setAlarm(time) { this.alarm = time; }
  async deleteAlarm() { this.alarm = null; }
}

function request(path, { method = 'POST', body, token = MASTER, headers = {} } = {}) {
  return new Request(`https://stackchan-callback.test.workers.dev${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

function harness(options = {}) {
  let time = 1000000;
  const storage = new MemoryStorage();
  const core = new MailboxCore({ storage, masterToken: MASTER, now: () => time, ...options });
  return {
    core, storage,
    advance(ms) { time += ms; },
    register(id = jobId(1), token = CALLBACK) { return core.fetch(request(`/v1/jobs/${id}`, { body: { callback_token: token } })); },
    callback(id = jobId(1), status = 'completed', spoken_reply = 'Grok Bot 的真实回复。', token = CALLBACK) {
      return core.fetch(request(`/callbacks/grok/${id}`, { token, body: { request_id: id, status, spoken_reply } }));
    },
    ack(id = jobId(1), revision = 1) { return core.fetch(request(`/v1/jobs/${id}/ack`, { body: { revision } })); },
    results() { return core.fetch(request('/v1/results', { method: 'GET' })); },
  };
}

test('registration stores SHA-256 only and returns a same-origin stable callback URL', async () => {
  const h = harness();
  const first = await h.register();
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), { callback_url: `https://stackchan-callback.test.workers.dev/callbacks/grok/${jobId(1)}` });
  const stored = h.storage.values.get(`job:${jobId(1)}`);
  assert.match(stored.tokenHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(CALLBACK));
  assert.equal(h.storage.alarm, stored.expiresAt);
  h.advance(1000);
  assert.equal((await h.register()).status, 200);
  assert.equal(h.storage.values.get(`job:${jobId(1)}`).expiresAt, stored.expiresAt);
  assert.equal((await h.register(jobId(1), OTHER)).status, 409);
});

test('management authentication is checked before obtaining any Durable Object stub', async () => {
  let stubCalls = 0;
  const env = {
    RELAY_MASTER_TOKEN: MASTER,
    MAILBOX: { idFromName() { stubCalls += 1; throw new Error('Must not access mailbox.'); } },
  };
  const answer = await routeRelayRequest(request('/v1/results', { method: 'GET', token: OTHER }), env);
  assert.equal(answer.status, 401);
  assert.equal(stubCalls, 0);
  assert.equal(answer.headers.get('access-control-allow-origin'), null);
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  const unset = await routeRelayRequest(request('/v1/results', { method: 'GET' }), { ...env, RELAY_MASTER_TOKEN: undefined });
  assert.equal(unset.status, 503);
});

test('Worker routes valid authenticated requests to one strongly consistent mailbox', async () => {
  const h = harness();
  const names = [];
  const env = {
    RELAY_MASTER_TOKEN: MASTER,
    MAILBOX: {
      idFromName(name) { names.push(name); return 'the-one-mailbox'; },
      get(id) { assert.equal(id, 'the-one-mailbox'); return h.core; },
    },
  };
  assert.equal((await routeRelayRequest(request(`/v1/jobs/${jobId(1)}`, { body: { callback_token: CALLBACK } }), env)).status, 201);
  assert.equal((await routeRelayRequest(request('/v1/results', { method: 'GET' }), env)).status, 200);
  assert.deepEqual(names, ['mailbox', 'mailbox']);
});

test('per-job callback authorization rejects a master credential and a different job token', async () => {
  const h = harness();
  await h.register();
  await h.register(jobId(2), OTHER);
  assert.equal((await h.callback(jobId(1), 'completed', 'wrong token', MASTER)).status, 401);
  assert.equal((await h.callback(jobId(1), 'completed', 'wrong token', OTHER)).status, 401);
  assert.equal((await h.callback(jobId(2), 'completed', 'wrong token', CALLBACK)).status, 401);
  assert.deepEqual(await (await h.results()).json(), { results: [] });
  assert.equal((await h.callback()).status, 200);
});

test('unknown callbacks look up the job before hashing supplied credentials', async () => {
  let hashes = 0;
  const h = harness({ subtle: { async digest(...args) { hashes += 1; return crypto.subtle.digest(...args); } } });
  const response = await h.callback();
  assert.equal(response.status, 404);
  assert.equal(hashes, 0);
  assert.equal(h.storage.reads, 1);
});

test('a callback remains available until its exact revision is acknowledged', async () => {
  const h = harness();
  await h.register();
  assert.deepEqual(await (await h.callback()).json(), { ok: true, revision: 1 });
  const expected = { results: [{ job_id: jobId(1), revision: 1, payload: { request_id: jobId(1), status: 'completed', spoken_reply: 'Grok Bot 的真实回复。' } }] };
  assert.deepEqual(await (await h.results()).json(), expected);
  assert.deepEqual(await (await h.results()).json(), expected);
  assert.equal((await h.ack()).status, 200);
  assert.deepEqual(await (await h.results()).json(), { results: [] });
  const tombstone = h.storage.values.get(`job:${jobId(1)}`);
  assert.equal(tombstone.payload, undefined);
  assert.equal(tombstone.status, 'completed');
  assert.match(tombstone.payloadHash, /^[a-f0-9]{64}$/);
  assert.equal((await h.ack()).status, 200);
  assert.equal((await h.callback()).status, 200);
  assert.deepEqual(await (await h.results()).json(), { results: [] });
});

test('needs_input can advance to a final response; an older ack cannot remove the new revision', async () => {
  const h = harness();
  await h.register();
  assert.equal((await (await h.callback(jobId(1), 'needs_input', '请问哪一天？')).json()).revision, 1);
  assert.equal((await h.results()).status, 200);
  assert.equal((await (await h.callback(jobId(1), 'completed', '安排完成。')).json()).revision, 2);
  assert.equal((await h.ack(jobId(1), 1)).status, 200);
  const pending = await (await h.results()).json();
  assert.equal(pending.results[0].revision, 2);
  assert.equal(pending.results[0].payload.spoken_reply, '安排完成。');
  await h.ack(jobId(1), 2);
  assert.deepEqual(await (await h.results()).json(), { results: [] });
});

test('an acknowledged needs_input tombstone can receive a later final response', async () => {
  const h = harness();
  await h.register();
  await h.callback(jobId(1), 'needs_input', '需要补充信息。');
  await h.ack();
  await h.callback(jobId(1), 'failed', '无法完成。');
  const pending = await (await h.results()).json();
  assert.equal(pending.results[0].revision, 2);
  assert.equal(pending.results[0].payload.status, 'failed');
});

test('final payloads are idempotent and cannot be replaced with a different final or needs_input', async () => {
  const h = harness();
  await h.register();
  await h.callback();
  assert.deepEqual(await (await h.callback()).json(), { ok: true, revision: 1 });
  assert.equal((await h.callback(jobId(1), 'completed', '不一样的答案。')).status, 409);
  assert.equal((await h.callback(jobId(1), 'failed', '失败了。')).status, 409);
  assert.equal((await h.callback(jobId(1), 'needs_input', '想重新提问。')).status, 409);
  assert.equal((await (await h.results()).json()).results[0].revision, 1);
});

test('concurrent duplicate callbacks increment once and concurrent differing finals cannot overwrite', async () => {
  const h = harness();
  await h.register();
  const duplicates = await Promise.all([h.callback(), h.callback(), h.callback()]);
  for (const response of duplicates) assert.deepEqual(await response.json(), { ok: true, revision: 1 });
  await h.register(jobId(2));
  const finals = await Promise.all([h.callback(jobId(2), 'completed', '答案 A'), h.callback(jobId(2), 'failed', '答案 B')]);
  assert.deepEqual(finals.map(response => response.status).sort(), [200, 409]);
});

test('UUIDs, callback schemas, revision numbers and methods are validated', async () => {
  const h = harness();
  await h.register();
  assert.equal((await h.core.fetch(request('/v1/jobs/not-a-uuid', { body: { callback_token: CALLBACK } }))).status, 400);
  assert.equal((await h.core.fetch(request(`/v1/jobs/${jobId(1)}`, { method: 'DELETE' }))).status, 405);
  assert.equal((await h.core.fetch(request('/unknown'))).status, 404);
  assert.equal((await h.core.fetch(request('/v1/results?token=do-not-accept', { method: 'GET' }))).status, 400);
  for (const body of [
    { request_id: jobId(2), status: 'completed', spoken_reply: '答复' },
    { request_id: jobId(1), status: 'running', spoken_reply: '答复' },
    { request_id: jobId(1), status: 'completed', spoken_reply: ' ' },
    { request_id: jobId(1), status: 'completed', spoken_reply: 'a'.repeat(16001) },
    { request_id: jobId(1), status: 'completed', spoken_reply: '答复', unexpected: true },
  ]) assert.equal((await h.core.fetch(request(`/callbacks/grok/${jobId(1)}`, { token: CALLBACK, body }))).status, 400);
  for (const revision of [0, -1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) assert.equal((await h.ack(jobId(1), revision)).status, 400);
  assert.equal((await h.ack(jobId(1), 1)).status, 409);
});

test('body and content-type limits reject malformed or oversized requests without exposing input', async () => {
  const h = harness();
  await h.register();
  assert.equal((await h.core.fetch(request(`/callbacks/grok/${jobId(1)}`, { token: CALLBACK, body: 'a'.repeat(65537) }))).status, 413);
  assert.equal((await h.core.fetch(request(`/v1/jobs/${jobId(2)}`, { body: 'SECRET malformed json' }))).status, 400);
  const malformed = await h.core.fetch(request(`/v1/jobs/${jobId(2)}`, { body: 'SECRET malformed json' }));
  assert.doesNotMatch(await malformed.text(), /SECRET/);
  assert.equal((await h.core.fetch(request(`/v1/jobs/${jobId(2)}`, { body: {}, headers: { 'content-type': 'text/plain' } }))).status, 415);
  assert.equal((await h.core.fetch(request(`/v1/jobs/${jobId(2)}`, { body: {}, headers: { 'content-encoding': 'gzip' } }))).status, 415);
});

test('result batches stop at 50 and leave additional results available after ack', async () => {
  const h = harness();
  for (let index = 1; index <= 53; index += 1) {
    await h.register(jobId(index));
    await h.callback(jobId(index), 'completed', '结果');
  }
  const first = await (await h.results()).json();
  assert.equal(first.results.length, 50);
  for (const item of first.results) await h.ack(item.job_id, item.revision);
  assert.equal((await (await h.results()).json()).results.length, 3);
});

test('UTF-8 result batches never exceed one megabyte', async () => {
  const h = harness();
  for (let index = 1; index <= 30; index += 1) {
    await h.register(jobId(index));
    await h.callback(jobId(index), 'completed', '方'.repeat(16000));
  }
  const response = await h.results();
  const bytes = await response.arrayBuffer();
  assert.ok(bytes.byteLength <= MAX_RESULTS_BYTES);
  const results = JSON.parse(new TextDecoder().decode(bytes)).results;
  assert.ok(results.length > 0 && results.length < 30);
});

test('seven-day expiry rejects old callbacks and alarms remove registrations and tombstones', async () => {
  const h = harness();
  await h.register();
  await h.callback();
  await h.ack();
  h.advance(1000);
  await h.register(jobId(2));
  const secondExpiry = h.storage.values.get(`job:${jobId(2)}`).expiresAt;
  h.advance(JOB_TTL_MS - 1000);
  await h.core.alarm();
  assert.equal(h.storage.values.has(`job:${jobId(1)}`), false);
  assert.equal(h.storage.values.has(`job:${jobId(2)}`), true);
  assert.equal(h.storage.alarm, secondExpiry);
  assert.equal((await h.callback()).status, 404);
  h.advance(1000);
  await h.core.alarm();
  assert.equal(h.storage.values.size, 0);
  assert.equal(h.storage.alarm, null);
});

test('storage failures return fixed errors and cannot leak credentials or callback content', async () => {
  const h = harness();
  h.storage.get = async () => { throw new Error(`secret ${MASTER} ${CALLBACK}`); };
  const response = await h.register();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'INTERNAL_ERROR' });
});

test('Wrangler config uses workers.dev with one SQLite-backed Durable Object and no saved secret', async () => {
  const config = await readFile(new URL('../cloudflare/wrangler.jsonc', import.meta.url), 'utf8');
  assert.match(config, /"workers_dev": true/);
  assert.match(config, /"storage": "sqlite"/);
  assert.match(config, /"class_name": "CallbackMailbox"/);
  assert.doesNotMatch(config, /"RELAY_MASTER_TOKEN"\s*:/);
});
