'use strict';

const DEFAULT_MAX_ROUNDS = 4;
const DEFAULT_MAX_TOOL_CALLS = 12;
const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_TOOL_RESULT_CHARS = 4000;

function cancelledError() {
  const error = new Error('Cancelled.');
  error.cancelled = true;
  return error;
}

function timeoutError(timeoutMs) {
  const error = new Error(`The assistant took too long and was stopped after ${Math.round(timeoutMs / 1000)} seconds.`);
  error.timeout = true;
  return error;
}

function defaultMessageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return '';
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function withDeadline(promise, deadlineAt, now, onTimeout, timeoutMs) {
  const remaining = deadlineAt - now();
  if (remaining <= 0) {
    onTimeout?.();
    return Promise.reject(timeoutError(timeoutMs));
  }
  let timer = null;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(timeoutError(timeoutMs));
    }, remaining);
    timer.unref?.();
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

async function runAgentLoop(options = {}) {
  const {
    messages,
    callModel,
    executeTool,
    isAlive = () => true,
    onTimeout,
    signal,
    messageToText = defaultMessageText,
    maxRounds = DEFAULT_MAX_ROUNDS,
    maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
    maxConsecutiveFailures = DEFAULT_MAX_FAILURES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxToolResultChars = DEFAULT_TOOL_RESULT_CHARS,
    now = Date.now
  } = options;

  if (!Array.isArray(messages)) throw new Error('Agent messages must be an array.');
  if (typeof callModel !== 'function') throw new Error('Agent loop needs a model function.');
  if (typeof executeTool !== 'function') throw new Error('Agent loop needs a tool executor.');

  const rounds = positiveInteger(maxRounds, DEFAULT_MAX_ROUNDS);
  const callLimit = positiveInteger(maxToolCalls, DEFAULT_MAX_TOOL_CALLS);
  const failureLimit = positiveInteger(maxConsecutiveFailures, DEFAULT_MAX_FAILURES);
  const totalTimeout = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS);
  const deadlineAt = now() + totalTimeout;
  const resultLimit = positiveInteger(maxToolResultChars, DEFAULT_TOOL_RESULT_CHARS);

  let lastContent = '';
  let toolCalls = 0;
  let consecutiveFailures = 0;
  let completedRounds = 0;

  function assertUsable() {
    if (signal?.aborted || !isAlive()) throw cancelledError();
    if (now() >= deadlineAt) throw timeoutError(totalTimeout);
  }

  for (let round = 0; round < rounds; round += 1) {
    assertUsable();
    completedRounds = round + 1;
    const message = await withDeadline(
      Promise.resolve().then(() => callModel(messages)),
      deadlineAt,
      now,
      onTimeout,
      totalTimeout
    );
    assertUsable();
    const content = String(messageToText(message) || '').trim();
    if (content) lastContent = content;
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    if (!calls.length) return { content: content || lastContent || 'Done.', rounds: completedRounds, toolCalls };

    messages.push({
      role: 'assistant',
      content: typeof message.content === 'string' ? message.content : '',
      tool_calls: calls
    });

    for (const call of calls) {
      assertUsable();
      if (toolCalls >= callLimit) throw new Error(`I stopped after ${callLimit} actions to avoid running in a loop.`);
      toolCalls += 1;
      const result = await withDeadline(
        Promise.resolve().then(() => executeTool(call)),
        deadlineAt,
        now,
        onTimeout,
        totalTimeout
      );
      assertUsable();
      if (result?.ok) consecutiveFailures = 0;
      else consecutiveFailures += 1;
      if (consecutiveFailures >= failureLimit) {
        throw new Error(`I stopped after ${failureLimit} actions in a row failed.`);
      }
      messages.push({
        role: 'tool',
        tool_call_id: call?.id || `call_${round}_${messages.length}`,
        content: JSON.stringify(result ?? { ok: false, error: 'No result.' }).slice(0, resultLimit)
      });
    }
  }

  return {
    content: lastContent || 'I stopped after several actions. Tell me what to do next.',
    rounds: completedRounds,
    toolCalls
  };
}

module.exports = {
  runAgentLoop,
  cancelledError,
  timeoutError,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_MAX_FAILURES,
  DEFAULT_TIMEOUT_MS
};
