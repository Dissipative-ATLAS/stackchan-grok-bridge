import { createServer } from 'node:http';

// A 16,000-character reply can occupy 48 KiB in UTF-8, plus JSON metadata.
const MAX_BODY = 64 * 1024;
function respond(response, code, value) {
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

export function createCallbackServer({ jobs }) {
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      respond(response, 200, { ok: true });
      return;
    }
    const route = /^\/callbacks\/grok\/([A-Za-z0-9_-]{1,128})$/.exec(request.url ?? '');
    if (request.method !== 'POST' || !route) {
      respond(response, 404, { error: 'NOT_FOUND' });
      request.resume();
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
      respond(response, 415, { error: 'JSON_REQUIRED' });
      request.resume();
      return;
    }
    const authorization = request.headers.authorization ?? '';
    const match = /^Bearer ([A-Za-z0-9_\-]+)$/i.exec(authorization);
    if (!match) {
      respond(response, 401, { error: 'CALLBACK_UNAUTHORIZED' });
      request.resume();
      return;
    }
    if (Number(request.headers['content-length']) > MAX_BODY) {
      respond(response, 413, { error: 'BODY_TOO_LARGE' });
      request.resume();
      return;
    }
    try {
      let length = 0;
      const chunks = [];
      for await (const chunk of request) {
        length += chunk.length;
        if (length > MAX_BODY) {
          respond(response, 413, { error: 'BODY_TOO_LARGE' });
          request.resume();
          return;
        }
        chunks.push(chunk);
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { respond(response, 400, { error: 'INVALID_JSON' }); return; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        respond(response, 400, { error: 'INVALID_CALLBACK' });
        return;
      }
      if (payload.request_id !== route[1]) {
        respond(response, 400, { error: 'REQUEST_ID_MISMATCH' });
        return;
      }
      const job = await jobs.acceptCallback(route[1], match[1], payload);
      respond(response, 200, { ok: true, request_id: job.id, status: job.status });
    } catch (error) {
      const code = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      const safeCode = /^[A-Z_]{1,50}$/.test(error.code ?? '') ? error.code : 'INTERNAL_ERROR';
      if (!response.headersSent) respond(response, code, { error: safeCode });
      else response.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return server;
}
