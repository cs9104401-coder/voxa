'use strict';

// Lifecycle and HTTP client for the optional local ASR service. The bundled
// Whisper server is untouched; this process is started only when a non-Whisper
// engine is selected. The interpreter is always a fixed executable plus an
// argument array (never a shell string), and the service binds to localhost.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { LIMITS } = require('./constants.cjs');

const SERVICE_VERSION = 2;
const START_ATTEMPTS = 240;
const START_DELAY_MS = 500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function createAsrService(options = {}) {
  const log = options.log || null;
  const port = Number(options.port || LIMITS.ASR_PORT);
  const appRoot = path.resolve(options.appRoot || path.join(__dirname, '..'));
  const userDataDir = path.resolve(options.userDataDir || path.join(appRoot, 'asr-data'));
  const resourcesPath = options.resourcesPath || process.resourcesPath || '';
  const isPackaged = Boolean(options.isPackaged);
  const cacheDir = path.resolve(options.cacheDir || path.join(userDataDir, 'asr-models'));
  const whisperCacheDir = path.resolve(options.whisperCacheDir || path.join(userDataDir, 'whisper-models'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const state = {
    child: null,
    starting: null,
    token: '',
    python: '',
    lastError: '',
    stopping: false,
    stderrTail: []
  };

  function projectRoot() {
    const override = String(process.env.VOXA_ASR_ROOT || '').trim();
    if (override) return path.resolve(override);
    if (!isPackaged) return appRoot;
    // The Python package lives outside app.asar; electron-builder unpacks it so
    // a normal interpreter can import it.
    return path.join(resourcesPath, 'app.asar.unpacked');
  }

  function resolvePython() {
    const explicit = String(process.env.VOXA_ASR_PYTHON || '').trim();
    if (explicit) {
      if (explicit.includes('\\') || explicit.includes('/')) {
        const resolved = path.resolve(explicit);
        if (!fs.existsSync(resolved)) throw new Error(`VOXA_ASR_PYTHON points to a missing file: ${resolved}`);
        return resolved;
      }
      return explicit;
    }
    const candidates = isPackaged
      ? [
        path.join(resourcesPath, 'asr-runtime', 'python.exe'),
        path.join(resourcesPath, 'asr-runtime', 'python', 'python.exe'),
        path.join(userDataDir, 'asr-runtime', 'python.exe'),
        path.join(userDataDir, 'asr-runtime', 'python', 'python.exe')
      ]
      : [
        path.join(appRoot, 'whisper-server', '.venv-asr', 'Scripts', 'python.exe'),
        path.join(appRoot, 'whisper-server', '.venv-asr', 'bin', 'python'),
        path.join(appRoot, 'whisper-server', '.venv', 'Scripts', 'python.exe'),
        path.join(appRoot, 'whisper-server', '.venv', 'bin', 'python')
      ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return 'python';
  }

  function publicInfo() {
    return {
      running: isRunning(),
      port,
      tokenSet: Boolean(state.token),
      python: state.python,
      cacheDir,
      error: state.lastError
    };
  }

  function isRunning() {
    return Boolean(state.child && state.child.exitCode === null && !state.child.killed);
  }

  function rememberStderr(text) {
    const line = asText(text);
    if (!line) return;
    if (/service_token|authorization|bearer/i.test(line)) return;
    state.stderrTail.push(line.slice(0, 500));
    state.stderrTail = state.stderrTail.slice(-12);
    log?.info?.('asr', line.slice(0, 500));
  }

  function launchArguments(launch = {}) {
    const args = [
      '-m', 'asr', 'serve',
      '--host', '127.0.0.1',
      '--port', String(port),
      '--cache', cacheDir,
      '--log-level', 'INFO'
    ];
    if (launch.model) args.push('--model', String(launch.model));
    if (launch.device) args.push('--device', String(launch.device));
    if (launch.computeType) args.push('--compute-type', String(launch.computeType));
    if (launch.language) args.push('--language', String(launch.language));
    if (launch.chunkSeconds) args.push('--chunk-seconds', String(launch.chunkSeconds));
    return args;
  }

  function environment() {
    const root = projectRoot();
    const pythonPath = [root, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter);
    return {
      ...process.env,
      ASR_SERVICE_TOKEN: state.token,
      ASR_MODEL_CACHE: cacheDir,
      ASR_LOG_LEVEL: 'INFO',
      VOXA_WHISPER_CACHE: whisperCacheDir,
      VOXA_ASR_COMPAT_CACHE: whisperCacheDir,
      PYTHONPATH: pythonPath,
      PYTHONUTF8: '1',
      PYTHONUNBUFFERED: '1',
      HF_HUB_DISABLE_TELEMETRY: '1'
    };
  }

  async function startProcess(launch) {
    if (isRunning()) return;
    const python = resolvePython();
    state.python = python;
    state.token = crypto.randomBytes(32).toString('hex');
    state.lastError = '';
    state.stopping = false;
    state.stderrTail = [];
    const root = projectRoot();
    if (!fs.existsSync(path.join(root, 'asr', '__main__.py'))) {
      throw new Error(
        `The optional ASR package was not found at ${root}. Set VOXA_ASR_ROOT to the folder that contains the asr package.`
      );
    }
    log?.info?.('asr', `Starting ${python} -m asr serve on 127.0.0.1:${port}`);
    const child = spawn(python, launchArguments(launch), {
      cwd: root,
      env: environment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    state.child = child;
    child.stdout?.on('data', (chunk) => rememberStderr(chunk));
    child.stderr?.on('data', (chunk) => rememberStderr(chunk));
    child.on('error', (error) => {
      state.lastError = `Could not start the ASR service: ${error.message}`;
      state.child = null;
    });
    child.on('exit', (code, signal) => {
      const tail = state.stderrTail.slice(-3).join(' | ');
      if (!state.stopping) {
        state.lastError = `The ASR service exited (${signal || code || 'unknown'}).${tail ? ` ${tail}` : ''}`;
        log?.warn?.('asr', state.lastError);
      }
      if (state.child === child) state.child = null;
    });

    for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
      if (!isRunning()) {
        throw new Error(state.lastError || 'The ASR service stopped before it became healthy.');
      }
      const health = await request('/health', { timeout: 2500, quiet: true }).catch(() => null);
      if (health?.service === 'asr') {
        log?.info?.('asr', `ASR service is healthy (pid ${health.pid}, version ${health.version}).`);
        return health;
      }
      await delay(START_DELAY_MS);
    }
    throw new Error(`The ASR service did not become healthy within ${Math.round((START_ATTEMPTS * START_DELAY_MS) / 1000)} seconds. ${state.lastError || ''}`.trim());
  }

  async function ensureStarted(launch = {}) {
    // The child process exists before /health answers. A second explicit action
    // (for example Load clicked while Check status is still starting the
    // service) must join that launch instead of treating the child as wedged.
    if (state.starting) return state.starting;
    if (isRunning()) {
      const health = await request('/health', { timeout: 3000, quiet: true }).catch(() => null);
      if (health?.service === 'asr') return health;
      throw new Error(state.lastError || 'The ASR service is running but did not answer its health check.');
    }
    state.starting = startProcess(launch).finally(() => {
      state.starting = null;
    });
    return state.starting;
  }

  function requestHeaders(extra = {}) {
    const headers = { ...extra };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    return headers;
  }

  async function request(endpoint, options = {}) {
    const timeout = Number(options.timeout || 15000);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    const external = options.signal;
    const abort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', abort, { once: true });
    }
    try {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: options.method || 'GET',
        headers: requestHeaders(options.headers),
        body: options.body,
        signal: controller.signal
      });
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }
      if (!response.ok) {
        const error = new Error(
          payload?.error?.message || payload?.message || text.slice(0, 500) || response.statusText || 'ASR request failed.'
        );
        error.code = payload?.error?.code || 'asr_http_error';
        error.status = response.status;
        error.details = payload?.error || null;
        throw error;
      }
      if (!payload) {
        if (options.allowEmpty) return null;
        throw new Error('The ASR service returned an empty response.');
      }
      return payload;
    } catch (error) {
      if (external?.aborted) {
        const cancelled = new Error('Cancelled.');
        cancelled.cancelled = true;
        throw cancelled;
      }
      if (timedOut) {
        const timeoutError = new Error(`The ASR service did not respond within ${Math.round(timeout / 1000)} seconds.`);
        timeoutError.code = 'asr_timeout';
        throw timeoutError;
      }
      if (options.quiet) return null;
      throw error;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener?.('abort', abort);
    }
  }

  async function health(timeout = 2500) {
    if (!isRunning()) return null;
    return request('/health', { timeout });
  }

  async function peek() {
    return health(2200).catch(() => null);
  }

  async function status(launch = {}) {
    await ensureStarted(launch);
    return request('/status', { timeout: 15000 });
  }

  async function peekStatus() {
    if (!isRunning()) return null;
    return request('/status', { timeout: 8000 }).catch(() => null);
  }

  async function models(launch = {}) {
    await ensureStarted(launch);
    return request('/models', { timeout: 30000 });
  }

  async function load(launch = {}, payload = {}) {
    await ensureStarted(launch);
    return request('/models/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 30000
    });
  }

  async function download(launch = {}, model) {
    await ensureStarted(launch);
    return request('/models/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      timeout: 30000
    });
  }

  async function cancel() {
    if (!isRunning()) return null;
    return request('/models/cancel', { method: 'POST', timeout: 15000 });
  }

  async function unload() {
    if (!isRunning()) return null;
    return request('/models/unload', { method: 'POST', timeout: 30000 });
  }

  async function cancelTranscription() {
    if (!isRunning()) return null;
    return request('/transcribe/cancel', { method: 'POST', timeout: 8000 }).catch(() => null);
  }

  async function transcribe(bytes, mime, options = {}) {
    // Transcription never owns lifecycle. The app checks the ready state and a
    // model is loaded only through an explicit Load/Download action. If the
    // process died in between, fail instead of restarting it on a hot path.
    if (!isRunning()) {
      throw new Error('The ASR service is not running. Load a model first.');
    }
    const timeout = Number(options.timeout || LIMITS.ASR_TRANSCRIBE_TIMEOUT_MS);
    const form = new FormData();
    const type = String(mime || 'audio/webm').slice(0, 100);
    form.append('audio', new Blob([bytes], { type }), `audio.${type.includes('wav') ? 'wav' : 'webm'}`);
    if (options.model) form.append('model', String(options.model));
    if (options.language) form.append('language', String(options.language));
    if (options.wordTimestamps !== undefined) form.append('word_timestamps', String(Boolean(options.wordTimestamps)));
    if (options.vad !== undefined) form.append('vad', String(Boolean(options.vad)));
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    const external = options.signal;
    const abort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', abort, { once: true });
    }
    try {
      const response = await fetch(`${baseUrl}/transcribe`, {
        method: 'POST',
        headers: requestHeaders(),
        body: form,
        signal: controller.signal
      });
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }
      if (!response.ok || !payload?.ok) {
        const error = new Error(
          payload?.error?.message || payload?.message || text.slice(0, 500) || response.statusText || 'Transcription failed.'
        );
        error.code = payload?.error?.code || 'asr_http_error';
        error.status = response.status;
        throw error;
      }
      return payload.result;
    } catch (error) {
      if (external?.aborted) {
        await cancelTranscription();
        const cancelled = new Error('Cancelled.');
        cancelled.cancelled = true;
        throw cancelled;
      }
      if (timedOut) {
        // The HTTP response is gone but the Python worker may still be busy.
        // Cancel it so the next dictation is not rejected as concurrent.
        await cancelTranscription().catch(() => null);
        const timeoutError = new Error(`The ASR service did not finish within ${Math.round(timeout / 1000)} seconds.`);
        timeoutError.code = 'asr_timeout';
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener?.('abort', abort);
    }
  }

  function stop() {
    state.stopping = true;
    state.starting = null;
    const child = state.child;
    state.child = null;
    state.token = '';
    if (!child || child.exitCode !== null || child.killed) return false;
    try {
      child.kill();
      return true;
    } catch (error) {
      log?.warn?.('asr', `Could not stop the ASR service: ${error.message}`);
      return false;
    }
  }

  async function stopAndWait(timeoutMs = 5000) {
    // Capture the child before stop() clears it. Callers that are about to
    // start another local engine need the old process to release its GPU
    // memory first, not just receive the kill signal.
    const child = state.child;
    stop();
    if (!child || child.exitCode !== null) return true;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const onError = () => finish(true);
      const timer = setTimeout(() => finish(false), Math.max(100, Number(timeoutMs) || 5000));
      timer.unref?.();
      child.once('exit', onExit);
      child.once('error', onError);
      if (child.exitCode !== null) finish(true);
    });
  }

  return {
    port,
    baseUrl,
    cacheDir,
    whisperCacheDir,
    ensureStarted,
    health,
    peek,
    status,
    peekStatus,
    models,
    load,
    download,
    cancel,
    unload,
    cancelTranscription,
    transcribe,
    stop,
    stopAndWait,
    isRunning,
    info: publicInfo,
    get version() {
      return SERVICE_VERSION;
    }
  };
}

module.exports = { createAsrService };
