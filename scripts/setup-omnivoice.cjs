'use strict';

// One-time OmniVoice runtime installer.
//
// Everything lives under %APPDATA%\my-voice-app\omnivoice (or VOXA_USER_DATA)
// so it matches the Electron app's userData folder:
//
//   venv\               isolated Python 3.11/3.12 environment
//   model\              k2-fsa/OmniVoice snapshot
//   setup.json          versions and paths written after a successful install
//
// The script is deliberately independent of npm and Electron so it can also be
// launched by the packaged app with ELECTRON_RUN_AS_NODE=1.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const userData = process.env.VOXA_USER_DATA || path.join(appData, 'my-voice-app');
const TORCH_VERSION = '2.8.0';
const CUDA_INDEX = 'https://download.pytorch.org/whl/cu128';
const CPU_INDEX = 'https://download.pytorch.org/whl/cpu';
const ASR_MODEL = 'openai/whisper-large-v3-turbo';

function usage() {
  console.log(`Usage: npm run setup:omnivoice -- [options]

Create the isolated OmniVoice runtime and download the model.

Options:
  --dir <dir>       Runtime folder (default: ${path.join(userData, 'omnivoice')})
  --python <exe>    Python 3.10-3.12 launcher to base the venv on
  --cpu             Install the CPU build of PyTorch even when NVIDIA is present
  --cuda            Force the CUDA build (fails instead of silently using CPU)
  --skip-model      Install Python packages but do not download the model
  --force           Replace a broken runtime created by this script
  -h, --help        Show this help`);
}

