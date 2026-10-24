import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createCallbackServer } from '../lib/http.mjs';

const jobId = 'job-123_test';
const callbackPath = `/callbacks/grok/${jobId}`;
const validPayload = { request_id: jobId, status: 'completed', spoken_reply: '查询成功。' };
const jsonHeaders = { 'content-type': 'application/json', authorization: 'Bearer test-token' };

async function fixture(t, acceptCallback = async (id, _token, payload) => ({ id, status: payload.status })) {
  const calls = [];
  const server = createCallbackServer({
    jobs: { acceptCallback: async (...args) => {
      calls.push(args);
      return await acceptCallback(...args);
    } },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, calls, port: server.address().port };
}

function send(port, { path = callbackPath, method = 'POST', headers = jsonHeaders, body, chunks } = {}) {
  const requestBody = body ?? (['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(validPayload));
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port, path, method, headers }, incoming => {
      const received = [];
      incoming.on('data', chunk => received.push(chunk));
      incoming.on('end', () => {
        try {
          resolve({ code: incoming.statusCode, headers: incoming.headers, body: JSON.parse(Buffer.concat(received).toString('utf8')) });
        } catch (error) { reject(error); }
      });
      incoming.on('error', reject);
    });
    outgoing.setTimeout(3000, () => outgoing.destroy(new Error('Local callback test timed out')));
    outgoing.on('error', reject);
    if (chunks) {
      for (const chunk of chunks) outgoing.write(chunk);
      outgoing.end();
    } else outgoing.end(requestBody);
  });
}

test('callback HTTP forwards matching request ID and bearer token to jobs', async t => {
  const { port, calls } = await fixture(t);
  const result = await send(port, { headers: { ...jsonHeaders, 'content-type': 'application/json; charset=utf-8' } });
  assert.equal(result.code, 200);
  assert.deepEqual(result.body, { ok: true, request_id: jobId, status: 'completed' });
  assert.deepEqual(calls, [[jobId, 'test-token', validPayload]]);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
});

test('callback HTTP rejects invalid JSON or non-object payloads without changing a job', async t => {
  const { port, calls } = await fixture(t);
  for (const body of ['{', 'null', '[]', '"text"']) {
    const result = await send(port, { body });
    assert.equal(result.code, 400);
    assert.equal(result.body.error, body === '{' ? 'INVALID_JSON' : 'INVALID_CALLBACK');
  }
  assert.equal(calls.length, 0);
});

test('callback HTTP checks JSON content type and requires bearer credentials', async t => {
  const { port, calls } = await fixture(t);
  const wrongType = await send(port, { headers: { authorization: 'Bearer test-token', 'content-type': 'text/plain' } });
  assert.equal(wrongType.code, 415);
  assert.equal(wrongType.body.error, 'JSON_REQUIRED');
  for (const authorization of [undefined, '', 'Basic test-token', 'Bearer invalid token']) {
    const headers = { 'content-type': 'application/json' };
    if (authorization !== undefined) headers.authorization = authorization;
    const result = await send(port, { headers });
    assert.equal(result.code, 401);
    assert.equal(result.body.error, 'CALLBACK_UNAUTHORIZED');
  }
  assert.equal(calls.length, 0);
});

test('callback HTTP preserves job authorization failures without exposing error messages', async t => {
  const { port, calls } = await fixture(t, async () => {
    throw Object.assign(new Error('private callback credential'), { statusCode: 401, code: 'CALLBACK_UNAUTHORIZED' });
  });
  const result = await send(port);
  assert.equal(result.code, 401);
  assert.deepEqual(result.body, { error: 'CALLBACK_UNAUTHORIZED' });
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(result.body).includes('private'));
});

test('callback HTTP rejects missing or mismatched request IDs before jobs sees them', async t => {
  const { port, calls } = await fixture(t);
  for (const request_id of [undefined, 'another-job', 123]) {
    const result = await send(port, { body: JSON.stringify({ ...validPayload, request_id }) });
    assert.equal(result.code, 400);
    assert.equal(result.body.error, 'REQUEST_ID_MISMATCH');
  }
  assert.equal(calls.length, 0);
});

test('callback HTTP accepts a full Chinese reply and enforces the 64 KiB body limit', async t => {
  const { port, calls } = await fixture(t);
  const fullReply = { ...validPayload, spoken_reply: '好'.repeat(16_000) };
  const accepted = await send(port, { body: JSON.stringify(fullReply) });
  assert.equal(accepted.code, 200);
  assert.deepEqual(calls[0], [jobId, 'test-token', fullReply]);
  calls.length = 0;
  const oversized = JSON.stringify({ ...validPayload, spoken_reply: 'x'.repeat(66_000) });
  const knownSize = await send(port, { headers: { ...jsonHeaders, 'content-length': Buffer.byteLength(oversized) }, body: oversized });
  assert.equal(knownSize.code, 413);
  assert.equal(knownSize.body.error, 'BODY_TOO_LARGE');
  const streamed = await send(port, {
    headers: { ...jsonHeaders, 'transfer-encoding': 'chunked' },
    chunks: [oversized.slice(0, 8000), oversized.slice(8000)],
  });
  assert.equal(streamed.code, 413);
  assert.equal(streamed.body.error, 'BODY_TOO_LARGE');
  assert.equal(calls.length, 0);
});

test('callback HTTP limits routable paths and methods, with a credential-free health endpoint', async t => {
  const { port, calls } = await fixture(t);
  for (const options of [
    { path: '/' }, { path: '/callbacks/grok/' }, { path: `${callbackPath}/extra` },
    { path: `${callbackPath}?token=unused` }, { method: 'GET' },
  ]) {
    const result = await send(port, options);
    assert.equal(result.code, 404);
    assert.equal(result.body.error, 'NOT_FOUND');
  }
  const health = await send(port, { path: '/health', method: 'GET', headers: {}, body: '' });
  assert.equal(health.code, 200);
  assert.deepEqual(health.body, { ok: true });
  assert.equal(calls.length, 0);
});
