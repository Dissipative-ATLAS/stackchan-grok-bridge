import { isIP } from 'node:net';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 5000;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(message = '结果邮箱暂时不可用，请稍后重试。', code = 'RELAY_UNAVAILABLE') {
  return Object.assign(new Error(message), { code, statusCode: 503 });
}

function isPrivate(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224;
  }
  return isIP(host) === 6 && (host === '::' || host === '::1'
    || /^(fc|fd|fe8|fe9|fea|feb)/i.test(host) || host.startsWith('::ffff:'));
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The relay receives only callback credentials and results, never MCP/Bot secrets. */
export class RelayClient {
  constructor({ baseUrl, masterToken, fetchImpl = globalThis.fetch }) {
    let url;
    try { url = new URL(baseUrl); } catch { throw failure('结果邮箱地址尚未正确配置。', 'CONFIG_REQUIRED'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search
      || !['', '/'].includes(url.pathname) || isPrivate(url.hostname)
      || typeof masterToken !== 'string' || !masterToken.trim() || masterToken.length > 4096
      || /[\r\n]/.test(masterToken) || typeof fetchImpl !== 'function') {
      throw failure('结果邮箱需要公网 HTTPS 根地址及独立认证密钥。', 'CONFIG_REQUIRED');
    }
    this.baseUrl = url.origin;
    this.masterToken = masterToken;
    this.fetchImpl = fetchImpl;
  }

  async #request(path, { method = 'GET', payload } = {}) {
    let response;
    let reader;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${this.masterToken}`,
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES
        || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel().catch(() => {});
        throw failure();
      }
      reader = response.body?.getReader();
      if (!reader) throw failure();
      const chunks = [];
      let length = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw failure('结果邮箱返回内容过大。');
        }
        chunks.push(Buffer.from(value));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!object(body)) throw failure();
      return body;
    } catch {
      throw failure();
    } finally {
      reader?.releaseLock();
    }
  }

  async register(jobId, callbackToken) {
    if (!JOB_ID.test(jobId) || typeof callbackToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(callbackToken)) {
      throw failure('结果邮箱任务参数无效。');
    }
    const result = await this.#request(`/v1/jobs/${jobId}`, {
      method: 'POST', payload: { callback_token: callbackToken },
    });
    const expected = `${this.baseUrl}/callbacks/grok/${jobId}`;
    if (result.callback_url !== expected) throw failure('结果邮箱返回的回调地址无效。');
    return { callback_url: expected };
  }

  async listResults() {
    const body = await this.#request('/v1/results');
    if (!Array.isArray(body.results) || body.results.length > 50
      || body.results.some((entry) => !object(entry) || !JOB_ID.test(entry.job_id) || !validRevision(entry.revision)
        || !object(entry.payload) || entry.payload.request_id !== entry.job_id
        || !['completed', 'failed', 'needs_input'].includes(entry.payload.status)
        || typeof entry.payload.spoken_reply !== 'string' || !entry.payload.spoken_reply.trim()
        || entry.payload.spoken_reply.length > 16000)) {
      throw failure('结果邮箱返回的任务格式无效。');
    }
    return body.results;
  }

  async ack(jobId, revision) {
    if (!JOB_ID.test(jobId) || !validRevision(revision)) throw failure('结果邮箱确认参数无效。');
    const result = await this.#request(`/v1/jobs/${jobId}/ack`, { method: 'POST', payload: { revision } });
    if (result.ok !== true) throw failure('结果邮箱未确认接收。');
  }
}
