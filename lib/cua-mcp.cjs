'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { LIMITS } = require('./constants.cjs');

// Keep the exposed surface small. The driver ships 60+ tools; these are the
// ones a voice assistant needs to complete ordinary desktop jobs.
const CUA_TOOL_NAMES = Object.freeze([
  'list_apps',
  'launch_app',
  'list_windows',
  'get_window_state',
  'verify_state',
  'bring_to_front',
  'click',
  'type_text',
  'press_key',
  'hotkey',
  'set_value',
  'scroll',
  'drag',
  'kill_app'
]);
const CUA_TOOL_SET = new Set(CUA_TOOL_NAMES);
// Pure reads are safe to repeat: a fresh read is often how the model verifies
// that its previous action actually changed the window.
const CUA_READ_ONLY_TOOLS = new Set([
  'cua_list_apps',
  'cua_list_windows',
  'cua_get_window_state',
  'cua_verify_state'
]);

const CUA_PREFIX = 'cua_';

function isCuaToolName(name) {
  return typeof name === 'string' && name.startsWith(CUA_PREFIX) && CUA_TOOL_SET.has(name.slice(CUA_PREFIX.length));
}

function cuaBaseName(name) {
  return isCuaToolName(name) ? name.slice(CUA_PREFIX.length) : null;
}

function cuaToolName(name) {
  return `${CUA_PREFIX}${name}`;
}

function readOpenCodeCommand() {
  const configPath = path.join(os.homedir(), '.config', 'opencode', 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const entry = raw?.mcp?.['cua-driver'];
    if (Array.isArray(entry?.command) && entry.command.length) {
      const [command, ...args] = entry.command;
      if (typeof command === 'string' && command.trim()) {
        const resolved = command.includes(path.sep) ? path.resolve(command) : command;
        return { command: resolved, args: args.map(String) };
      }
    }
  } catch {
    // Missing or unreadable config is normal when OpenCode is not installed.
  }
  return null;
}

function resolveCuaCommand() {
  const explicit = String(process.env.VOXA_CUA_DRIVER || '').trim();
  if (explicit) {
    return { command: path.resolve(explicit), args: ['mcp'], source: 'VOXA_CUA_DRIVER' };
  }
  const configured = readOpenCodeCommand();
  if (configured) {
    const args = configured.args.length ? configured.args : ['mcp'];
    return { command: configured.command, args, source: 'opencode config' };
  }
  const local = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe');
  if (fs.existsSync(local)) return { command: local, args: ['mcp'], source: 'default install' };
  return { command: 'cua-driver', args: ['mcp'], source: 'PATH' };
}

function clampText(value, max = LIMITS.CUA_MAX_TOOL_RESULT_CHARS) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n[... truncated ${text.length - max} characters]` : text;
}

function sanitizeSchema(schema) {
  const copy = structuredClone(schema || {});
  if (copy.properties && typeof copy.properties === 'object') {
    delete copy.properties.session;
    if (Array.isArray(copy.required)) copy.required = copy.required.filter((name) => name !== 'session');
  }
  if (copy.additionalProperties === undefined) copy.additionalProperties = false;
  return copy;
}

function sanitizeString(value, schema, label) {
  const text = String(value);
  if (schema?.enum && !schema.enum.includes(text)) {
    throw new Error(`${label} must be one of: ${schema.enum.join(', ')}.`);
  }
  const max = Math.min(Number(schema?.maxLength) || LIMITS.CUA_MAX_ARGUMENT_CHARS, LIMITS.CUA_MAX_ARGUMENT_CHARS);
  if (text.length > max) throw new Error(`${label} is too long (${text.length} characters, limit ${max}).`);
  return text;
}

function sanitizeValue(schema, value, label, depth = 0) {
  if (depth > 6) throw new Error(`${label} is nested too deeply.`);
  if (!schema || typeof schema !== 'object') return value;
  const type = schema.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
    const properties = schema.properties || {};
    const allowAdditional = schema.additionalProperties !== false;
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) {
        result[key] = sanitizeValue(properties[key], child, `${label}.${key}`, depth + 1);
      } else if (allowAdditional) {
        if (child === null || ['string', 'number', 'boolean'].includes(typeof child) || Array.isArray(child)) result[key] = child;
      }
    }
    for (const key of schema.required || []) {
      if (result[key] === undefined) throw new Error(`${label} is missing "${key}".`);
    }
    return result;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
    if (value.length > 100) throw new Error(`${label} has too many items.`);
    return value.map((item, index) => sanitizeValue(schema.items, item, `${label}[${index}]`, depth + 1));
  }
  if (type === 'integer' || type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${label} must be a number.`);
    if (type === 'integer' && !Number.isInteger(number)) throw new Error(`${label} must be a whole number.`);
    if (schema.minimum !== undefined && number < schema.minimum) throw new Error(`${label} must be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && number > schema.maximum) throw new Error(`${label} must be at most ${schema.maximum}.`);
    return number;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${label} must be true or false.`);
    return value;
  }
  return sanitizeString(value, schema, label);
}

