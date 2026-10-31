'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { app } = require('electron');
const { LIMITS, WHISPER_MODELS, normalizeOmniInstruct } = require('./constants.cjs');
const { BASE_URL_ERROR, normalizeProviderUrl } = require('./store.cjs');
const { normaliseForSpeech, segmentSentences, takeCompleteSentences } = require('./tts-text.cjs');

let whisperProcess = null;
let whisperStarting = null;
let whisperError = '';
let whisperConfig = { port: LIMITS.WHISPER_PORT, model: '', device: '', computeType: '' };
let whisperGeneration = 0;
let whisperStopping = false;
let whisperStopPromise = null;
let whisperLaunchId = '';
let whisperLaunchImage = '';
let whisperServerPid = 0;

function trimBase(url) {
  return String(url || '').replace(/\/+$/, '');
}

function providerBaseUrl(providerName, value, label = '') {
  const url = normalizeProviderUrl(providerName, value);
  if (!url) throw new Error(label ? `${label} must be https, or http only for localhost / 127.0.0.1.` : BASE_URL_ERROR);
  return trimBase(url);
}

function requestSignal(timeout, externalSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const forwardAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', forwardAbort);
    }
  };
}

async function requestJson(url, options, timeout, externalSignal) {
  const request = requestSignal(timeout, externalSignal);
  try {
    const response = await fetch(url, { ...options, signal: request.signal });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!response.ok) {
      const detail = data?.error?.message || data?.message || text.slice(0, 1000) || response.statusText;
      const error = new Error(`${response.status} ${detail || 'Request failed'}`.trim());
      error.status = response.status;
      throw error;
    }
    if (!data) throw new Error('The server returned an empty response.');
    return data;
  } catch (error) {
    if (externalSignal?.aborted) {
      const cancelled = new Error('Cancelled.');
      cancelled.cancelled = true;
      throw cancelled;
    }
    if (request.timedOut()) throw new Error(`Request timed out after ${Math.round(timeout / 1000)} seconds.`);
    throw error;
  } finally {
    request.cleanup();
  }
}

function authHeaders(providerName, config, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (providerName === 'anthropic' && key) {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  }
  return headers;
}

async function listModels(providerName, config, key, signal) {
  if (providerName === 'local') {
    const models = await ollamaTags(ollamaBase(config.url), LIMITS.MODEL_LIST_TIMEOUT_MS, signal);
    return [...new Set(models)].sort();
  }
  const data = await requestJson(`${providerBaseUrl(providerName, config.url)}/models`, {
    method: 'GET',
    headers: authHeaders(providerName, config, key)
  }, LIMITS.MODEL_LIST_TIMEOUT_MS, signal);
  const models = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  return [...new Set(models.map((model) => model?.id || model?.name).filter(Boolean))].sort();
}

async function checkHealth(providerName, config, key, signal, model) {
  const started = Date.now();
  const models = await listModels(providerName, config, key, signal);
  const wanted = model || config.model;
  return {
    ok: true,
    provider: providerName,
    model: wanted,
    modelAvailable: models.length > 0 && models.includes(wanted),
    models: models.slice(0, 50),
    latencyMs: Date.now() - started
  };
}

