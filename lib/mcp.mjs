import { createHash, randomUUID } from 'node:crypto';

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_QUESTION_CHARS = 4000;
const MAX_SESSION_REQUESTS = 1024;
const MAX_AUTOMATIC_FLOWS = 128;
const MAX_CONTINUATION_TOKENS = 512;
const WAITING_STATUSES = new Set(['pending', 'dispatching', 'accepted', 'running', 'unknown']);
const SUPPORTED_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const INSTRUCTIONS = '保留 StackChan 原有聊天、语音和转头、灯光等全部设备控制工具。只有用户明确说“问 Grok Bot”“请 Grok Bot 帮忙”等要求时才调用 ask_grok_bot。工具通常在本轮等待约 25 秒获取真实结果；返回“Grok Bot 已回复”时，当次直接通过现有语音朗读答复；返回“Grok Bot 需要你补充信息”时，当次向用户询问缺少的信息。上述结果不要再说成已提交或仍在处理。只有尚无最终答复的长任务才稍后用 check_grok_task 查询，提交确认不代表完成。普通聊天或设备控制不要调用本桥接工具。';
const AUTOMATIC_INSTRUCTIONS = '保留 StackChan 原有聊天、语音和转头、灯光等全部设备控制工具。只有用户明确要求询问或委托已有 Grok Bot 时才调用 ask_grok_bot。每次工具调用只短暂等待；若返回自动续查指令，在当前轮按正文给出的完整参数调用 check_grok_task，不需要用户追问，也不要朗读中间控制说明。只查询同一个任务，不得再次调用 ask_grok_bot。工具限制了自动查询次数和累计时间；没有新的 continuation_token 或提示本轮自动等待已结束时必须停止自动查询。返回“Grok Bot 已回复”时立即通过原有语音朗读真实答复；返回“Grok Bot 需要你补充信息”时当次询问。任务提交或等待中不代表完成，不要编造答复。普通聊天和设备控制继续使用原有工具。';
const UNTIL_RESULT_INSTRUCTIONS = '保留 StackChan 原有聊天、语音和转头、灯光等全部设备控制工具。只有用户明确要求询问或委托已有 Grok Bot 时才调用 ask_grok_bot。首次收到明确委托时，先调用 ask_grok_bot；首次提交不需要 continuation_token。持续等待模式不设置本轮自动续查的总时长或次数上限，但每次工具调用只短暂等待。只有工具提供新的 continuation_token 时，才在当前轮按正文给出的完整参数调用 check_grok_task，只查询同一个任务，不得重新提交，不需要用户追问，不朗读控制说明。用户要求停止等待或不再播报时，立即调用 cancel_grok_wait，并停止续查；这只停止本机等待，不取消 Grok Bot 任务。没有有效的新令牌、任务结束或查询出错时必须停止自动续查；这些续查停止条件不阻止首次提交。返回“Grok Bot 已回复”时立即通过原有语音朗读真实答复；需要补充信息时询问用户。云端可能结束或中断当前会话，本模式不能保证会话结束后主动开口，不能声称已经设置会话外播报。普通聊天和设备控制继续使用原有工具。';
const INTERIM_PROGRESS_SENTENCE = '我还在等格洛克的回复，再查一下。';
const INTERIM_SPEECH_INSTRUCTIONS = `等待期间的语音衔接：每次收到有效自动续查指令后，先用 StackChan 原有音色只朗读一句“${INTERIM_PROGRESS_SENTENCE}”，然后在当前轮按工具提供的完整参数续查同一任务。不要等待用户再次说话；不要朗读任务编号、参数或其他控制说明。进度句不代表 Bot 已收到或完成任务；播报不增加查询次数、延长累计时间或允许重新提交。没有有效续查指令时不播报这句，也不继续查询。`;
const QUESTION_INSTRUCTIONS = 'Grok Bot 的中文称呼为“格洛克”或“格罗克”。用户明确说“让格洛克……”“请格洛克……”“叫格洛克……”或“帮我问问 Grok Bot……”时，应将后面的完整请求交给 ask_grok_bot，question 保留实际问题、安排和必要上下文，包括“先等两分钟再回复”等等待或延迟要求，只去掉转交用语。明确委托 Grok 的等待、延迟或提醒要求也应交给 Grok，不能擅自改为 StackChan 自己设置提醒、闹钟或定时器，不能用本机提醒代替 Grok 的真实答复。未委托 Grok 的普通提醒、闹钟及设备控制继续使用 StackChan 原有工具。若只识别到 Bot 的名称而没有具体问题，应先向用户问清楚，不调用工具，也不要让 Bot 再去寻找同名队友。';

