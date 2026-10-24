// Platform-independent mailbox logic. The Worker adapter supplies the SQLite-
// backed Durable Object storage; tests supply an isolated in-memory equivalent.
export const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_RESULTS_BYTES = 1_000_000;
const MAX_BATCH = 50;
const PAGE_SIZE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9._~+/-]{32,256}={0,2}$/;
const encoder = new TextEncoder();

class RelayError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function fail(status, code) { throw new RelayError(status, code); }

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function errorResponse(error) {
  return error instanceof RelayError
    ? jsonResponse({ error: error.code }, error.status)
    : jsonResponse({ error: 'INTERNAL_ERROR' }, 500);
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) { return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function bearer(request) {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '');
  return match && TOKEN.test(match[1]) ? match[1] : null;
}

async function digest(value, subtle = globalThis.crypto.subtle) {
  const bytes = new Uint8Array(await subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function equalHashes(one, two) {
  if (typeof one !== 'string' || typeof two !== 'string' || one.length !== 64 || two.length !== 64) return false;
  let difference = 0;
  for (let index = 0; index < 64; index += 1) difference |= one.charCodeAt(index) ^ two.charCodeAt(index);
  return difference === 0;
}

export async function authorizedMaster(request, masterToken, subtle = globalThis.crypto.subtle) {
  const supplied = bearer(request);
  if (!supplied || typeof masterToken !== 'string' || !TOKEN.test(masterToken)) return false;
  const [actual, expected] = await Promise.all([digest(supplied, subtle), digest(masterToken, subtle)]);
  return equalHashes(actual, expected);
}

function route(request) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:') fail(400, 'HTTPS_REQUIRED');
  if (url.search) fail(400, 'QUERY_NOT_ALLOWED');
  if (url.pathname === '/v1/results') {
    if (request.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED');
    return { kind: 'results', admin: true, origin: url.origin };
  }
  const match = /^\/(v1\/jobs|callbacks\/grok)\/([^/]+)(\/ack)?$/.exec(url.pathname);
  if (!match || (match[1] === 'callbacks/grok' && match[3])) fail(404, 'NOT_FOUND');
  if (request.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED');
  if (!UUID.test(match[2])) fail(400, 'INVALID_JOB_ID');
  return {
    kind: match[1] === 'callbacks/grok' ? 'callback' : match[3] ? 'ack' : 'register',
    admin: match[1] === 'v1/jobs',
    id: match[2].toLowerCase(),
    origin: url.origin,
  };
}

async function readJson(request) {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim().match(/^application\/json$/)) fail(415, 'JSON_REQUIRED');
  const encoding = request.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') fail(415, 'CONTENT_ENCODING_UNSUPPORTED');
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) fail(413, 'BODY_TOO_LARGE');
  if (!request.body) fail(400, 'INVALID_JSON');
  const reader = request.body.getReader();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const chunks = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY_BYTES) fail(413, 'BODY_TOO_LARGE');
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { fail(400, 'INVALID_JSON'); }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new RelayError(408, 'BODY_TIMEOUT')), 10000);
      }),
    ]);
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof RelayError) throw error;
    fail(400, 'REQUEST_READ_FAILED');
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

/** Public Worker routing: reject management auth before obtaining a DO stub. */
export async function routeRelayRequest(request, env) {
  try {
    const target = route(request);
    if (typeof env.RELAY_MASTER_TOKEN !== 'string' || !TOKEN.test(env.RELAY_MASTER_TOKEN)) fail(503, 'RELAY_NOT_CONFIGURED');
    if (target.admin && !await authorizedMaster(request, env.RELAY_MASTER_TOKEN)) fail(401, 'UNAUTHORIZED');
    if (!target.admin && !bearer(request)) fail(401, 'UNAUTHORIZED');
    const id = env.MAILBOX.idFromName('mailbox');
    return await env.MAILBOX.get(id).fetch(request);
  } catch (error) { return errorResponse(error); }
}

export class MailboxCore {
  constructor({ storage, masterToken, now = Date.now, subtle = globalThis.crypto.subtle }) {
    this.storage = storage;
    this.masterToken = masterToken;
    this.now = now;
    this.subtle = subtle;
    this.tail = Promise.resolve();
  }

  // Web Crypto awaits can release DO input gates. Explicit sequencing keeps
  // callback transitions and revision acknowledgements atomic relative to each
  // other, while body uploads happen outside this short critical section.
  serial(work) {
    const operation = this.tail.then(work);
    this.tail = operation.catch(() => {});
    return operation;
  }

  async liveJob(id) {
    const key = `job:${id}`;
    const job = await this.storage.get(key);
    if (job && job.expiresAt <= this.now()) {
      await this.storage.delete(key);
      return undefined;
    }
    return job;
  }

  async schedule(expiresAt) {
    const current = await this.storage.getAlarm();
    if (current === null || current === undefined || expiresAt < current) await this.storage.setAlarm(expiresAt);
  }

  async register(target, body) {
    if (!exactKeys(body, ['callback_token']) || typeof body.callback_token !== 'string' || !TOKEN.test(body.callback_token)) fail(400, 'INVALID_CALLBACK_TOKEN');
    const tokenHash = await digest(body.callback_token, this.subtle);
    return this.serial(async () => {
      const existing = await this.liveJob(target.id);
      if (existing && !equalHashes(existing.tokenHash, tokenHash)) fail(409, 'JOB_ALREADY_REGISTERED');
      const callback_url = `${target.origin}/callbacks/grok/${target.id}`;
      if (existing) return jsonResponse({ callback_url });
      const createdAt = this.now();
      const expiresAt = createdAt + JOB_TTL_MS;
      // Schedule before persisting so a stored registration always has cleanup.
      await this.schedule(expiresAt);
      await this.storage.put(`job:${target.id}`, { tokenHash, createdAt, expiresAt, revision: 0, ackedRevision: 0 });
      return jsonResponse({ callback_url }, 201);
    });
  }

