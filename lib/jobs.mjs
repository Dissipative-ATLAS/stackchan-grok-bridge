import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

const CALLBACK_STATUSES = new Set(['completed', 'failed', 'needs_input']);
const FINAL_STATUSES = new Set(['completed', 'failed']);
const JOB_STATUSES = new Set(['dispatching', 'accepted', 'unknown', ...CALLBACK_STATUSES]);
const MAX_QUESTION_LENGTH = 16_000;
const MAX_REPLY_LENGTH = 16_000;
const TRIGGER_TIMEOUT_MS = 8_000;

function problem(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function validText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isLocalHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a >= 224;
  }
  if (isIP(host) === 6) {
    return host === '::' || host === '::1' || /^(fc|fd|fe8|fe9|fea|feb)/i.test(host)
      || host.startsWith('::ffff:');
  }
  return false;
}

function httpsUrl(value, name, { publicOnly = false, base = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw problem('CONFIG_REQUIRED', `尚未配置 ${name}。`, 503);
  }
  let url;
  try { url = new URL(value); } catch {
    throw problem('CONFIG_REQUIRED', `${name} 配置无效。`, 503);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || base && url.search || publicOnly && isLocalHost(url.hostname)) {
    throw problem('CONFIG_REQUIRED', `${name} 必须是有效的公网 HTTPS 地址。`, 503);
  }
  return url;
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    question: job.question,
    status: job.status,
    spokenReply: job.spokenReply,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.requestKey ? { requestKey: job.requestKey } : {}),
  };
}

/** One persistent dispatch per request key; remote acceptance is not completion. */
export class JobManager {
  constructor({ config = {}, dataDir, fetchImpl = globalThis.fetch, relay }) {
    if (typeof dataDir !== 'string' || !dataDir.trim() || typeof fetchImpl !== 'function') {
      throw problem('STATE_UNAVAILABLE', '任务存储或请求组件未配置。', 500);
    }
    this.config = { ...config };
    this.callbackMode = config.callbackMode ?? 'relay';
    this.relay = relay;
    this.relayOutstanding = false;
    this.relaySyncPromise = null;
    this.fetchImpl = fetchImpl;
    this.dataDir = resolve(dataDir);
    this.stateFile = join(this.dataDir, 'jobs-state.json');
    this.jobs = new Map();
    this.requestKeys = new Map();
    this.#load();
  }

