import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadConfig } from '../lib/config.mjs';
import { RelayClient } from '../lib/relay.mjs';

// Exercises the deployed mailbox only. This never calls the Grok webhook.
let stage = 'load_config';
let lastHttpStatus = null;
let lastNetworkCode = null;
let lastNetworkType = null;
try {
  const config = await loadConfig();
  const fetchImpl = async (...args) => {
    try {
      const response = await fetch(...args);
      lastHttpStatus = response.status;
      return response;
    } catch (error) {
      lastNetworkType = `${error.name ?? 'Error'}/${error.cause?.name ?? 'none'}`;
      const code = error.cause?.code ?? error.code ?? error.cause?.errors?.find(item => item.code)?.code;
      if (/^[A-Z_0-9]{1,60}$/.test(code ?? '')) lastNetworkCode = code;
      throw error;
    }
  };
  const relay = new RelayClient({ baseUrl: config.callbackBaseUrl, masterToken: config.relayMasterToken, fetchImpl });
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  stage = 'register';
  const { callback_url } = await relay.register(id, token);
  const payload = { request_id: id, status: 'completed', spoken_reply: 'Stackchan 回调信箱联通测试成功。' };
  const send = bearer => fetch(callback_url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  stage = 'reject_unauthorized';
  const rejected = await send(randomBytes(32).toString('base64url'));
  assert.equal(rejected.status, 401);
  await rejected.body?.cancel();
  stage = 'callback';
  const accepted = await send(token);
  assert.equal(accepted.status, 200);
  await accepted.body?.cancel();
  stage = 'read_result';
  const found = (await relay.listResults()).find(result => result.job_id === id);
  assert.deepEqual(found?.payload, payload);
  stage = 'ack';
  await relay.ack(id, found.revision);
  stage = 'verify_cleared';
  assert.ok(!(await relay.listResults()).some(result => result.job_id === id));
  console.log(JSON.stringify({ registered: true, unauthorizedRejected: true, resultReceived: true, acknowledgmentClearedResult: true, grokBotCalled: false }));
} catch {
  console.error(JSON.stringify({ relayCheckPassed: false, stage, lastHttpStatus, lastNetworkCode, lastNetworkType, grokBotCalled: false }));
  process.exitCode = 1;
}