function applyDefaults(name, args) {
  const result = { ...args };
  if (name === 'get_window_state') {
    // Screenshots are large and the overlay cannot show them. A compact text
    // tree is enough for the model and keeps each tool result well bounded.
    if (result.include_screenshot === undefined) result.include_screenshot = false;
    if (result.full_output === undefined) result.full_output = false;
    if (result.tree_format === undefined) result.tree_format = 'markdown';
    if (result.max_elements === undefined) result.max_elements = 300;
    if (result.verbose === undefined) result.verbose = false;
  }
  return result;
}

function prepareArguments(name, args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
  delete args.session;
  const withDefaults = applyDefaults(name, args);
  return sanitizeValue(sanitizeSchema(schema), withDefaults, name);
}

function contentText(result) {
  if (!result || typeof result !== 'object') return '';
  const parts = Array.isArray(result.content)
    ? result.content.map((entry) => (entry && entry.type === 'text' ? String(entry.text || '') : '')).filter(Boolean)
    : [];
  if (parts.length) return parts.join('\n');
  if (result.structuredContent !== undefined) {
    try {
      return JSON.stringify(result.structuredContent);
    } catch {
      return '';
    }
  }
  return '';
}

function extractTargets(name, args, text) {
  const targets = [];
  const source = String(text || '');
  if (['launch_app', 'list_windows', 'bring_to_front', 'get_window_state'].includes(name)) {
    const pidMatch = source.match(/\(pid\s+(\d+)\)/i);
    const windowMatch = source.match(/\[window_id:\s*(\d+)\]/i);
    const pid = Number(pidMatch?.[1] || args?.pid || 0);
    const windowId = Number(windowMatch?.[1] || args?.window_id || 0);
    if (pid > 0) targets.push({ pid, windowId: windowId > 0 ? windowId : null });
  }
  if (name === 'list_windows') {
    const linePattern = /\(pid\s+(\d+)\)[^\n]*?\[window_id:\s*(\d+)\]/gi;
    let match;
    while ((match = linePattern.exec(source))) {
      targets.push({ pid: Number(match[1]), windowId: Number(match[2]) });
    }
  }
  return targets;
}

function createCuaClient({ log } = {}) {
  const resolved = resolveCuaCommand();
  let child = null;
  let rl = null;
  let nextId = 0;
  let starting = null;
  let closed = false;
  let tools = [];
  let toolMap = null;
  const pending = new Map();
  const stderrTail = [];

  function formatStderr() {
    return stderrTail.join('').trim().slice(-600);
  }

  function rejectPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function handleLine(line) {
    const text = String(line || '').trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  }

  function request(method, params, timeoutMs, signal) {
    if (!child || closed) return Promise.reject(new Error('The desktop driver is not running.'));
    if (signal?.aborted) return Promise.reject(new Error('The request was cancelled.'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`The desktop driver did not answer ${method} within ${Math.round(timeoutMs / 1000)} seconds.`));
      }, timeoutMs);
      timer.unref?.();
      const onAbort = () => {
        if (!pending.has(id)) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error('The request was cancelled.'));
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener?.('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener?.('abort', onAbort);
          reject(error);
        },
        timer
      });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function notify(method, params) {
    if (!child || closed) return;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      // A broken pipe is surfaced by the next request or by the exit handler.
    }
  }

  async function start(signal) {
    if (closed) throw new Error('The desktop driver session is closed.');
    if (child && tools.length) return tools;
    if (starting) return starting;
    starting = (async () => {
      if (!child) {
        child = spawn(resolved.command, resolved.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...process.env }
        });
        child.on('error', (error) => {
          log?.warn('cua', `Driver process error: ${error.message}`);
          rejectPending(new Error(`The desktop driver could not start: ${error.message}`));
        });
        child.on('exit', (code, exitSignal) => {
          const detail = formatStderr();
          log?.info('cua', `Driver exited (code=${code ?? 'null'}, signal=${exitSignal || 'none'})${detail ? `: ${detail}` : ''}`);
          rejectPending(new Error('The desktop driver stopped unexpectedly.'));
          child = null;
          tools = [];
          toolMap = null;
        });
        child.stderr.on('data', (chunk) => {
          stderrTail.push(String(chunk));
          if (stderrTail.length > 20) stderrTail.shift();
        });
        rl = readline.createInterface({ input: child.stdout });
        rl.on('line', handleLine);
      }
      const init = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'voxa', version: '1.0.0' }
      }, LIMITS.CUA_START_TIMEOUT_MS, signal);
      notify('notifications/initialized', {});
      const list = await request('tools/list', {}, LIMITS.CUA_START_TIMEOUT_MS, signal);
      const available = Array.isArray(list?.tools) ? list.tools : [];
      tools = available.filter((tool) => CUA_TOOL_SET.has(tool.name));
      toolMap = new Map(tools.map((tool) => [tool.name, tool]));
      const missing = CUA_TOOL_NAMES.filter((name) => !toolMap.has(name));
      if (missing.length) log?.warn('cua', `Driver is missing expected tools: ${missing.join(', ')}`);
      log?.info('cua', `Connected to ${init?.serverInfo?.name || 'cua-driver'} ${init?.serverInfo?.version || ''} with ${tools.length} desktop tools.`);
      return tools;
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  function definitions() {
    if (!toolMap) return [];
    return tools
      .filter((tool) => CUA_TOOL_SET.has(tool.name))
      .map((tool) => {
        const description = String(tool.description || '').split('\n')[0].slice(0, 1200);
        return {
          type: 'function',
          function: {
            name: cuaToolName(tool.name),
            description: `Desktop control through cua-driver. Prefer this over guessing coordinates. ${description}`,
            parameters: sanitizeSchema(tool.inputSchema)
          }
        };
      });
  }

  async function callTool(prefixedName, args, { signal, timeoutMs = LIMITS.CUA_CALL_TIMEOUT_MS } = {}) {
    const name = cuaBaseName(prefixedName);
    if (!name) throw new Error(`Unknown desktop tool: ${prefixedName}`);
    await start(signal);
    const definition = toolMap.get(name);
    if (!definition) throw new Error(`The desktop driver does not expose ${name}.`);
    const prepared = prepareArguments(name, args, definition.inputSchema);
    const result = await request('tools/call', { name, arguments: prepared }, timeoutMs, signal);
    const text = clampText(contentText(result), LIMITS.CUA_MAX_TOOL_RESULT_CHARS);
    return {
      ok: result?.isError !== true,
      isError: result?.isError === true,
      text: text || (result?.isError ? 'The desktop action failed.' : 'Done.'),
      targets: extractTargets(name, prepared, text),
      structured: result?.structuredContent
    };
  }

  async function close() {
    if (closed) return;
    closed = true;
    rejectPending(new Error('The desktop driver session closed.'));
    try {
      if (child) {
        child.stdin.end();
        const exiting = child;
        const timer = setTimeout(() => {
          try {
            exiting.kill();
          } catch {
            // Process already gone.
          }
        }, 1200);
        timer.unref?.();
      }
      rl?.close();
    } catch {
      // Best effort shutdown.
    }
    child = null;
    rl = null;
    tools = [];
    toolMap = null;
  }

  return {
    command: resolved.command,
    source: resolved.source,
    start,
    definitions,
    callTool,
    close,
    get connected() {
      return Boolean(child && tools.length);
    }
  };
}