  async authorizeCallback(id, token) {
    return this.serial(async () => {
      const job = await this.liveJob(id);
      if (!job) fail(404, 'JOB_NOT_FOUND');
      // Look up the registered job first; never accept a master credential or a
      // caller-supplied hash as authority for an arbitrary callback.
      const tokenHash = await digest(token, this.subtle);
      if (!equalHashes(tokenHash, job.tokenHash)) fail(401, 'UNAUTHORIZED');
      return tokenHash;
    });
  }

  async callback(target, body, tokenHash) {
    if (!exactKeys(body, ['request_id', 'status', 'spoken_reply'])
      || typeof body.request_id !== 'string' || body.request_id.toLowerCase() !== target.id
      || !['completed', 'failed', 'needs_input'].includes(body.status)
      || typeof body.spoken_reply !== 'string' || !body.spoken_reply.trim() || body.spoken_reply.length > 16000) fail(400, 'INVALID_CALLBACK');
    const payload = { request_id: target.id, status: body.status, spoken_reply: body.spoken_reply.trim() };
    const payloadHash = await digest(JSON.stringify(payload), this.subtle);
    return this.serial(async () => {
      const job = await this.liveJob(target.id);
      if (!job) fail(404, 'JOB_NOT_FOUND');
      if (!equalHashes(tokenHash, job.tokenHash)) fail(401, 'UNAUTHORIZED');
      if (job.payloadHash === payloadHash) return jsonResponse({ ok: true, revision: job.revision });
      if (job.status === 'completed' || job.status === 'failed') fail(409, 'FINAL_RESULT_CONFLICT');
      const revision = job.revision + 1;
      await this.storage.put(`job:${target.id}`, { ...job, status: payload.status, payload, payloadHash, revision });
      return jsonResponse({ ok: true, revision });
    });
  }

  async results() {
    return this.serial(async () => {
      const results = [];
      let bytes = encoder.encode('{"results":[]}').byteLength;
      let cursor;
      while (results.length < MAX_BATCH) {
        const page = await this.storage.list({ prefix: 'job:', limit: PAGE_SIZE, ...(cursor ? { startAfter: cursor } : {}) });
        if (!page.size) break;
        for (const [key, job] of page) {
          cursor = key;
          if (job.expiresAt <= this.now()) { await this.storage.delete(key); continue; }
          if (!job.payload || job.revision <= job.ackedRevision) continue;
          const item = { job_id: key.slice(4), revision: job.revision, payload: job.payload };
          const size = encoder.encode(JSON.stringify(item)).byteLength + (results.length ? 1 : 0);
          if (bytes + size > MAX_RESULTS_BYTES) return jsonResponse({ results });
          results.push(item);
          bytes += size;
          if (results.length === MAX_BATCH) break;
        }
        if (page.size < PAGE_SIZE) break;
      }
      return jsonResponse({ results });
    });
  }

  async ack(target, body) {
    if (!exactKeys(body, ['revision']) || !Number.isSafeInteger(body.revision) || body.revision < 1) fail(400, 'INVALID_REVISION');
    return this.serial(async () => {
      const job = await this.liveJob(target.id);
      if (!job) fail(404, 'JOB_NOT_FOUND');
      if (body.revision > job.revision) fail(409, 'REVISION_NOT_AVAILABLE');
      if (body.revision === job.revision && body.revision > job.ackedRevision) {
        // Leave tokenHash/status/payloadHash as a tombstone until the original
        // TTL. A duplicate callback must not recreate an acknowledged result.
        const updated = { ...job, ackedRevision: body.revision };
        delete updated.payload;
        await this.storage.put(`job:${target.id}`, updated);
      }
      // Old acknowledgements are harmless even if needs_input has since become
      // a final result with a larger revision.
      return jsonResponse({ ok: true });
    });
  }

  async fetch(request) {
    try {
      const target = route(request);
      if (target.admin && !await authorizedMaster(request, this.masterToken, this.subtle)) fail(401, 'UNAUTHORIZED');
      if (target.kind === 'results') return await this.results();
      if (target.kind === 'callback') {
        const token = bearer(request);
        if (!token) fail(401, 'UNAUTHORIZED');
        const tokenHash = await this.authorizeCallback(target.id, token);
        return await this.callback(target, await readJson(request), tokenHash);
      }
      const body = await readJson(request);
      return target.kind === 'register' ? await this.register(target, body) : await this.ack(target, body);
    } catch (error) { return errorResponse(error); }
  }

  async alarm() {
    try {
      return await this.serial(async () => {
        let next = Infinity;
        let cursor;
        while (true) {
          const page = await this.storage.list({ prefix: 'job:', limit: PAGE_SIZE, ...(cursor ? { startAfter: cursor } : {}) });
          if (!page.size) break;
          for (const [key, job] of page) {
            cursor = key;
            if (job.expiresAt <= this.now()) await this.storage.delete(key);
            else next = Math.min(next, job.expiresAt);
          }
          if (page.size < PAGE_SIZE) break;
        }
        if (Number.isFinite(next)) await this.storage.setAlarm(next);
        else await this.storage.deleteAlarm();
      });
    } catch { throw new Error('MAILBOX_CLEANUP_FAILED'); }
  }
}
