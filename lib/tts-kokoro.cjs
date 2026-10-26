'use strict';

// Kokoro-82M TTS — model file management and server process lifecycle.
// Handles: one-time download consent, SHA-256 verification, process
// start/stop/health, circuit breaker state.  No Electron UI imports except
// dialog (for consent).  Never downloads without explicit user consent.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { app, dialog } = require('electron');
const { LIMITS } = require('./constants.cjs');

// ── Model catalogue ────────────────────────────────────────────────────────
// Source: https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX
// Hashes are LFS sha256 values fetched from the HF API — they match the
// content of the downloaded files exactly.
const MODEL_VARIANTS = {
  quantized: {
    filename: 'model_quantized.onnx',
    url: 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx',
    sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478',
    sizeBytes: 92_361_116
  }
};

const VOICES_FILE = {
  filename: 'voices-v1.0.bin',
  url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin',
  sha256: 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d',
  sizeBytes: 28_214_398
};
const KOKORO_PORT = 8001;
const HEALTH_TIMEOUT_MS = 1500;
const START_POLL_INTERVAL_MS = 500;
const START_TIMEOUT_MS = 60_000;
const DOWNLOAD_CHUNK_BYTES = 512 * 1024;

// ── Paths ──────────────────────────────────────────────────────────────────

function kokoroDir() {
  return path.join(app.getPath('userData'), 'kokoro');
}

function modelDir() {
  return path.join(kokoroDir(), 'model');
}

function voicesDir() {
  return path.join(kokoroDir(), 'voices');
}

function modelPath(variant = 'quantized') {
  const spec = MODEL_VARIANTS[variant] || MODEL_VARIANTS.quantized;
  return path.join(modelDir(), spec.filename);
}

function voicePath(voiceId) {
  return path.join(voicesDir(), VOICES_FILE.filename);
}

function consentFlagPath() {
  return path.join(kokoroDir(), 'download-consent.json');
}

// ── Consent ────────────────────────────────────────────────────────────────

function hasConsent() {
  try {
    const raw = fs.readFileSync(consentFlagPath(), 'utf8');
    return JSON.parse(raw)?.granted === true;
  } catch {
    return false;
  }
}

function writeConsent(granted) {
  fs.mkdirSync(kokoroDir(), { recursive: true });
  fs.writeFileSync(
    consentFlagPath(),
    JSON.stringify({ granted, at: new Date().toISOString() }, null, 2) + '\n',
    'utf8'
  );
}

async function requestConsent(modelSizeMb) {
  if (hasConsent()) return true;
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Download (~' + modelSizeMb + ' MB)', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    title: 'Download Kokoro TTS model?',
    message: 'Kokoro natural-voice replies need a one-time model download.',
    detail:
      'The model file (~' + modelSizeMb + ' MB) will be saved in your AppData folder. ' +
      'It is downloaded from Hugging Face and stays on your machine — nothing is sent to a server when speaking. ' +
      'Select "Not now" to keep using Windows voice.'
  });
  const granted = response === 0;
  writeConsent(granted);
  return granted;
}

// ── SHA-256 verification ───────────────────────────────────────────────────

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyFile(filePath, expectedHash) {
  const actual = await sha256File(filePath);
  if (actual !== expectedHash) {
    throw new Error(
      `SHA-256 mismatch for ${path.basename(filePath)}.\n` +
      `  expected: ${expectedHash}\n` +
      `  actual:   ${actual}\n` +
      'The file may be corrupted. Delete it and try again.'
    );
  }
}

// ── File download ──────────────────────────────────────────────────────────

function downloadFile(url, destPath, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(destPath);
    fs.mkdirSync(dir, { recursive: true });
    const partPath = `${destPath}.part`;

    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) {
        try { fs.rmSync(partPath, { force: true }); } catch { /**/ }
        reject(err);
      } else {
        resolve();
      }
    };

    const abort = () => done(Object.assign(new Error('Cancelled.'), { cancelled: true }));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });

    // Use Node's built-in fetch (available in Node 18+ / Electron 28+).
    fetch(url, { signal }).then(async (res) => {
      if (!res.ok) {
        done(new Error(`Download failed: HTTP ${res.status} for ${path.basename(destPath)}`));
        return;
      }
      const total = Number(res.headers.get('content-length')) || 0;
      let received = 0;
      const out = fs.createWriteStream(partPath);
      const reader = res.body.getReader();
      const pump = async () => {
        for (;;) {
          if (signal?.aborted) { reader.cancel(); done(Object.assign(new Error('Cancelled.'), { cancelled: true })); return; }
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
          received += value.byteLength;
          out.write(Buffer.from(value));
          onProgress?.({ received, total });
        }
        out.end();
        out.once('finish', () => {
          try {
            fs.renameSync(partPath, destPath);
            done(null);
          } catch (err) {
            done(err);
          }
        });
        out.once('error', done);
      };
      pump().catch(done);
    }).catch(done);
  });
}

// ── Model readiness check ──────────────────────────────────────────────────

