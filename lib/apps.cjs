'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { shell } = require('electron');

const MAX_APPS = 300;
const SKIP_NAME = /(uninstall|readme|release notes|help|manual|website|support)/i;

const KNOWN_APPS = [
  ['Google Chrome', process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')],
  ['Google Chrome', process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')],
  ['Microsoft Edge', process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
  ['Mozilla Firefox', process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Mozilla Firefox', 'firefox.exe')],
  ['Visual Studio Code', process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe')],
  ['Notepad', path.join(process.env.WINDIR || 'C:\\Windows', 'notepad.exe')],
  ['File Explorer', path.join(process.env.WINDIR || 'C:\\Windows', 'explorer.exe')]
];

let cachedApps = null;

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
      if (launch && fs.existsSync(launch)) addApp(map, name, launch);
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

function findApp(query, apps = discoverApps()) {
  const wanted = normalize(query);
  if (!wanted) return null;
  const normalized = apps.map((item) => ({ item, name: normalize(item.name) }));
  const exact = normalized.filter(({ name }) => name === wanted);
  if (exact.length) return exact[0].item;
  const starts = normalized.filter(({ name }) => name.split(' ').slice(0, 2).join(' ').startsWith(wanted) || name.startsWith(wanted));
  if (starts.length) return starts.sort((a, b) => a.name.length - b.name.length)[0].item;
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

async function openApp(app) {
  const result = await shell.openPath(app.launch);
  if (result) throw new Error(result);
}

function appNames(limit = 50) {
  return discoverApps().slice(0, limit).map((item) => item.name);
}

module.exports = {
  discoverApps,
  refreshApps,
  findApp,
  openApp,
  appNames
};