  #load() {
    try {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      if (!lstatSync(this.dataDir).isDirectory() || lstatSync(this.dataDir).isSymbolicLink()) {
        throw new Error('Invalid state directory');
      }
      chmodSync(this.dataDir, 0o700);
      if (!existsSync(this.stateFile)) return;
      const metadata = lstatSync(this.stateFile);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Invalid state file');
      chmodSync(this.stateFile, 0o600);
      const state = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.jobs)) throw new Error('Invalid state');
      let recovered = false;
      for (const job of state.jobs) {
        if (!job || typeof job.id !== 'string' || !validText(job.question, MAX_QUESTION_LENGTH)
          || !JOB_STATUSES.has(job.status) || typeof job.callbackToken !== 'string'
          || job.callbackToken.length !== 43 || typeof job.createdAt !== 'string'
          || typeof job.updatedAt !== 'string' || this.jobs.has(job.id)
          || job.requestKey && (typeof job.requestKey !== 'string' || this.requestKeys.has(job.requestKey))) {
          throw new Error('Invalid stored job');
        }
        if (job.status === 'dispatching') {
          const registrationOnly = job.dispatchPhase === 'registering';
          job.status = registrationOnly ? 'failed' : 'unknown';
          job.error = registrationOnly
            ? '中转在准备结果邮箱时重启，尚未向 Grok Bot 发送任务。'
            : '中转在发送期间重启，任务是否已启动未知；请先查询 Grok Bot，避免重复安排。';
          job.updatedAt = new Date().toISOString();
          recovered = true;
        }
        this.jobs.set(job.id, job);
        if (job.requestKey) this.requestKeys.set(job.requestKey, job.id);
      }
      if (recovered) this.#save();
    } catch {
      throw problem('STATE_UNAVAILABLE', '任务状态文件无法安全读取，请检查本地存储。', 500);
    }
  }

  #save() {
    const temporary = join(this.dataDir, `.jobs-${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify({ version: 1, jobs: [...this.jobs.values()] }), 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.stateFile);
    } catch {
      if (descriptor !== undefined) { try { closeSync(descriptor); } catch {} }
      try { unlinkSync(temporary); } catch {}
      throw problem('STATE_UNAVAILABLE', '任务状态无法安全保存，请检查本地存储。', 500);
    }
  }

  #update(job, fields) {
    const previous = { ...job };
    Object.assign(job, fields, { updatedAt: new Date().toISOString() });
    try { this.#save(); } catch (error) {
      Object.assign(job, previous);
      throw error;
    }
  }

  get(jobId) {
    return publicJob(this.jobs.get(jobId));
  }

  getByRequestKey(requestKey) {
    if (typeof requestKey !== 'string' || !requestKey) return null;
    return publicJob(this.jobs.get(this.requestKeys.get(requestKey)));
  }

  latest() {
    return publicJob([...this.jobs.values()].at(-1));
  }

  #requireRelay() {
    if (!this.relay || ['register', 'listResults', 'ack'].some((name) => typeof this.relay[name] !== 'function')) {
      throw problem('CONFIG_REQUIRED', '结果邮箱尚未配置，未向 Grok Bot 发送任务。', 503);
    }
  }

  hasPendingRelay() {
    return this.callbackMode === 'relay' && (this.relayOutstanding || [...this.jobs.values()].some((job) =>
      job.callbackMode === 'relay' && ['dispatching', 'accepted', 'unknown', 'needs_input'].includes(job.status)));
  }

  async syncRelay() {
    if (this.callbackMode !== 'relay') return { applied: 0, acknowledged: 0, rejected: 0 };
    this.#requireRelay();
    if (this.relaySyncPromise) return this.relaySyncPromise;
    this.relaySyncPromise = this.#syncRelayResults().catch((error) => {
      if (error.code === 'STATE_UNAVAILABLE') throw error;
      throw problem('RELAY_UNAVAILABLE', '结果邮箱暂时不可用，任务结果将在连接恢复后继续同步。', 503);
    }).finally(() => { this.relaySyncPromise = null; });
    return this.relaySyncPromise;
  }

  async #syncRelayResults() {
    const results = await this.relay.listResults();
    if (!Array.isArray(results)) throw problem('RELAY_UNAVAILABLE', '结果邮箱返回格式无效。', 503);
    this.relayOutstanding = results.length > 0;
    const counts = { applied: 0, acknowledged: 0, rejected: 0 };
    for (const result of results) {
      const job = this.jobs.get(result?.job_id);
      if (!job || job.callbackMode !== 'relay' || !Number.isSafeInteger(result.revision) || result.revision < 1) {
        counts.rejected++;
        continue;
      }
      try {
        await this.acceptCallback(job.id, job.callbackToken, result.payload);
      } catch (error) {
        if (error.code === 'STATE_UNAVAILABLE') throw error;
        counts.rejected++;
        continue;
      }
      counts.applied++;
      await this.relay.ack(job.id, result.revision);
      counts.acknowledged++;
    }
    this.relayOutstanding = counts.rejected > 0;
    return counts;
  }

  async submit(question, { requestKey } = {}) {
    if (!validText(question, MAX_QUESTION_LENGTH)) {
      throw problem('INVALID_QUESTION', `问题不能为空，且不能超过 ${MAX_QUESTION_LENGTH} 个字符。`);
    }
    const normalizedQuestion = question.trim();
    if (requestKey !== undefined && (!validText(requestKey, 256) || requestKey !== requestKey.trim())) {
      throw problem('INVALID_REQUEST_KEY', '请求标识必须是 1 到 256 个字符，且不能包含首尾空格。');
    }
    if (requestKey && this.requestKeys.has(requestKey)) {
      const existing = this.jobs.get(this.requestKeys.get(requestKey));
      if (existing.question !== normalizedQuestion) {
        throw problem('REQUEST_KEY_CONFLICT', '该请求标识已用于另一个问题。', 409);
      }
      return publicJob(existing);
    }

    const webhook = httpsUrl(this.config.grokWebhookUrl, 'Grok Bot webhook');
    const callbackBase = httpsUrl(this.config.callbackBaseUrl, '回调入口', { publicOnly: true, base: true });
    if (!validText(this.config.grokWebhookKey, 4096) || /[\r\n]/.test(this.config.grokWebhookKey)) {
      throw problem('CONFIG_REQUIRED', '尚未配置有效的 Grok Bot webhook 密钥。', 503);
    }
    if (!['relay', 'direct'].includes(this.callbackMode)) {
      throw problem('CONFIG_REQUIRED', '结果回传模式配置无效。', 503);
    }
    if (this.callbackMode === 'relay') this.#requireRelay();

    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      question: normalizedQuestion,
      requestKey: requestKey ?? null,
      status: 'dispatching',
      callbackMode: this.callbackMode,
      dispatchPhase: this.callbackMode === 'relay' ? 'registering' : 'triggering',
      spokenReply: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      callbackToken: randomBytes(32).toString('base64url'),
    };
    this.jobs.set(job.id, job);
    if (requestKey) this.requestKeys.set(requestKey, job.id);
    try { this.#save(); } catch (error) {
      this.jobs.delete(job.id);
      if (requestKey) this.requestKeys.delete(requestKey);
      throw error;
    }

    let callbackUrl = `${callbackBase.href.replace(/\/+$/, '')}/callbacks/grok/${job.id}`;
    if (this.callbackMode === 'relay') {
      let registered;
      try {
        registered = await this.relay.register(job.id, job.callbackToken);
        if (registered?.callback_url !== callbackUrl) throw new Error('Invalid relay callback');
      } catch {
        this.#update(job, {
          status: 'failed', dispatchPhase: 'registration_failed',
          error: '结果邮箱准备失败，尚未向 Grok Bot 发送任务；请检查邮箱配置后再发起新请求。',
        });
        return publicJob(job);
      }
      this.#update(job, { dispatchPhase: 'triggering' });
      callbackUrl = registered.callback_url;
    }
    const payload = {
      request_id: job.id,
      question: normalizedQuestion,
      callback_url: callbackUrl,
      callback_token: job.callbackToken,
      callback_contract: {
        method: 'POST',
        authorization: 'Bearer <callback_token>',
        content_type: 'application/json',
        body: {
          request_id: job.id,
          status: 'completed | failed | needs_input',
          spoken_reply: '给用户朗读的简洁中文结果',
        },
      },
      instructions: '请处理 question 中的请求，并保留该 Grok Bot 原有的记忆和能力。'
        + '任务完成、失败或需要用户补充信息时，必须向 callback_url 发出 HTTP POST，'
        + '使用 Authorization: Bearer 加本次 callback_token，Content-Type: application/json，'
        + 'JSON 必须包含 request_id（与本次 request_id 完全一致）、status（completed、failed 或 needs_input）'
        + '与 spoken_reply（简洁中文文本，适合语音朗读）。'
        + 'HTTP webhook 触发成功只表示接收任务，不能代替结果回传。不要把回调密钥或地址写进 spoken_reply。'
        + '如无法发出回调，请在 Grok Bot 对话里明确说明尚未回传；不要声称 Stackchan 已收到结果。',
    };

    let response;
    try {
      response = await this.fetchImpl(webhook.href, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.grokWebhookKey}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
      });
    } catch {
      if (job.status === 'dispatching') {
        this.#update(job, {
          status: 'unknown',
          error: '发送超时或网络中断，任务是否已启动未知；请先查询 Grok Bot，避免重复安排。',
        });
      }
      return publicJob(job);
    }

    if (job.status === 'dispatching') {
      if (response.ok === true) {
        this.#update(job, { status: 'accepted', error: null });
      } else {
        const status = Number.isInteger(response.status) ? response.status : 0;
        const definitiveRejection = status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
        this.#update(job, {
          status: definitiveRejection ? 'failed' : 'unknown',
          error: definitiveRejection
            ? `Grok Bot 拒绝了任务（HTTP ${status}），请检查 webhook 配置。`
            : '未收到明确的任务接收确认；请先查询 Grok Bot，避免重复安排。',
        });
      }
    }
    return publicJob(job);
  }

  async acceptCallback(jobId, bearer, payload) {
    const job = this.jobs.get(jobId);
    if (!job) throw problem('JOB_NOT_FOUND', '未找到该任务。', 404);
    const candidate = typeof bearer === 'string' ? bearer : '';
    const expected = Buffer.from(job.callbackToken);
    const provided = Buffer.from(candidate);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw problem('CALLBACK_UNAUTHORIZED', '回调认证失败。', 401);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.request_id !== jobId
      || !CALLBACK_STATUSES.has(payload.status) || !validText(payload.spoken_reply, MAX_REPLY_LENGTH)) {
      throw problem('INVALID_CALLBACK', '回调必须包含匹配的 request_id、有效的 status 和非空 spoken_reply。');
    }
    const reply = payload.spoken_reply.trim();
    const knownSecrets = [this.config.grokWebhookKey, this.config.mcpEndpoint, this.config.relayMasterToken,
      ...[...this.jobs.values()].map((entry) => entry.callbackToken)];
    if (this.config.mcpEndpoint) {
      try { knownSecrets.push(new URL(this.config.mcpEndpoint).searchParams.get('token')); } catch {}
    }
    if (knownSecrets.some((secret) => typeof secret === 'string' && secret.length > 0 && reply.includes(secret))) {
      throw problem('INVALID_CALLBACK', '语音回复包含敏感连接信息，请移除后重新回传。');
    }
    if (job.status === payload.status && job.spokenReply === reply) return publicJob(job);
    if (FINAL_STATUSES.has(job.status) && job.spokenReply !== null) {
      throw problem('CALLBACK_CONFLICT', '该任务已收到最终结果，不能覆盖。', 409);
    }
    this.#update(job, { status: payload.status, spokenReply: reply, error: null });
    return publicJob(job);
  }
}