function isModelReady(variant = 'quantized') {
  try {
    const spec = MODEL_VARIANTS[variant] || MODEL_VARIANTS.quantized;
    const file = path.join(modelDir(), spec.filename);
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size === spec.sizeBytes;
  } catch {
    return false;
  }
}

function isVoiceReady(voiceId) {
  try {
    return fs.statSync(voicePath(voiceId)).isFile();
  } catch {
    return false;
  }
}

// ── Ensure model + voice are present ──────────────────────────────────────

async function ensureModelFile(variant = 'quantized', signal, log) {
  const spec = MODEL_VARIANTS[variant] || MODEL_VARIANTS.quantized;
  const dest = path.join(modelDir(), spec.filename);

  if (isModelReady(variant)) {
    // Verify hash in background — log a warning if it fails but don't block.
    verifyFile(dest, spec.sha256).catch((err) => {
      log?.warn('kokoro', `Model hash check failed: ${err.message}`);
    });
    return dest;
  }

  log?.info('kokoro', `Downloading ${spec.filename} (${Math.round(spec.sizeBytes / 1_048_576)} MB)…`);
  await downloadFile(spec.url, dest, signal, ({ received, total }) => {
    if (total > 0) {
      const pct = Math.round((received / total) * 100);
      if (pct % 10 === 0) log?.info('kokoro', `Download ${pct}% (${Math.round(received / 1_048_576)} MB)`);
    }
  });

  log?.info('kokoro', `Verifying ${spec.filename}…`);
  await verifyFile(dest, spec.sha256);
  log?.info('kokoro', `${spec.filename} verified OK.`);
  return dest;
}

async function ensureVoiceFile(voiceId, signal, log) {
  const dest = voicePath(voiceId);
  if (isVoiceReady(voiceId)) return dest;

  log?.info('kokoro', `Downloading ${VOICES_FILE.filename} (${Math.round(VOICES_FILE.sizeBytes / 1_048_576)} MB)…`);
  await downloadFile(VOICES_FILE.url, dest, signal, ({ received, total }) => {
    if (total > 0) {
      const pct = Math.round((received / total) * 100);
      if (pct % 10 === 0) log?.info('kokoro', `Voice download ${pct}% (${Math.round(received / 1_048_576)} MB)`);
    }
  });

  log?.info('kokoro', `Verifying ${VOICES_FILE.filename}…`);
  await verifyFile(dest, VOICES_FILE.sha256);
  log?.info('kokoro', `${VOICES_FILE.filename} verified OK.`);
  return dest;
}

// ── Process lifecycle ──────────────────────────────────────────────────────

let kokoroProcess = null;
let kokoroStarting = null;
let kokoroError = '';
let kokoroGeneration = 0;
let kokoroStopping = false;

function whisperServerDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'whisper-server');
  return path.join(app.getAppPath(), 'whisper-server');
}

function runtimePythonCandidates() {
  return process.platform === 'win32'
    ? ['python.exe', 'python311.exe']
    : ['python3'];
}

function runtimePythonExe() {
  const dir = path.join(whisperServerDir(), 'runtime-kokoro', 'python');
  for (const name of runtimePythonCandidates()) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, runtimePythonCandidates()[0]);
}

function embeddedPythonExe() {
  if (process.env.VOXA_PYTHON) return process.env.VOXA_PYTHON;
  if (!app.isPackaged) {
    // In dev mode we use the venv python
    const venvPython = path.join(whisperServerDir(), '.venv', 'Scripts', 'python.exe');
    if (fs.existsSync(venvPython)) return venvPython;
    return process.platform === 'win32' ? 'python.exe' : 'python3';
  }
  // Packaged mode: the embeddable runtime ships python.exe (python311.exe is
  // also accepted for older builds). The matching _pth file is python311._pth.
  const exePath = runtimePythonExe();
  if (fs.existsSync(exePath)) return exePath;
  throw new Error(`Embedded Kokoro Python not found at ${exePath}.`);
}

