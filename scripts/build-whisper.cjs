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
const workDir = path.join(serverDir, 'build', 'whisper');
const specDir = path.join(serverDir, 'build', 'spec');
const executable = path.join(outputDir, process.platform === 'win32' ? 'voxa-whisper.exe' : 'voxa-whisper');

function fail(message) {
  console.error(`\n[build:whisper] ${message}`);
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
if (run(python, ['-c', 'import faster_whisper, uvicorn, fastapi, multipart, huggingface_hub']) !== 0) fail('Dependencies missing.');

fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(specDir, { recursive: true });
fs.rmSync(executable, { force: true });

const icon = path.join(root, 'assets', 'icon.ico');
const args = [
  '-m', 'PyInstaller',
  '--noconfirm', '--clean', '--onefile', '--noupx',
  '--name', 'voxa-whisper',
  `--distpath=${outputDir}`,
  `--workpath=${workDir}`,
  `--specpath=${specDir}`,
  '--collect-all=faster_whisper',
  '--collect-all=ctranslate2',
  '--collect-all=tokenizers',
  '--collect-all=huggingface_hub',
  '--collect-all=onnxruntime',
  '--collect-all=av',
  '--hidden-import=multipart',
  '--hidden-import=uvicorn.logging',
  '--hidden-import=uvicorn.loops.auto',
  '--hidden-import=uvicorn.loops.asyncio',
  '--hidden-import=uvicorn.protocols.http.auto',
  '--hidden-import=uvicorn.protocols.http.h11_impl',
  '--hidden-import=uvicorn.protocols.websockets.auto',
  '--hidden-import=uvicorn.protocols.websockets.websockets_impl',
  '--hidden-import=uvicorn.lifespan.on',
  '--hidden-import=soundfile',
  '--exclude-module=tkinter'
];
if (fs.existsSync(icon)) args.push(`--icon=${icon}`);
args.push(path.join('whisper-server', 'server.py'));

console.log(`[build:whisper] Building...`);
if (run(python, args) !== 0) fail('PyInstaller failed.');

const stat = fs.statSync(executable, { throwIfNoEntry: false });
if (!stat) fail('Executable not created.');
console.log(`[build:whisper] Created ${executable} (${(stat.size / 1024 / 1024).toFixed(1)} MB).`);