async function chat(settings, key, messages, tools, signal) {
  const providerName = settings.chatProvider;
  const config = settings.providers[providerName];
  if (!config) throw new Error(`Unknown chat provider: ${providerName}`);
  if (!['local', 'freellmapi'].includes(providerName) && !key) throw new Error(`Add an API key for ${providerName} in the dashboard.`);
  const body = {
    model: config.model,
    messages,
    temperature: 0.2,
    stream: false
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const data = await requestJson(`${providerBaseUrl(providerName, config.url)}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(providerName, config, key),
    body: JSON.stringify(body)
  }, LIMITS.CHAT_TIMEOUT_MS, signal);
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('The model returned no message.');
  return message;
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return '';
}

function completionDelta(data) {
  const choice = data?.choices?.[0];
  return messageText(choice?.delta?.content) || messageText(choice?.message?.content);
}

function chatStreamError(error) {
  const detail = error?.error?.message || error?.error || error?.message;
  return detail ? new Error(String(detail)) : null;
}

function mergeToolCallDeltas(calls, deltas) {
  if (!Array.isArray(deltas)) return;
  for (const part of deltas) {
    if (!part || typeof part !== 'object') continue;
    const index = Number.isInteger(part.index) ? part.index : calls.length;
    while (calls.length <= index) {
      calls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
    }
    const call = calls[index];
    if (part.id) call.id = String(part.id);
    if (part.type) call.type = String(part.type);
    if (part.function?.name) call.function.name += String(part.function.name);
    if (part.function?.arguments) call.function.arguments += String(part.function.arguments);
  }
}

function finalToolCalls(calls) {
  return (calls || [])
    .filter((call) => call?.function?.name)
    .map((call, index) => ({
      id: call.id || `call_${index}`,
      type: call.type || 'function',
      function: {
        name: call.function.name,
        arguments: call.function.arguments || '{}'
      }
    }));
}

async function chatStream(settings, key, messages, signal, onDelta, options = {}) {
  const providerName = settings.chatProvider;
  const config = settings.providers?.[providerName];
  if (!config) throw new Error(`Unknown chat provider: ${providerName}`);
  if (!['local', 'freellmapi'].includes(providerName) && !key) throw new Error(`Add an API key for ${providerName} in the dashboard.`);
  const request = requestSignal(LIMITS.CHAT_TIMEOUT_MS, signal);
  let canFallback = false;
  let reader = null;
  const wantMessage = options.message === true;
  const toolCalls = [];
  let toolCallNotified = false;
  try {
    const body = {
      model: config.model,
      messages,
      temperature: 0.2,
      stream: true
    };
    if (Array.isArray(options.tools) && options.tools.length) {
      body.tools = options.tools;
      body.tool_choice = 'auto';
    }
    const response = await fetch(`${providerBaseUrl(providerName, config.url)}/chat/completions`, {
      method: 'POST',
      headers: { ...authHeaders(providerName, config, key), Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: request.signal
    });
    if (!response.ok) {
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      const detail = data?.error?.message || data?.message || text.slice(0, 1000) || response.statusText;
      const error = new Error(`${response.status} ${detail || 'Request failed'}`.trim());
      error.status = response.status;
      canFallback = [400, 404, 405, 415, 422, 501].includes(response.status);
      throw error;
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/event-stream') || !response.body) {
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!data) throw new Error('The server returned an unreadable response.');
      const message = data.choices?.[0]?.message || {};
      const content = completionDelta(data);
      if (!content.trim() && !message.tool_calls?.length) throw new Error('The model returned an empty response.');
      if (content) onDelta?.(content, content);
      if (wantMessage) {
        return {
          role: 'assistant',
          content,
          ...(Array.isArray(message.tool_calls) && message.tool_calls.length ? { tool_calls: message.tool_calls } : {})
        };
      }
      return content;
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let output = '';
    let eventData = [];
    let finished = false;

    const dispatch = () => {
      if (!eventData.length) return;
      const raw = eventData.join('\n').trim();
      eventData = [];
      if (!raw) return;
      if (raw === '[DONE]') {
        finished = true;
        return;
      }
      let event = null;
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }
      const error = chatStreamError(event);
      if (error) throw error;
      const delta = event?.choices?.[0]?.delta || {};
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
        mergeToolCallDeltas(toolCalls, delta.tool_calls);
        if (!toolCallNotified) {
          toolCallNotified = true;
          options.onToolCall?.();
        }
      }
      const piece = completionDelta(event);
      if (piece) {
        output += piece;
        onDelta?.(output, piece);
      }
    };

    const consumeLine = (rawLine) => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line) {
        dispatch();
        return;
      }
      if (line.startsWith(':')) return;
      if (line.startsWith('data:')) eventData.push(line.slice(5).replace(/^ /, ''));
    };

    for (;;) {
      if (finished) break;
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        consumeLine(line);
        if (finished) break;
      }
    }
    if (!finished) {
      pending += decoder.decode();
      if (pending) consumeLine(pending);
      dispatch();
    }
    const calls = finalToolCalls(toolCalls);
    if (!output.trim() && !calls.length) throw new Error('The model returned an empty response.');
    if (wantMessage) {
      return {
        role: 'assistant',
        content: output,
        ...(calls.length ? { tool_calls: calls } : {})
      };
    }
    return output;
  } catch (error) {
    if (canFallback && !signal?.aborted && !request.timedOut()) {
      const message = await chat(settings, key, messages, options.tools, signal);
      const content = messageText(message?.content);
      if (!content.trim() && !message?.tool_calls?.length) throw new Error('The model returned an empty response.');
      if (content) onDelta?.(content, content);
      if (wantMessage) return message;
      return content;
    }
    if (signal?.aborted) {
      const cancelled = new Error('Cancelled.');
      cancelled.cancelled = true;
      throw cancelled;
    }
    if (request.timedOut()) throw new Error(`Request timed out after ${Math.round(LIMITS.CHAT_TIMEOUT_MS / 1000)} seconds.`);
    throw error;
  } finally {
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // The stream is already closed.
      }
      try {
        reader.releaseLock?.();
      } catch {
        // A rejected read can leave the lock pending; cancellation is best effort.
      }
    }
    request.cleanup();
  }
}

async function transcribe(serverUrl, audio, mime, model, signal, options = {}) {
  const baseUrl = providerBaseUrl('local', serverUrl, 'Transcription URL');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime || 'audio/webm' }), 'speech.webm');
  form.append('model', model || 'whisper-1');
  if (options.language) form.append('language', String(options.language));
  const request = requestSignal(LIMITS.TRANSCRIBE_TIMEOUT_MS, signal);
  try {
    const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
      signal: request.signal
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const detail = data?.error?.message || data?.detail || text.slice(0, 800) || response.statusText;
      throw new Error(`Transcription failed (${response.status}): ${detail}`);
    }
    if (!data) throw new Error('The transcription server returned an empty response.');
    return { text: String(data.text || data.transcript || '').trim(), raw: data };
  } catch (error) {
    if (signal?.aborted) {
      const cancelled = new Error('Cancelled.');
      cancelled.cancelled = true;
      throw cancelled;
    }
    if (request.timedOut()) throw new Error(`Transcription timed out after ${Math.round(LIMITS.TRANSCRIBE_TIMEOUT_MS / 1000)} seconds.`);
    throw error;
  } finally {
    request.cleanup();
  }
}

async function cloudTranscribe(settings, key, audio, mime, signal) {
  const providerName = settings.sttCloudProvider;
  const config = settings.providers[providerName];
  if (!config) throw new Error(`Unknown transcription provider: ${providerName}`);
  if (!key) throw new Error(`Add an API key for ${providerName} in the dashboard.`);
  const baseUrl = providerBaseUrl(providerName, config.url, 'Transcription URL');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime || 'audio/webm' }), 'speech.webm');
  form.append('model', settings.sttModel || 'whisper-1');
  const request = requestSignal(LIMITS.TRANSCRIBE_TIMEOUT_MS, signal);
  try {
    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: request.signal
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const detail = data?.error?.message || data?.message || text.slice(0, 800) || response.statusText;
      throw new Error(`Cloud transcription failed (${response.status}): ${detail}`);
    }
    if (!data) throw new Error('The cloud transcription service returned an empty response.');
    return { text: String(data.text || data.transcript || '').trim(), raw: data };
  } catch (error) {
    if (signal?.aborted) {
      const cancelled = new Error('Cancelled.');
      cancelled.cancelled = true;
      throw cancelled;
    }
    if (request.timedOut()) throw new Error(`Cloud transcription timed out after ${Math.round(LIMITS.TRANSCRIBE_TIMEOUT_MS / 1000)} seconds.`);
    throw error;
  } finally {
    request.cleanup();
  }
}

function whisperDirectory() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'whisper-server');
  return path.join(app.getAppPath(), 'whisper-server');
}

function pythonPath() {
  if (process.env.VOXA_PYTHON) return process.env.VOXA_PYTHON;
  const environment = process.platform === 'win32'
    ? path.join(whisperDirectory(), '.venv', 'Scripts', 'python.exe')
    : path.join(whisperDirectory(), '.venv', 'bin', 'python');
  return environment;
}

function whisperExecutableName() {
  return process.platform === 'win32' ? 'voxa-whisper.exe' : 'voxa-whisper';
}

function bundledWhisperPath() {
  return path.join(whisperDirectory(), whisperExecutableName());
}

function whisperCacheDir() {
  return path.join(app.getPath('userData'), 'whisper-models');
}

const WHISPER_SNAPSHOT_FILES = Object.freeze(['config.json', 'model.bin', 'tokenizer.json']);

function whisperFileReady(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

// Mirror the server's model_snapshot_ready check so the dashboard can report
// installed models from disk even when the Whisper server is stopped.
function whisperSnapshotReady(directory) {
  try {
    if (!WHISPER_SNAPSHOT_FILES.every((name) => whisperFileReady(path.join(directory, name)))) return false;
    return fs.readdirSync(directory, { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.startsWith('vocabulary.') && whisperFileReady(path.join(directory, entry.name)));
  } catch {
    return false;
  }
}

function whisperModelInstalled(model, cacheDir = whisperCacheDir()) {
  const id = String(model || '').trim();
  if (!id) return false;
  if (whisperSnapshotReady(path.join(cacheDir, 'models', path.basename(id)))) return true;
  const spec = WHISPER_MODELS.find((item) => item.id === id);
  if (!spec?.repoId) return false;
  const snapshots = path.join(cacheDir, 'hub', `models--${spec.repoId.replace('/', '--')}`, 'snapshots');
  try {
    return fs.readdirSync(snapshots, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(snapshots, entry.name))
      .sort()
      .reverse()
      .some((snapshot) => whisperSnapshotReady(snapshot));
  } catch {
    return false;
  }
}

function whisperInstalledModels(cacheDir = whisperCacheDir()) {
  return Object.fromEntries(WHISPER_MODELS.map((item) => [item.id, whisperModelInstalled(item.id, cacheDir)]));
}

function whisperLaunchCommand() {
  const configured = String(process.env.VOXA_WHISPER_EXE || '').trim();
  if (configured && fs.existsSync(configured)) {
    return { command: configured, args: [], cwd: path.dirname(configured), bundled: true };
  }
  if (app.isPackaged) {
    const executable = bundledWhisperPath();
    if (fs.existsSync(executable)) return { command: executable, args: [], cwd: path.dirname(executable), bundled: true };
    throw new Error(`The bundled Whisper engine is missing (${executable}). Reinstall Voxa or rebuild it with npm run build:whisper.`);
  }
  const python = pythonPath();
  if (fs.existsSync(python)) {
    const script = path.join(whisperDirectory(), 'server.py');
    if (!fs.existsSync(script)) throw new Error('whisper-server/server.py is missing.');
    return { command: python, args: [script], cwd: whisperDirectory(), bundled: false };
  }
  const developmentExecutable = path.join(whisperDirectory(), 'dist', whisperExecutableName());
  if (fs.existsSync(developmentExecutable)) {
    return { command: developmentExecutable, args: [], cwd: path.dirname(developmentExecutable), bundled: true };
  }
  throw new Error(`Whisper is not available. Run the whisper-server setup steps in README.md or build the bundled engine with npm run build:whisper (${python}).`);
}

async function whisperHealth(port = whisperConfig.port) {
  const request = requestSignal(1500, null);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: request.signal });
    if (!response.ok) {
      const server = String(response.headers.get('server') || '').trim();
      const detail = `HTTP ${response.status}${server ? ` from ${server}` : ''} at /health`;
      return {
        ok: false,
        error: `Another service is already using port ${port} (${detail}).`,
        status: 'http-error',
        port
      };
    }
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object' || typeof data.status !== 'string') {
      return {
        ok: false,
        error: `Another service is already using port ${port} (unexpected response from /health).`,
        status: 'http-error',
        port
      };
    }
    if (data.ok === false) {
      return {
        ok: false,
        ...data,
        error: data.error || (data.status === 'loading' ? 'The Whisper model is still loading.' : 'Whisper is not ready.'),
        port
      };
    }
    return { ok: true, ...data, port };
  } catch (error) {
    return { ok: false, error: error.message, status: 'unreachable', port };
  } finally {
    request.cleanup();
  }
}

async function whisperRequest(port, pathname, options = {}, timeout = 5000) {
  const request = requestSignal(timeout, null);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      signal: request.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let detail = '';
      try {
        const data = JSON.parse(text);
        const value = data?.detail ?? data?.error;
        detail = typeof value === 'string' ? value : value ? JSON.stringify(value) : '';
      } catch {
        const match = text.match(/<p>Message:\s*([^<]+)<\/p>/i);
        detail = match ? match[1].trim() : '';
      }
      const suffix = detail ? `: ${detail}` : '';
      throw new Error(`Whisper request to ${pathname} failed (HTTP ${response.status}${suffix}).`);
    }
    return await response.json().catch(() => ({}));
  } finally {
    request.cleanup();
  }
}

async function whisperModels(port = whisperConfig.port) {
  return whisperRequest(port, '/models', {}, 4000);
}

async function loadWhisperModel(port, model) {
  const name = String(model || '').trim();
  if (!name) throw new Error('Choose a Whisper model to load.');
  return whisperRequest(port, '/load_model', {
    method: 'POST',
    body: JSON.stringify({ model: name })
  }, 8000);
}

async function cancelWhisperModel(port = whisperConfig.port) {
  return whisperRequest(port, '/cancel_model_load', { method: 'POST', body: '{}' }, 5000);
}

function captureWhisperLog(stream, log) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) log?.info('whisper server', line.trim().slice(0, 2000));
    }
  });
}

async function waitForWhisper(port, log, onHealth, generation = whisperGeneration) {
  const startedAt = Date.now();
  let lastProgressAt = Date.now();
  let lastProgressBytes = -1;
  let lastStatus = '';
  let loggedPercent = -25;
  while (Date.now() - startedAt < LIMITS.WHISPER_START_TIMEOUT_MS) {
    if (whisperStopping || generation !== whisperGeneration) {
      const cancelled = new Error('Whisper startup was stopped.');
      cancelled.cancelled = true;
      throw cancelled;
    }
    if (whisperError) throw new Error(whisperError);
    if (whisperProcess?.exitCode !== null && whisperProcess?.exitCode !== undefined) {
      throw new Error(whisperError || 'Whisper server exited during startup.');
    }
    const health = await whisperHealth(port);
    if (health.pid) whisperServerPid = Number(health.pid) || whisperServerPid;
    onHealth?.(health);
    if (health.ok) return health;
    if (health.status === 'error') throw new Error(health.error || 'The Whisper model failed to load.');
    if (health.status === 'http-error') {
      throw new Error(`${health.error || `Port ${port} is already used by another service.`} Stop that service and try again.`);
    }
    const downloaded = Number(health.progress?.downloaded_bytes);
    if (Number.isFinite(downloaded) && downloaded > lastProgressBytes) {
      lastProgressBytes = downloaded;
      lastProgressAt = Date.now();
    }
    const percent = Number(health.progress?.percent);
    if (Number.isFinite(percent) && percent >= loggedPercent + 25 && percent < 100) {
      loggedPercent = percent;
      log?.info('whisper server', health.message || `Downloading the Whisper model (${percent}%).`);
    }
    if (health.status !== lastStatus) {
      lastStatus = health.status;
      if (health.status === 'loading') log?.info('whisper server', health.message || 'Loading the Whisper model.');
    }
    if (health.status === 'downloading' && Date.now() - lastProgressAt > LIMITS.WHISPER_STALL_TIMEOUT_MS) {
      throw new Error(health.message || 'The Whisper model download stopped making progress. Check the connection and try again.');
    }
    await new Promise((resolve) => setTimeout(resolve, LIMITS.WHISPER_PROGRESS_POLL_MS));
  }
  throw new Error('Whisper did not become ready in time. Check the Whisper logs and try again.');
}

async function startWhisper(options = {}, log) {
  if (whisperStopPromise) await whisperStopPromise;
  const port = Number(options.port) || LIMITS.WHISPER_PORT;
  const model = options.model || 'small';
  const device = options.device || 'cpu';
  const computeType = options.computeType || (device === 'cuda' ? 'float16' : 'int8');
  const cacheDir = options.cacheDir || whisperCacheDir();
  const onHealth = typeof options.onHealth === 'function' ? options.onHealth : null;
  whisperConfig = { port, model, device, computeType };
  whisperStopping = false;
  const launch = whisperLaunchCommand();
  whisperLaunchImage = launch.command;
  whisperLaunchId = whisperLaunchIdentity(launch);
  const existing = await whisperHealth(port);
  if (existing.ok) {
    const sameLaunch = String(existing.launch_id || '') === whisperLaunchId;
    const sameConfig = existing.model === model
      && existing.device === device
      && (!existing.compute_type || existing.compute_type === computeType);
    if (sameLaunch && sameConfig) {
      whisperServerPid = Number(existing.pid) || 0;
      onHealth?.(existing);
      return existing;
    }
    log?.warn('whisper server', 'An existing Whisper server does not match this build or compute setting; restarting it.');
    await stopExistingWhisper(existing);
  } else if (existing.status === 'loading' || existing.status === 'downloading') {
    if (String(existing.launch_id || '') === whisperLaunchId) {
      whisperServerPid = Number(existing.pid) || 0;
      if (!whisperProcess) whisperError = '';
      onHealth?.(existing);
      return waitForWhisper(port, log, onHealth);
    }
    log?.warn('whisper server', 'An existing Whisper load is from a different build or compute setting; restarting it.');
    await stopExistingWhisper(existing);
  } else if (existing.status === 'error') {
    onHealth?.(existing);
    throw new Error(existing.error || 'The Whisper model failed to load.');
  } else if (existing.status === 'http-error') {
    onHealth?.(existing);
    throw new Error(`${existing.error || `Port ${port} is already used by another service.`} Stop that service and try again.`);
  }
  if (whisperStarting) return whisperStarting;
  if (whisperProcess && whisperProcess.exitCode === null) return waitForWhisper(port, log, onHealth);

  const starting = (async () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    whisperError = '';
    whisperServerPid = 0;
    const generation = ++whisperGeneration;
    whisperStopping = false;
    log?.info('whisper server', `Starting bundled=${launch.bundled} on port ${port} with ${model} on ${device} (${computeType})`);
    log?.info('whisper server', `Whisper model cache: ${cacheDir}`);
    const args = [
      ...launch.args,
      '--host', '127.0.0.1',
      '--port', String(port),
      '--model', model,
      '--device', device,
      '--compute-type', computeType,
      '--cache-dir', cacheDir
    ];
    const child = spawn(launch.command, args, {
      cwd: launch.cwd,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        HF_HOME: cacheDir,
        HF_HUB_CACHE: path.join(cacheDir, 'hub'),
        VOXA_WHISPER_CACHE: cacheDir,
        VOXA_WHISPER_LAUNCH_ID: whisperLaunchId
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    whisperProcess = child;
    captureWhisperLog(child.stdout, log);
    captureWhisperLog(child.stderr, log);
    const intentionalStop = () => whisperStopping || generation !== whisperGeneration;
    child.on('error', (error) => {
      if (whisperProcess === child) whisperProcess = null;
      if (intentionalStop()) return;
      whisperError = error.message;
      log?.error('whisper server', error.message);
    });
    child.on('close', (code) => {
      if (whisperProcess === child) {
        whisperProcess = null;
        whisperStarting = null;
      }
      if (intentionalStop()) {
        log?.info('whisper server', 'Whisper server stopped.');
        return;
      }
      if (code !== 0) {
        whisperError = `Whisper server exited with code ${code}.`;
        log?.warn('whisper server', whisperError);
      }
    });
    return waitForWhisper(port, log, onHealth, generation);
  })();
  whisperStarting = starting;

  try {
    return await starting;
  } catch (error) {
    if (!error.cancelled) whisperError = error.message;
    throw error;
  } finally {
    if (whisperStarting === starting) whisperStarting = null;
  }
}

function whisperLaunchIdentity(launch) {
  const target = launch.args?.[0] || launch.command;
  try {
    const stat = fs.statSync(target);
    return [app.getVersion(), target, stat.size, Math.floor(stat.mtimeMs)].join('|');
  } catch {
    return [app.getVersion(), target, 0, 0].join('|');
  }
}

function whisperExpectedLaunchId() {
  return whisperLaunchIdentity(whisperLaunchCommand());
}

function taskkill(args) {
  if (process.platform !== 'win32') return;
  try {
    spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 5000 });
  } catch {
    // The process may already be gone.
  }
}

function killWhisperPidSync(pid) {
  const value = Number(pid) || 0;
  if (process.platform !== 'win32' || !value) return;
  taskkill(['/pid', String(value), '/T', '/F']);
}

function killWhisperImageSync() {
  const image = path.basename(String(whisperLaunchImage || ''));
  if (process.platform !== 'win32' || image.toLowerCase() !== whisperExecutableName()) return;
  taskkill(['/F', '/IM', image]);
}

async function stopExistingWhisper(existing) {
  killWhisperPidSync(existing?.pid);
  if (!Number(existing?.pid)) killWhisperImageSync();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const health = await whisperHealth(existing.port);
    if (health.status === 'unreachable') return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function killProcessTree(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    // Never block a restart forever if taskkill itself wedges.
    timer = setTimeout(finish, 5000);
    timer.unref?.();
    child.once('close', finish);
    const fallback = () => {
      try {
        child.kill();
      } catch {
        // The process may already have exited.
      }
    };
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', fallback);
      killer.on('exit', (code) => {
        if (code !== 0) fallback();
      });
      return;
    }
    fallback();
  });
}

function stopWhisper() {
  whisperStopping = true;
  whisperGeneration += 1;
  whisperError = '';
  if (whisperStopPromise) return whisperStopPromise;
  const child = whisperProcess;
  const serverPid = whisperServerPid;
  whisperProcess = null;
  whisperStarting = null;
  whisperServerPid = 0;
  if (child) {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  killWhisperPidSync(serverPid);
  killWhisperImageSync();
  const tracked = killProcessTree(child).finally(() => {
    if (whisperStopPromise === tracked) whisperStopPromise = null;
  });
  whisperStopPromise = tracked;
  return tracked;
}

function whisperStatus() {
  return {
    running: Boolean(whisperProcess && whisperProcess.exitCode === null),
    processAlive: Boolean(whisperProcess),
    error: whisperError,
    port: whisperConfig.port,
    model: whisperConfig.model,
    device: whisperConfig.device,
    computeType: whisperConfig.computeType
  };
}

function ollamaBase(configUrl) {
  const base = providerBaseUrl('local', configUrl || 'http://localhost:11434/v1', 'Ollama URL');
  return base.replace(/\/v1$/i, '');
}

let ollamaExecutableCache = { checkedAt: 0, value: null };

function ollamaExecutable() {
  if (Date.now() - ollamaExecutableCache.checkedAt < 10000) return ollamaExecutableCache.value;
  const candidates = [];
  if (process.env.OLLAMA_EXE) candidates.push(process.env.OLLAMA_EXE);
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama app.exe'));
    }
    if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe'));
  }
  let found = candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
  if (!found) {
    const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ollama'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    });
    if (lookup.status === 0) {
      found = String(lookup.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && fs.existsSync(line)) || null;
    }
  }
  ollamaExecutableCache = { checkedAt: Date.now(), value: found };
  return found;
}

async function ollamaTags(base, timeout = 2500, signal = null) {
  const data = await requestJson(`${base}/api/tags`, { method: 'GET' }, timeout, signal);
  return Array.isArray(data.models)
    ? data.models.map((model) => String(model?.name || model?.model || '')).filter(Boolean)
    : [];
}

async function detectFreeLlmApi() {
  const ports = [31415, 3001];
  let lastError = '';
  for (const port of ports) {
    const url = `http://127.0.0.1:${port}/v1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      await fetch(`${url}/models`, { method: 'GET', signal: controller.signal });
      return { url };
    } catch (error) {
      lastError = error.message;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`No FreeLLMAPI server responded on 127.0.0.1:31415 or 127.0.0.1:3001.${lastError ? ` ${lastError}` : ''}`);
}

async function ensureOllamaRunning(base, log) {
  try {
    await ollamaTags(base);
    return { ok: true, started: false };
  } catch {
    // Try to start an installed Ollama below.
  }
  const executable = ollamaExecutable();
  if (!executable) {
    const error = new Error('Ollama is not installed. Download it from https://ollama.com/download/windows.');
    error.code = 'OLLAMA_NOT_INSTALLED';
    throw error;
  }
  const args = /ollama\.exe$/i.test(executable) ? ['serve'] : [];
  log?.info('ollama', `Starting ${executable}`);
  let child;
  try {
    child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (error) {
    throw new Error(`Ollama could not be started: ${error.message}`);
  }
  let lastError = '';
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      await ollamaTags(base);
      return { ok: true, started: true };
    } catch (error) {
      lastError = error.message;
      if (child.exitCode !== null && child.exitCode !== 0) break;
    }
  }
  throw new Error(`Ollama is installed but did not start. Open Ollama once, then try again. ${lastError}`.trim());
}

