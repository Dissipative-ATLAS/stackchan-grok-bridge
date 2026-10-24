import { setTimeout as delay } from 'node:timers/promises';

const REPLY_STATUSES = new Set(['completed', 'failed', 'needs_input']);
const STOPPED = Symbol('local-wait-stopped');

/**
 * Holds a voice tool call open for a real reply, without redispatching its task.
 * Optional total call budgets keep slow dispatch running safely in the
 * background. Stopping a local wait never cancels or resubmits the Bot task.
 */
export function createVoiceJobs({
  jobs,
  relayEnabled = false,
  replyWaitMs = 25_000,
  maxCallMs = null,
  pollIntervalMs = 1_500,
  signal,
  now = () => performance.now(),
  sleep = (ms, options) => delay(ms, undefined, options),
} = {}) {
  if (!jobs || ['submit', 'get', 'latest'].some((name) => typeof jobs[name] !== 'function')
    || relayEnabled && ['syncRelay', 'hasPendingRelay'].some((name) => typeof jobs[name] !== 'function')) {
    throw new TypeError('Voice replies require a jobs manager and configured relay methods.');
  }
  if (!Number.isFinite(replyWaitMs) || replyWaitMs < 0 || replyWaitMs > 90_000
    || maxCallMs !== null && (!Number.isFinite(maxCallMs) || maxCallMs <= 0 || maxCallMs > 90_000 || typeof jobs.getByRequestKey !== 'function')
    || !Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0
    || typeof now !== 'function' || typeof sleep !== 'function') {
    throw new TypeError('Voice reply waits must be 0–90000 ms with a positive polling interval.');
  }

  const background = new Set();
  function track(promise) {
    background.add(promise);
    void promise.then(() => background.delete(promise), () => background.delete(promise));
    return promise;
  }

  function queryBudget(options) {
    const requested = options?.waitMs ?? replyWaitMs;
    if (!Number.isFinite(requested) || requested < 0) throw new TypeError('Query wait must be a nonnegative finite number.');
    return Math.min(replyWaitMs, maxCallMs ?? replyWaitMs, requested);
  }

  // A slow mailbox request may finish in the background after the local voice
  // budget expires. JobManager owns that sync and safely retains its result.
  function bounded(operation, remainingMs) {
    if (signal?.aborted || remainingMs <= 0) return Promise.resolve(STOPPED);
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      let timer;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        controller.abort();
        callback(value);
      };
      const abort = () => finish(resolve, STOPPED);
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, remainingMs);
      Promise.resolve().then(() => {
        if (settled || signal?.aborted) return STOPPED;
        return operation(controller.signal);
      }).then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
  }

  async function waitForReply(initial, deadline = now() + replyWaitMs) {
    if (!initial || REPLY_STATUSES.has(initial.status)) return initial;
    let current = initial;
    const read = () => jobs.get(initial.id);
    while (!signal?.aborted && deadline > now()) {
      current = await read();
      if (!current || REPLY_STATUSES.has(current.status)) return current;
      let syncError;
      if (relayEnabled && jobs.hasPendingRelay()) {
        try {
          const synced = await bounded(() => track(Promise.resolve(jobs.syncRelay())), deadline - now());
          if (synced === STOPPED) return read();
        } catch (error) {
          syncError = error;
        }
        current = await read();
        // An acknowledgment can fail after the reply was safely persisted.
        if (!current || REPLY_STATUSES.has(current.status)) return current;
        if (syncError && syncError.code !== 'RELAY_UNAVAILABLE') throw syncError;
      }
      if (signal?.aborted) return read();
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      const paused = await bounded(
        (waitSignal) => sleep(Math.min(pollIntervalMs, remainingMs), { signal: waitSignal }),
        remainingMs,
      );
      if (paused === STOPPED) break;
    }
    return read();
  }

  return {
    async submit(question, options) {
      if (signal?.aborted) throw new DOMException('Voice bridge stopped before submission.', 'AbortError');
      // Submit exactly once. Its durable idempotency and errors remain owned by
      // JobManager; a timeout must never be interpreted as permission to retry.
      const startedAt = now();
      const submission = track(Promise.resolve(jobs.submit(question, options)));
      if (maxCallMs === null) return waitForReply(await submission);
      const deadline = startedAt + maxCallMs;
      const job = await bounded(() => submission, deadline - now());
      if (job === STOPPED) {
        // JobManager creates and persists this exact request before its first
        // network await. Never substitute latest(), which could be another task.
        const snapshot = jobs.getByRequestKey(options?.requestKey);
        if (!snapshot || snapshot.question !== question.trim()) {
          throw Object.assign(new Error('Cannot identify the dispatched task.'), { code: 'STATE_UNAVAILABLE' });
        }
        return snapshot;
      }
      return waitForReply(job, Math.min(deadline, now() + replyWaitMs));
    },
    async get(jobId, options) {
      const deadline = now() + queryBudget(options);
      return waitForReply(await jobs.get(jobId), deadline);
    },
    async latest(options) {
      const deadline = now() + queryBudget(options);
      return waitForReply(await jobs.latest(), deadline);
    },
    async drain() { await Promise.allSettled([...background]); },
  };
}
