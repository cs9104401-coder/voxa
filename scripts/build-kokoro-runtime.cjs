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
  '3.11.9': 'f5ed70a4904e49f12b81aa0b7c8d5a81dc0f9e8e6e8f2e2d5e44b0c36f8c7c6a',
};
const MATCHING_KEY = Object.keys(PATCH_VERSIONS).find(
  (ver) => path.basename(path.dirname(require('child_process').execSync(null, []) || '').trim() === ver
);
const PYTHON_VERSION = MATCHING_KEY || '3.11.9';
const expectedChecksum = PATCH_VERSIONS[PYTHON_VERSION];

async function build() {
  console.log('[build:kokoro-runtime] Starting build...');

  // Verify Python version match
  const venvPython = require('child_process').spawnSync(
    pythonDir.replace(/.*Scripts$/, '.') && process.platform === 'win32' ? path.join(pythonDir, 'python.exe') : null
  );

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

  // Enable site-packages in ._pth
  const pthFile = path.join(pythonDir, 'python3' + PYTHON_VERSION.split('.')[2].replace(/\./g, '') + '._pth');
  if (!fs.existsSync(pthFile)) {
    const possibleFiles = [
      path.join(pythonDir, 'python311._pth'),
      path.join(pythonDir, 'python3.11._pth'),
    ];
    let selected = possibleFiles.find((p) => fs.existsSync(p));
    if (!selected) throw new Error(`Could not find ._pth file for Python ${PYTHON_VERSION}.`);
    selected = selected;
  }
  let pthContent = fs.readFileSync(path.join(pythonDir, 'python311._pth'), 'utf8');
  if (!pthContent.includes('import site')) {
    pthContent += '\nimport site\n';
    fs.writeFileSync(path.join(pythonDir, 'python311._pth'), pthContent, 'utf8');
  }

  // Copy needed packages from venv
  fs.mkdirSync(sitePackages, { recursive: true });
  const venvSite = path.join(serverDir, '.venv', 'Lib', 'site-packages');

  console.log('[build:kokoro-runtime] Copying packages from venv...');
  const pkgsToCopy = [
    ' kokoro_onnx ', ' kokoro-onnx ', ' soundfile ', ' numpy ', ' fastapi ',
    ' uvicorn ', ' pydantic ', ' pydantic_core ', ' anyio ', ' sniffio ',
    ' starlette ', ' h11 ', ' click ', ' idna ', ' typing_extensions ',
    ' annotated_types ', ' phonemizer ', ' espeakng_loader ', ' onnxruntime '
  ];

  for (const pkg of pkgsToCopy) {
    const src = path.join(venvSite, pkg.trim());
    const dest = path.join(sitePackages, pkg.trim());
    if (!fs.existsSync(src)) {
      console.warn(`[build:kokoro-runtime] WARN: Package not found: ${pkg.trim()}`);
      continue;
    }

    if (fs.statSync(src).isDirectory()) {
      spawnSync('powershell', ['-Command', `Copy-Item -Path '${src}' -Destination '${dest}' -Recurse -Force`], { stdio: 'inherit' });
    } else {
      try {
        fs.copyFileSync(src, dest);
      } catch (err) {
        console.warn(`[build:kokoro-runtime] WARN: Could not copy ${pkg.trim()}: ${err.message}`);
      }
    }
  }

  // __init__.py placeholder needed for package imports?
  for (const pkg of pkgsToCopy) {
    const subPath = path.join(sitePackages, pkg.trim(), '__init__.py');
    if (!fs.existsSync(subPath)) {
      // Create empty package marker
      fs.writeFileSync(subPath, '', 'utf8');
    }
  }

  // Copy kokoro_server.py
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(path.join(serverDir, 'kokoro_server.py'), path.join(runtimeDir, 'kokoro_server.py'));

  console.log('[build:kokoro-runtime] Done. Created whisper-server/runtime-kokoro');
}

build().catch(err => {
  console.error('[build:kokoro-runtime] FAILED:', err);
  process.exit(1);
});
