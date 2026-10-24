'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { app } = require('electron');
const { LIMITS } = require('./constants.cjs');
const { BASE_URL_ERROR, normalizeProviderUrl } = require('./store.cjs');

let whisperProcess = null;
let whisperStarting = null;
let whisperError = '';
let whisperConfig = { port: 8000, model: '', device: '', computeType: '' };
let whisperGeneration = 0;
let whisperStopping = false;

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

async function transcribe(serverUrl, audio, mime, model, signal) {
  const baseUrl = providerBaseUrl('local', serverUrl, 'Transcription URL');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime || 'audio/webm' }), 'speech.webm');
  form.append('model', model || 'whisper-1');
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
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, status: 'http-error', port };
    const data = await response.json();
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
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.error || `Whisper request failed (HTTP ${response.status}).`);
    return data;
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
    onHealth?.(health);
    if (health.ok) return health;
    if (health.status === 'error') throw new Error(health.error || 'The Whisper model failed to load.');
    if (health.status === 'http-error') {
      throw new Error(`Port ${port} is already used by another service. Stop that service and try again.`);
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
  const port = Number(options.port) || 8000;
  const model = options.model || 'small';
  const device = options.device || 'cpu';
  const computeType = options.computeType || (device === 'cuda' ? 'float16' : 'int8');
  const cacheDir = options.cacheDir || whisperCacheDir();
  const onHealth = typeof options.onHealth === 'function' ? options.onHealth : null;
  whisperConfig = { port, model, device, computeType };
  whisperStopping = false;
  const existing = await whisperHealth(port);
  if (existing.status !== 'unreachable') onHealth?.(existing);
  if (existing.ok) return existing;
  if (existing.status === 'error') throw new Error(existing.error || 'The Whisper model failed to load.');
  if (existing.status === 'loading' || existing.status === 'downloading') {
    if (!whisperProcess) whisperError = '';
    return waitForWhisper(port, log, onHealth);
  }
  if (existing.status === 'http-error') {
    throw new Error(`Port ${port} is already used by another service. Stop that service and try again.`);
  }
  if (whisperStarting) return whisperStarting;
  if (whisperProcess && whisperProcess.exitCode === null) return waitForWhisper(port, log, onHealth);

  const starting = (async () => {
    const launch = whisperLaunchCommand();
    fs.mkdirSync(cacheDir, { recursive: true });
    whisperError = '';
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
        VOXA_WHISPER_CACHE: cacheDir
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

function killProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => {
      try {
        child.kill();
      } catch {
        // The process may already have exited.
      }
    });
    killer.on('exit', (code) => {
      if (code === 0) return;
      try {
        child.kill();
      } catch {
        // The process may already have exited.
      }
    });
    return;
  }
  try {
    child.kill();
  } catch {
    // The process may already have exited.
  }
}

