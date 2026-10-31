'use strict';

// OmniVoice local TTS — runtime discovery, server lifecycle, and HTTP client.
//
// The runtime is intentionally separate from Kokoro/Whisper:
//   %APPDATA%\my-voice-app\omnivoice\venv   isolated Python environment
//   %APPDATA%\my-voice-app\omnivoice\model  downloaded k2-fsa/OmniVoice model
//
// Nothing here downloads a model. Selecting OmniVoice starts the server only
// after scripts/setup-omnivoice.cjs has produced the runtime, and every failure
// is reported to the caller so services.cjs can fall back to another voice.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { app } = require('electron');
const { LIMITS } = require('./constants.cjs');

const OMNIVOICE_PORT = 8765;
const HEALTH_TIMEOUT_MS = 2000;
const START_POLL_INTERVAL_MS = 750;
const START_TIMEOUT_MS = 15 * 60 * 1000;
const SYNTHESIZE_TIMEOUT_MS = 3 * 60 * 1000;

function omnivoiceDir() {
  return path.join(app.getPath('userData'), 'omnivoice');
}

function venvDir() {
  return path.join(omnivoiceDir(), 'venv');
}

function venvPython() {
  return process.platform === 'win32'
    ? path.join(venvDir(), 'Scripts', 'python.exe')
    : path.join(venvDir(), 'bin', 'python3');
}

function modelDir() {
  return path.join(omnivoiceDir(), 'model');
}

function markerPath() {
  return path.join(omnivoiceDir(), 'setup.json');
}

function serverScript() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'omnivoice', 'server.py');
  return path.join(app.getAppPath(), 'omnivoice', 'server.py');
}

function setupScript() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'scripts', 'setup-omnivoice.cjs');
  return path.join(app.getAppPath(), 'scripts', 'setup-omnivoice.cjs');
}

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(markerPath(), 'utf8'));
  } catch {
    return null;
  }
}

function isModelReady() {
  const dir = modelDir();
  try {
    if (!fs.existsSync(path.join(dir, 'config.json'))) return false;
    const files = fs.readdirSync(dir);
    const weights = files.some((name) => /^model(?:-\d+-of-\d+)?\.safetensors$/i.test(name))
      || files.includes('model.safetensors.index.json');
    return weights && fs.existsSync(path.join(dir, 'audio_tokenizer', 'config.json'));
  } catch {
    return false;
  }
}

function isInstalled() {
  const marker = readMarker();
  return Boolean(marker && marker.kind === 'voxa-omnivoice-runtime' && marker.status !== 'installing')
    && fs.existsSync(venvPython())
    && fs.existsSync(serverScript());
}

function nvidiaSmiPath() {
  if (process.platform !== 'win32') return 'nvidia-smi';
  const candidates = [
    'nvidia-smi.exe',
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe')
  ];
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
    try {
      const probe = spawnSync(candidate, ['--query-gpu=name', '--format=csv,noheader'], {
        encoding: 'utf8',
        timeout: 2500,
        windowsHide: true
      });
      if (probe.status === 0) return candidate;
    } catch {
      // Try the next path.
    }
  }
  return null;
}

let gpuProbeCache = null;
let gpuProbeAt = 0;
const GPU_PROBE_TTL_MS = 30000;

function probeGpu() {
  if (gpuProbeCache && Date.now() - gpuProbeAt < GPU_PROBE_TTL_MS) return gpuProbeCache;
  const command = nvidiaSmiPath();
  if (!command) {
    gpuProbeCache = { detected: false, gpus: [] };
    gpuProbeAt = Date.now();
    return gpuProbeCache;
  }
  let result;
  try {
    const output = spawnSync(command, [
      '--query-gpu=name,memory.total,driver_version',
      '--format=csv,noheader,nounits'
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (output.status !== 0) {
      result = { detected: false, gpus: [], error: (output.stderr || '').trim() };
    } else {
      const gpus = String(output.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, memory, driver] = line.split(',').map((part) => part.trim());
          return {
            name: name || 'NVIDIA GPU',
            memoryMb: Number(memory) || 0,
            driver: driver || ''
          };
        });
      result = { detected: gpus.length > 0, gpus };
    }
  } catch (error) {
    result = { detected: false, gpus: [], error: error.message };
  }
  gpuProbeCache = result;
  gpuProbeAt = Date.now();
  return result;
}

