'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { shell } = require('electron');

const MAX_APPS = 300;
const START_APP_TIMEOUT_MS = 12000;
const SKIP_NAME = /(uninstall|readme|release notes|help|manual|website|support)/i;
const WINDOWS_DIR = process.env.WINDIR || 'C:\\Windows';
const LOCAL_APPDATA = process.env.LOCALAPPDATA || '';
const SPOTIFY_PATH = process.env.APPDATA && path.join(process.env.APPDATA, 'Spotify', 'Spotify.exe');

const KNOWN_APPS = [
  ['Google Chrome', process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')],
  ['Google Chrome', process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')],
  ['Microsoft Edge', process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
  ['Microsoft Edge', process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
  ['Mozilla Firefox', process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Mozilla Firefox', 'firefox.exe')],
  ['Visual Studio Code', process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe')],
  ['Notepad', path.join(WINDOWS_DIR, 'notepad.exe')],
  ['Notepad', path.join(WINDOWS_DIR, 'System32', 'notepad.exe')],
  ['Notepad', LOCAL_APPDATA && path.join(LOCAL_APPDATA, 'Microsoft', 'WindowsApps', 'notepad.exe')],
  ['Calculator', path.join(WINDOWS_DIR, 'System32', 'calc.exe')],
  ['Paint', path.join(WINDOWS_DIR, 'System32', 'mspaint.exe')],
  ['Command Prompt', path.join(WINDOWS_DIR, 'System32', 'cmd.exe')],
  ['Windows PowerShell', path.join(WINDOWS_DIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
  ['File Explorer', path.join(WINDOWS_DIR, 'explorer.exe')],
  ['Task Manager', path.join(WINDOWS_DIR, 'System32', 'taskmgr.exe')],
  ['Snipping Tool', LOCAL_APPDATA && path.join(LOCAL_APPDATA, 'Microsoft', 'WindowsApps', 'SnippingTool.exe')],
  ['Control Panel', path.join(WINDOWS_DIR, 'System32', 'control.exe')],
  ['WordPad', path.join(WINDOWS_DIR, 'System32', 'write.exe')]
];

const ALIAS_TARGETS = {
  notepad: ['Notepad', 'notepad.exe'],
  calculator: ['Calculator', 'calc.exe'],
  calc: ['Calculator', 'calc.exe'],
  paint: ['Paint', 'mspaint.exe'],
  mspaint: ['Paint', 'mspaint.exe'],
  'command prompt': ['Command Prompt', 'cmd.exe'],
  cmd: ['Command Prompt', 'cmd.exe'],
  powershell: ['Windows PowerShell', 'powershell.exe'],
  'file explorer': ['File Explorer', 'explorer.exe'],
  explorer: ['File Explorer', 'explorer.exe'],
  'task manager': ['Task Manager', 'taskmgr.exe'],
  taskmgr: ['Task Manager', 'taskmgr.exe'],
  'snipping tool': ['Snipping Tool', 'SnippingTool.exe'],
  settings: ['Settings', 'ms-settings:'],
  'control panel': ['Control Panel', 'control.exe'],
  wordpad: ['WordPad', 'write.exe'],
  edge: ['Microsoft Edge', 'msedge.exe'],
  chrome: ['Google Chrome', 'chrome.exe'],
  firefox: ['Mozilla Firefox', 'firefox.exe'],
  spotify: ['Spotify', SPOTIFY_PATH && fs.existsSync(SPOTIFY_PATH) ? SPOTIFY_PATH : 'spotify:'],
  discord: ['Discord', 'discord:'],
  'vs code': ['Visual Studio Code', 'code'],
  code: ['Visual Studio Code', 'code'],
  word: ['Microsoft Word', 'winword.exe'],
  excel: ['Microsoft Excel', 'excel.exe'],
  powerpoint: ['Microsoft PowerPoint', 'powerpnt.exe']
};

const APP_ALIASES = new Map(Object.entries(ALIAS_TARGETS).map(([alias, [name, launch]]) => [
  alias,
  { name, launch, alias: true }
]));

let cachedApps = null;

function fileExists(file) {
  try {
    fs.accessSync(file, fs.constants.F_OK);
    return true;
  } catch {
    try {
      // App Execution Aliases under WindowsApps are symlinks whose target ACLs
      // make stat() fail with EACCES, even though Windows can launch them.
      return fs.lstatSync(file).isSymbolicLink();
    } catch {
      return false;
    }
  }
}

function addApp(map, name, launch) {
  const cleanName = String(name || '').replace(/\.(lnk|url)$/i, '').trim();
  if (!cleanName || SKIP_NAME.test(cleanName) || !launch) return;
  const key = cleanName.toLowerCase();
  if (!map.has(key)) map.set(key, { name: cleanName, launch });
}

function walkShortcuts(directory, depth, map) {
  if (depth < 0 || map.size >= MAX_APPS) return;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (map.size >= MAX_APPS) return;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkShortcuts(full, depth - 1, map);
    } else if (/\.(lnk|url)$/i.test(entry.name)) {
      addApp(map, entry.name, full);
    }
  }
}

function discoverApps() {
  if (cachedApps) return cachedApps;
  const map = new Map();
  for (const [name, launch] of KNOWN_APPS) {
    try {
      if (launch && fileExists(launch)) addApp(map, name, launch);
    } catch {
      // Ignore inaccessible optional install locations.
    }
  }
  const startMenus = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    process.env.PROGRAMDATA && path.join(process.env.PROGRAMDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  ].filter(Boolean);
  for (const directory of startMenus) walkShortcuts(directory, 3, map);
  cachedApps = Array.from(map.values()).sort((left, right) => left.name.localeCompare(right.name));
  return cachedApps;
}

function refreshApps(log) {
  cachedApps = null;
  const apps = discoverApps();
  log?.info('apps refreshed', `${apps.length} apps found`);
  return apps;
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeAppQuery(value) {
  return normalize(value)
    .replace(/^(?:open|launch|start)\s+/, '')
    .replace(/\b(?:the|app)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findApp(query, apps = discoverApps()) {
  const wanted = normalizeAppQuery(query);
  if (!wanted) return null;
  const normalized = apps.map((item) => {
    const name = normalize(item.name);
    return { item, name, compact: name.replace(/\s+/g, '') };
  });
  const exact = normalized.find(({ name }) => name === wanted);
  if (exact) return exact.item;
  const compact = wanted.replace(/\s+/g, '');
  const compactMatch = normalized.find(({ compact: candidate }) => candidate === compact);
  if (compactMatch) return compactMatch.item;
  const starts = normalized.filter(({ name }) => name.split(' ').slice(0, 2).join(' ').startsWith(wanted) || name.startsWith(wanted));
  if (starts.length) return starts.sort((a, b) => a.name.length - b.name.length)[0].item;
  const alias = APP_ALIASES.get(wanted);
  if (alias) return alias;
  // Token-overlap is the weakest match, so it runs after the alias map. This
  // keeps "cmd" on Command Prompt instead of matching "Git CMD".
  const words = new Set(wanted.split(' '));
  const scored = normalized
    .map(({ item, name }) => {
      const nameWords = new Set(name.split(' '));
      const overlap = [...words].filter((word) => nameWords.has(word)).length;
      return { item, name, overlap };
    })
    .filter(({ overlap }) => overlap === words.size)
    .sort((a, b) => a.name.length - b.name.length);
  return scored.length ? scored[0].item : null;
}

function editDistance(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (!a) return b.length;
  if (!b) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

function closeMatches(query, apps = discoverApps(), limit = 5) {
  const wanted = normalizeAppQuery(query);
  const names = new Map();
  for (const item of apps) names.set(normalize(item.name), item.name);
  for (const item of APP_ALIASES.values()) names.set(normalize(item.name), item.name);
  return [...names.entries()]
    .filter(([key, name]) => key && name)
    .map(([key, name]) => ({
      name,
      score: editDistance(wanted, key) + (key.includes(wanted) || wanted.includes(key) ? 0 : 1)
    }))
    .sort((left, right) => left.score - right.score || left.name.length - right.name.length)
    .slice(0, limit)
    .map((entry) => entry.name);
}

function powershellPath() {
  return path.join(WINDOWS_DIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(script, timeout = START_APP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath(), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The process may already be gone.
      }
      finish(reject, new Error('The app launcher timed out.'));
    }, timeout);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (code === 0) {
        finish(resolve, stdout.trim());
      } else {
        finish(reject, new Error((stderr || stdout).trim() || `The app launcher exited with code ${code}.`));
      }
    });
  });
}

async function startProcess(target) {
  const value = String(target || '').trim();
  if (!value) throw new Error('No app target was provided.');
  await runPowerShell(`$ErrorActionPreference = 'Stop'\nStart-Process ${quotePowerShell(value)}`);
}

async function findStartAppId(name) {
  const output = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$name = ${quotePowerShell(name)}
$apps = @(Get-StartApps)
$hit = $apps | Where-Object { $_.Name -ieq $name } | Select-Object -First 1
if (-not $hit) {
  $needle = $name.ToLowerInvariant()
  $hit = $apps | Where-Object { $_.Name.ToLowerInvariant().Contains($needle) } | Select-Object -First 1
}
if ($hit) { $hit.AppID }
`);
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || '';
}

async function openApp(app) {
  if (!app?.launch) throw new Error('That app does not have a launch target.');
  if (app.alias) {
    await startProcess(app.launch);
    return;
  }
  if (/\\Microsoft\\WindowsApps\\/i.test(app.launch)) {
    // Store App Execution Aliases are symlinks; ShellExecute can reject them
    // even though Start-Process resolves them through the app model.
    await startProcess(app.launch);
    return;
  }
  const result = await shell.openPath(app.launch);
  if (result) throw new Error(result);
}

async function openAppByName(query) {
  const text = String(query || '').trim();
  if (!text) throw new Error('No app name was provided.');
  if (text.length > 200) throw new Error('The app name is too long.');
  const entry = findApp(text);
  if (entry) {
    try {
      await openApp(entry);
      return entry;
    } catch {
      // Fall through to the explicit launcher paths.
    }
    try {
      await startProcess(entry.launch);
      return entry;
    } catch {
      // Fall through to the app name and Start apps lookup.
    }
    try {
      await startProcess(entry.name);
      return entry;
    } catch {
      // Fall through to the Start apps lookup.
    }
  } else {
    const launchName = normalizeAppQuery(text) || text;
    try {
      await startProcess(launchName);
      return { name: launchName, launch: launchName };
    } catch {
      // Fall through to the Start apps lookup.
    }
  }
  let appId = '';
  try {
    appId = await findStartAppId(entry?.name || normalizeAppQuery(text) || text);
  } catch {
    // The Start apps lookup is a best-effort fallback.
  }
  if (appId) {
    const launch = `shell:AppsFolder\\${appId}`;
    try {
      await startProcess(launch);
      return { name: entry?.name || normalizeAppQuery(text) || text, launch };
    } catch {
      // Fall through to the clear error below.
    }
  }
  const matches = closeMatches(text);
  if (entry) {
    throw new Error(`I found ${entry.name}, but Windows could not start it. Close matches: ${matches.join(', ')}.`);
  }
  throw new Error(`I could not find an app matching "${text}". Close matches: ${matches.join(', ')}.`);
}

function appNames(limit = 50) {
  return discoverApps().slice(0, limit).map((item) => item.name);
}

module.exports = {
  discoverApps,
  refreshApps,
  findApp,
  closeMatches,
  openApp,
  openAppByName,
  appNames
};