function stopWhisper() {
  whisperStopping = true;
  whisperGeneration += 1;
  whisperError = '';
  const child = whisperProcess;
  if (child) {
    killProcessTree(child);
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  whisperProcess = null;
  whisperStarting = null;
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
 * Unified speech engine — tries Kokoro when enabled, falls back to Windows voice.
 * Parameters:
 *   text: string to speak
 *   ttsSettings: { ttsEngine: 'kokoro'|'windows', ttsVoice, ttsSpeed, ttsVolume, ttsGpu, ttsModelVariant }
 *   signal: optional AbortSignal
 *   log: optional logger
 */
async function speak(text, ttsSettings, signal, log) {
  const clean = String(text || '').trim();
  if (!clean) return;

  // Silence: check ttsVolume (0 means silent)
  const volume = Number(ttsSettings?.ttsVolume ?? 1);
  if (volume <= 0) {
    log?.info('speech', 'TTS volume is 0; speaking suppressed.');
    return;
  }

  // Route: Kokoro engine or Windows fallback.
  if (ttsSettings?.ttsEngine === 'kokoro') {
    try {
      // Prepare Kokoro server if not already running.
      await startKokoro({
        variant: ttsSettings.ttsModelVariant || 'int8',
        voiceId: ttsSettings.ttsVoice || 'af_heart',
        signal,
        log
      });
      const wavBuffer = await kokoroMod().synthesize(clean, ttsSettings.ttsVoice || 'af_heart', ttsSettings.ttsSpeed || 1.0, signal);
      if (signal?.aborted) return;
      // Play the WAV buffer via Web Audio (handled by renderer).
      // For now, just resolve; the renderer will decode and play.
      log?.info('speech', `Kokoro synthesis complete (${wavBuffer.length} bytes).`);
      return wavBuffer;
    } catch (err) {
      if (err.cancelled || signal?.aborted) return;
      log?.warn('speech', `Kokoro failed, falling back to Windows voice: ${err.message}`);
      // Fall through to Windows voice.
    }
  }

  // Windows voice fallback (or primary if ttsEngine !== 'kokoro').
  return speakWindows(clean, signal, log);
}

/**
 * Unified speech engine (Streaming variant) — tries Kokoro when enabled,
 * segments text into sentences, and calls onChunk for each.
 */
async function speakStreaming(text, ttsSettings, signal, log, onChunk) {
  const clean = String(text || '').trim();
  if (!clean) return;

  // Silence: check ttsVolume (0 means silent)
  const volume = Number(ttsSettings?.ttsVolume ?? 1);
  if (volume <= 0) {
    log?.info('speech', 'TTS volume is 0; speaking suppressed.');
    return;
  }

  // Route: Kokoro engine or Windows fallback.
  if (ttsSettings?.ttsEngine === 'kokoro') {
    try {
      // Prepare Kokoro server if not already running.
      await startKokoro({
        variant: ttsSettings.ttsModelVariant || 'int8',
        voiceId: ttsSettings.ttsVoice || 'af_heart',
        signal,
        log
      });

      // Segment text into sentences
      const { segmentSentences } = require('./tts-text.cjs');
      const sentences = segmentSentences(clean);
      log?.info('speech', `Streaming synthesis: ${sentences.length} segments.`);

      // Pipeline with max 2 concurrent in-flight requests
      const queue = [...sentences];
      const inFlight = [];
      let index = 0;

      return new Promise((resolve, reject) => {
        const next = async () => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          if (queue.length === 0 && inFlight.length === 0) {
            resolve();
            return;
          }

          while (inFlight.length < 2 && queue.length > 0) {
            const sentence = queue.shift();
            const p = kokoroMod().synthesize(sentence, ttsSettings.ttsVoice || 'af_heart', ttsSettings.ttsSpeed || 1.0, signal)
              .then((wavBuffer) => {
                if (!signal?.aborted && wavBuffer && wavBuffer.length > 0) {
                  log?.info('speech', `Kokoro segment complete (${wavBuffer.length} bytes).`);
                  onChunk(wavBuffer);
                }
              })
              .catch((err) => {
                if (!err.cancelled && !signal?.aborted) {
                  log?.warn('speech', `Kokoro segment failed: ${err.message}`);
                }
              })
              .finally(() => {
                const idx = inFlight.indexOf(p);
                if (idx !== -1) inFlight.splice(idx, 1);
                next();
              });
            inFlight.push(p);
          }
        };

        next();
      });
    } catch (err) {
      if (err.cancelled || signal?.aborted) return;
      log?.warn('speech', `Kokoro streaming failed, falling back to Windows voice: ${err.message}`);
    }
  }

  // Windows voice fallback (not streaming)
  const buffer = await speakWindows(clean, signal, log);
  if (buffer) onChunk(buffer);
}

module.exports = {
  messageText,
  listModels,
  checkHealth,
  chat,
  transcribe,
  cloudTranscribe,
  whisperDirectory,
  pythonPath,
  whisperCacheDir,
  whisperLaunchCommand,
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
  speak
};