async function omnivoiceHealth(timeoutMs = HEALTH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${OMNIVOICE_PORT}/health`, { signal: controller.signal });
    const data = await response.json();
    if (data?.service !== 'omnivoice') {
      return { ok: false, status: 'port-in-use', service: data?.service || 'unknown' };
    }
    return { ...data, ok: data?.status === 'ready' };
  } catch {
    return { ok: false, status: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

let omnivoiceProcess = null;
let omnivoiceStarting = null;
let omnivoiceError = '';
let omnivoiceGeneration = 0;
let omnivoiceStopping = false;

function processExited(child) {
  return child && child.exitCode !== null && child.exitCode !== undefined;
}

async function waitForOmnivoice(generation, log) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastLog = 0;
  while (Date.now() < deadline) {
    if (omnivoiceStopping || generation !== omnivoiceGeneration) {
      throw Object.assign(new Error('OmniVoice startup cancelled.'), { cancelled: true });
    }
    if (omnivoiceError) throw new Error(omnivoiceError);
    if (processExited(omnivoiceProcess)) {
      throw new Error(omnivoiceError || 'OmniVoice server exited during startup.');
    }
    const health = await omnivoiceHealth();
    if (health.status === 'ready') return health;
    if (health.status === 'error') throw new Error(health.load_error || 'OmniVoice model failed to load.');
    if (health.status === 'port-in-use') {
      throw new Error(`Port ${OMNIVOICE_PORT} is already used by ${health.service || 'another service'}.`);
    }
    if (Date.now() - lastLog > 15000) {
      lastLog = Date.now();
      const detail = health.status === 'loading'
        ? `model loading${health.load_seconds ? ` (${Math.round(health.load_seconds)}s)` : ''}`
        : 'waiting for the server';
      log?.info('omnivoice', `OmniVoice is starting: ${detail}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, START_POLL_INTERVAL_MS));
  }
  throw new Error('OmniVoice did not become ready in time. Check the setup log and try again.');
}

async function startOmnivoice({ signal, log } = {}) {
  const health = await omnivoiceHealth();
  if (health.status === 'ready') return health;
  if (health.status === 'port-in-use') {
    throw new Error(`Port ${OMNIVOICE_PORT} is already used by ${health.service || 'another service'}.`);
  }
  if (omnivoiceStarting) return omnivoiceStarting;
  if (omnivoiceProcess && omnivoiceProcess.exitCode === null) {
    return waitForOmnivoice(omnivoiceGeneration, log);
  }

  const starting = (async () => {
    if (!isInstalled()) {
      throw Object.assign(
        new Error('OmniVoice is not installed. Run "npm run setup:omnivoice" once, then try again.'),
        { code: 'not-installed' }
      );
    }
    if (!isModelReady()) {
      throw Object.assign(
        new Error('The OmniVoice model is missing. Run "npm run setup:omnivoice" to download it.'),
        { code: 'model-missing' }
      );
    }

    const python = venvPython();
    const script = serverScript();
    if (!fs.existsSync(python)) throw new Error(`OmniVoice Python not found at ${python}.`);
    if (!fs.existsSync(script)) throw new Error(`OmniVoice server not found at ${script}.`);

    omnivoiceError = '';
    omnivoiceStopping = false;
    const generation = ++omnivoiceGeneration;
    log?.info('omnivoice', `Starting OmniVoice on port ${OMNIVOICE_PORT} with ${path.basename(modelDir())}`);
    const child = spawn(python, [
      script,
      '--host', '127.0.0.1',
      '--port', String(OMNIVOICE_PORT),
      '--model-path', modelDir(),
      '--device', 'auto'
    ], {
      cwd: path.dirname(script),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        HF_HUB_DISABLE_TELEMETRY: '1',
        TOKENIZERS_PARALLELISM: 'false'
      }
    });
    omnivoiceProcess = child;

    const capture = (stream, level) => {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) log?.[level]?.('omnivoice server', line.trim().slice(0, 1200));
        }
      });
    };
    capture(child.stdout, 'info');
    capture(child.stderr, 'info');

    const intentional = () => omnivoiceStopping || generation !== omnivoiceGeneration;
    child.on('error', (error) => {
      if (omnivoiceProcess === child) omnivoiceProcess = null;
      if (!intentional()) {
        omnivoiceError = error.message;
        log?.error('omnivoice server', error.message);
      }
    });
    child.on('close', (code) => {
      if (omnivoiceProcess === child) {
        omnivoiceProcess = null;
        omnivoiceStarting = null;
      }
      if (intentional()) {
        log?.info('omnivoice server', 'OmniVoice server stopped.');
        return;
      }
      if (code !== 0) {
        omnivoiceError = `OmniVoice server exited with code ${code}.`;
        log?.warn('omnivoice server', omnivoiceError);
      }
    });

    const ready = await waitForOmnivoice(generation, log);
    log?.info('omnivoice', `Ready on ${ready.device || 'CPU'} at ${ready.sample_rate || 24000} Hz.`);
    return ready;
  })();

  omnivoiceStarting = starting;
  try {
    return await starting;
  } catch (error) {
    if (!error.cancelled) omnivoiceError = error.message;
    throw error;
  } finally {
    if (omnivoiceStarting === starting) omnivoiceStarting = null;
  }
}

