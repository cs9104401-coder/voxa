'use strict';

// Tests for the optional ASR integration. The default run needs no model
// artifacts: it checks the pure JavaScript health normalization and then runs
// the Python unit tests with mocks. Passing --integration starts the real
// localhost service and lists its model cache. Add --transcribe <file> to load
// and transcribe with a real cached model (for example whisper-tiny).
//
//   npm run test:asr
//   npm run test:asr -- --integration
//   $env:VOXA_ASR_PYTHON = "whisper-server\.venv\Scripts\python.exe"
//   node scripts/asr-test.cjs --integration --transcribe sample.wav --model whisper-tiny

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const { ASR_ENGINES } = require(path.join(root, 'lib', 'constants.cjs'));
const {
  normalizeAsrModels,
  normalizeProgress,
  summarizeAsr
} = require(path.join(root, 'lib', 'asr-health.cjs'));
const { createAsrService } = require(path.join(root, 'lib', 'asr-service.cjs'));

const results = [];

async function test(name, callback) {
  try {
    await callback();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL  ${name}`);
    console.log(`      ${String(error && error.message || error).split('\n').join('\n      ')}`);
  }
}

function testAsrHealth() {
  return (async () => {
    await test('catalog ids are unique and the bundled default is Whisper', () => {
      const ids = ASR_ENGINES.map((engine) => engine.id);
      assert.equal(new Set(ids).size, ids.length);
      assert.equal(ids[0], 'whisper');
      for (const engine of ASR_ENGINES) {
        assert.ok(engine.label);
        assert.ok(engine.backend);
      }
    });

    await test('Whisper stays on the bundled path and never starts the optional service', () => {
      const summary = summarizeAsr({ engineId: 'whisper', running: false });
      assert.equal(summary.mode, 'bundled');
      assert.equal(summary.status, 'bundled');
      assert.equal(summary.ok, true);
      assert.equal(summary.serviceRunning, false);
      assert.match(summary.message, /bundled Whisper/);
      assert.equal(summary.progress, null);
    });

    await test('an optional engine that was never started reports stopped without invented state', () => {
      const summary = summarizeAsr({ engineId: 'parakeet-tdt-0.6b-v3', running: false });
      assert.equal(summary.mode, 'optional');
      assert.equal(summary.status, 'stopped');
      assert.equal(summary.ok, false);
      assert.equal(summary.serviceRunning, false);
      assert.equal(summary.activeModel, '');
      assert.equal(summary.downloaded, null);
      assert.equal(summary.available, null);
      assert.equal(summary.approxSizeBytes, 2508311120);
      assert.equal(summary.canLoad, true);
      assert.equal(summary.canCancel, false);
      assert.equal('words' in summary, false);
      assert.equal('segments' in summary, false);
    });

    await test('transcription never starts a stopped service', async () => {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxa-asr-no-start-'));
      const service = createAsrService({
        port: 59999,
        appRoot: root,
        userDataDir,
        cacheDir: path.join(userDataDir, 'asr-models'),
        whisperCacheDir: path.join(userDataDir, 'whisper-models')
      });
      try {
        await assert.rejects(
          () => service.transcribe(Buffer.from('not audio'), 'audio/wav', { model: 'parakeet-tdt-0.6b-v3' }),
          /not running|Load a model/i
        );
        assert.equal(service.isRunning(), false);
      } finally {
        service.stop();
        fs.rmSync(userDataDir, { recursive: true, force: true });
      }
    });

    await test('download progress is clamped and mirrored from real service fields', () => {
      const summary = summarizeAsr({
        engineId: 'parakeet-tdt-0.6b-v3',
        running: true,
        status: {
          status: 'downloading',
          target_model: 'parakeet-tdt-0.6b-v3',
          download_active: true,
          downloaded: false,
          available: true,
          progress: {
            status: 'downloading',
            downloaded_bytes: 1_000_000,
            total_bytes: 2_500_000,
            percent: 41.6,
            speed_bps: 2048,
            current_file: 'model.safetensors'
          }
        }
      });
      assert.equal(summary.status, 'downloading');
      assert.equal(summary.busy, true);
      assert.equal(summary.progress.percent, 42);
      assert.equal(summary.progress.downloadedBytes, 1_000_000);
      assert.equal(summary.progress.speedBps, 2048);
      assert.equal(summary.canCancel, true);
      assert.match(summary.message, /41|42/);
    });

    await test('a finished standalone download returns to idle with the model available', () => {
      const summary = summarizeAsr({
        engineId: 'parakeet-tdt-0.6b-v3',
        running: true,
        models: [{
          id: 'parakeet-tdt-0.6b-v3',
          approxSizeBytes: 2508311120,
          downloaded: true
        }],
        status: {
          status: 'idle',
          target_model: 'parakeet-tdt-0.6b-v3',
          selected_model: 'parakeet-tdt-0.6b-v3',
          active_model: null,
          downloaded: true,
          available: true,
          download_active: false,
          progress: {
            model: 'parakeet-tdt-0.6b-v3',
            status: 'complete',
            downloaded_bytes: 2_508_311_120,
            total_bytes: 2_508_311_120,
            percent: 100
          }
        }
      });
      assert.equal(summary.status, 'idle');
      assert.equal(summary.busy, false);
      assert.equal(summary.ready, false);
      assert.equal(summary.downloaded, true);
      assert.equal(summary.canLoad, true);
      assert.equal(summary.canDownload, false);
      assert.equal(summary.canCancel, false);
      assert.equal(summary.progress.percent, 100);
      assert.match(summary.message, /not loaded/);
    });

    await test('a canceled standalone download stays canceled until retried', () => {
      const summary = summarizeAsr({
        engineId: 'parakeet-tdt-0.6b-v3',
        running: true,
        models: [{
          id: 'parakeet-tdt-0.6b-v3',
          downloaded: false
        }],
        status: {
          status: 'canceled',
          target_model: 'parakeet-tdt-0.6b-v3',
          selected_model: 'parakeet-tdt-0.6b-v3',
          active_model: null,
          downloaded: false,
          available: true,
          download_active: false,
          error: 'The model download was canceled.',
          progress: {
            model: 'parakeet-tdt-0.6b-v3',
            status: 'canceled',
            downloaded_bytes: 5,
            total_bytes: 10,
            percent: 50,
            error: 'The model download was canceled.'
          }
        }
      });
      assert.equal(summary.status, 'canceled');
      assert.equal(summary.busy, false);
      assert.equal(summary.downloaded, false);
      assert.equal(summary.canDownload, true);
      assert.equal(summary.canLoad, true);
      assert.match(summary.message, /canceled/);
    });

    await test('stalled downloads are described without inventing a percentage', () => {
      const summary = summarizeAsr({
        engineId: 'granite-speech-5.0-470m-turboctc',
        running: true,
        status: {
          status: 'downloading',
          target_model: 'granite-speech-5.0-470m-turboctc',
          download_active: true,
          progress: { status: 'downloading', stalled: true, downloaded_bytes: 10, total_bytes: 0 }
        }
      });
      assert.equal(summary.status, 'downloading');
      assert.equal(summary.progress.percent, null);
      assert.match(summary.message, /has not made progress/);
    });

    await test('ready state reports the active model and native capabilities only', () => {
      const summary = summarizeAsr({
        engineId: 'parakeet-tdt-0.6b-v3',
        running: true,
        models: [{
          id: 'parakeet-tdt-0.6b-v3',
          approxSizeBytes: 2508311120,
          downloaded: true
        }],
        status: {
          status: 'ready',
          active_model: 'parakeet-tdt-0.6b-v3',
          target_model: 'parakeet-tdt-0.6b-v3',
          selected_model: 'parakeet-tdt-0.6b-v3',
          available: true,
          downloaded: true,
          backend: 'transformers-tdt',
          device: 'cpu',
          compute_type: 'int8',
          chunked: true,
          chunk_seconds: 30,
          capabilities: { token_timestamps: true, word_timestamps: false, long_form: false },
          warnings: ['Using the CPU']
        }
      });
      assert.equal(summary.status, 'ready');
      assert.equal(summary.ok, true);
      assert.equal(summary.activeModel, 'parakeet-tdt-0.6b-v3');
      assert.equal(summary.downloaded, true);
      assert.equal(summary.device, 'cpu');
      assert.equal(summary.computeType, 'int8');
      assert.equal(summary.capabilities.token_timestamps, true);
      assert.equal(summary.capabilities.word_timestamps, false);
      assert.deepEqual(summary.warnings, ['Using the CPU']);
      assert.equal('words' in summary, false);
      assert.equal('tokens' in summary, false);
      assert.match(summary.message, /ready/);
    });

    await test('a loaded model that does not match the selection is a mismatch', () => {
      const summary = summarizeAsr({
        engineId: 'parakeet-tdt-0.6b-v3',
        running: true,
        status: {
          status: 'ready',
          active_model: 'granite-speech-5.0-470m-turboctc',
          target_model: 'granite-speech-5.0-470m-turboctc'
        }
      });
      assert.equal(summary.status, 'mismatch');
      assert.equal(summary.ok, false);
      assert.match(summary.message, /granite-speech-5\.0-470m-turboctc/);
    });

    await test('missing backend dependencies surface the service error', () => {
      const summary = summarizeAsr({
        engineId: 'qwen3-asr-1.7b',
        running: true,
        status: {
          status: 'error',
          target_model: 'qwen3-asr-1.7b',
          available: false,
          missing: ['qwen-asr'],
          availability_reason: 'qwen-asr is not installed',
          error: 'Install whisper-server/requirements-asr-qwen.txt in an isolated environment.'
        }
      });
      assert.equal(summary.status, 'error');
      assert.equal(summary.available, false);
      assert.deepEqual(summary.missing, ['qwen-asr']);
      assert.match(summary.message, /requirements-asr-qwen/);
    });

    await test('unavailable metadata without an error is still described', () => {
      const summary = summarizeAsr({
        engineId: 'granite-speech-5.0-470m-turboctc',
        running: true,
        status: {
          status: 'idle',
          available: false,
          availability_reason: 'transformers is too old',
          outdated: ['transformers']
        }
      });
      assert.equal(summary.status, 'idle');
      assert.equal(summary.available, false);
      assert.match(summary.message, /unavailable in this Python environment/);
      assert.match(summary.message, /transformers is too old/);
    });

    await test('cancellation keeps the service error but not a fake ready state', () => {
      const summary = summarizeAsr({
        engineId: 'granite-speech-5.0-470m-turboctc',
        running: true,
        status: {
          status: 'canceled',
          target_model: 'granite-speech-5.0-470m-turboctc',
          error: 'The ASR model load was canceled.'
        }
      });
      assert.equal(summary.status, 'canceled');
      assert.match(summary.message, /canceled/);
    });

    await test('a dead service cannot leave a stale ready card', () => {
      const summary = summarizeAsr({
        engineId: 'parakeet-tdt-0.6b-v3',
        running: false,
        serviceError: 'connect ECONNREFUSED 127.0.0.1:8756',
        status: {
          status: 'ready',
          active_model: 'parakeet-tdt-0.6b-v3',
          available: true
        }
      });
      assert.equal(summary.status, 'error');
      assert.equal(summary.ok, false);
      assert.match(summary.message, /ECONNREFUSED/);
    });

    await test('explicit CUDA requests report an unavailable wheel reason', () => {
      const summary = summarizeAsr({
        engineId: 'parakeet-tdt-0.6b-v3',
        running: true,
        status: {
          status: 'idle',
          requested_device: 'cuda',
          device: 'cuda',
          cuda: {
            cuda_available: false,
            reason: 'The installed PyTorch build has no kernels for sm_120.'
          }
        }
      });
      assert.equal(summary.cudaAvailable, false);
      assert.match(summary.cudaReason, /sm_120/);
      assert.match(summary.message, /CUDA is unavailable/);
    });

    await test('Qwen long-form metadata is preserved without fabricated timestamps', () => {
      const summary = summarizeAsr({
        engineId: 'qwen3-asr-1.7b',
        running: true,
        status: {
          status: 'ready',
          active_model: 'qwen3-asr-1.7b',
          available: true,
          backend: 'qwen-asr',
          chunked: false,
          capabilities: { long_form: true, language_detection: true, word_timestamps: false }
        }
      });
      assert.equal(summary.status, 'ready');
      assert.equal(summary.chunked, false);
      assert.equal(summary.chunkSeconds, null);
      assert.equal(summary.capabilities.long_form, true);
      assert.equal(summary.capabilities.language_detection, true);
      assert.equal(summary.capabilities.word_timestamps, false);
    });

    await test('progress normalization clamps bad numbers and preserves unknowns', () => {
      assert.equal(normalizeProgress(null), null);
      const high = normalizeProgress({ percent: 250, downloaded_bytes: -5, total_bytes: '10', speed_bps: -2 });
      assert.equal(high.percent, 100);
      assert.equal(high.downloadedBytes, 0);
      assert.equal(high.totalBytes, 10);
      assert.equal(high.speedBps, 0);
      const unknown = normalizeProgress({ downloaded_bytes: 0 });
      assert.equal(unknown.percent, null);
      assert.equal(unknown.totalBytes, 0);
    });

    await test('model list normalization keeps real availability and drops empty ids', () => {
      const models = normalizeAsrModels({
        models: [
          {
            id: 'parakeet-tdt-0.6b-v3',
            label: 'Parakeet',
            backend: 'transformers-tdt',
            approx_size_bytes: 123,
            downloaded: true,
            available: true,
            active: true,
            missing: [],
            outdated: [],
            languages: ['en', 'de'],
            capabilities: { token_timestamps: true, word_timestamps: false },
            long_form: false
          },
          { id: '', label: 'empty' }
        ]
      }, 'parakeet-tdt-0.6b-v3');
      assert.equal(models.length, 1);
      assert.equal(models[0].downloaded, true);
      assert.equal(models[0].selected, true);
      assert.equal(models[0].capabilities.token_timestamps, true);
      assert.deepEqual(models[0].languages, ['en', 'de']);
    });
  })();
}

function findPython() {
  const explicit = String(process.env.VOXA_ASR_PYTHON || '').trim();
  const candidates = [
    explicit,
    path.join(root, 'whisper-server', '.venv-asr', 'Scripts', 'python.exe'),
    path.join(root, 'whisper-server', '.venv-asr', 'bin', 'python'),
    path.join(root, 'whisper-server', '.venv', 'Scripts', 'python.exe'),
    path.join(root, 'whisper-server', '.venv', 'bin', 'python')
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === 'python' || candidate === 'py') return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'python';
}

async function testPython() {
  const python = findPython();
  const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'asr/tests', '-t', '.', '-q'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000
  });
  const detail = `${result.stdout || ''}${result.stderr || ''}`.trim().split('\n').slice(-20).join('\n');
  await test(`Python ASR unit tests (${path.basename(python)})`, () => {
    assert.equal(result.error, undefined, result.error && result.error.message);
    assert.equal(result.status, 0, detail);
    assert.match(detail, /Ran \d+ tests/);
  });
  if (result.status === 0) console.log(`      ${detail.split('\n').filter(Boolean).slice(-2).join(' ')}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await service.peekStatus();
    if (last?.status === 'ready') return last;
    if (last?.status === 'error') throw new Error(last.error || 'The model failed to load.');
    if (last?.status === 'canceled') throw new Error(last.error || 'The model load was canceled.');
    await sleep(700);
  }
  throw new Error(`The model was still ${last?.status || 'unknown'} after ${Math.round(timeoutMs / 1000)} seconds.`);
}