const TOOLS = [
  {
    name: 'ask_grok_bot',
    description: '仅在用户明确要求询问或委托其已有 Grok Bot 时提交任务，按原 Bot 的权限和确认机制处理。保留用户的问题和上下文；普通聊天、转头、灯光、摄像头等使用原有工具。默认在本轮等待约 25 秒获取真实结果。返回“Grok Bot 已回复”时，当次直接朗读真实答复；返回“Grok Bot 需要你补充信息”时，当次询问用户，不要再说成已提交或仍在处理。长任务若尚无最终答复，才稍后用 check_grok_task 查询；不要编造回复或重新提交同一任务。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', minLength: 1, maxLength: MAX_QUESTION_CHARS, description: '用户实际要交给 Grok Bot（格洛克/格罗克）的完整问题或安排及必要上下文，保留先等待、延迟多久或多久后再回复的要求。去掉“帮我问问 Grok Bot”“让格洛克”等转交用语；明确委托 Grok 时不要改成本机提醒。没有识别到具体问题时先问用户，不调用工具。' },
        request_key: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$', description: '可选的幂等键。同一任务重试时使用相同键，避免重复安排。' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'check_grok_task',
    description: '查询此前明确委托给 Grok Bot 的任务。task_id 不填时查询最近任务。返回“Grok Bot 已回复”时，当次直接用 StackChan 原有语音朗读答复；返回“Grok Bot 需要你补充信息”时，当次向用户询问待补充事项；不要把这些结果说成仍在处理，也不要重新提交任务。pending、dispatching、accepted、running 或 unknown 都不代表完成，只有尚无最终答复时才稍后再查。不要用本工具执行普通聊天或设备控制，不要频繁循环轮询。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$', description: 'ask_grok_bot 返回的任务编号；省略时查询最近一次任务。' },
        continuation_token: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$', description: '仅自动续查时，原样填写上次工具正文指定的值，并同时提供指定的 task_id。手动查询不要填写。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const CANCEL_WAIT_TOOL = {
  name: 'cancel_grok_wait',
  description: '仅在用户要求停止等待或不再自动播报 Grok Bot 结果时，停止本机对指定任务的自动续查。省略 task_id 时停止最近等待的任务。不会撤销或重新提交 Grok Bot 任务，也不会清除结果；之后仍可手动查询。',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$', description: '需要停止自动等待的任务编号；省略时选择最近等待的任务。' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function response(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

const RESULT_META_KEY = 'io.stackchan.grok.result';

function toolResult(text, isError = false, extra = {}, speech = text) {
  return { content: [{ type: 'text', text }], isError, _meta: { [RESULT_META_KEY]: { ...extra, speech } } };
}

/** Read bridge metadata while accepting tool results from older bridge versions. */
export function readToolSummary(answer) {
  const summary = answer?.result?._meta?.[RESULT_META_KEY];
  if (record(summary)) return summary;
  try {
    const legacy = JSON.parse(answer?.result?.content?.[0]?.text);
    return record(legacy) ? legacy : {};
  } catch { return {}; }
}

function safeText(value, limit = 12000) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/wss?:\/\/[^\s<>"']+/gi, '[MCP 接入地址已隐藏]')
    .replace(/([?&](?:token|secret|api_key|apikey|access_token)=)[^\s&#"']+/gi, '$1[已隐藏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [已隐藏]')
    .slice(0, limit);
}

function jobResult(job, submitted = false) {
  if (!job) return toolResult('目前没有找到 Grok Bot 任务。可以先说“帮我问问 Grok Bot……”来提交任务。');
  const taskId = safeText(job.id ?? job.task_id, 128);
  const status = typeof job.status === 'string' ? safeText(job.status, 40) : 'unknown';
  const fields = { task_id: taskId, status };
  const reply = safeText(job.spokenReply || job.result || job.reply || job.message || job.error);
  if (status === 'completed') {
    const speech = reply || 'Grok Bot 已完成任务，但没有返回可播报的文字。';
    return toolResult(`Grok Bot 已回复：\n${speech}`, false, fields, speech);
  }
  if (status === 'needs_input') {
    const speech = reply || '请到本机 Grok Bot 查看待确认的问题。';
    return toolResult(`Grok Bot 需要你补充信息：\n${speech}`, false, fields, speech);
  }
  if (status === 'failed') {
    return toolResult(reply || '这次 Grok Bot 任务失败了。请查看 Mac 中转服务的任务状态后再决定是否重试。', true, fields);
  }
  if (status === 'unknown') {
    return toolResult('目前无法确认 Grok Bot 是否已收到或完成任务。为避免重复安排，请先查询已有任务或到 Grok Bot 核实，不要自动再次提交。', false, fields);
  }
  const stateText = submitted ? '任务已登记，正在转交或等待 Grok Bot 回复' : 'Grok Bot 任务仍在等待或处理中';
  return toolResult(`${stateText}。这不是完成确认，尚无最终答复；稍后可以查询任务进度。`, false, fields);
}

function allowedArgs(args, keys) {
  return record(args) && Object.keys(args).every(key => keys.includes(key));
}

function validKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

/** JSON-RPC handler. The jobs object supplies sanitized submit/get/latest views. */
export function createMcpHandler({ jobs, version = '1.0.0', automaticChecks = 0, automaticCheckBudgetMs = 30_000, automaticWaitMode = 'bounded', interimSpeech = false, now = () => performance.now() } = {}) {
  if (!jobs || ['submit', 'get', 'latest'].some(name => typeof jobs[name] !== 'function')) {
    throw new TypeError('MCP requires a jobs manager with submit, get and latest methods.');
  }
  if (!Number.isInteger(automaticChecks) || automaticChecks < 0 || automaticChecks > 12
    || !Number.isFinite(automaticCheckBudgetMs) || automaticCheckBudgetMs <= 0 || automaticCheckBudgetMs > 90_000
    || !['bounded', 'until_result'].includes(automaticWaitMode)
    || typeof interimSpeech !== 'boolean' || typeof now !== 'function') {
    throw new TypeError('Automatic checks require 0–12 checks and a positive budget of at most 90000 ms.');
  }
  const untilResult = automaticWaitMode === 'until_result';
  const automaticEnabled = untilResult || automaticChecks > 0;
  const speechInstructions = untilResult
    ? INTERIM_SPEECH_INSTRUCTIONS.replace('播报不增加查询次数、延长累计时间或允许重新提交。', '播报不允许重新提交任务；用户要求停止时立即调用 cancel_grok_wait。')
    : INTERIM_SPEECH_INSTRUCTIONS;
  let sessionId;
  let calls;
  let flows;
  let activeTokens;
  let replayTokens;
  function resetSession() {
    sessionId = randomUUID();
    calls = new Map();
    flows = new Map();
    activeTokens = new Map();
    replayTokens = new Map();
  }
  resetSession();

  function touch(map, key, value) {
    map.delete(key);
    map.set(key, value);
  }

  function rememberReplay(key, token) {
    activeTokens.delete(key);
    touch(replayTokens, key, token);
    while (replayTokens.size > MAX_CONTINUATION_TOKENS) replayTokens.delete(replayTokens.keys().next().value);
  }

  function flowExpired(flow) {
    return !untilResult && (flow.remaining <= 0 || now() >= flow.deadline);
  }

  function stoppedResult(job) {
    const result = jobResult(job);
    if (job && WAITING_STATUSES.has(job.status)) {
      result.content[0].text += ' 本轮自动等待已结束，请停止自动查询；结果尚未确认，可稍后手动查询同一任务，不要重新提交。';
    }
    return result;
  }

  function offerContinuation(job, flow) {
    flow.lastJob = job;
    if (flow.stopResult) return flow.stopResult;
    if (flow.finalResult) return flow.finalResult;
    if (!job || !WAITING_STATUSES.has(job.status)) {
      flow.finalResult = jobResult(job);
      return flow.finalResult;
    }
    if (flows.get(flow.taskId) !== flow || flowExpired(flow)) return stoppedResult(job);
    if (flow.currentToken) {
      const current = activeTokens.get(flow.currentToken) ?? replayTokens.get(flow.currentToken);
      if (current) return current.offeredResult;
      // Eviction must not create another branch of an already issued check.
      return stoppedResult(job);
    }
    const token = randomUUID();
    const args = { task_id: flow.taskId, continuation_token: token };
    const progressInstruction = interimSpeech
      ? `先用 StackChan 原有音色只朗读一句“${INTERIM_PROGRESS_SENTENCE}”，然后在当前轮继续；不要等待用户再次说话。`
      : '';
    const result = toolResult(
      `Grok Bot 尚无最终答复。任务编号：${flow.taskId}。${progressInstruction}现在自动调用 check_grok_task，完整参数为 ${JSON.stringify(args)}。只查询这项已有任务，不要再次提交；不要朗读这段控制说明。收到真实答复后立即用原有语音读出，没有新的续查指令时停止自动查询。`,
      false,
      { task_id: flow.taskId, status: job.status, continuation_token: token, automatic_checks_remaining: flow.remaining, ...(untilResult ? { automatic_wait_mode: automaticWaitMode } : {}) },
      'Grok Bot 的任务仍在处理中。',
    );
    flow.currentToken = token;
    activeTokens.set(token, { flow, offeredResult: result, result: null });
    return result;
  }

  function submittedResult(job, startedAt) {
    if (!automaticEnabled || !job || !WAITING_STATUSES.has(job.status) || !validKey(job.id ?? job.task_id)) return jobResult(job, true);
    const taskId = job.id ?? job.task_id;
    let flow = flows.get(taskId);
    if (!flow) {
      flow = { taskId, remaining: untilResult ? null : automaticChecks, deadline: untilResult ? null : startedAt + automaticCheckBudgetMs, currentToken: null, lastJob: job };
      flows.set(taskId, flow);
      while (flows.size > MAX_AUTOMATIC_FLOWS) {
        const oldest = flows.keys().next().value;
        activeTokens.delete(flows.get(oldest).currentToken);
        flows.delete(oldest);
      }
    } else touch(flows, taskId, flow);
    return offerContinuation(job, flow);
  }

  async function continueCheck(id, args) {
    const token = activeTokens.get(args.continuation_token) ?? replayTokens.get(args.continuation_token);
    if (!token || args.task_id !== token.flow.taskId || flows.get(token.flow.taskId) !== token.flow) {
      return rpcError(id, -32602, 'The continuation is invalid or expired; use a manual query for the original task.');
    }
    const flow = token.flow;
    if (replayTokens.has(args.continuation_token)) touch(replayTokens, args.continuation_token, token);
    touch(flows, flow.taskId, flow);
    if (flow.stopResult) return response(id, flow.stopResult);
    // A consumed token always shares its original operation, even if the peer
    // assigns another RPC id. Replays cannot consume another check or wait.
    if (!token.result) {
      if (flowExpired(flow) || flow.currentToken !== args.continuation_token) {
        return response(id, stoppedResult(flow.lastJob));
      }
      if (!untilResult) flow.remaining -= 1;
      token.result = Promise.resolve().then(async () => {
        if (flow.stopResult) return flow.stopResult;
        if (flows.get(flow.taskId) !== flow) return stoppedResult(flow.lastJob);
        const job = untilResult
          ? await jobs.get(flow.taskId)
          : await jobs.get(flow.taskId, { waitMs: Math.max(0, flow.deadline - now()) });
        if (job && (job.id ?? job.task_id) !== flow.taskId) throw new Error('Task lookup mismatch.');
        if (flow.currentToken === args.continuation_token) flow.currentToken = null;
        return offerContinuation(job, flow);
      }).catch(() => {
        flow.stopResult ??= toolResult('暂时无法查询 Grok Bot 的任务状态。请停止自动查询，稍后手动查询同一任务；不要重新提交，也不要当作任务完成。', true, { task_id: flow.taskId });
        return flow.stopResult;
      }).then(result => {
        // Current capabilities never compete with historical replay entries.
        // Keep replay memory finite even if a single task rotates indefinitely.
        if (flows.get(flow.taskId) === flow) rememberReplay(args.continuation_token, token);
        return result;
      });
    }
    return response(id, await token.result);
  }

  async function callTool(id, params, requestKey) {
    if (!record(params) || typeof params.name !== 'string') return rpcError(id, -32602, 'Invalid tool call parameters.');
    const args = params.arguments ?? {};
    if (untilResult && params.name === 'cancel_grok_wait') {
      if (!allowedArgs(args, ['task_id']) || args.task_id !== undefined && !validKey(args.task_id)) {
        return rpcError(id, -32602, 'task_id must be a safe identifier.');
      }
      const flow = args.task_id ? flows.get(args.task_id) : [...flows.values()].at(-1);
      if (!flow || flow.finalResult) {
        return response(id, toolResult('没有找到正在自动等待的 Grok Bot 任务。没有取消或重新提交任何 Grok Bot 任务。'));
      }
      if (!flow.cancelled) {
        flow.cancelled = true;
        flow.stopResult = toolResult('已停止这项任务的自动等待。Grok Bot 任务本身未取消；之后仍可手动查询结果。', false, { task_id: flow.taskId, status: 'wait_cancelled', local_wait_cancelled: true });
      }
      const token = activeTokens.get(flow.currentToken);
      if (token && !token.result) {
        token.result = Promise.resolve(flow.stopResult);
        rememberReplay(flow.currentToken, token);
        flow.currentToken = null;
      }
      return response(id, flow.stopResult);
    }
    if (params.name === 'ask_grok_bot') {
      const startedAt = now();
      if (!allowedArgs(args, ['question', 'request_key']) || typeof args.question !== 'string' || !args.question.trim() || args.question.length > MAX_QUESTION_CHARS || (args.request_key !== undefined && !validKey(args.request_key))) {
        return rpcError(id, -32602, 'question must be 1–4000 characters; request_key must be a safe identifier of at most 128 characters.');
      }
      try {
        const job = await jobs.submit(args.question.trim(), { requestKey: args.request_key ?? requestKey });
        return response(id, submittedResult(job, startedAt));
      } catch {
        return response(id, toolResult('暂时无法提交给 Grok Bot。没有确认任务完成；请查看 Mac 中转服务的状态，避免反复提交同一安排。', true));
      }
    }
    if (params.name === 'check_grok_task') {
      if (!allowedArgs(args, ['task_id', 'continuation_token']) || (args.task_id !== undefined && !validKey(args.task_id))
        || args.continuation_token !== undefined && (!validKey(args.continuation_token) || !validKey(args.task_id))) return rpcError(id, -32602, 'task_id and continuation_token must be safe identifiers; a continuation also requires its task_id.');
      if (args.continuation_token !== undefined) return continueCheck(id, args);
      try {
        const job = args.task_id ? await jobs.get(args.task_id) : await jobs.latest();
        return response(id, jobResult(job));
      } catch {
        return response(id, toolResult('暂时无法查询 Grok Bot 的任务状态。请稍后再查，不要将本次查询失败当作任务完成。', true));
      }
    }
    return rpcError(id, -32602, 'Unknown tool.');
  }

  const handle = async message => {
    // Bound direct use as well as transport use; never include input in an error.
    let serialized;
    try { serialized = JSON.stringify(message); } catch { return rpcError(null, -32600, 'Invalid request.'); }
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES) return rpcError(null, -32600, 'Invalid or oversized request.');
    if (!record(message) || message.jsonrpc !== '2.0') return rpcError(null, -32600, 'Invalid request.');
    const hasId = Object.hasOwn(message, 'id');
    const id = message.id;
    if (hasId && !(id === null || typeof id === 'string' && id.length <= 128 || typeof id === 'number' && Number.isFinite(id))) return rpcError(null, -32600, 'Invalid request id.');
    // Ignore responses from the peer and all notifications without executing tools.
    if (!Object.hasOwn(message, 'method') && hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) return null;
    if (typeof message.method !== 'string') return rpcError(hasId ? id : null, -32600, 'Invalid method.');
    if (!hasId) return null;
    if (message.params !== undefined && !record(message.params)) return rpcError(id, -32602, 'Parameters must be an object.');
    if (message.method === 'initialize') {
      if (typeof message.params?.protocolVersion !== 'string') return rpcError(id, -32602, 'A protocolVersion is required.');
      resetSession();
      return response(id, {
        protocolVersion: SUPPORTED_VERSIONS.has(message.params.protocolVersion) ? message.params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'stackchan-grok-bridge', version },
        instructions: `${untilResult ? UNTIL_RESULT_INSTRUCTIONS : automaticEnabled ? AUTOMATIC_INSTRUCTIONS : INSTRUCTIONS}${QUESTION_INSTRUCTIONS}${automaticEnabled && interimSpeech ? speechInstructions : ''}`,
      });
    }
    if (message.method === 'ping') return response(id, {});
    if (message.method === 'tools/list') {
      const tools = structuredClone(TOOLS);
      if (automaticEnabled) {
        tools[0].description = '仅在用户明确要求询问或委托其已有 Grok Bot 时提交一次任务，按原 Bot 的权限和确认机制处理，保留用户的问题和上下文。每次短暂等待，尚未完成时严格遵循工具返回的有界自动续查指令，在当前轮查询同一任务，不要让用户再次追问，不要重复提交。取得真实答复后立即通过原有语音朗读；需要补充信息时询问用户。没有续查指令或本轮自动等待结束后停止，不能编造结果。普通聊天和设备控制使用原有工具。';
        tools[1].description += ' 唯有工具正文提供 continuation_token 时，才在当前轮按完整指定参数进行一次自动续查；次数与累计时间由工具限制，不能自行重建或反复使用续查参数。手动查询可以省略 continuation_token。';
        if (untilResult) {
          tools[0].description = '仅在用户明确要求时提交一次 Grok Bot 任务。首次明确委托先调用本工具，不需要 continuation_token；后续自动查询才需要工具新提供的令牌。持续等待模式没有自动续查总时长或次数上限；每次短暂等待，只按工具新提供的完整参数在当前轮续查同一任务，不需要用户追问，不得重新提交。真实答复立即通过原有语音朗读；失败、需要补充信息、查询异常或没有有效新令牌时停止自动续查，不阻止首次提交。用户要求停止时调用 cancel_grok_wait。云端结束当前会话后不能保证主动开口。普通聊天和设备控制使用原有工具。';
          tools[1].description = '查询此前明确委托给 Grok Bot 的已有任务，task_id 省略时手动查询最近任务。只有工具新提供 continuation_token 时，才按完整参数自动续查同一任务；不要重建令牌或重新提交任务。持续等待模式没有总时长或次数上限，每次只短暂等待。返回真实答复时立即用原厂语音朗读；失败、需要补充信息、查询异常或无有效新令牌时停止自动续查。用户要求停止时调用 cancel_grok_wait。手动查询不填写 continuation_token，不会自动开始持续等待。';
          tools.push(structuredClone(CANCEL_WAIT_TOOL));
        }
        if (interimSpeech) {
          tools[0].description += speechInstructions;
          tools[1].description += speechInstructions;
        }
      }
      tools[0].description += QUESTION_INSTRUCTIONS;
      return response(id, { tools });
    }
    if (message.method === 'tools/call') {
      const signature = JSON.stringify(message.params);
      const key = `${typeof id}:${String(id)}`;
      const prior = calls.get(key);
      if (prior) {
        calls.delete(key);
        calls.set(key, prior);
        if (prior.signature !== signature) return rpcError(id, -32600, 'Request id was reused with different content.');
        // A replay must never dispatch a task twice. Read-only status queries
        // can refresh after completion, while concurrent duplicates share work.
        if (message.params?.name !== 'check_grok_task' || !prior.settled) return prior.result;
      }
      // LRU bounds memory for a permanently connected Mac. Eviction never
      // changes the derived requestKey; the jobs manager's persisted dedupe
      // continues to protect old replayed submissions.
      if (!prior && calls.size >= MAX_SESSION_REQUESTS) calls.delete(calls.keys().next().value);
      const requestKey = `mcp:${sessionId}:${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
      const result = callTool(id, message.params, requestKey);
      const entry = { signature, result, settled: false };
      calls.set(key, entry);
      void result.then(() => { entry.settled = true; }, () => { entry.settled = true; });
      return result;
    }
    return rpcError(id, -32601, 'Method not found.');
  };
  handle.resetSession = resetSession;
  return handle;
}

function validateEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw new TypeError('MCP endpoint must be a valid wss URL.'); }
  if (url.protocol !== 'wss:' || !url.hostname || url.username || url.password || url.hash) {
    throw new TypeError('MCP endpoint must be a wss URL without user credentials or a fragment.');
  }
  return url.href;
}

/**
 * Actively connects to the XiaoZhi MCP access point. No public listener is opened.
 * Returns { stop(), done, status }. Optional transport/timing parameters support
 * isolated tests; production defaults use Node's built-in WebSocket.
 */
export function connectMcp({ endpoint, handler, signal, logger = () => {}, WebSocketImpl = globalThis.WebSocket, retryBaseMs = 1000, retryMaxMs = 60000, connectTimeoutMs = 15000, random = Math.random } = {}) {
  const url = validateEndpoint(endpoint);
  if (typeof handler !== 'function' || typeof WebSocketImpl !== 'function') throw new TypeError('MCP requires a handler and a WebSocket implementation.');
  if (![retryBaseMs, retryMaxMs, connectTimeoutMs].every(value => Number.isFinite(value) && value > 0)) throw new TypeError('MCP timeouts must be positive finite numbers.');
  const controller = new AbortController();
  let socket;
  let status = 'connecting';
  let stopped = false;
  function log(event) {
    // The logger receives fixed event names only; endpoint, peer data and thrown
    // errors can all contain credentials and must never be passed to it.
    try {
      if (typeof logger === 'function') logger(event);
      else if (typeof logger?.info === 'function') logger.info(event);
    } catch { /* A logging sink must not affect task delivery. */ }
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    status = 'stopped';
    controller.abort();
    try { socket?.close(1000, 'Bridge stopped'); } catch { /* Already closed. */ }
  }
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });

  function wait(ms) {
    return new Promise(resolve => {
      if (controller.signal.aborted) return resolve();
      const finish = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      controller.signal.addEventListener('abort', finish, { once: true });
    });
  }

  function session() {
    return new Promise(resolve => {
      let ws;
      let ended = false;
      let openedAt = null;
      let queue = Promise.resolve();
      let queuedBytes = 0;
      let queuedMessages = 0;
      try { ws = new WebSocketImpl(url); } catch { log('mcp_connection_failed'); resolve(false); return; }
      socket = ws;
      ws.binaryType = 'arraybuffer';
      const finish = () => {
        if (ended) return;
        ended = true;
        clearTimeout(timeout);
        controller.signal.removeEventListener('abort', abort);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('message', onMessage);
        ws.removeEventListener('close', finish);
        ws.removeEventListener('error', onError);
        if (socket === ws) socket = undefined;
        resolve(openedAt !== null && Date.now() - openedAt >= 30000);
      };
      const abort = () => { finish(); try { ws.close(1000, 'Bridge stopped'); } catch { /* Already closed. */ } };
      const fail = event => {
        log(event);
        finish();
        try { ws.close(1008, 'Bridge connection reset'); } catch { /* Already closed. */ }
      };
      const send = value => {
        if (ended || stopped || ws.readyState !== 1 || value === null || value === undefined) return;
        try { ws.send(`${JSON.stringify(value)}\n`); } catch { fail('mcp_send_failed'); }
      };
      const onOpen = () => {
        if (ended || stopped) return;
        clearTimeout(timeout);
        openedAt = Date.now();
        status = 'connected';
        try { handler.resetSession?.(); } catch { fail('mcp_handler_failed'); return; }
        log('mcp_connected');
      };
      const onMessage = event => {
        if (ended || stopped) return;
        let data;
        if (typeof event.data === 'string') data = event.data;
        else if (event.data instanceof ArrayBuffer) data = new TextDecoder().decode(event.data);
        else if (ArrayBuffer.isView(event.data)) data = new TextDecoder().decode(event.data);
        else { fail('mcp_unsupported_message'); return; }
        const bytes = Buffer.byteLength(data);
        if (bytes > MAX_MESSAGE_BYTES || queuedBytes + bytes > 4 * MAX_MESSAGE_BYTES || queuedMessages >= 64) { fail('mcp_message_limit'); return; }
        queuedBytes += bytes;
        queuedMessages += 1;
        queue = queue.then(async () => {
          try {
            if (ended || stopped) return;
            // The official stdio pipe uses one JSON object per line. Also accept
            // a complete object without a trailing newline.
            const lines = data.split(/\r?\n/).filter(line => line.trim());
            if (lines.length > 64) { fail('mcp_message_limit'); return; }
            for (const line of lines) {
              if (ended || stopped) break;
              let message;
              try { message = JSON.parse(line); } catch { send(rpcError(null, -32700, 'Parse error.')); continue; }
              try {
                const answer = await handler(message);
                send(answer);
                if (answer?.result && message.method === 'initialize') log('mcp_initialized');
                if (answer?.result && message.method === 'tools/list') log('mcp_tools_listed');
              } catch { send(rpcError(record(message) ? message.id : null, -32603, 'Internal error.')); log('mcp_handler_failed'); }
            }
          } finally {
            queuedBytes -= bytes;
            queuedMessages -= 1;
          }
        }).catch(() => fail('mcp_handler_failed'));
      };
      const onError = () => fail('mcp_connection_failed');
      const timeout = setTimeout(() => fail('mcp_connect_timeout'), connectTimeoutMs);
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', finish);
      ws.addEventListener('error', onError);
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
    });
  }

  const done = (async () => {
    let attempts = 0;
    try {
      while (!stopped) {
        status = 'connecting';
        const stable = await session();
        if (stopped) break;
        // Reset backoff after a stable connection. A server that opens and then
        // immediately closes must also back off, rather than reconnect forever
        // at the initial delay.
        attempts = stable ? 0 : Math.min(attempts + 1, 30);
        status = 'reconnecting';
        log('mcp_reconnecting');
        const base = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, attempts - 1));
        let jitter = 0.5;
        try { const value = random(); if (Number.isFinite(value)) jitter = Math.max(0, Math.min(1, value)); } catch { /* Fixed midpoint. */ }
        await wait(Math.max(1, Math.floor(base * (0.8 + jitter * 0.4))));
      }
    } finally {
      signal?.removeEventListener('abort', stop);
      status = 'stopped';
      log('mcp_stopped');
    }
  })();
  return { stop, done, get status() { return status; } };
}
