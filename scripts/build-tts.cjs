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
const workDir = path.join(serverDir, 'build');
const whisperExe = path.join(outputDir, process.platform === 'win32' ? 'voxa-whisper.exe' : 'voxa-whisper');
const kokoroExe = path.join(outputDir, process.platform === 'win32' ? 'voxa-kokoro.exe' : 'voxa-kokoro');

function fail(message) {
  console.error(`\n[build:tts] ${message}`);
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

if (!fs.existsSync(python)) {
  fail([
    'The Whisper Python environment is missing.',
    `Expected: ${python}`,
    'Create it first:',
    '  py -3 -m venv whisper-server\\.venv',
    '  .\\whisper-server\\.venv\\Scripts\\python.exe -m pip install -r whisper-server\\requirements.txt',
    '  .\\whisper-server\\.venv\\Scripts\\python.exe -m pip install -r whisper-server\\requirements-build.txt'
  ].join('\n'));
}

// Check for all required dependencies
const depChecks = [
  ['faster_whisper, uvicorn, fastapi, multipart, huggingface_hub', 'import faster_whisper, uvicorn, fastapi, multipart, huggingface_hub'],
  ['soundfile, kokoro-onnx', 'import soundfile, kokoro_onnx']
];

for (const [label, check] of depChecks) {
  if (run(python, ['-c', check]) !== 0) {
    fail([
      `The TTS service dependencies (${label}) are missing from the virtual environment.`,
      `Run: "${python}" -m pip install -r whisper-server\\requirements.txt`,
      `Run: "${python}" -m pip install -r whisper-server\\requirements-build.txt`
    ].join('\n'));
  }
}

if (run(python, ['-c', 'import PyInstaller']) !== 0) {
  console.log('[build:tts] PyInstaller is not installed; installing the pinned build dependency.');
  if (run(python, ['-m', 'pip', 'install', '-r', path.join('whisper-server', 'requirements-build.txt')]) !== 0) {
    fail('PyInstaller could not be installed. Install it with: python -m pip install -r whisper-server\\requirements-build.txt');
  }
}

fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(path.join(workDir, 'pyinstaller'), { recursive: true });
fs.mkdirSync(path.join(workDir, 'spec'), { recursive: true });

function buildExecutable(name, scriptPath, additionalArgs = []) {
  const executable = path.join(outputDir, process.platform === 'win32' ? `${name}.exe` : name);
  fs.rmSync(executable, { force: true });

  const icon = path.join(root, 'assets', 'icon.ico');
  const baseArgs = [
    '-m', 'PyInstaller',
    '--noconfirm',
    '--clean',
    '--onefile',
    '--noupx',
    '--name', name,
    `--distpath=${outputDir}`,
    `--workpath=${path.join(workDir, 'pyinstaller')}`,
    `--specpath=${path.join(workDir, 'spec')}`,
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
    '--exclude-module=tkinter'
  ];

  if (fs.existsSync(icon)) baseArgs.push(`--icon=${icon}`);

  const args = [...baseArgs, ...additionalArgs, scriptPath];

  console.log(`[build:tts] Building ${path.relative(root, executable)} with ${python}`);
  if (run(python, args) !== 0) fail(`PyInstaller failed for ${name}. Review the output above.`);

  const stat = fs.statSync(executable, { throwIfNoEntry: false });
  if (!stat) fail(`PyInstaller did not create ${executable}.`);
  console.log(`[build:tts] Created ${path.relative(root, executable)} (${(stat.size / 1024 / 1024).toFixed(1)} MB).`);

  return executable;
}

console.log('[build:tts] Building Whisper server...');
buildExecutable('voxa-whisper', path.join('whisper-server', 'server.py'), [
  '--hidden-import=soundfile'  // Include soundfile for audio handling
]);

console.log('[build:tts] Building Kokoro TTS server...');
buildExecutable('voxa-kokoro', path.join('whisper-server', 'kokoro_server.py'), [
  '--collect-all=soundfile',
  '--hidden-import=soundfile._soundfile_data',  // soundfile data files
  '--collect-all=kokoro_onnx'
]);

console.log('[build:tts] Both TTS servers built successfully.');
console.log(`  Whisper:  ${whisperExe}`);
console.log(`  Kokoro:   ${kokoroExe}`);