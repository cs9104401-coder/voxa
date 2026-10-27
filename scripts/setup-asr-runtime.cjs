'use strict';

// Build the per-user runtime used by the packaged app from an existing ASR
// virtual environment. The packaged app looks for
// %APPDATA%\my-voice-app\asr-runtime\python\python.exe, so this script creates a
// small venv-shaped launcher there: a base-Python executable, a pyvenv.cfg, and
// a copy of the source environment's site-packages. The base Python install is
// still used for the standard library and its system site-packages (including
// torch when the source environment was created with --system-site-packages).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

function usage() {
  console.log(`Usage: npm run setup:asr-runtime -- [options]

Copy an existing ASR virtual environment into the runtime used by the installed
app. The app looks for %APPDATA%\\my-voice-app\\asr-runtime\\python\\python.exe.

Options:
  --source <dir>    Virtual environment to copy
                    (default: whisper-server\\.venv-asr)
  --target <dir>    Runtime directory
                    (default: %APPDATA%\\my-voice-app\\asr-runtime)
  --app-root <dir>  Folder containing the asr package for the import check
                    (default: this repository)
  --force           Replace a target that was not created by this script
  -h, --help        Show this help`);
}

function parseArgs(argv) {
  const options = {
    source: path.join(root, 'whisper-server', '.venv-asr'),
    target: path.join(appData, 'my-voice-app', 'asr-runtime'),
    appRoot: root,
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
    if (name === '--source') options.source = path.resolve(value());
    else if (name === '--target') options.target = path.resolve(value());
    else if (name === '--app-root') options.appRoot = path.resolve(value());
    else if (name === '--force') options.force = true;
    else if (name === '--help' || name === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Remove a directory tree without following junctions or symlinks. Node's
// rmSync can traverse a junction on Windows, which would delete the source
// environment instead of only removing the link.
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

function fail(message) {
  console.error(`[setup:asr-runtime] ${message}`);
  process.exitCode = 1;
}

function readSourceEnvironment(source) {
  const python = path.join(source, 'Scripts', 'python.exe');
  const sitePackages = path.join(source, 'Lib', 'site-packages');
  if (!fs.existsSync(python)) {
    throw new Error(`The source environment has no Scripts\\python.exe: ${source}`);
  }
  if (!fs.existsSync(sitePackages)) {
    throw new Error(`The source environment has no Lib\\site-packages: ${source}`);
  }
  if (!fs.existsSync(path.join(sitePackages, 'numpy'))) {
    throw new Error(`The source environment has no numpy. Install whisper-server\\requirements-asr-parakeet.txt first.`);
  }
  const base = execFileSync(python, ['-c', 'import sys; print(sys.base_prefix)'], { encoding: 'utf8' }).trim();
  const version = execFileSync(
    python,
    ['-c', 'import sys; print(".".join(str(part) for part in sys.version_info[:3]))'],
    { encoding: 'utf8' }
  ).trim();
  if (!base || !fs.existsSync(path.join(base, 'python.exe'))) {
    throw new Error(`Could not find the base Python installation for ${source}.`);
  }
  return { python, sitePackages, base, version };
}

function build(options) {
  const source = path.resolve(options.source);
  const target = path.resolve(options.target);
  const appRoot = path.resolve(options.appRoot);
  if (!fs.existsSync(appRoot)) throw new Error(`The app root does not exist: ${appRoot}`);
  if (!fs.existsSync(path.join(appRoot, 'asr', '__main__.py'))) {
    throw new Error(`The app root has no asr package: ${appRoot}`);
  }
  if (isInside(target, root) || isInside(root, target) || isInside(target, source) || isInside(source, target)) {
    throw new Error('Refusing to use a target that contains or is contained by the project or source environment.');
  }
  if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
    throw new Error(`The target is not a directory: ${target}`);
  }
  const marker = path.join(target, 'voxa-asr-runtime.json');
  const hasTarget = fs.existsSync(target);
  const targetEntries = hasTarget ? fs.readdirSync(target) : [];
  if (hasTarget && targetEntries.length > 0 && !fs.existsSync(marker) && !options.force) {
    throw new Error(`Refusing to replace ${target}; it was not created by this script. Pass --force to replace it.`);
  }

  const environment = readSourceEnvironment(source);
  const staging = `${target}.tmp-${process.pid}`;
  removeTree(staging);
  try {
    fs.mkdirSync(path.join(staging, 'python'), { recursive: true });
    fs.mkdirSync(path.join(staging, 'Lib'), { recursive: true });

    const baseFiles = fs.readdirSync(environment.base).filter((name) => (
      /^(?:python(?:w)?\.exe|python.*\.dll|vcruntime.*\.dll)$/i.test(name)
    ));
    if (!baseFiles.includes('python.exe')) throw new Error(`No python.exe in ${environment.base}.`);
    for (const name of baseFiles) {
      fs.copyFileSync(path.join(environment.base, name), path.join(staging, 'python', name));
    }

    console.log(`[setup:asr-runtime] Copying ${environment.sitePackages} ...`);
    fs.cpSync(environment.sitePackages, path.join(staging, 'Lib', 'site-packages'), {
      recursive: true,
      force: true,
      dereference: true
    });

    const cfg = [
      `home = ${environment.base}`,
      'include-system-site-packages = true',
      `version = ${environment.version}`,
      `executable = ${path.join(environment.base, 'python.exe')}`,
      `command = ${path.join(environment.base, 'python.exe')} -m venv ${target}`
    ];
    fs.writeFileSync(path.join(staging, 'python', 'pyvenv.cfg'), `${cfg.join('\r\n')}\r\n`, 'utf8');
    fs.writeFileSync(path.join(staging, 'voxa-asr-runtime.json'), `${JSON.stringify({
      kind: 'voxa-asr-runtime',
      createdAt: new Date().toISOString(),
      sourceVenv: source,
      basePython: environment.base,
      pythonVersion: environment.version
    }, null, 2)}\n`, 'utf8');

    console.log('[setup:asr-runtime] Verifying imports ...');
    const verify = spawnSync(
      path.join(staging, 'python', 'python.exe'),
      ['-c', [
        'import sys, numpy, torch, transformers, fastapi, uvicorn, asr',
        'print("python", sys.version.split()[0])',
        'print("numpy", numpy.__version__)',
        'print("torch", torch.__version__, "cuda", torch.cuda.is_available())',
        'print("transformers", transformers.__version__)',
        'print("asr", asr.__file__)'
      ].join('; ')],
      {
        cwd: appRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH: [appRoot, process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter)
        }
      }
    );
    if (verify.status !== 0) {
      throw new Error(`Runtime import check failed:\n${(verify.stdout || '') + (verify.stderr || '')}`.trim());
    }

    let backup = '';
    if (fs.existsSync(target)) {
      backup = `${target}.old-${Date.now()}`;
      fs.renameSync(target, backup);
    }
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      if (backup && !fs.existsSync(target)) fs.renameSync(backup, target);
      throw new Error(`Could not install the runtime at ${target}: ${error.message}`);
    }
    if (backup) {
      try {
        removeTree(backup);
      } catch (error) {
        console.warn(`[setup:asr-runtime] Installed the new runtime, but could not remove ${backup}: ${error.message}`);
      }
    }

    console.log(`[setup:asr-runtime] Installed ${target}`);
    console.log(verify.stdout.trim());
    console.log('[setup:asr-runtime] Restart Voxa or click Check status in Dictation to use it.');
  } catch (error) {
    removeTree(staging);
    throw error;
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) usage();
  else build(options);
} catch (error) {
  fail(error.message || error);
}