function parseArgs(argv) {
  const options = {
    dir: path.join(userData, 'omnivoice'),
    python: process.env.VOXA_OMNIVOICE_PYTHON || '',
    cpu: false,
    cuda: false,
    skipModel: false,
    force: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const separator = arg.indexOf('=');
    const name = separator >= 0 ? arg.slice(0, separator) : arg;
    const inline = separator >= 0 ? arg.slice(separator + 1) : null;
    const value = () => {
      if (inline !== null) {
        if (!inline) throw new Error(`${name} needs a value.`);
        return inline;
      }
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${name} needs a value.`);
      index += 1;
      return next;
    };
    if (name === '--dir') options.dir = path.resolve(value());
    else if (name === '--python') options.python = path.resolve(value());
    else if (name === '--cpu') options.cpu = true;
    else if (name === '--cuda') options.cuda = true;
    else if (name === '--skip-model') options.skipModel = true;
    else if (name === '--force') options.force = true;
    else if (name === '--help' || name === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.cpu && options.cuda) throw new Error('--cpu and --cuda cannot be used together.');
  return options;
}

function log(message) {
  console.log(`[setup:omnivoice] ${message}`);
}

function warn(message) {
  console.warn(`[setup:omnivoice] ${message}`);
}

function removeTree(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(target);
    return;
  }
  if (!stat.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    const child = fs.lstatSync(full);
    if (child.isSymbolicLink()) fs.unlinkSync(full);
    else if (child.isDirectory()) removeTree(full);
    else fs.unlinkSync(full);
  }
  fs.rmdirSync(target);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    log(`> ${command} ${args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')}`);
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1', ...options.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    const forward = (stream, target) => {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n|\r/);
        pending = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          target.write(`${line}\n`);
          if (target === process.stderr) stderr += `${line}\n`;
          if (stderr.length > 12000) stderr = stderr.slice(-12000);
        }
      });
      stream.on('end', () => {
        if (pending.trim()) {
          target.write(`${pending}\n`);
          if (target === process.stderr) stderr += `${pending}\n`;
        }
      });
    };
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with code ${code}.${stderr ? `\n${stderr.trim().slice(-4000)}` : ''}`));
    });
  });
}

function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 15000,
    env: { ...process.env, PYTHONUNBUFFERED: '1' }
  }).trim();
}

function versionParts(text) {
  const match = String(text).match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function supportedPython(version) {
  if (!version) return false;
  const [major, minor] = version;
  return major === 3 && minor >= 10 && minor <= 12;
}

function discoverPython(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`Python launcher not found: ${explicit}`);
    const version = versionParts(capture(explicit, ['-c', 'import sys; print(sys.version)']));
    if (!supportedPython(version)) throw new Error(`Python ${version?.join('.') || 'unknown'} is not supported; use 3.10-3.12.`);
    return { command: explicit, prefix: [], version };
  }
  const candidates = [];
  if (process.platform === 'win32') {
    for (const minor of [11, 12, 10]) candidates.push({ command: 'py', prefix: [`-3.${minor}`] });
  }
  candidates.push({ command: 'python', prefix: [] });
  candidates.push({ command: 'python3', prefix: [] });
  const failures = [];
  for (const candidate of candidates) {
    try {
      const version = versionParts(capture(candidate.command, [...candidate.prefix, '-c', 'import sys; print(sys.version)']));
      if (supportedPython(version)) return { ...candidate, version };
      failures.push(`${candidate.command} ${candidate.prefix.join(' ')} (${version?.join('.') || 'unknown'})`);
    } catch (error) {
      failures.push(`${candidate.command} ${candidate.prefix.join(' ')} (${error.code || error.message})`);
    }
  }
  throw new Error(`Python 3.10-3.12 was not found. Install Python 3.11 from python.org, then pass --python "C:\\path\\to\\python.exe".\nTried: ${failures.join(', ')}`);
}

function venvPython(runtime) {
  return process.platform === 'win32'
    ? path.join(runtime, 'venv', 'Scripts', 'python.exe')
    : path.join(runtime, 'venv', 'bin', 'python3');
}

function markerPath(runtime) {
  return path.join(runtime, 'setup.json');
}

function readMarker(runtime) {
  try {
    return JSON.parse(fs.readFileSync(markerPath(runtime), 'utf8'));
  } catch {
    return null;
  }
}

function modelReady(modelDir) {
  try {
    if (!fs.existsSync(path.join(modelDir, 'config.json'))) return false;
    const files = fs.readdirSync(modelDir);
    return files.some((name) => /^model(?:-\d+-of-\d+)?\.safetensors$/i.test(name))
      || files.includes('model.safetensors.index.json');
  } catch {
    return false;
  }
}

function detectGpu() {
  try {
    const output = capture('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], { timeout: 5000 });
    if (!output) return null;
    return output.split(/\r?\n/).filter(Boolean).map((line) => {
      const [name, memory, driver] = line.split(',').map((part) => part.trim());
      return { name, memoryMb: Number(memory) || 0, driver };
    });
  } catch {
    return null;
  }
}

function torchState(python) {
  try {
    const output = capture(python, ['-c', [
      'import torch',
      'print(torch.__version__)',
      'print(torch.version.cuda or "")',
      'print("1" if torch.cuda.is_available() else "0")',
      'print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else "")'
    ].join('; ')], { timeout: 30000 });
    const [version, cudaVersion, available, device] = output.split(/\r?\n/);
    return { version, cudaVersion, cudaAvailable: available === '1', device };
  } catch {
    return null;
  }
}

function torchMatches(state, wantCuda) {
  if (!state || !String(state.version).startsWith(TORCH_VERSION)) return false;
  return wantCuda ? Boolean(state.cudaAvailable) : true;
}

async function installTorch(python, wantCuda) {
  const args = [
    '-m', 'pip', 'install', '--upgrade', '--force-reinstall',
    `torch==${TORCH_VERSION}${wantCuda ? '+cu128' : ''}`,
    `torchaudio==${TORCH_VERSION}${wantCuda ? '+cu128' : ''}`,
    '--index-url', wantCuda ? CUDA_INDEX : CPU_INDEX
  ];
  await run(python, args);
}

async function installPackages(python) {
  await run(python, [
    '-m', 'pip', 'install', '--upgrade',
    'omnivoice', 'soundfile', 'fastapi', 'uvicorn'
  ]);
}

async function downloadModel(python, modelDir) {
  fs.mkdirSync(modelDir, { recursive: true });
  log(`Downloading k2-fsa/OmniVoice to ${modelDir}`);
  const script = [
    'import os',
    'from huggingface_hub import snapshot_download',
    `model_dir = ${JSON.stringify(modelDir)}`,
    'snapshot_download(',
    '    repo_id="k2-fsa/OmniVoice",',
    '    local_dir=model_dir,',
    '    max_workers=4,',
    '    token=os.environ.get("HF_TOKEN") or None,',
    ')',
    'tokenizer_status = "present" if os.path.isdir(os.path.join(model_dir, "audio_tokenizer")) else "missing"',
    'print("OMNIVOICE_MODEL_DONE tokenizer=" + tokenizer_status)'
  ].join('\n');
  await run(python, ['-c', script]);
}

async function downloadTokenizerIfMissing(python, modelDir) {
  const tokenizerDir = path.join(modelDir, 'audio_tokenizer');
  if (fs.existsSync(path.join(tokenizerDir, 'config.json'))) return;
  log('Downloading the Higgs audio tokenizer into model\\audio_tokenizer…');
  const script = [
    'import os',
    'from huggingface_hub import snapshot_download',
    `tokenizer_dir = ${JSON.stringify(tokenizerDir)}`,
    'snapshot_download(',
    '    repo_id="eustlb/higgs-audio-v2-tokenizer",',
    '    local_dir=tokenizer_dir,',
    '    max_workers=4,',
    '    token=os.environ.get("HF_TOKEN") or None,',
    ')',
    'print("OMNIVOICE_TOKENIZER_DONE")'
  ].join('\n');
  await run(python, ['-c', script]);
}

async function downloadAsrModel(python) {
  // Voice cloning without a transcript uses this Whisper checkpoint. Fetch it
  // during setup so the first clone does not unexpectedly download 1.6 GB.
  log(`Preparing the reference-transcription model (${ASR_MODEL})…`);
  const script = [
    'import os',
    'from huggingface_hub import snapshot_download',
    `snapshot_download(`,
    `    repo_id=${JSON.stringify(ASR_MODEL)},`,
    '    max_workers=4,',
    '    token=os.environ.get("HF_TOKEN") or None,',
    ')',
    'print("OMNIVOICE_ASR_DONE")'
  ].join('\n');
  await run(python, ['-c', script]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const runtime = path.resolve(options.dir);
  if (!path.isAbsolute(runtime)) throw new Error('The runtime path must be absolute.');
  log(`Runtime: ${runtime}`);
  const modelDir = path.join(runtime, 'model');
  const marker = readMarker(runtime);
  const existingEntries = fs.existsSync(runtime) ? fs.readdirSync(runtime) : [];
  if (existingEntries.length && !marker && !options.force) {
    throw new Error(`Refusing to reuse ${runtime}; it was not created by this script. Pass --force to replace it.`);
  }

  fs.mkdirSync(runtime, { recursive: true });
  // Mark the folder as ours before the long install. If setup is interrupted,
  // the next run can resume instead of refusing to touch the partial runtime.
  if (!marker) {
    fs.writeFileSync(markerPath(runtime), `${JSON.stringify({
      kind: 'voxa-omnivoice-runtime',
      status: 'installing',
      createdAt: new Date().toISOString(),
      runtime
    }, null, 2)}\n`, 'utf8');
  }

  const gpu = detectGpu();
  const wantCuda = !options.cpu && (options.cuda || Boolean(gpu));
  if (wantCuda && !gpu) {
    if (options.cuda) throw new Error('--cuda was requested, but nvidia-smi did not report an NVIDIA GPU.');
    warn('nvidia-smi was not found; installing the CPU build.');
  }
  if (gpu?.length) {
    for (const card of gpu) log(`GPU: ${card.name} · ${Math.round(card.memoryMb / 1024)} GB · driver ${card.driver}`);
  } else {
    log('GPU: none detected (OmniVoice will use CPU and be much slower).');
  }

  const base = discoverPython(options.python);
  log(`Base Python: ${base.version.join('.')} (${base.command} ${base.prefix.join(' ')})`.trim());

  const python = venvPython(runtime);
  if (options.force && fs.existsSync(path.join(runtime, 'venv'))) {
    log('Removing the existing virtual environment…');
    removeTree(path.join(runtime, 'venv'));
  }
  if (!fs.existsSync(python)) {
    log('Creating the isolated virtual environment…');
    await run(base.command, [...base.prefix, '-m', 'venv', path.join(runtime, 'venv')]);
  }
  if (!fs.existsSync(python)) throw new Error(`The virtual environment has no Python at ${python}.`);
  await run(python, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel']);

  let state = torchState(python);
  let useCuda = wantCuda;
  if (torchMatches(state, useCuda)) {
    log(`PyTorch ${state.version} already matches (${useCuda ? 'CUDA' : 'CPU'}).`);
  } else {
    log(`Installing PyTorch ${TORCH_VERSION} (${useCuda ? 'CUDA 12.8' : 'CPU'})…`);
    try {
      await installTorch(python, useCuda);
    } catch (error) {
      if (!useCuda) throw error;
      warn(`CUDA PyTorch installation failed; falling back to CPU.\n${error.message}`);
      useCuda = false;
      await installTorch(python, false);
    }
    state = torchState(python);
    if (!torchMatches(state, useCuda)) {
      throw new Error(`PyTorch installation did not produce the expected build (${state?.version || 'missing'}).`);
    }
  }

  log('Installing OmniVoice and the sidecar dependencies…');
  await installPackages(python);
  state = torchState(python);
  log(`PyTorch ${state?.version || 'unknown'}${state?.cudaAvailable ? ` · CUDA ${state.cudaVersion} · ${state.device}` : ' · CPU'}`);

  log('Checking imports…');
  await run(python, ['-c', [
    'import sys, torch, torchaudio, soundfile, fastapi, uvicorn, omnivoice',
    'print("python", sys.version.split()[0])',
    'print("torch", torch.__version__, "cuda", torch.cuda.is_available())',
    'print("torchaudio", torchaudio.__version__)',
    'print("omnivoice", getattr(omnivoice, "__version__", "unknown"))',
    'print("fastapi", fastapi.__version__, "uvicorn", uvicorn.__version__)'
  ].join('\n')]);

  if (!options.skipModel) {
    if (modelReady(modelDir)) {
      log('The OmniVoice model is already downloaded.');
    } else {
      await downloadModel(python, modelDir);
    }
    await downloadTokenizerIfMissing(python, modelDir);
    await downloadAsrModel(python);
  }

  const markerData = {
    kind: 'voxa-omnivoice-runtime',
    status: 'ready',
    createdAt: new Date().toISOString(),
    runtime,
    modelDir,
    venvPython: python,
    basePython: base.command,
    pythonVersion: base.version.join('.'),
    torchVersion: state?.version || '',
    cuda: Boolean(useCuda && state?.cudaAvailable),
    gpu: gpu || [],
    modelReady: modelReady(modelDir),
    asrModel: ASR_MODEL
  };
  fs.writeFileSync(markerPath(runtime), `${JSON.stringify(markerData, null, 2)}\n`, 'utf8');
  log(`Setup complete. ${markerData.modelReady ? 'Model ready.' : 'Model download was skipped.'}`);
  if (!markerData.cuda) warn('No CUDA runtime is active; expect slow CPU synthesis.');
}

main().catch((error) => {
  console.error(`[setup:omnivoice] ${error.message}`);
  process.exitCode = 1;
});