async function testIntegration(options) {
  const python = findPython();
  const explicit = String(process.env.VOXA_ASR_PYTHON || '').trim();
  const cacheDir = path.resolve(
    process.env.ASR_MODEL_CACHE
      || path.join(process.env.APPDATA || os.homedir(), 'my-voice-app', 'asr-models')
  );
  const whisperCacheDir = path.resolve(
    process.env.VOXA_WHISPER_CACHE
      || path.join(process.env.APPDATA || os.homedir(), 'my-voice-app', 'whisper-models')
  );
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxa-asr-test-'));
  const port = await freePort();
  const logs = [];
  const service = createAsrService({
    port,
    appRoot: root,
    userDataDir,
    cacheDir,
    whisperCacheDir,
    log: {
      info: (scope, message) => logs.push(`${scope}: ${message}`),
      warn: (scope, message) => logs.push(`${scope} WARN: ${message}`)
    }
  });
  const model = options.model || 'parakeet-tdt-0.6b-v3';
  const device = options.device || 'cpu';
  try {
    await test(`real service starts with ${path.basename(python)} on port ${port}`, async () => {
      // Two dashboard actions can race during startup: Check status starts the
      // process, then Load arrives before /health answers. Both callers must
      // join the same launch rather than fail on a child that is not ready yet.
      const launch = { model, device, computeType: 'auto', chunkSeconds: 30 };
      const [models, status] = await Promise.all([
        service.models(launch),
        service.status(launch)
      ]);
      assert.equal(models.ok, true);
      assert.equal(status.status, 'idle');
      assert.equal(service.isRunning(), true);
      const health = await service.health();
      assert.equal(health.service, 'asr');
    });

    await test('real service lists registry models and live status', async () => {
      const payload = await service.models();
      assert.equal(payload.ok, true);
      const ids = payload.models.map((item) => item.id);
      for (const id of ['parakeet-tdt-0.6b-v3', 'qwen3-asr-1.7b', 'granite-speech-5.0-470m-turboctc', 'whisper-large-v3-turbo']) {
        assert.ok(ids.includes(id), `missing ${id}`);
      }
      assert.equal(payload.status.status, 'idle');
      assert.equal(path.basename(String(payload.status.cache_dir || '').replace(/[\\/]+$/, '')), path.basename(cacheDir));
    });

    if (options.transcribe) {
      await test(`real transcription with ${model}`, async () => {
        const file = path.resolve(options.transcribe);
        assert.ok(fs.existsSync(file), `missing audio file: ${file}`);
        await service.load({ model, device, computeType: 'auto', chunkSeconds: 30 }, {
          model,
          device,
          compute_type: 'auto'
        });
        const status = await waitForReady(service, Number(options.timeout || 20 * 60) * 1000);
        assert.equal(status.active_model, model);
        const audio = fs.readFileSync(file);
        const result = await service.transcribe(audio, 'audio/wav', {
          model,
          vad: false,
          wordTimestamps: false,
          timeout: 10 * 60 * 1000
        });
        assert.equal(typeof result.text, 'string');
        assert.ok(result.text.trim().length > 0, 'the model returned no text');
        assert.ok(result.duration_seconds > 0);
        console.log(`      ${JSON.stringify({
          model: result.model,
          backend: result.backend,
          language: result.language,
          device: result.device,
          text: result.text.slice(0, 160),
          warnings: result.warnings
        })}`);
      });
    }
  } finally {
    service.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    if (process.env.VOXA_ASR_TEST_LOGS === '1') console.log(logs.join('\n'));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const option = (name, fallback = '') => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  await testAsrHealth();
  if (!argv.includes('--no-python')) await testPython();
  if (argv.includes('--integration')) {
    await testIntegration({
      model: option('--model'),
      device: option('--device'),
      transcribe: option('--transcribe'),
      timeout: option('--timeout')
    });
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} ASR checks passed.`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