async function pullOllamaModel(base, model, onProgress, log) {
  const name = String(model || '').trim();
  if (!name) throw new Error('Choose an Ollama model before pulling it.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.OLLAMA_PULL_TIMEOUT_MS);
  log?.info('ollama', `Pulling ${name}`);
  try {
    let response;
    try {
      response = await fetch(`${base}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, stream: true }),
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error('The Ollama model download timed out.');
      throw new Error(`Ollama is not reachable: ${error.message}`);
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama returned ${response.status}: ${text.slice(0, 500) || response.statusText}`);
    }
    if (!response.body) throw new Error('Ollama returned an empty download stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let lastProgress = { status: 'pulling', completed: 0, total: 0, percent: null };
    const handleLine = (line) => {
      const text = line.trim();
      if (!text) return;
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        return;
      }
      if (event.error) throw new Error(String(event.error));
      const completed = Number(event.completed) || 0;
      const total = Number(event.total) || 0;
      const percent = total > 0 ? Math.max(0, Math.min(100, Math.floor((completed * 100) / total))) : null;
      lastProgress = {
        status: String(event.status || 'pulling'),
        completed,
        total,
        percent: event.status === 'success' ? 100 : percent
      };
      onProgress?.(lastProgress);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) handleLine(line);
    }
    pending += decoder.decode();
    if (pending.trim()) handleLine(pending);
    log?.info('ollama', `${name} is ready`);
    return { ok: true, model: name, progress: lastProgress };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The Ollama model download timed out.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Lazy-require tts-kokoro so it only loads when Kokoro is actually used.
// This avoids pulling in Electron's dialog/app at require time in tests.
let _kokoroMod = null;
function kokoroMod() {
  if (!_kokoroMod) _kokoroMod = require('./tts-kokoro.cjs');
  return _kokoroMod;
}

function kokoroHealth() {
  return kokoroMod().kokoroHealth();
}

function startKokoro(opts) {
  return kokoroMod().startKokoro(opts);
}

function stopKokoro() {
  return kokoroMod().stopKokoro();
}

// Lazy-require OmniVoice for the same reason as Kokoro: Electron's app/dialog
// objects are not needed by tests or by users who keep the Windows voice.
let _omnivoiceMod = null;
function omnivoiceMod() {
  if (!_omnivoiceMod) _omnivoiceMod = require('./tts-omnivoice.cjs');
  return _omnivoiceMod;
}

function omniHealth() {
  return omnivoiceMod().omnivoiceHealth();
}

function startOmnivoice(opts) {
  return omnivoiceMod().startOmnivoice(opts);
}

function stopOmnivoice() {
  return omnivoiceMod().stopOmnivoice();
}

function omniStatus() {
  return omnivoiceMod().omnivoiceStatus();
}

function probeOmni() {
  return omnivoiceMod().probeGpu();
}

function resolveTtsVoice(ttsSettings) {
  const requested = String(ttsSettings?.ttsVoice || 'af_heart').trim() || 'af_heart';
  if (ttsSettings?.ttsAutoVoice === false) return requested;
  const { VOICES } = require('./tts-text.cjs');
  return VOICES.some((voice) => voice.id === requested) ? requested : 'af_heart';
}

async function ensureKokoroServer(ttsSettings, signal, log) {
  const kokoro = kokoroMod();
  await kokoro.startKokoro({
    variant: ttsSettings?.ttsModelVariant || 'quantized',
    voiceId: resolveTtsVoice(ttsSettings),
    provider: ttsSettings?.ttsGpu ? 'cuda' : 'cpu',
    signal,
    log
  });
  return kokoro;
}

function speechScript(text) {
  const escaped = String(text).replace(/'/g, "''").slice(0, 1200);
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 0
$synth.Speak('${escaped}')
$synth.Dispose()
`;
}

// Windows TTS via PowerShell — final fallback if Kokoro fails or isn't selected.
function speakWindows(text, signal, log) {
  return new Promise((resolve, reject) => {
    const clean = String(text || '').trim();
    if (!clean) {
      resolve();
      return;
    }
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encoded = Buffer.from(speechScript(clean), 'utf16le').toString('base64');
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: 'ignore'
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      child.kill();
      reject(new Error('Speech timed out.'));
    }, LIMITS.SPEECH_TIMEOUT_MS);
    const cancel = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve();
    };
    if (signal) {
      if (signal.aborted) {
        cancel();
        return;
      }
      signal.addEventListener('abort', cancel, { once: true });
    }
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      log?.warn('speech', error.message);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (code !== 0) {
        reject(new Error(`Windows speech exited with code ${code}.`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Splits the first long sentence of a segment list at a natural boundary.
 */
function splitFirstSegment(list) {
  if (!Array.isArray(list) || list.length === 0) return list;
  const first = String(list[0]);
  if (first.length <= 60) return list;
  let cut = -1;
  const m = /[,;:\u2014-]\s/.exec(first.slice(20, 90));
  if (m) cut = 20 + m.index + 1;
  else {
    const sp = first.indexOf(' ', 45);
    if (sp > 0 && sp < first.length - 10) cut = sp;
  }
  if (cut <= 0 || cut >= first.length - 5) return list;
  return [first.slice(0, cut).trim(), first.slice(cut).trim(), ...list.slice(1)];
}

const KOKORO_SYNTH_TIMEOUT_MS = 20000;

function synthesizeKokoroSegment(kokoro, text, voice, speed, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    }

    function onAbort() {
      finish(resolve, null);
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new Error(`Kokoro segment timed out after ${KOKORO_SYNTH_TIMEOUT_MS / 1000} seconds.`);
      error.timeout = true;
      finish(reject, error);
    }, KOKORO_SYNTH_TIMEOUT_MS);

    let synthesis;
    try {
      synthesis = kokoro.synthesize(text, voice, speed, signal);
    } catch (error) {
      finish(reject, error);
      return;
    }
    Promise.resolve(synthesis).then(
      (wavBuffer) => finish(resolve, wavBuffer),
      (error) => finish(reject, error)
    );
  });
}

const SPEECH_INFLIGHT = 2;

function fallbackEngineFor(ttsSettings) {
  const configured = String(ttsSettings?.ttsFallbackEngine || 'windows');
  return configured === 'kokoro' ? 'kokoro' : 'windows';
}

/**
 * Incremental speech queue shared by true LLM streaming and one-shot replies.
 *
 * Text can be pushed in arbitrary deltas. Complete sentences are synthesized as
 * soon as they arrive, at most two requests are in flight, and completed audio
 * is emitted strictly in sentence order so the renderer can schedule a gapless
 * sequence. If OmniVoice cannot start or produces no audio, the remaining text
 * is sent to the configured fallback engine instead of failing the turn.
 */
class SpeechStream {
  constructor(ttsSettings, signal, log, onChunk, options = {}) {
    this.tts = { ...(ttsSettings || {}) };
    this.signal = signal;
    this.log = log;
    this.onChunk = onChunk;
    this.onNotice = options.onNotice;
    this.engine = String(this.tts.ttsEngine || 'windows');
    this.speed = Number(this.tts.ttsSpeed || 1.0);
    this.rawText = '';
    this.consumed = 0;
    this.segments = [];
    this.queue = [];
    this.inFlight = 0;
    this.completed = new Map();
    this.nextEmit = 0;
    this.nextSeq = 0;
    this.delivered = 0;
    this.errors = [];
    this.fatal = null;
    this.cancelled = false;
    this.fallbackUsed = false;
    this.inThink = false;
    this.readyPromise = null;
    this.idleWaiters = [];
    this.finishPromise = null;
    this.generation = 0;
    this.callController = new AbortController();
  }

  activeSignal() {
    if (!this.signal) return this.callController.signal;
    if (typeof AbortSignal.any === 'function') {
      return AbortSignal.any([this.signal, this.callController.signal]);
    }
    // Older Node versions: forward the outer abort to an internal controller.
    if (!this._compositeController) {
      this._compositeController = new AbortController();
      this.signal.addEventListener('abort', () => this._compositeController.abort(), { once: true });
      this.callController.signal.addEventListener('abort', () => this._compositeController.abort(), { once: true });
    }
    return this._compositeController.signal;
  }

  push(delta) {
    if (this.cancelled || !delta) return;
    let text = String(delta);
    if (this.inThink) {
      const close = text.search(/<\/think>/i);
      if (close < 0) return;
      this.inThink = false;
      text = text.slice(close + 8);
    }
    text = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, ' ');
    const open = text.search(/<think\b[^>]*>/i);
    if (open >= 0) {
      this.inThink = true;
      text = text.slice(0, open);
    }
    if (!text) return;
    this.rawText += text;
    this.extract();
  }

  flush() {
    this.extract(true);
  }

  extract(final = false) {
    if (!this.rawText) return;
    let source = this.rawText;
    if (final) {
      // An unfinished fence would otherwise be spoken as source code. Close it
      // so normaliseForSpeech can replace the whole block with "code block".
      const fences = (source.match(/```/g) || []).length;
      if (fences % 2 === 1) {
        source += '\n```\n';
        this.rawText = source;
      }
      const chunk = source.slice(this.consumed);
      if (!chunk.trim()) return;
      for (const sentence of segmentSentences(normaliseForSpeech(chunk))) this.enqueue(sentence);
      this.consumed = source.length;
      return;
    }
    let safeEnd = source.length;
    const marks = [...source.matchAll(/```/g)];
    if (marks.length % 2 === 1) safeEnd = marks[marks.length - 1].index;
    if (safeEnd <= this.consumed) return;
    const chunk = source.slice(this.consumed, safeEnd);
    const { ready } = takeCompleteSentences(chunk);
    if (!ready) return;
    for (const sentence of segmentSentences(normaliseForSpeech(ready))) this.enqueue(sentence);
    this.consumed += ready.length;
  }

  enqueue(text) {
    if (this.cancelled) return;
    const clean = String(text || '').trim();
    if (!clean) return;
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.segments.push({ text: clean, delivered: false });
    this.queue.push(seq);
    this.pump();
  }

  ensureReady() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      if (this.engine === 'omnivoice') {
        return omnivoiceMod().startOmnivoice({ signal: this.signal, log: this.log });
      }
      if (this.engine === 'kokoro') {
        return ensureKokoroServer(this.tts, this.signal, this.log);
      }
      return null;
    })();
    return this.readyPromise;
  }

  async synthesize(text) {
    if (this.engine === 'omnivoice') {
      const mode = String(this.tts.ttsOmniMode || 'auto');
      const options = { speed: this.speed };
      if (mode === 'clone' && this.tts.ttsOmniRefAudio) {
        options.ref_audio = this.tts.ttsOmniRefAudio;
        if (this.tts.ttsOmniRefText) options.ref_text = this.tts.ttsOmniRefText;
      } else if (mode === 'design') {
        const instruct = normalizeOmniInstruct(this.tts.ttsOmniInstruct);
        if (instruct) options.instruct = instruct;
      }
      if (this.tts.ttsOmniLanguage) options.language = this.tts.ttsOmniLanguage;
      return omnivoiceMod().synthesize(text, options, this.activeSignal());
    }
    if (this.engine === 'kokoro') {
      const kokoro = await this.ensureReady();
      return synthesizeKokoroSegment(kokoro, text, resolveTtsVoice(this.tts), this.speed, this.activeSignal());
    }
    return speakWindows(text, this.activeSignal(), this.log);
  }

  pump() {
    if (this.cancelled) {
      this.resolveIdle();
      return;
    }
    const generation = this.generation;
    const inflightLimit = this.engine === 'windows' ? 1 : SPEECH_INFLIGHT;
    while (this.inFlight < inflightLimit && this.queue.length) {
      const seq = this.queue.shift();
      this.inFlight += 1;
      Promise.resolve()
        .then(() => this.ensureReady())
        .then(() => this.synthesize(this.segments[seq].text))
        .then((buffer) => {
          if (generation !== this.generation) return;
          if (this.engine === 'windows') {
            this.completed.set(seq, true);
            return;
          }
          if (!this.cancelled && buffer?.length) {
            this.completed.set(seq, buffer);
            return;
          }
          throw new Error(`${this.engine} returned no audio for this sentence.`);
        })
        .catch((error) => {
          if (generation !== this.generation) return;
          if (this.cancelled || error?.cancelled || this.signal?.aborted) {
            this.completed.set(seq, null);
            return;
          }
          this.errors.push(error);
          this.log?.warn('speech', `${this.engine} segment failed: ${error.message}`);
          // Switch the rest of the reply to the configured fallback immediately.
          // The engine that just failed may be unable to answer at all, so
          // waiting until the whole LLM response finishes would delay speech.
          if (!this.switchEngine(error)) {
            this.fatal = this.fatal || error;
            this.queue = [];
          }
        })
        .finally(() => {
          if (generation !== this.generation) return;
          this.inFlight -= 1;
          this.drain();
          this.pump();
          if (this.inFlight === 0 && this.queue.length === 0) this.resolveIdle();
        });
    }
    this.drain();
    if (this.inFlight === 0 && this.queue.length === 0) this.resolveIdle();
  }

  switchEngine(error) {
    let next = null;
    if (this.engine === 'omnivoice') next = fallbackEngineFor(this.tts);
    else if (this.engine === 'kokoro') next = 'windows';
    if (!next || next === this.engine) return false;

    const previous = this.engine === 'omnivoice' ? 'OmniVoice' : 'Kokoro';
    const replacement = next === 'kokoro' ? 'Kokoro' : 'the Windows voice';
    const partial = this.delivered > 0;
    this.fallbackUsed = true;
    this.log?.warn('speech', `${previous} failed; using ${next} for ${partial ? 'the remaining text' : 'the reply'}: ${error.message}`);
    this.onNotice?.({
      level: 'warn',
      message: partial
        ? `${previous} stopped; the rest is using ${replacement}. ${error.message}`
        : `${previous} is unavailable; using ${replacement}. ${error.message}`
    });

    this.engine = next;
    this.readyPromise = null;
    this.generation += 1;
    try { this.callController.abort(); } catch { /**/ }
    this.callController = new AbortController();
    this.inFlight = 0;
    this.completed.clear();
    this.queue = [];
    this.nextEmit = this.segments.findIndex((segment) => !segment.delivered);
    if (this.nextEmit < 0) {
      this.resolveIdle();
      return true;
    }
    for (let seq = this.nextEmit; seq < this.segments.length; seq += 1) {
      if (!this.segments[seq].delivered) this.queue.push(seq);
    }
    this.pump();
    return true;
  }

  drain() {
    while (this.completed.has(this.nextEmit)) {
      const seq = this.nextEmit;
      const buffer = this.completed.get(seq);
      this.completed.delete(seq);
      this.nextEmit += 1;
      if (this.cancelled || buffer == null) continue;
      this.segments[seq].delivered = true;
      this.delivered += 1;
      if (buffer === true) continue;
      try {
        this.onChunk(buffer);
      } catch (error) {
        this.log?.warn('speech', `Could not deliver audio: ${error.message}`);
      }
    }
  }

  waitIdle() {
    if (this.inFlight === 0 && this.queue.length === 0) {
      this.drain();
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  resolveIdle() {
    if (this.inFlight !== 0 || this.queue.length !== 0) return;
    this.drain();
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  remainingText() {
    return this.segments.filter((segment) => !segment.delivered).map((segment) => segment.text).join(' ').trim();
  }

  async fallback(reason) {
    if (this.fallbackUsed || this.cancelled || this.signal?.aborted) return;
    const text = this.remainingText() || normaliseForSpeech(this.rawText).trim();
    if (!text) return;
    const engine = fallbackEngineFor(this.tts);
    const label = this.engine === 'omnivoice' ? 'OmniVoice' : 'The voice engine';
    const replacement = engine === 'kokoro' ? 'Kokoro' : 'the Windows voice';
    const message = reason?.message || 'The voice engine is unavailable.';
    this.fallbackUsed = true;
    this.log?.warn('speech', `${label} failed; using ${engine} for ${this.delivered ? 'the remaining text' : 'the reply'}: ${message}`);
    this.onNotice?.({
      level: 'warn',
      message: this.delivered
        ? `${label} stopped; the rest is using ${replacement}. ${message}`
        : `${label} is unavailable; using ${replacement}. ${message}`
    });
    try {
      await speakStreaming(text, {
        ...this.tts,
        ttsEngine: engine,
        ttsFallbackEngine: 'windows'
      }, this.signal, this.log, this.onChunk);
    } catch (error) {
      this.errors.push(error);
      this.log?.warn('speech', `${engine} fallback failed: ${error.message}`);
    }
  }

  finish() {
    if (this.finishPromise) return this.finishPromise;
    this.finishPromise = (async () => {
      this.flush();
      await this.waitIdle();
      this.drain();
      if (this.cancelled || this.signal?.aborted) {
        return { ok: true, cancelled: true, delivered: this.delivered, fallback: this.fallbackUsed };
      }
      const total = this.segments.length;
      const reason = this.fatal || (this.delivered === 0 && total > 0 ? this.errors[0] || new Error('No audio was produced.') : null);
      if (reason && this.delivered < total) {
        await this.fallback(reason);
      }
      return {
        ok: this.delivered > 0 || this.fallbackUsed,
        delivered: this.delivered,
        fallback: this.fallbackUsed,
        errors: this.errors.map((error) => error.message)
      };
    })();
    return this.finishPromise;
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.generation += 1;
    this.queue = [];
    this.inFlight = 0;
    this.completed.clear();
    try { this.callController.abort(); } catch { /**/ }
    this.resolveIdle();
  }
}

function createSpeechStream(ttsSettings, signal, log, onChunk, options = {}) {
  return new SpeechStream(ttsSettings, signal, log, onChunk, options);
}

/**
 * Unified streaming speech engine — OmniVoice or Kokoro when selected, with
 * the configured fallback and the Windows voice as the last resort. onChunk is
 * called with each WAV buffer in sentence order.
 */
async function speakStreaming(text, ttsSettings, signal, log, onChunk, options = {}) {
  const clean = String(text || '').trim();
  if (!clean) return { ok: true, delivered: 0, fallback: false };

  // Silence: check ttsVolume (0 means silent)
  const volume = Number(ttsSettings?.ttsVolume ?? 1);
  if (volume <= 0) {
    log?.info('speech', 'TTS volume is 0; speaking suppressed.');
    return { ok: true, delivered: 0, fallback: false };
  }

  const engine = String(ttsSettings?.ttsEngine || 'windows');
  if (engine === 'omnivoice' || engine === 'kokoro') {
    const stream = createSpeechStream(ttsSettings, signal, log, onChunk, options);
    stream.push(clean);
    stream.flush();
    return stream.finish();
  }

  // Windows voice (not streaming)
  await speakWindows(clean, signal, log);
  return { ok: true, delivered: 0, fallback: false, system: true };
}


module.exports = {
  messageText,
  listModels,
  checkHealth,
  chat,
  chatStream,
  transcribe,
  cloudTranscribe,
  whisperDirectory,
  pythonPath,
  whisperCacheDir,
  whisperLaunchCommand,
  whisperExpectedLaunchId,
  whisperModelInstalled,
  whisperInstalledModels,
  whisperHealth,
  whisperModels,
  loadWhisperModel,
  cancelWhisperModel,
  startWhisper,
  stopWhisper,
  whisperStatus,
  ollamaBase,
  ollamaExecutable,
  ollamaTags,
  detectFreeLlmApi,
  ensureOllamaRunning,
  pullOllamaModel,
  speakStreaming,
  createSpeechStream,
  kokoroHealth,
  startKokoro,
  stopKokoro,
  omniHealth,
  startOmnivoice,
  stopOmnivoice,
  omniStatus,
  probeOmni,
  omnivoiceMod
};