function stopOmnivoice() {
  omnivoiceStopping = true;
  omnivoiceGeneration += 1;
  omnivoiceError = '';
  const child = omnivoiceProcess;
  omnivoiceProcess = null;
  omnivoiceStarting = null;
  if (!child) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } catch {
      try { child.kill(); } catch { /**/ }
    }
  } else {
    try { child.kill(); } catch { /**/ }
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function omnivoiceStatus() {
  return {
    running: Boolean(omnivoiceProcess && omnivoiceProcess.exitCode === null),
    error: omnivoiceError,
    port: OMNIVOICE_PORT,
    python: venvPython(),
    modelDir: modelDir(),
    marker: readMarker()
  };
}

async function synthesize(text, options = {}, signal) {
  const payload = { text: String(text || '') };
  for (const key of ['ref_audio', 'ref_text', 'instruct', 'language', 'speed']) {
    if (options[key] !== undefined && options[key] !== null && options[key] !== '') {
      payload[key] = options[key];
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNTHESIZE_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw Object.assign(new Error('Cancelled.'), { cancelled: true });
    }
    signal.addEventListener('abort', forwardAbort, { once: true });
  }
  try {
    const response = await fetch(`http://127.0.0.1:${OMNIVOICE_PORT}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      let message = detail.slice(0, 600) || `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(detail);
        message = parsed?.detail || message;
      } catch {
        // Keep the plain text.
      }
      throw new Error(`OmniVoice synthesis failed: ${message}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('OmniVoice returned an empty audio response.');
    return buffer;
  } catch (error) {
    if (signal?.aborted || controller.signal.aborted) {
      throw Object.assign(new Error('Cancelled.'), { cancelled: true });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

function runSetup({ onOutput, signal, log } = {}) {
  return new Promise((resolve, reject) => {
    const script = setupScript();
    if (!fs.existsSync(script)) {
      reject(new Error(`OmniVoice setup script not found at ${script}.`));
      return;
    }
    stopOmnivoice();
    const child = spawn(process.execPath, [script, '--dir', omnivoiceDir()], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        VOXA_USER_DATA: app.getPath('userData'),
        PYTHONUNBUFFERED: '1'
      }
    });
    let settled = false;
    let output = '';
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve({ ok: true, output });
    };
    const abort = () => {
      if (process.platform === 'win32' && child.pid) {
        try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /**/ }
      } else {
        try { child.kill(); } catch { /**/ }
      }
      finish(Object.assign(new Error('Setup cancelled.'), { cancelled: true }));
    };
    if (signal) {
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
    }
    const forward = (stream, level) => {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n|\r/);
        pending = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          output += `${line}\n`;
          if (level === 'error') log?.warn('omnivoice setup', line.trim());
          else log?.info('omnivoice setup', line.trim());
          onOutput?.(line.trim());
        }
      });
    };
    forward(child.stdout, 'info');
    forward(child.stderr, 'error');
    child.on('error', (error) => {
      log?.error('omnivoice setup', error.message);
      finish(error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        log?.info('omnivoice setup', 'Runtime setup finished.');
        finish(null);
      } else {
        const error = new Error(`OmniVoice setup exited with code ${code}. See the Voxa log for details.`);
        log?.error('omnivoice setup', error.message);
        finish(error);
      }
    });
  });
}

module.exports = {
  OMNIVOICE_PORT,
  SYNTHESIZE_TIMEOUT_MS,
  omnivoiceDir,
  venvDir,
  venvPython,
  modelDir,
  markerPath,
  serverScript,
  setupScript,
  readMarker,
  isInstalled,
  isModelReady,
  probeGpu,
  omnivoiceHealth,
  startOmnivoice,
  stopOmnivoice,
  omnivoiceStatus,
  synthesize,
  runSetup
};