async function kokoroHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${KOKORO_PORT}/health`, { signal: controller.signal });
    const data = await res.json();
    return { ok: Boolean(data.ok), status: String(data.status || 'unknown'), ...data };
  } catch {
    return { ok: false, status: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForKokoro(generation, log) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (kokoroStopping || generation !== kokoroGeneration) {
      throw Object.assign(new Error('Kokoro startup cancelled.'), { cancelled: true });
    }
    if (kokoroError) throw new Error(kokoroError);
    if (kokoroProcess?.exitCode !== null && kokoroProcess?.exitCode !== undefined) {
      throw new Error(kokoroError || 'Kokoro server exited during startup.');
    }
    const h = await kokoroHealth();
    if (h.ok || h.status === 'loading') return h;
    if (h.status === 'error') throw new Error(h.load_error || 'Kokoro model failed to load.');
    await new Promise((resolve) => setTimeout(resolve, START_POLL_INTERVAL_MS));
  }
  throw new Error('Kokoro TTS server did not become ready in time.');
}

async function startKokoro({ variant = 'quantized', voiceId = 'af_heart', provider = 'cpu', signal, log } = {}) {
  // If already running and healthy, return immediately.
  const existing = await kokoroHealth();
  if (existing.ok) return existing;
  if (kokoroStarting) return kokoroStarting;
  if (kokoroProcess && kokoroProcess.exitCode === null) {
    return waitForKokoro(kokoroGeneration, log);
  }

  const starting = (async () => {
    // Spoken replies must never trigger the one-time model/voice download on
    // their own; only an explicit dashboard download can grant consent.
    if ((!isModelReady(variant) || !isVoiceReady(voiceId)) && !hasConsent()) {
      throw Object.assign(
        new Error('Kokoro needs a one-time voice download. Open Voxa settings and download the voice model.'),
        { consentRequired: true }
      );
    }
    // Ensure model and voice files are on disk before starting the server.
    const mPath = await ensureModelFile(variant, signal, log);
    await ensureVoiceFile(voiceId, signal, log);
    const vFile = voicePath(voiceId);

    const python = embeddedPythonExe();
    const useBundled = app.isPackaged;

    let command, args;
    if (useBundled) {
      command = python;
      args = [path.join(process.resourcesPath, 'whisper-server', 'kokoro_server.py'), '--port', String(KOKORO_PORT), '--model-path', mPath, '--voices-file', vFile, '--provider', provider];
    } else {
      if (!fs.existsSync(python)) {
        throw new Error(
          `Python not found at ${python}. ` +
          'Set up the whisper-server virtual environment first (see README).'
        );
      }
      const script = path.join(whisperServerDir(), 'kokoro_server.py');
      if (!fs.existsSync(script)) {
        throw new Error('kokoro_server.py is missing from the whisper-server directory.');
      }
      command = python;
      args = [script, '--port', String(KOKORO_PORT), '--model-path', mPath, '--voices-file', vFile, '--provider', provider];
    }

    kokoroError = '';
    kokoroStopping = false;
    const generation = ++kokoroGeneration;
    log?.info('kokoro', `Starting Kokoro TTS server (bundled=${useBundled}) on port ${KOKORO_PORT}`);

    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
    });
    kokoroProcess = child;

    const captureLog = (stream) => {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) log?.info('kokoro server', line.trim().slice(0, 1000));
        }
      });
    };
    captureLog(child.stdout);
    captureLog(child.stderr);

    const intentional = () => kokoroStopping || generation !== kokoroGeneration;
    child.on('error', (err) => {
      if (kokoroProcess === child) kokoroProcess = null;
      if (!intentional()) {
        kokoroError = err.message;
        log?.error('kokoro server', err.message);
      }
    });
    child.on('close', (code) => {
      if (kokoroProcess === child) {
        kokoroProcess = null;
        kokoroStarting = null;
      }
      if (intentional()) {
        log?.info('kokoro server', 'Kokoro TTS server stopped.');
        return;
      }
      if (code !== 0) {
        kokoroError = `Kokoro server exited with code ${code}.`;
        log?.warn('kokoro server', kokoroError);
      }
    });

    return waitForKokoro(generation, log);
  })();

  kokoroStarting = starting;
  try {
    return await starting;
  } catch (err) {
    if (!err.cancelled) kokoroError = err.message;
    throw err;
  } finally {
    if (kokoroStarting === starting) kokoroStarting = null;
  }
}

function stopKokoro() {
  kokoroStopping = true;
  kokoroGeneration += 1;
  kokoroError = '';
  const child = kokoroProcess;
  if (child) {
    if (process.platform === 'win32' && child.pid) {
      const { spawn: spawnSync } = require('node:child_process');
      const killer = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore'
      });
      killer.on('error', () => { try { child.kill(); } catch { /**/ } });
    } else {
      try { child.kill(); } catch { /**/ }
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  kokoroProcess = null;
  kokoroStarting = null;
}

function kokoroStatus() {
  return {
    running: Boolean(kokoroProcess && kokoroProcess.exitCode === null),
    error: kokoroError,
    port: KOKORO_PORT
  };
}

// ── TTS synthesis via HTTP ─────────────────────────────────────────────────

async function synthesize(text, voice, speed, signal) {
  const body = JSON.stringify({ input: text, voice: voice || 'af_heart', speed: speed || 1.0 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.TTS_SYNTHESIZE_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); throw Object.assign(new Error('Cancelled.'), { cancelled: true }); }
    signal.addEventListener('abort', forwardAbort, { once: true });
  }
  try {
    const res = await fetch(`http://127.0.0.1:${KOKORO_PORT}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let msg = detail.slice(0, 400) || `HTTP ${res.status}`;
      try { msg = JSON.parse(detail)?.detail || msg; } catch { /**/ }
      throw new Error(`Kokoro synthesis failed: ${msg}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (signal?.aborted || controller.signal.aborted) {
      throw Object.assign(new Error('Cancelled.'), { cancelled: true });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

module.exports = {
  kokoroDir,
  modelDir,
  voicesDir,
  modelPath,
  voicePath,
  MODEL_VARIANTS,
  KOKORO_PORT,
  hasConsent,
  requestConsent,
  isModelReady,
  isVoiceReady,
  ensureModelFile,
  ensureVoiceFile,
  kokoroHealth,
  startKokoro,
  stopKokoro,
  kokoroStatus,
  synthesize
};
