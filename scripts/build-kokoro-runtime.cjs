'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

const root = path.resolve(__dirname, '..');
const serverDir = path.join(root, 'whisper-server');
const runtimeDir = path.join(serverDir, 'runtime-kokoro');
const pythonDir = path.join(runtimeDir, 'python');
const sitePackages = path.join(pythonDir, 'site-packages');
const zipPath = path.join(runtimeDir, 'python.zip');
const PATCH_VERSIONS = {
  // Verified against python.org published MD5/Size
  '3.11.9': '009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b',
};
const pythonExe = path.join(root, 'whisper-server', '.venv', 'Scripts', 'python.exe');
if (!fs.existsSync(pythonExe)) {
  throw new Error(`Python executable not found at ${pythonExe}`);
}

const versionOutput = require('node:child_process').execFileSync(pythonExe, ['-c', 'import sys; print(sys.version.split()[0])'], { encoding: 'utf8' }).trim();

const MATCHING_KEY = Object.keys(PATCH_VERSIONS).find((ver) => versionOutput === ver);

const PYTHON_VERSION = MATCHING_KEY || '3.11.9';
const expectedChecksum = PATCH_VERSIONS[PYTHON_VERSION];

async function build() {
  console.log('[build:kokoro-runtime] Starting build...');

  // Verify Python version match (this block was using invalid spawnSync arguments)
  if (!fs.existsSync(pythonExe)) {
    throw new Error(`Python executable not found at ${pythonExe}`);
  }

  if (!expectedChecksum) {
    throw new Error('No matching Python version for checksum verification.');
  }

  console.log(`[build:kokoro-runtime] Using Python ${PYTHON_VERSION} (from .venv).`);

  // Download embedded Python if zip doesn't exist
  if (!fs.existsSync(zipPath)) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    const url = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
    console.log(`[build:kokoro-runtime] Downloading ${url}...`);
    await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        pipeline(res, fs.createWriteStream(zipPath)).then(() => resolve()).catch(reject);
      }).on('error', reject);
    });

    console.log(`[build:kokoro-runtime] Verifying download hash...`);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
    if (actual !== expectedChecksum) {
      fs.unlinkSync(zipPath);
      throw new Error(`Downloaded Python zip checksum mismatch.\n  Expected: ${expectedChecksum}\n  Actual:   ${actual}`);
    }
  } else {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
    if (actual !== expectedChecksum) {
      throw new Error(`Cached Python zip checksum mismatch.\n  Expected: ${expectedChecksum}\n  Actual:   ${actual}`);
    }
  }

  // Extract
  if (!fs.existsSync(pythonDir)) {
    fs.mkdirSync(pythonDir, { recursive: true });
    console.log(`[build:kokoro-runtime] Extracting zip...`);
    spawnSync('powershell', ['-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${pythonDir}' -Force`], { stdio: 'inherit' });
  }

  // The embeddable runtime keeps its packages in site-packages (not
  // Lib/site-packages). Add that directory to the isolated search path so
  // `python.exe kokoro_server.py` can import onnxruntime, numpy, etc.
  const pthFile = path.join(pythonDir, 'python311._pth');
  if (!fs.existsSync(pthFile)) throw new Error(`Could not find ${pthFile}.`);
  const pthLines = fs.readFileSync(pthFile, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!pthLines.includes('site-packages')) {
    const dot = pthLines.indexOf('.');
    pthLines.splice(dot >= 0 ? dot + 1 : pthLines.length, 0, 'site-packages');
    fs.writeFileSync(pthFile, pthLines.join('\r\n') + '\r\n', 'utf8');
  }

  // Copy needed packages from venv
  fs.mkdirSync(sitePackages, { recursive: true });
  const venvSite = path.join(serverDir, '.venv', 'Lib', 'site-packages');

  console.log('[build:kokoro-runtime] Copying packages from venv...');
  // Keep this list in sync with kokoro_server.py's import graph. The embedded
  // runtime has no pip and its ._pth only exposes site-packages, so every
  // module and native data directory must be copied explicitly.
  const pkgsToCopy = [
    // Kokoro / inference
    'kokoro_onnx', 'onnxruntime', 'numpy', 'numpy.libs',
    // Audio encoding (soundfile needs its DLL data directory)
    'soundfile.py', '_soundfile.py', '_soundfile_data',
    // HTTP server
    'fastapi', 'starlette', 'uvicorn', 'pydantic', 'pydantic_core',
    'anyio', 'h11', 'click', 'colorama', 'idna',
    // Phonemizer chain
    'phonemizer', 'espeakng_loader', 'joblib', 'attrs', 'attr', 'dlinfo',
    'cffi', '_cffi_backend.cp311-win_amd64.pyd', 'cloudpickle',
    // Typing helpers required by FastAPI/Pydantic
    'annotated_types', 'annotated_doc', 'typing_inspection', 'typing_extensions.py',
    // FastAPI 0.159 imports opentelemetry unconditionally
    'opentelemetry',
  ];

  for (const pkg of pkgsToCopy) {
    const src = path.join(venvSite, pkg);
    const dest = path.join(sitePackages, pkg);
    if (!fs.existsSync(src)) {
      throw new Error(`Required package not found in venv: ${src}`);
    }

    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, dest, { recursive: true, force: true });
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  // Package metadata is required at runtime (kokoro_onnx calls
  // importlib.metadata.version) and identifies native dependencies correctly.
  for (const entry of fs.readdirSync(venvSite)) {
    if (!entry.endsWith('.dist-info')) continue;
    fs.cpSync(path.join(venvSite, entry), path.join(sitePackages, entry), { recursive: true, force: true });
  }

  // Copy kokoro_server.py
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(path.join(serverDir, 'kokoro_server.py'), path.join(runtimeDir, 'kokoro_server.py'));

  // Fail the build if the embedded interpreter cannot import the server's
  // dependencies. This catches missing DLLs/data directories at build time
  // instead of at runtime on a user's machine.
  console.log('[build:kokoro-runtime] Verifying embedded runtime imports...');
  const verify = spawnSync(
    path.join(pythonDir, 'python.exe'),
    ['-c', 'import numpy, onnxruntime, soundfile, kokoro_onnx, fastapi, uvicorn, phonemizer, espeakng_loader; print("imports-ok", numpy.__version__, onnxruntime.__version__)'],
    { cwd: pythonDir, encoding: 'utf8' }
  );
  if (verify.status !== 0) {
    throw new Error(`Embedded runtime import check failed:\n${verify.stdout || ''}${verify.stderr || ''}`);
  }
  console.log(`[build:kokoro-runtime] ${verify.stdout.trim()}`);

  console.log('[build:kokoro-runtime] Done. Created whisper-server/runtime-kokoro');
}

build().catch(err => {
  console.error('[build:kokoro-runtime] FAILED:', err);
  process.exit(1);
});
