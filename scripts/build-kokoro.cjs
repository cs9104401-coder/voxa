'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const serverDir = path.join(root, 'whisper-server');
const defaultPython = process.platform === 'win32'
  ? path.join(serverDir, '.venv', 'Scripts', 'python.exe')
  : path.join(serverDir, '.venv', 'bin', 'python');
const python = process.env.VOXA_PYTHON || defaultPython;
const outputDir = path.join(serverDir, 'dist');
const workDir = path.join(serverDir, 'build', 'kokoro');
const specDir = path.join(serverDir, 'build', 'spec');
const executable = path.join(outputDir, process.platform === 'win32' ? 'voxa-kokoro.exe' : 'voxa-kokoro');

function fail(message) {
  console.error(`\n[build:kokoro] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', ...options.env }
  });
  if (result.error) fail(`${path.basename(command)} could not start: ${result.error.message}`);
  return result.status;
}

if (!fs.existsSync(python)) fail('Python environment missing.');
if (run(python, ['-c', 'import soundfile, uvicorn, fastapi, pydantic, kokoro_onnx']) !== 0) fail('Dependencies missing.');

fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(specDir, { recursive: true });
fs.rmSync(executable, { force: true });

const icon = path.join(root, 'assets', 'icon.ico');
const args = [
  '-m', 'PyInstaller',
  '--noconfirm', '--clean', '--onefile', '--noupx',
  '--name', 'voxa-kokoro',
  `--distpath=${outputDir}`,
  `--workpath=${workDir}`,
  `--specpath=${specDir}`,
  '--collect-all=soundfile',
  '--collect-all=kokoro_onnx',
  '--collect-all=onnxruntime',
  '--collect-all=tokenizers',
  '--collect-all=huggingface_hub',
  '--hidden-import=soundfile._soundfile_data',
  '--hidden-import=uvicorn.logging',
  '--hidden-import=uvicorn.loops.auto',
  '--hidden-import=uvicorn.loops.asyncio',
  '--hidden-import=uvicorn.protocols.http.auto',
  '--hidden-import=uvicorn.protocols.http.h11_impl',
  '--hidden-import=uvicorn.protocols.websockets.auto',
  '--hidden-import=uvicorn.protocols.websockets.websockets_impl',
  '--hidden-import=uvicorn.lifespan.on',
  '--exclude-module=tkinter',
  '--hidden-import=kokoro_onnx.phonemizer'
];
if (fs.existsSync(icon)) args.push(`--icon=${icon}`);
args.push(path.join('whisper-server', 'kokoro_server.py'));

console.log(`[build:kokoro] Building...`);
if (run(python, args) !== 0) fail('PyInstaller failed.');

const stat = fs.statSync(executable, { throwIfNoEntry: false });
if (!stat) fail('Executable not created.');
console.log(`[build:kokoro] Created ${executable} (${(stat.size / 1024 / 1024).toFixed(1)} MB).`);