// A destructive call always gets a spoken confirmation, even in Full Access.
// `knownPids` and `knownWindows` let us tell deliberate typing into an app the
// model just opened from blind typing into whatever happens to be focused.
function destructiveCuaReason(name, args, known = {}) {
  const pids = known.pids instanceof Set ? known.pids : new Set();
  const windows = known.windows instanceof Set ? known.windows : new Set();
  if (name === 'kill_app') {
    return { kind: 'close', detail: `close the app with process id ${args?.pid ?? 'unknown'}` };
  }
  const keys = [];
  if (name === 'hotkey' && Array.isArray(args?.keys)) keys.push(...args.keys);
  if (name === 'press_key' && args?.key) keys.push(...(Array.isArray(args.modifiers) ? args.modifiers : []), args.key);
  const combo = keys.map((key) => String(key).toLowerCase()).filter(Boolean);
  if (combo.length) {
    const joined = combo.join('+');
    if (/(^|\+)alt\+f4($|\+)/.test(joined) || /(^|\+)ctrl\+w($|\+)/.test(joined) || /(^|\+)ctrl\+shift\+w($|\+)/.test(joined)) {
      return { kind: 'close', detail: `send ${keys.join('+')} to close a window or tab` };
    }
    if (/(^|\+)(shift\+)?delete($|\+)/.test(joined) || /(^|\+)ctrl\+delete($|\+)/.test(joined) || /(^|\+)ctrl\+backspace($|\+)/.test(joined)) {
      return { kind: 'delete', detail: `send ${keys.join('+')} to delete content` };
    }
  }
  const hasElementToken = typeof args?.element_token === 'string' && args.element_token.trim() !== '';
  const hasTarget = Number(args?.pid) > 0 || Number(args?.window_id) > 0 || hasElementToken;
  if ((name === 'type_text' || name === 'set_value') && !hasTarget) {
    return { kind: 'unknown-target', detail: 'type into the window that currently has focus, which this request did not identify' };
  }
  if (name === 'click' && args?.target?.kind === 'window') {
    const pid = Number(args.target.pid) || 0;
    const windowId = Number(args.target.window_id) || 0;
    if (pid && !pids.has(pid)) {
      return { kind: 'unknown-window', detail: `click inside an app window (pid ${pid}) it has not inspected` };
    }
    if (windowId && !windows.has(windowId)) {
      return { kind: 'unknown-window', detail: `click inside a window (id ${windowId}) it has not inspected` };
    }
  }
  return null;
}

module.exports = {
  CUA_TOOL_NAMES,
  CUA_PREFIX,
  CUA_READ_ONLY_TOOLS,
  resolveCuaCommand,
  isCuaToolName,
  cuaBaseName,
  cuaToolName,
  sanitizeSchema,
  prepareArguments,
  contentText,
  extractTargets,
  createCuaClient,
  destructiveCuaReason
};
