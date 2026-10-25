'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, screen, session, shell
} = require('electron');

const logger = require('./lib/logger.cjs');
const { createApprovalGate } = require('./lib/approval.cjs');
const { runAgentLoop } = require('./lib/agent-loop.cjs');
const permissions = require('./lib/permissions.cjs');
const { parseToolArguments } = require('./lib/tool-schema.cjs');
const store = require('./lib/store.cjs');
const updater = require('./lib/updater.cjs');
const apps = require('./lib/apps.cjs');
const desktop = require('./lib/desktop.cjs');
const services = require('./lib/services.cjs');
const { createRecorderManager } = require('./lib/recorder.cjs');
const { createOverlay } = require('./lib/overlay.cjs');
const { createHotkeys, isValidHotkey } = require('./lib/hotkeys.cjs');
const {
  APP_NAME, APPROVABLE_TOOLS, LIMITS, MESSAGES, STT_CLOUD_PROVIDERS, TOOL_DEFINITIONS, TOOL_NAMES,
  WHISPER_MODELS, WHISPER_PRESETS, defaults
} = require('./lib/constants.cjs');

const START_HIDDEN = process.argv.includes('--hidden');
const GALLERY = process.argv.includes('--gallery') || process.argv.includes('--ui-gallery');
const SELF_TEST = process.argv.includes('--selftest-worker') || Boolean(process.env.VOXA_SELFTEST_OUTPUT);
const RECORDER_PARTITION = 'persist:voxa-recorder';
const WHISPER_PORT = 8000;

let userName = 'User';
try {
  userName = os.userInfo().username || userName;
} catch {
  // Keep the generic fallback if the OS account name is unavailable.
}

let settings;
let secrets = {};
let history = [];
let memory = [];
let dashboardWindow = null;
let recorderWindow = null;
let recorderReady = null;
let recorderQueue = Promise.resolve();
let pendingRecorderRequests = new Map();
let nextRecorderRequestId = 1;
let overlay = null;
let recorderManager = null;
let hotkeys = null;
let tray = null;
let lastHealth = {
  ollama: { ok: false, message: 'Not checked yet.' },
  chat: { ok: false, provider: 'local', message: 'Not checked yet.' },
  whisper: { ok: false, message: 'Not checked yet.' },
  kokoro: { status: 'unknown' }
};
let kokoroDownloadController = null;
let currentTurn = null;
let turnRunning = false;
let nextTurnId = 1;
let nextChatId = 1;
const chatSession = {
  open: false,
  requestId: 0,
  controller: null,
  messages: []
};
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const modelListCache = new Map();
const approvalGate = createApprovalGate({
  timeoutMs: LIMITS.APPROVAL_TIMEOUT_MS,
  onTimeout: () => {
    logger.warn('approval', 'The approval request timed out and was denied.');
    if (currentTurn) overlay?.setState({ status: 'thinking', message: 'Approval timed out. Nothing was run.', approval: null });
  }
});
let micTestRunning = false;
let ollamaPullRunning = false;
let whisperWatchTimer = null;
let whisperWatchToken = 0;
let tailTimer = null;
let audioTimer = null;
let hideTimer = null;
let hideDeadline = 0;
let hideRemaining = 0;
let hideDuration = 0;
let hidePaused = false;
let speechController = null;
let quitting = false;

const USER_DATA_DIR = process.env.VOXA_USER_DATA
  ? path.resolve(process.env.VOXA_USER_DATA)
  : path.join(app.getPath('appData'), 'my-voice-app');
app.setPath('userData', USER_DATA_DIR);
app.setPath('sessionData', USER_DATA_DIR);
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.voxa.assistant');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
ipcMain.on('brand:name', (event) => {
  event.returnValue = APP_NAME;
});

function cleanError(error) {
  return String(error?.message || error || 'The action failed.').split(/\r?\n/)[0].trim().slice(0, 500);
}

function providerNeedsKey(provider) {
  return provider !== 'local' && provider !== 'freellmapi';
}

function isCloudProvider(provider) {
  return Boolean(provider && provider !== 'none' && provider !== 'local' && provider !== 'freellmapi');
}

function clearModelCache(provider = '') {
  if (!provider) {
    modelListCache.clear();
    return;
  }
  for (const key of modelListCache.keys()) {
    if (key.startsWith(`${provider}|`)) modelListCache.delete(key);
  }
}

async function loadProviderModels(provider, config = {}, force = false) {
  if (typeof provider !== 'string' || !Object.hasOwn(settings.providers, provider)) throw new Error('Unknown provider.');
  const base = { ...settings.providers[provider] };
  const url = store.normalizeProviderUrl(provider, config?.url || base.url);
  if (!url) throw new Error(store.BASE_URL_ERROR);
  base.url = url;
  if (config?.model) base.model = String(config.model).trim().slice(0, 200);
  const typedKey = providerNeedsKey(provider) ? String(config?.apiKey || '').trim() : '';
  const key = typedKey || (providerNeedsKey(provider) ? secrets[provider] : '');
  if (providerNeedsKey(provider) && !key) throw new Error(`Add an API key for ${provider} first.`);
  const cacheKey = `${provider}|${url}`;
  const cached = modelListCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) return cached.models;
  const models = await services.listModels(provider, base, key);
  modelListCache.set(cacheKey, { at: Date.now(), models });
  return models;
}

function toBuffer(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  if (ArrayBuffer.isView(payload)) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (payload?.type === 'Buffer' && Array.isArray(payload.data)) return Buffer.from(payload.data);
  return Buffer.alloc(0);
}

function publicSettings() {
  return structuredClone(settings);
}

function sendToDashboard(channel, payload) {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) return false;
  try {
    dashboardWindow.webContents.send(channel, payload);
    return true;
  } catch (error) {
    logger.warn('dashboard', `Could not send ${channel}: ${cleanError(error)}`);
    return false;
  }
}

function broadcast(channel, payload) {
  sendToDashboard(channel, payload);
}

function sendToOverlay(channel, payload) {
  const window = overlay?.getWindow();
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
  try {
    window.webContents.send(channel, payload);
    return true;
  } catch (error) {
    logger.warn('overlay', `Could not send ${channel}: ${cleanError(error)}`);
    return false;
  }
}

function sendToDashboardWhenReady(channel, payload) {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) return false;
  const contents = dashboardWindow.webContents;
  if (!contents || contents.isDestroyed()) return false;
  if (contents.isLoadingMainFrame()) {
    contents.once('did-finish-load', () => sendToDashboard(channel, payload));
    return true;
  }
  return sendToDashboard(channel, payload);
}

function openExternalLink(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:') return false;
    shell.openExternal(parsed.href).catch((error) => logger.warn('link', cleanError(error)));
    return true;
  } catch {
    return false;
  }
}

function hotkeyStatus() {
  const status = hotkeys?.status?.() || { active: false, error: '' };
  return {
    mode: status.active ? 'uiohook' : 'unavailable',
    error: status.error || '',
    dictation: settings?.dictationHotkey || '',
    agent: settings?.agentHotkey || ''
  };
}

function buildDashboardState() {
  return {
    appName: APP_NAME,
    appVersion: app.getVersion(),
    userName,
    gallery: GALLERY,
    settings: publicSettings(),
    turns: structuredClone(history),
    memory: [...memory],
    health: structuredClone(lastHealth),
    activationLogs: logger.read(LIMITS.MAX_LOG_LINES),
    hotkey: hotkeyStatus(),
    apps: apps.appNames(80),
    keyStatus: Object.fromEntries(Object.keys(settings.providers).map((provider) => [provider, Boolean(secrets[provider])]))
  };
}

function normalizeSettings() {
  if (!settings.providers || typeof settings.providers !== 'object') settings.providers = structuredClone(defaults(userName).providers);
  if (!STT_CLOUD_PROVIDERS.includes(settings.sttCloudProvider)) settings.sttCloudProvider = 'openai';
  if (settings.fallbackProvider !== 'none' && (!settings.fallbackProvider || settings.fallbackProvider === 'local' || !Object.hasOwn(settings.providers, settings.fallbackProvider))) settings.fallbackProvider = 'none';
  if (settings.fallbackProvider === 'none') settings.fallbackEnabled = false;
  if (!settings.lastCloudProvider || settings.lastCloudProvider === 'local' || !Object.hasOwn(settings.providers, settings.lastCloudProvider)) settings.lastCloudProvider = 'openai';
  if (settings.chatProvider === 'local') {
    settings.activeMode = 'local';
  } else {
    settings.activeMode = 'cloud';
    settings.lastCloudProvider = settings.chatProvider;
  }
  settings.permissionMode = permissions.normalizePermissionMode(settings.permissionMode);
  settings.permissionCustom = permissions.normalizeCustomPermissions(settings.permissionCustom);
  if (!['agent', 'dictation'].includes(settings.mode)) settings.mode = 'agent';
  if (!['island', 'notch'].includes(settings.overlayStyle)) settings.overlayStyle = 'island';
  if (!Object.hasOwn(WHISPER_PRESETS, settings.performancePreset)) settings.performancePreset = 'custom';
  if (settings.performancePreset !== 'custom' && WHISPER_PRESETS[settings.performancePreset].model !== settings.whisperModel) {
    settings.performancePreset = 'custom';
  }
}

function normalizeConsoleArgs(args) {
  if (args[0] && typeof args[0] === 'object' && ('level' in args[0] || 'message' in args[0])) {
    return { level: args[0].level, message: args[0].message };
  }
  return { level: args[0], message: args[1] };
}

function attachConsoleLogging(window, label) {
  window.webContents.on('console-message', (_event, ...args) => {
    const { level, message } = normalizeConsoleArgs(args);
    const numeric = typeof level === 'number' ? level : ({ verbose: 0, info: 1, warning: 2, error: 3 }[level] ?? 0);
    if (numeric >= 3) logger.error(`${label} console`, message);
    else if (numeric === 2) logger.warn(`${label} console`, message);
  });
}

function createDashboard(show = false) {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    if (show) {
      if (dashboardWindow.isMinimized()) dashboardWindow.restore();
      dashboardWindow.show();
      dashboardWindow.focus();
    }
    return dashboardWindow;
  }
  dashboardWindow = new BrowserWindow({
    width: 1080,
    height: 710,
    minWidth: 860,
    minHeight: 580,
    frame: false,
    show: false,
    title: APP_NAME,
    backgroundColor: '#0e0d0b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  dashboardWindow.setMenuBarVisibility(false);
  dashboardWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url);
    return { action: 'deny' };
  });
  dashboardWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openExternalLink(url);
  });
  attachConsoleLogging(dashboardWindow, 'dashboard');
  dashboardWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('dashboard', `Renderer exited: ${details.reason}`);
    if (quitting) return;
    const crashed = dashboardWindow;
    dashboardWindow = null;
    if (crashed && !crashed.isDestroyed()) crashed.destroy();
  });
  dashboardWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html')).catch((error) => {
    logger.error('dashboard', `Dashboard failed to load: ${cleanError(error)}`);
  });
  dashboardWindow.once('ready-to-show', () => {
    if (show && dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.show();
  });
  dashboardWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      dashboardWindow.hide();
    }
  });
  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
  });
  return dashboardWindow;
}

function showDashboard() {
  createDashboard(true);
}

function rejectPendingRecorderRequests(message) {
  for (const pending of pendingRecorderRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }
  pendingRecorderRequests.clear();
}

function configureRecorderSession() {
  const recorderSession = session.fromPartition(RECORDER_PARTITION);
  recorderSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
  recorderSession.setPermissionCheckHandler((_webContents, permission) => permission === 'media');
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function createRecorderWindow() {
  if (recorderWindow && !recorderWindow.isDestroyed()) return recorderWindow;
  recorderWindow = new BrowserWindow({
    width: 480,
    height: 320,
    show: false,
    skipTaskbar: true,
    title: `${APP_NAME} microphone`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      partition: RECORDER_PARTITION
    }
  });
  recorderWindow.setMenuBarVisibility(false);
  recorderWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  recorderWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  attachConsoleLogging(recorderWindow, 'recorder');
  recorderReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Microphone window did not load within 15 seconds.')), 15000);
    const failed = (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      clearTimeout(timer);
      reject(new Error(`Microphone window failed to load (${code}: ${description}).`));
    };
    recorderWindow.webContents.on('did-fail-load', failed);
    recorderWindow.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      recorderWindow?.webContents.removeListener('did-fail-load', failed);
      resolve();
    });
  });
  recorderReady.catch((error) => logger.error('recorder', cleanError(error)));
  recorderWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('recorder', `Renderer exited: ${details.reason}`);
    if (!quitting) rejectPendingRecorderRequests('The microphone window stopped unexpectedly.');
    if (!quitting && currentTurn?.recording) {
      if (currentTurn.recorderId) recorderManager?.cancel(currentTurn.recorderId, 'microphone renderer crash');
      failTurn(currentTurn, 'The microphone window stopped unexpectedly. Try again.');
    }
    const crashed = recorderWindow;
    recorderWindow = null;
    recorderReady = null;
    if (crashed && !crashed.isDestroyed()) crashed.destroy();
  });
  recorderWindow.on('closed', () => {
    if (!quitting) rejectPendingRecorderRequests('The microphone window closed.');
    if (!quitting && currentTurn?.recording) {
      if (currentTurn.recorderId) recorderManager?.cancel(currentTurn.recorderId, 'microphone window closed');
      failTurn(currentTurn, 'The microphone window stopped unexpectedly. Try again.');
    }
    recorderWindow = null;
    recorderReady = null;
  });
  recorderWindow.loadFile(path.join(__dirname, 'renderer', 'recorder.html')).catch((error) => {
    logger.error('recorder', `Recorder failed to load: ${cleanError(error)}`);
  });
  return recorderWindow;
}

async function ensureRecorder() {
  if (!recorderWindow || recorderWindow.isDestroyed()) createRecorderWindow();
  try {
    if (recorderReady) await recorderReady;
    if (!recorderWindow || recorderWindow.isDestroyed()) throw new Error('Microphone window is unavailable.');
    return recorderWindow;
  } catch (error) {
    if (recorderWindow && !recorderWindow.isDestroyed()) recorderWindow.destroy();
    recorderWindow = null;
    recorderReady = null;
    throw error;
  }
}

function recorderRequest(type, payload = {}, timeout = 20000) {
  return ensureRecorder().then(() => new Promise((resolve, reject) => {
    if (!recorderWindow || recorderWindow.isDestroyed()) {
      reject(new Error('Microphone window is unavailable.'));
      return;
    }
    const id = nextRecorderRequestId++;
    const timer = setTimeout(() => {
      pendingRecorderRequests.delete(id);
      reject(new Error('Microphone request timed out.'));
    }, timeout);
    pendingRecorderRequests.set(id, { resolve, reject, timer });
    try {
      recorderWindow.webContents.send('recorder:request', { id, type, ...payload });
    } catch (error) {
      clearTimeout(timer);
      pendingRecorderRequests.delete(id);
      reject(error);
    }
  }));
}

function queueRecorderOperation(operation) {
  const run = recorderQueue.then(operation, operation);
  recorderQueue = run.catch(() => {});
  return run;
}

function createTray() {
  let image = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  if (image.isEmpty()) {
    logger.warn('tray', 'Tray image is missing; using a minimal fallback.');
    image = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAEklEQVQ4jWNgGAWjYBSMglEwCgAsLQAB7c0mNQAAAABJRU5ErkJggg==');
  }
  if (process.platform === 'win32') image = image.resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip(APP_NAME);
  tray.on('click', showDashboard);
  refreshTray();
}

function trayTemplate() {
  const talkLabel = currentTurn?.recording ? 'Stop recording' : currentTurn ? 'Cancel current turn' : 'Talk now';
  return [
    { label: 'Open dashboard', click: showDashboard },
    { label: 'Ask Voxa', click: () => openChat() },
    { label: talkLabel, click: () => { toggleTalk('tray', settings.mode).catch((error) => logger.error('tray', cleanError(error))); } },
    { type: 'separator' },
    { label: 'Agent mode', type: 'radio', checked: settings.mode === 'agent', click: () => setMode('agent') },
    { label: 'Dictation mode', type: 'radio', checked: settings.mode === 'dictation', click: () => setMode('dictation') },
    { label: settings.paused ? 'Resume listening' : 'Pause listening', click: togglePaused },
    { label: 'Start with Windows', type: 'checkbox', checked: Boolean(settings.startWithWindows), click: (item) => {
      try {
        saveSettingsPatch({ startWithWindows: item.checked });
      } catch (error) {
        logger.error('settings', cleanError(error));
        refreshTray();
      }
    } },
    { type: 'separator' },
    { label: 'Check for updates', click: () => {
      showDashboard();
      updater.checkNow().catch((error) => logger.warn('updater', cleanError(error)));
    } },
    { label: 'Settings', click: () => { showDashboard(); sendToDashboardWhenReady('settings:refresh', 'settings'); } },
    { label: 'Quit', click: () => app.quit() }
  ];
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(`${APP_NAME} · ${settings.paused ? 'Paused' : settings.mode === 'dictation' ? 'Dictation' : 'Agent'}`);
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
}

function applyAutostart() {
  if (process.platform !== 'win32') return;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(settings.startWithWindows),
      path: process.execPath,
      args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']
    });
  } catch (error) {
    logger.warn('startup', `Could not update Start with Windows: ${cleanError(error)}`);
  }
}

function persistSettings() {
  store.writeJson('settings.json', settings);
}

function saveSettingsPatch(patch) {
  const next = { ...settings, ...store.sanitizeSettingsPatch(patch, settings, isValidHotkey) };
  if (next.chatProvider === 'local') {
    next.activeMode = 'local';
  } else {
    next.activeMode = 'cloud';
    next.lastCloudProvider = next.chatProvider;
  }
  if (next.fallbackProvider === 'none') {
    next.fallbackEnabled = false;
  } else if (next.fallbackEnabled && isCloudProvider(next.fallbackProvider) && !secrets[next.fallbackProvider]) {
    throw new Error(`Save an API key for ${next.fallbackProvider} before enabling the cloud fallback.`);
  }
  const whisperModelChanged = next.whisperModel !== settings.whisperModel;
  const whisperDeviceChanged = next.whisperDevice !== settings.whisperDevice;
  const hotkeysChanged = next.dictationHotkey !== settings.dictationHotkey || next.agentHotkey !== settings.agentHotkey;
  const overlayStyleChanged = next.overlayStyle !== settings.overlayStyle;
  const companionEnabledChanged = next.companionEnabled !== settings.companionEnabled;
  const chatChanged = next.chatProvider !== settings.chatProvider
    || JSON.stringify(next.providers) !== JSON.stringify(settings.providers);
  if (hotkeysChanged && (turnRunning || currentTurn)) {
    throw new Error('Finish or cancel the current turn before changing shortcuts.');
  }
  if (hotkeys && hotkeysChanged) {
    try {
      hotkeys.configure({ dictationHotkey: next.dictationHotkey, agentHotkey: next.agentHotkey });
    } catch (error) {
      throw new Error(`Shortcut changes could not be applied: ${cleanError(error)}`);
    }
  }
  try {
    store.writeJson('settings.json', next);
  } catch (error) {
    if (hotkeys && hotkeysChanged) {
      hotkeys.configure({ dictationHotkey: settings.dictationHotkey, agentHotkey: settings.agentHotkey });
    }
    throw error;
  }
  settings = next;
  applyAutostart();
  if (overlayStyleChanged) overlay?.setStyle(next.overlayStyle);
  if (companionEnabledChanged) overlay?.setState({ companionEnabled: next.companionEnabled });
  if (whisperDeviceChanged) {
    stopWhisperWatch();
    services.stopWhisper();
    logger.info('whisper server', 'Whisper will restart with the new compute device.');
  } else if (whisperModelChanged) {
    logger.info('whisper server', `Whisper model selection changed to ${next.whisperModel}; the active model stays loaded until the switch is requested.`);
  }
  refreshTray();
  broadcast('settings:updated', publicSettings());
  broadcast('hotkey-status', hotkeyStatus());
  broadcast('mode-status', { mode: settings.mode });
  logger.info('settings', `Saved: ${Object.keys(patch).join(', ') || 'settings'}`);
  if (chatChanged) {
    clearModelCache();
    healthChecks().catch((error) => logger.warn('health', cleanError(error)));
  }
  return publicSettings();
}

function setMode(mode) {
  if (!['agent', 'dictation'].includes(mode)) throw new Error('Unknown assistant mode.');
  if (settings.mode === mode) return;
  const previous = settings.mode;
  settings.mode = mode;
  try {
    persistSettings();
  } catch (error) {
    settings.mode = previous;
    logger.error('settings', `Could not change mode: ${cleanError(error)}`);
  }
  refreshTray();
  broadcast('mode-status', { mode: settings.mode });
}

function togglePaused() {
  const previous = settings.paused;
  settings.paused = !previous;
  try {
    persistSettings();
  } catch (error) {
    settings.paused = previous;
    logger.error('settings', `Could not change listening state: ${cleanError(error)}`);
    refreshTray();
    broadcast('settings:updated', publicSettings());
    return;
  }
  if (settings.paused) abortTurn('paused');
  refreshTray();
  broadcast('settings:updated', publicSettings());
  logger.info('app', settings.paused ? 'Listening paused' : 'Listening resumed');
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function whisperModelSummary(health = {}) {
  const source = Array.isArray(health.models) && health.models.length ? health.models : null;
  if (source) {
    return source.map((item) => ({
      id: String(item.id || ''),
      label: String(item.label || item.id || ''),
      sizeBytes: Number(item.size_bytes ?? item.sizeBytes) || 0,
      downloaded: typeof item.downloaded === 'boolean' ? item.downloaded : null,
      active: Boolean(item.active),
      status: String(item.status || '')
    })).filter((item) => item.id);
  }
  return WHISPER_MODELS.map((item) => ({
    ...item,
    downloaded: null,
    active: false,
    status: 'Unknown'
  }));
}

function whisperHealthSummary(health = {}) {
  const selectedModel = settings.whisperModel;
  const activeModel = health.active_model || health.activeModel || (health.ok ? health.model : '') || '';
  const targetModel = health.target_model || health.targetModel || activeModel || selectedModel;
  const rawStatus = String(health.status || '');
  const switching = Boolean(health.switching) || ['downloading', 'loading'].includes(rawStatus);
  const modelMatches = !activeModel || activeModel === selectedModel;
  const source = health.progress && typeof health.progress === 'object' ? health.progress : null;
  const downloaded = Number(source?.downloaded_bytes);
  const total = Number(source?.total_bytes);
  const percent = source?.percent == null ? NaN : Number(source.percent);
  const speed = Number(source?.speed_bps ?? source?.speedBps);
  const progress = source ? {
    model: typeof source.model === 'string' ? source.model : '',
    status: typeof source.status === 'string' ? source.status : '',
    downloadedBytes: Number.isFinite(downloaded) ? Math.max(0, downloaded) : 0,
    totalBytes: Number.isFinite(total) ? Math.max(0, total) : 0,
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null,
    speedBps: Number.isFinite(speed) ? Math.max(0, speed) : 0,
    stalled: Boolean(source.stalled),
    error: typeof source.error === 'string' ? source.error : ''
  } : null;
  let status;
  if (switching) status = rawStatus === 'downloading' ? 'downloading' : 'loading';
  else if (!modelMatches) status = 'mismatch';
  else status = rawStatus || (health.ok ? 'ready' : 'unreachable');
  const ok = Boolean(health.ok && modelMatches && !switching);
  const model = activeModel || targetModel || selectedModel;
  const switchError = String(health.switch_error || health.switchError || '');
  let message;
  if (switching) {
    message = health.message || (status === 'downloading'
      ? (progress?.percent == null
        ? `Preparing the ${targetModel} model download.`
        : `Downloading ${targetModel} — ${progress.percent}% (${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)}).`)
      : `Loading the ${targetModel} model.`);
  } else if (ok) {
    message = health.message || `Reachable — ${model}.`;
  } else if (status === 'mismatch') {
    message = `Reachable with ${activeModel}, not the selected ${selectedModel}.`;
  } else if (status === 'error') {
    message = health.error || switchError || 'The Whisper model failed to load.';
  } else {
    message = `Not reachable: ${health.error || 'start the whisper server.'}`;
  }
  return {
    ok,
    model,
    selectedModel,
    activeModel,
    targetModel,
    modelMatches,
    switching,
    switchStatus: String(health.switch_status || health.switchStatus || ''),
    switchError,
    status,
    progress,
    models: whisperModelSummary(health),
    message
  };
}

function publishKokoroHealth(status) {
  lastHealth.kokoro = { ...status, checkedAt: new Date().toISOString() };
  sendToDashboard('tts:health-updated', lastHealth.kokoro);
}

function publishWhisperHealth(health) {
  lastHealth = {
    ...lastHealth,
    whisper: whisperHealthSummary(health),
    checkedAt: new Date().toISOString()
  };
  sendToDashboard('health:updated', structuredClone(lastHealth));
}

async function ensureWhisper() {
  try {
    const existing = await services.whisperHealth(WHISPER_PORT);
    if (existing.ok) {
      publishWhisperHealth(existing);
      return existing;
    }
    if (existing.status === 'error') {
      publishWhisperHealth(existing);
      throw new Error(existing.error || 'The Whisper model failed to load.');
    }
    const health = await services.startWhisper({
      port: WHISPER_PORT,
      model: settings.whisperModel,
      device: settings.whisperDevice,
      onHealth: publishWhisperHealth
    }, logger);
    publishWhisperHealth(health);
    return health;
  } catch (error) {
    if (services.whisperStatus().running) startWhisperWatch();
    throw error;
  }
}

function stopWhisperWatch(token = 0) {
  if (token && token !== whisperWatchToken) return;
  whisperWatchToken += 1;
  clearInterval(whisperWatchTimer);
  whisperWatchTimer = null;
}

function startWhisperWatch(expectStart = false) {
  const token = ++whisperWatchToken;
  clearInterval(whisperWatchTimer);
  const deadline = Date.now() + LIMITS.WHISPER_START_TIMEOUT_MS;
  let polling = false;
  let waitingForStart = Boolean(expectStart);
  const tick = async () => {
    if (token !== whisperWatchToken || polling) return;
    polling = true;
    try {
      const health = await services.whisperHealth(WHISPER_PORT);
      if (token !== whisperWatchToken) return;
      if (health.status !== 'unreachable') waitingForStart = false;
      publishWhisperHealth(health);
      const processStatus = services.whisperStatus();
      const starting = health.status === 'unreachable'
        && (waitingForStart || Boolean(processStatus.running || processStatus.processAlive));
      const active = Boolean(health.switching)
        || ['downloading', 'loading'].includes(health.status)
        || starting;
      const startExpired = health.status === 'unreachable' && Date.now() > deadline;
      if (!active || health.status === 'error' || startExpired) stopWhisperWatch(token);
    } finally {
      polling = false;
    }
  };
  void tick();
  whisperWatchTimer = setInterval(() => void tick(), LIMITS.WHISPER_PROGRESS_POLL_MS);
}

async function cancelWhisperSwitch() {
  await services.cancelWhisperModel(WHISPER_PORT);
  const health = await services.whisperHealth(WHISPER_PORT);
  publishWhisperHealth(health);
  return whisperHealthSummary(health);
}

async function switchWhisperModel(model) {
  const target = String(model || '').trim();
  if (!WHISPER_MODELS.some((item) => item.id === target)) throw new Error('Choose a supported Whisper model.');
  const currentPreset = settings.performancePreset;
  const preset = currentPreset
    && currentPreset !== 'custom'
    && WHISPER_PRESETS[currentPreset]?.model === target
    ? currentPreset
    : 'custom';
  saveSettingsPatch({ whisperModel: target, performancePreset: preset });
  const existing = await services.whisperHealth(WHISPER_PORT);
  if (existing.status !== 'unreachable') {
    await services.loadWhisperModel(WHISPER_PORT, target);
    startWhisperWatch();
  } else {
    startWhisperWatch(true);
    ensureWhisper().catch((error) => {
      if (services.whisperStatus().running) return;
      stopWhisperWatch();
      publishWhisperHealth({
        ok: false,
        status: 'error',
        error: cleanError(error),
        active_model: null,
        target_model: target,
        models: WHISPER_MODELS.map((item) => ({
          ...item,
          downloaded: null,
          active: false,
          status: 'Unknown'
        }))
      });
    });
  }
  const health = await services.whisperHealth(WHISPER_PORT);
  publishWhisperHealth(health);
  return whisperHealthSummary(health);
}

async function transcribeAudio(audio, mime, signal) {
  const bytes = toBuffer(audio);
  if (!bytes.length) throw new Error('No audio was captured.');
  if (bytes.length > LIMITS.MAX_AUDIO_BYTES) throw new Error('The recording is larger than 25 MB.');
  if (settings.sttProvider === 'cloud') {
    const key = secrets[settings.sttCloudProvider];
    if (!key) throw new Error(`Add an API key for ${settings.sttCloudProvider} in the dashboard.`);
    const result = await services.cloudTranscribe(settings, key, bytes, mime, signal);
    return result.text.slice(0, LIMITS.MAX_TRANSCRIPT_CHARS);
  }
  await ensureWhisper();
  const result = await services.transcribe(`http://127.0.0.1:${WHISPER_PORT}`, bytes, mime, settings.whisperModel, signal);
  return result.text.slice(0, LIMITS.MAX_TRANSCRIPT_CHARS);
}

async function healthChecks() {
  const localConfig = settings.providers.local;
  const providerName = settings.chatProvider;
  const providerConfig = settings.providers[providerName] || localConfig;
  const providerKey = providerNeedsKey(providerName) ? secrets[providerName] || '' : '';
  const ollamaInstalled = Boolean(services.ollamaExecutable());
  const [ollamaResult, whisperResult, remoteChatResult] = await Promise.all([
    (async () => {
      try {
        const models = await services.listModels('local', localConfig, '');
        const wanted = localConfig.model;
        const available = models.includes(wanted);
        return {
          ok: available,
          installed: ollamaInstalled,
          model: wanted,
          modelAvailable: available,
          models: models.slice(0, 50),
          message: available ? `Reachable · ${wanted} installed.` : models.length ? `Reachable, but ${wanted} is not installed.` : 'Ollama returned no models.'
        };
      } catch (error) {
        return {
          ok: false,
          installed: ollamaInstalled,
          model: localConfig.model,
          message: ollamaInstalled
            ? `Ollama is installed but not running: ${cleanError(error)}`
            : 'Ollama is not installed. Download it, then pull the model from this page.'
        };
      }
    })(),
    (async () => whisperHealthSummary(await services.whisperHealth(WHISPER_PORT)))(),
    (async () => {
      if (providerName === 'local') return null;
      const wanted = providerConfig.model;
      if (providerNeedsKey(providerName) && !providerKey) {
        return { ok: false, provider: providerName, model: wanted, message: `Add an API key for ${providerName}.` };
      }
      try {
        const models = await services.listModels(providerName, providerConfig, providerKey);
        const available = models.length > 0 && models.includes(wanted);
        return {
          ok: available,
          provider: providerName,
          model: wanted,
          modelAvailable: available,
          models: models.slice(0, 50),
          message: available
            ? `Reachable — ${wanted} available.`
            : models.length ? `Reachable, but ${wanted} is not available.` : 'The provider returned no models.'
        };
      } catch (error) {
        return { ok: false, provider: providerName, model: wanted, message: `Not reachable: ${cleanError(error)}` };
      }
    })()
  ]);
  if (whisperResult.switching || ['downloading', 'loading'].includes(whisperResult.status)) startWhisperWatch();
  const chatResult = providerName === 'local'
    ? { ...ollamaResult, provider: 'local' }
    : remoteChatResult;
  lastHealth = {
    ollama: ollamaResult,
    chat: chatResult,
    whisper: whisperResult,
    checkedAt: new Date().toISOString()
  };
  sendToDashboard('health:updated', lastHealth);
  return structuredClone(lastHealth);
}

function warmServices() {
  setTimeout(async () => {
    await healthChecks().catch((error) => logger.warn('health', cleanError(error)));
    if (settings.sttProvider === 'local') {
      try {
        await ensureWhisper();
        await healthChecks();
      } catch (error) {
        logger.warn('whisper server', cleanError(error));
      }
    }
  }, 1200).unref?.();
}

function addTurn(said, did) {
  history = [{ time: new Date().toISOString(), said: said.slice(0, LIMITS.MAX_TRANSCRIPT_CHARS), did: did.slice(0, LIMITS.MAX_TRANSCRIPT_CHARS) }, ...history].slice(0, LIMITS.MAX_TURNS);
  try {
    store.writeJson('history.json', history);
  } catch (error) {
    logger.error('history', cleanError(error));
  }
  broadcast('history:updated', structuredClone(history));
}

function addMemory(note) {
  memory = [...memory, note].slice(-LIMITS.MAX_MEMORY_ENTRIES);
  try {
    store.writeJson('memory.json', memory);
  } catch (error) {
    logger.error('memory', cleanError(error));
  }
  broadcast('memory-updated', [...memory]);
}

function turnAlive(turn) {
  return currentTurn === turn && !turn.controller.signal.aborted;
}

async function requireTurnTarget(turn) {
  const target = await turn.targetPromise;
  if (!turnAlive(turn)) throw Object.assign(new Error('Cancelled.'), { cancelled: true });
  if (!target?.id) {
    throw new Error('Voxa could not tell which app was focused when you started. Click into the target app and try again.');
  }
  return target;
}

function clearTurnTimers(turn) {
  if (turn?.tailTimer) clearTimeout(turn.tailTimer);
  if (turn?.audioTimer) clearTimeout(turn.audioTimer);
  if (turn?.maxHoldTimer) clearTimeout(turn.maxHoldTimer);
  if (currentTurn === turn) {
    clearTimeout(tailTimer);
    clearTimeout(audioTimer);
  }
  tailTimer = null;
  audioTimer = null;
}

function finishTurn(turn) {
  if (!turn) return;
  clearTurnTimers(turn);
  approvalGate.cancelTurn(turn.id);
  if (currentTurn === turn) currentTurn = null;
  turnRunning = false;
  broadcast('ptt-state', { active: false, cancelled: false, mode: turn.mode });
  refreshTray();
}

function clearOverlayHideTimer() {
  clearTimeout(hideTimer);
  hideTimer = null;
  hideDeadline = 0;
  hideRemaining = 0;
  hideDuration = 0;
  hidePaused = false;
  overlay?.setDismiss(null);
}

function scheduleOverlayHide(delay) {
  if (chatSession.open) return;
  clearTimeout(hideTimer);
  hidePaused = false;
  hideDuration = Math.max(0, Number(delay) || 0);
  hideRemaining = hideDuration;
  hideDeadline = Date.now() + hideRemaining;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    hidePaused = false;
    hideRemaining = 0;
    if (!currentTurn && !chatSession.open) overlay?.hide();
  }, hideRemaining);
  hideTimer.unref?.();
  overlay?.setDismiss({
    duration: hideDuration,
    startedAt: Date.now(),
    paused: false,
    remaining: hideRemaining
  });
}

function pauseOverlayHide() {
  if (chatSession.open || hidePaused || (!hideTimer && !hideRemaining)) return;
  clearTimeout(hideTimer);
  hideTimer = null;
  hideRemaining = Math.max(0, hideDeadline - Date.now());
  hidePaused = true;
  overlay?.setDismiss({
    duration: hideDuration || hideRemaining,
    startedAt: Date.now(),
    paused: true,
    remaining: hideRemaining
  });
}

function resumeOverlayHide() {
  if (chatSession.open || !hidePaused) return;
  hidePaused = false;
  hideDeadline = Date.now() + hideRemaining;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    hideRemaining = 0;
    if (!currentTurn && !chatSession.open) overlay?.hide();
  }, hideRemaining);
  hideTimer.unref?.();
  overlay?.setDismiss({
    duration: hideDuration || hideRemaining,
    startedAt: Date.now() - Math.max(0, (hideDuration || hideRemaining) - hideRemaining),
    paused: false,
    remaining: hideRemaining
  });
}

function showTurnError(turn, message, detail = '') {
  if (currentTurn !== turn) return;
  const cancelled = turn.controller.signal.aborted;
  finishTurn(turn);
  if (cancelled) {
    overlay?.hide();
    return;
  }
  logger.error('turn', detail || message);
  overlay?.show({ status: 'error', message, approval: null, canCopy: false, mode: turn.mode, streaming: false });
  scheduleOverlayHide(6000);
}

function failTurn(turn, message, detail = '') {
  if (!turn || currentTurn !== turn) return;
  showTurnError(turn, message, detail);
}

function abortTurn(reason = 'cancelled') {
  const turn = currentTurn;
  clearOverlayHideTimer();
  if (turn) {
    logger.info('turn', `Cancelled: ${reason}`);
    turn.controller.abort();
    if (turn.recorderId) recorderManager?.cancel(turn.recorderId, reason);
    finishTurn(turn);
    overlay?.hide();
  } else {
    speechController?.abort(); sendToPlayer('tts:stop-audio', {});
    speechController = null;
    overlay?.hide();
  }
  clearTimeout(tailTimer);
  clearTimeout(audioTimer);
  return Boolean(turn);
}

async function beginTurn(mode, origin = 'hotkey') {
  if (!['agent', 'dictation'].includes(mode)) return false;
  sendToPlayer('tts:stop-audio', {});
  if (speechController) {
    speechController.abort();
    speechController = null;
  }
  if (settings.paused) {
    logger.info('hotkey', 'Activation ignored while listening is paused.');
    return false;
  }
  if (mode === 'dictation' && settings.dictationEnabled === false) return false;
  if (mode === 'agent' && settings.agentEnabled === false) return false;
  if (micTestRunning) {
    logger.info('hotkey', 'Activation ignored while the microphone test is running.');
    return false;
  }
  if (turnRunning || currentTurn) {
    logger.warn('hotkey', 'Activation ignored while another turn is active.');
    return false;
  }
  if (chatSession.open) collapseChat({ hide: false });
  else overlay?.setState({ chatOpen: false, chatPreview: false });
  clearOverlayHideTimer();
  const turn = {
    id: nextTurnId++,
    mode,
    origin,
    controller: new AbortController(),
    holdStartedAt: Date.now(),
    recording: false,
    recordingStartedAt: 0,
    recorderId: null,
    releaseRequested: false,
    stopping: false,
    audioRequested: false,
    processing: false,
    target: null,
    targetPromise: null,
    transcript: '',
    toolsExecuted: false,
    approvalCount: 0,
    approvalDecisions: new Map(),
    executedActions: new Set()
  };
  currentTurn = turn;
  turnRunning = true;
  settings.mode = mode;
  try {
    persistSettings();
  } catch (error) {
    logger.warn('settings', cleanError(error));
  }
  broadcast('mode-status', { mode });
  refreshTray();
  turn.targetPromise = desktop.getFocusedTarget({ ignoreProcessId: process.pid })
    .then((target) => {
      turn.target = target;
      if (target) logger.info('focus', `Key-down foreground: ${desktop.describeWindow(target)}`);
      else logger.info('focus', 'Key-down foreground: no external window was captured (Voxa windows are ignored).');
      return target;
    })
    .catch((error) => {
      logger.warn('focus', `Could not capture the key-down window: ${cleanError(error)}`);
      return null;
    });
  try {
    await ensureRecorder();
    if (!turnAlive(turn)) return false;
    const recording = recorderManager.start({ deviceId: settings.microphoneId, origin: `${mode}:${origin}` });
    if (!recording) {
      recorderManager.cancelAll();
      throw new Error('The microphone could not start. Try again.');
    }
    turn.recorderId = recording.id;
    turn.recordingStartedAt = Date.now();
    turn.recording = true;
    overlay.show({
      status: 'listening',
      mode,
      message: mode === 'dictation' ? 'Dictation · release to type' : 'Listening · release to ask',
      approval: null,
      canCopy: false,
      streaming: false,
      speaking: false
    });
    broadcast('ptt-state', { active: true, mode });
    turn.maxHoldTimer = setTimeout(() => releaseTurn(mode, 'maximum recording length'), 60000);
    turn.maxHoldTimer.unref?.();
    if (turn.releaseRequested) scheduleTurnStop(turn);
    logger.info('recording', `${mode} recording started from ${origin}`);
    return true;
  } catch (error) {
    if (turn.recorderId) recorderManager?.cancel(turn.recorderId, 'microphone start failed');
    showTurnError(turn, `Microphone unavailable: ${cleanError(error)}`, `Could not start recording: ${cleanError(error)}`);
    return false;
  }
}

function releaseTurn(mode, reason = 'released') {
  const turn = currentTurn;
  if (!turn || turn.mode !== mode) return false;
  if (turn.releaseRequested) return Boolean(turn.recording);
  turn.releaseRequested = true;
  if (turn.recording) scheduleTurnStop(turn);
  else logger.info('recording', `Release received before microphone start (${reason}).`);
  return true;
}

function scheduleTurnStop(turn) {
  if (currentTurn !== turn || turn.stopping || !turn.recording) return;
  turn.stopping = true;
  clearTimeout(turn.maxHoldTimer);
  const held = Date.now() - turn.holdStartedAt;
  if (held < LIMITS.MIN_HOLD_MS) {
    logger.info('recording', `Ignored ${held} ms hold; minimum is ${LIMITS.MIN_HOLD_MS} ms.`);
    if (turn.recorderId) recorderManager.cancel(turn.recorderId, 'too short');
    finishTurn(turn);
    overlay.show({ status: 'error', message: MESSAGES.HOLD_TOO_SHORT, approval: null, canCopy: false, mode: turn.mode });
    scheduleOverlayHide(3000);
    return;
  }
  overlay.setState({ status: 'listening', message: 'Got it — finishing…' });
  turn.tailTimer = setTimeout(() => stopTurnRecording(turn), LIMITS.TAIL_MS);
  tailTimer = turn.tailTimer;
  turn.tailTimer.unref?.();
  logger.info('recording', `Release detected after ${held} ms; tail is ${LIMITS.TAIL_MS} ms.`);
}

function stopTurnRecording(turn) {
  if (currentTurn !== turn || turn.audioRequested) return;
  turn.audioRequested = true;
  turn.recording = false;
  overlay.setState({ status: 'thinking', message: 'Transcribing…' });
  const stopped = recorderManager.stop(turn.recorderId);
  if (!stopped) {
    showTurnError(turn, 'The recording could not be stopped. Try again.');
    return;
  }
  turn.audioTimer = setTimeout(() => {
    if (currentTurn === turn) showTurnError(turn, 'Audio capture timed out. Check your microphone and try again.');
  }, 20000);
  audioTimer = turn.audioTimer;
  turn.audioTimer.unref?.();
}

function cleanReply(value) {
  const text = String(value || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/<\/think>/gi, '')
    .trim();
  return (text || 'Done.').slice(0, 8000);
}

function chatDisplayText(value) {
  return String(value || '')
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<think\b[^>]*>[\s\S]*$/i, '')
    .replace(/<\/think>/gi, '')
    .slice(0, LIMITS.MAX_CHAT_CHARS);
}

function cleanChatReply(value) {
  return chatDisplayText(value).trim();
}

function chatSystemPrompt() {
  const notes = memory.length ? memory.join(' | ') : '(none)';
  return [
    'You are Voxa, a concise desktop assistant.',
    'This is a typed chat inside a small overlay. Answer directly and keep replies short unless the user asks for detail.',
    'Typed chat cannot use desktop tools or perform actions. Never claim you opened, typed, clicked, or changed anything.',
    'If the user asks for a desktop action, tell them to use voice or agent mode.',
    `User notes: ${notes}.`,
    `Current time: ${new Date().toISOString()}.`
  ].join(' ');
}

function chatMessagesFor(text) {
  const recent = history
    .filter((turn) => turn && turn.said && turn.did && turn.did !== 'Dictated into the focused app.')
    .slice(0, 6)
    .reverse();
  const messages = [{ role: 'system', content: chatSystemPrompt() }];
  for (const turn of recent) {
    messages.push({ role: 'user', content: String(turn.said).slice(0, LIMITS.MAX_CHAT_CHARS) });
    messages.push({ role: 'assistant', content: String(turn.did).slice(0, LIMITS.MAX_CHAT_CHARS) });
  }
  messages.push({ role: 'user', content: text });
  return messages;
}

function sendChatHistory() {
  sendToOverlay('chat:history', {
    messages: structuredClone(chatSession.messages),
    requestId: chatSession.requestId,
    streaming: Boolean(chatSession.controller)
  });
}

function openChat() {
  if (currentTurn) {
    logger.warn('chat', 'Chat was ignored while a voice turn is active.');
    return false;
  }
  clearOverlayHideTimer();
  chatSession.open = true;
  overlay?.show({
    status: 'chat',
    mode: 'agent',
    message: '',
    approval: null,
    canCopy: false,
    streaming: false,
    chatOpen: true,
    chatPreview: false,
    chatStreaming: Boolean(chatSession.controller),
    speaking: false
  });
  overlay?.setInteractive(true);
  overlay?.setKeyboardFocus(true);
  logger.info('chat', 'Chat opened');
  return true;
}

function collapseChat({ hide = true } = {}) {
  if (!chatSession.open) return false;
  chatSession.open = false;
  overlay?.setState({ chatOpen: false, chatPreview: false });
  overlay?.setKeyboardFocus(false);
  if (hide) overlay?.hide();
  return true;
}

function closeChat() {
  if (!collapseChat({ hide: true })) return false;
  logger.info('chat', 'Chat collapsed');
  return true;
}

function cancelChat() {
  if (!chatSession.controller) {
    if (chatSession.open) sendChatHistory();
    return false;
  }
  logger.info('chat', 'Stopping reply');
  chatSession.controller.abort();
  return true;
}

async function sendChat(payload) {
  if (!chatSession.open) {
    logger.warn('chat', 'A typed message was ignored because chat is closed.');
    sendToOverlay('chat:error', { message: 'Chat was closed before the message could be sent.' });
    return;
  }
  if (currentTurn) {
    sendToOverlay('chat:error', { message: 'Finish the voice turn before typing.' });
    return;
  }
  if (chatSession.controller) {
    sendToOverlay('chat:error', { message: 'Please wait for the current reply to finish.' });
    return;
  }
  const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    sendToOverlay('chat:error', { message: 'Type a message first.' });
    return;
  }
  if (text.length > LIMITS.MAX_CHAT_CHARS) {
    sendToOverlay('chat:error', { message: `Messages are limited to ${LIMITS.MAX_CHAT_CHARS} characters.` });
    return;
  }
  const providerName = settings.chatProvider;
  const config = settings.providers?.[providerName];
  if (!config) {
    sendToOverlay('chat:error', { message: `Unknown chat provider: ${providerName}` });
    return;
  }
  const key = providerNeedsKey(providerName) ? secrets[providerName] : '';
  if (providerNeedsKey(providerName) && !key) {
    sendToOverlay('chat:error', { message: `Add an API key for ${providerName} in the dashboard.` });
    return;
  }

  const id = nextChatId++;
  const controller = new AbortController();
  chatSession.controller = controller;
  chatSession.requestId = id;
  chatSession.messages.push({ role: 'user', content: text }, { role: 'assistant', content: '', streaming: true });
  if (chatSession.messages.length > 40) chatSession.messages.splice(0, chatSession.messages.length - 40);
  overlay?.setState({ chatStreaming: true });
  sendToOverlay('chat:started', { id, text });
  logger.info('chat', `Sending ${text.length} characters to ${providerName}/${config.model || 'default'}`);

  try {
    const chatSettings = structuredClone(settings);
    const reply = await services.chatStream(
      chatSettings,
      key,
      chatMessagesFor(text),
      controller.signal,
      (partial) => {
        const display = chatDisplayText(partial);
        const last = chatSession.messages[chatSession.messages.length - 1];
        if (last?.role === 'assistant') last.content = display;
        sendToOverlay('chat:delta', { id, text: display });
      }
    );
    const clean = cleanChatReply(reply);
    if (!clean) throw new Error('The model returned an empty reply.');
    const last = chatSession.messages[chatSession.messages.length - 1];
    if (last?.role === 'assistant') {
      last.content = clean;
      last.streaming = false;
    } else {
      chatSession.messages.push({ role: 'assistant', content: clean });
    }
    addTurn(text, clean);
    sendToOverlay('chat:done', { id, text: clean });
    logger.info('chat', `Reply received from ${providerName}`);
  } catch (error) {
    const last = chatSession.messages[chatSession.messages.length - 1];
    if (controller.signal.aborted) {
      if (last?.role === 'assistant') {
        last.streaming = false;
        last.cancelled = true;
      }
      sendToOverlay('chat:done', { id, text: last?.content || '', cancelled: true });
      logger.info('chat', 'Reply stopped');
    } else {
      const message = cleanError(error);
      if (last?.role === 'assistant') {
        last.streaming = false;
        last.error = message;
      } else {
        chatSession.messages.push({ role: 'assistant', content: '', error: message });
      }
      sendToOverlay('chat:error', { id, message });
      logger.warn('chat', message);
    }
  } finally {
    if (chatSession.controller === controller) chatSession.controller = null;
    overlay?.setState({ chatStreaming: false });
  }
}

function stripForSpeech(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\*\*|__|~~|\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toolSchemas() {
  return TOOL_DEFINITIONS.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(tool.parameters).map(([name]) => [name, { type: 'string' }])),
        required: Object.keys(tool.parameters),
        additionalProperties: false
      }
    }
  }));
}

function systemPrompt(target) {
  const installed = apps.appNames(80).join('; ') || '(none discovered)';
  const notes = memory.length ? memory.join(' | ') : '(none)';
  return [
    'You are Voxa, a concise desktop voice assistant.',
    'Answer ordinary questions directly in one to three short sentences.',
    'Use tools when the user asks you to perform an action on their computer.',
    'Never claim an action succeeded unless a tool result says it did.',
    'Routine actions may run without a prompt based on the saved permission mode; sensitive actions still require approval.',
    'If the user denies approval, accept it and do not retry the same action.',
    'Do not end with generic questions such as "Anything else?".',
    `Focused app when the turn began: ${target?.title || 'unknown'}.`,
    `Installed apps: ${installed}.`,
    `User notes: ${notes}.`,
    `Current time: ${new Date().toISOString()}.`
  ].join(' ');
}

async function askApproval(turn, request) {
  if (!turnAlive(turn)) return false;
  const id = `${turn.id}-${++turn.approvalCount}`;
  const detail = String(request.detail || '').slice(0, 2000);
  logger.info('approval', `${request.tool}: ${request.title}`);
  const decision = approvalGate.request(id, turn.id);
  try {
    overlay.show({
      status: 'approval',
      mode: turn.mode,
      message: detail,
      approval: { id, title: request.title, detail, tool: request.tool },
      canCopy: false,
      streaming: false
    });
  } catch (error) {
    approvalGate.respond(id, false);
    throw error;
  }
  return decision;
}

function respondApproval(id, allowed) {
  if (!approvalGate.respond(id, allowed)) return false;
  if (currentTurn) {
    overlay.setState({ status: 'thinking', message: allowed ? 'Working on it…' : 'Okay, skipped.', approval: null });
  }
  logger.info('approval', allowed ? 'Allowed' : 'Denied');
  return true;
}

async function prepareTool(turn, name, args, providerName) {
  if (name === 'type_text') {
    const text = String(args.text || '').trim();
    if (!text) throw new Error('There is no text to type.');
    if (text.length > LIMITS.MAX_TOOL_TEXT_CHARS) throw new Error('The text is too long to type.');
    return {
      title: 'Type this text into the focused app?',
      detail: `App: ${turn.target?.title || 'the app that was focused when you started'}\n\n${text.slice(0, 1000)}`,
      run: async () => {
        const target = await requireTurnTarget(turn);
        const result = await desktop.typeText(text, target, turn.controller.signal);
        const title = result?.foreground?.title || target.title || 'the target app';
        return `Typed ${text.length} character${text.length === 1 ? '' : 's'} into ${title}.`;
      }
    };
  }
  if (name === 'open_url') {
    const url = desktop.validUrl(args.url);
    return {
      title: 'Open this website?',
      detail: url,
      run: async () => {
        await desktop.openUrl(url);
        return `Opened ${url}.`;
      }
    };
  }
  if (name === 'open_app') {
    const query = String(args.app || '').trim();
    if (!query) throw new Error('No app name was provided.');
    const entry = apps.findApp(query);
    if (!entry) throw new Error(`I could not find an installed app matching "${query}".`);
    return {
      title: `Open ${entry.name}?`,
      detail: entry.launch,
      run: async () => {
        await apps.openApp(entry);
        return `Opened ${entry.name}.`;
      }
    };
  }
  if (name === 'web_search') {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('No search query was provided.');
    if (query.length > 500) throw new Error('The search query is too long.');
    return {
      title: 'Search Google?',
      detail: query,
      run: async () => {
        await desktop.webSearch(query);
        return `Searched Google for "${query}".`;
      }
    };
  }
  if (name === 'open_folder') {
    const folder = String(args.folder || '').trim();
    const target = desktop.resolveUserDirectory(folder);
    return {
      title: `Open ${target.name}?`,
      detail: target.path,
      permissionContext: { sensitiveKind: target.sensitiveKind },
      run: async () => {
        await desktop.openFolder(folder);
        return `Opened ${target.name}.`;
      }
    };
  }
  if (name === 'open_file' || name === 'read_file') {
    const file = desktop.resolveUserFile(args.path);
    const verb = name === 'open_file' ? 'Open' : 'Read';
    const cloudRead = name === 'read_file' && providerName !== 'local';
    const cloudNote = cloudRead ? `\n\nThis file's text will be sent to ${providerName}.` : '';
    return {
      title: `${verb} ${file.name}?`,
      detail: `${file.path}${file.sensitiveKind ? '\n\nThis file needs an explicit security check.' : ''}${cloudNote}`,
      permissionContext: { sensitiveKind: file.sensitiveKind, cloudRead },
      run: () => (name === 'open_file' ? desktop.openFile(file.path) : desktop.readFile(file.path))
    };
  }
  if (name === 'press_keys') {
    const shortcut = String(args.shortcut || '').trim();
    desktop.parseShortcut(shortcut);
    return {
      title: 'Send this keyboard shortcut?',
      detail: shortcut,
      run: async () => {
        const target = await requireTurnTarget(turn);
        await desktop.pressKeys(shortcut, target, turn.controller.signal);
        return `Sent ${shortcut} to ${target.title || 'the target app'}.`;
      }
    };
  }
  if (name === 'remember_note') {
    const note = String(args.note || '').trim();
    if (!note) throw new Error('The note is empty.');
    if (note.length > LIMITS.MAX_MEMORY_CHARS) throw new Error('The note is too long.');
    return {
      title: 'Save this memory note?',
      detail: note,
      run: () => {
        addMemory(note);
        return 'Saved the note.';
      }
    };
  }
  throw new Error(`Unknown action: ${name}`);
}

async function executeTool(turn, call, providerName = settings.chatProvider) {
  const name = call?.function?.name;
  if (!TOOL_NAMES.includes(name)) return { ok: false, error: 'That action is unavailable.' };
  if (!turnAlive(turn)) return { ok: false, error: 'Turn cancelled.' };
  let args;
  try {
    args = parseToolArguments(name, call?.function?.arguments);
  } catch (error) {
    return { ok: false, error: cleanError(error) };
  }
  if (name === 'refresh_apps') {
    const list = apps.refreshApps(logger);
    return { ok: true, message: `Refreshed ${list.length} installed apps.` };
  }
  let prepared;
  try {
    prepared = await prepareTool(turn, name, args, providerName);
  } catch (error) {
    return { ok: false, error: cleanError(error) };
  }
  if (!turnAlive(turn)) return { ok: false, error: 'Turn cancelled.' };
  const fingerprint = permissions.actionFingerprint(name, JSON.stringify(args));
  const executed = turn.executedActions || (turn.executedActions = new Set());
  if (executed.has(fingerprint)) {
    return { ok: false, duplicate: true, error: 'That action already ran in this turn, so it was not repeated.' };
  }
  const permission = permissions.resolvePermission(settings, name, prepared.permissionContext);
  if (permission.requiresApproval) {
    const decisions = turn.approvalDecisions || (turn.approvalDecisions = new Map());
    if (decisions.has(fingerprint)) {
      if (!decisions.get(fingerprint)) {
        return { ok: false, denied: true, error: 'The user denied this action.' };
      }
    } else {
      const pending = turn.pendingApprovals || (turn.pendingApprovals = new Map());
      let allowed;
      if (pending.has(fingerprint)) {
        allowed = await pending.get(fingerprint);
      } else {
        const decision = askApproval(turn, { tool: name, title: prepared.title, detail: prepared.detail });
        pending.set(fingerprint, decision);
        try {
          allowed = await decision;
        } finally {
          pending.delete(fingerprint);
        }
        if (!turnAlive(turn)) return { ok: false, error: 'Turn cancelled.' };
        decisions.set(fingerprint, allowed);
      }
      if (!allowed) return { ok: false, denied: true, error: 'The user denied this action.' };
    }
  } else {
    logger.info('permission', `${name} allowed by ${permission.mode} permission mode (${permission.category}).`);
  }
  if (!turnAlive(turn)) return { ok: false, error: 'Turn cancelled.' };
  overlay.setState({ status: 'executing', message: 'Doing that now…', approval: null });
  try {
    const message = await prepared.run();
    executed.add(fingerprint);
    if (turnAlive(turn)) overlay.setState({ status: 'verifying', message: 'Checking the result…', approval: null });
    logger.info('tool', `${name} completed`);
    return { ok: true, message: message || `Completed ${name.replaceAll('_', ' ')}.` };
  } catch (error) {
    if (error.cancelled) return { ok: false, cancelled: true, error: 'Turn cancelled.' };
    logger.warn('tool', `${name} failed: ${cleanError(error)}`);
    return { ok: false, error: cleanError(error) };
  }
}

async function runConversation(turn, transcript, providerName, target) {
  const key = providerNeedsKey(providerName) ? secrets[providerName] : '';
  if (providerNeedsKey(providerName) && !key) throw new Error(`Add an API key for ${providerName} in the dashboard.`);
  const conversationSettings = providerName === settings.chatProvider ? settings : { ...settings, chatProvider: providerName };
  const messages = [
    { role: 'system', content: systemPrompt(target) },
    { role: 'user', content: transcript }
  ];
  const tools = toolSchemas();
  const result = await runAgentLoop({
    messages,
    isAlive: () => turnAlive(turn),
    signal: turn.controller.signal,
    onTimeout: () => {
      turn.controller.abort();
      if (currentTurn !== turn) return;
      logger.error('turn', `The agent timed out after ${Math.round(LIMITS.AGENT_TIMEOUT_MS / 1000)} seconds.`);
      finishTurn(turn);
      overlay.show({
        status: 'error',
        mode: turn.mode,
        message: 'The assistant took too long and was stopped. Try a shorter request.',
        approval: null,
        canCopy: false,
        streaming: false
      });
      scheduleOverlayHide(6000);
    },
    maxRounds: LIMITS.MAX_TOOL_ROUNDS,
    maxToolCalls: LIMITS.MAX_TOOL_CALLS,
    maxConsecutiveFailures: LIMITS.MAX_CONSECUTIVE_TOOL_FAILURES,
    timeoutMs: LIMITS.AGENT_TIMEOUT_MS,
    maxToolResultChars: LIMITS.MAX_TOOL_TEXT_CHARS,
    messageToText: (message) => {
      const raw = services.messageText(message?.content);
      return raw ? cleanReply(raw) : '';
    },
    callModel: (conversation) => services.chat(conversationSettings, key, conversation, tools, turn.controller.signal),
    executeTool: async (call) => {
      turn.toolsExecuted = true;
      const toolResult = await executeTool(turn, call, providerName);
      logger.info('tool result', `${call.function?.name || 'unknown'}: ${toolResult.ok ? 'ok' : cleanError(toolResult.error)}`);
      return toolResult;
    }
  });
  return result.content;
}

async function runAgent(turn, transcript) {
  const target = await turn.targetPromise;
  const provider = settings.chatProvider;
  try {
    return await runConversation(turn, transcript, provider, target);
  } catch (error) {
    if (error.cancelled || !turnAlive(turn)) throw error;
    const canFallback = !turn.toolsExecuted
      && provider === 'local'
      && settings.fallbackEnabled
      && settings.fallbackProvider
      && settings.fallbackProvider !== 'none'
      && settings.fallbackProvider !== 'local'
      && (!isCloudProvider(settings.fallbackProvider) || Boolean(secrets[settings.fallbackProvider]));
    if (!canFallback) throw error;
    logger.warn('model', `${provider} failed; trying ${settings.fallbackProvider}: ${cleanError(error)}`);
    overlay.setState({ status: 'thinking', message: `Local model unavailable. Trying ${settings.fallbackProvider}…` });
    return runConversation(turn, transcript, settings.fallbackProvider, target);
  }
}

function sendToPlayer(channel, payload) {
  logger.info('speech', 'player <- ' + channel);
  if (recorderWindow && !recorderWindow.isDestroyed() && !recorderWindow.webContents.isDestroyed()) {
    try {
      recorderWindow.webContents.send(channel, payload);
      return true;
    } catch (error) {
      logger.warn('speech', `Could not send ${channel} to player: ${cleanError(error)}`);
    }
  }
  return sendToDashboard(channel, payload);
}
async function speakReply(turn, text) {
  if (!settings.spokenReplies) return;
  const speech = stripForSpeech(text);
  if (!speech) return;
  speechController?.abort(); sendToPlayer('tts:stop-audio', {});
  speechController = new AbortController();
  const controller = speechController;
  try {
    // Extract TTS settings with safe defaults
    const tts = {
      ttsEngine: settings.ttsEngine,
      ttsVoice: settings.ttsVoice,
      ttsSpeed: settings.ttsSpeed,
      ttsVolume: settings.ttsVolume,
      ttsGpu: settings.ttsGpu,
      ttsModelVariant: settings.ttsModelVariant
    };
    await services.speakStreaming(speech, tts, controller.signal, logger, (buffer) => {
      sendToPlayer('tts:play-audio', buffer);
    });
  } catch (error) {
    logger.warn('speech', cleanError(error));
  } finally {
    if (speechController === controller) {
      speechController = null;
      // Playback really ended: tell the island so the companion stops speaking.
      if (overlay?.state().speaking) overlay.setState({ speaking: false });
    }
  }
}

async function processTurn(turn, audio, mime) {
  if (!turnAlive(turn) || turn.processing) return;
  turn.processing = true;
  try {
    overlay.setState({ status: 'thinking', message: 'Transcribing…' });
    const transcript = await transcribeAudio(audio, mime, turn.controller.signal);
    if (!turnAlive(turn)) return;
    turn.transcript = transcript;
    if (!transcript) {
      showTurnError(turn, MESSAGES.HEARD_NOTHING, 'Transcription returned no text.');
      return;
    }
    logger.info('transcript', transcript.slice(0, 1000));
    if (turn.mode === 'dictation') {
      if (!turnAlive(turn)) return;
      overlay.setState({ status: 'thinking', message: 'Typing into your app…' });
      const target = await requireTurnTarget(turn);
      await desktop.typeText(transcript, target, turn.controller.signal);
      if (!turnAlive(turn)) return;
      addTurn(transcript, 'Dictated into the focused app.');
      finishTurn(turn);
      overlay.show({ status: 'answer', mode: 'dictation', message: transcript, canCopy: true, approval: null, streaming: false, speaking: false });
      scheduleOverlayHide(3500);
      return;
    }
    overlay.setState({ status: 'thinking', message: 'Thinking…' });
    const answer = await runAgent(turn, transcript);
    if (!turnAlive(turn)) return;
    finishTurn(turn);
    addTurn(transcript, answer);
    const willSpeak = Boolean(settings.spokenReplies && stripForSpeech(answer));
    overlay.show({ status: 'answer', mode: 'agent', message: answer, canCopy: true, approval: null, streaming: false, speaking: willSpeak });
    scheduleOverlayHide(12000);
    void speakReply(turn, answer);
  } catch (error) {
    if (error.cancelled || turn.controller.signal.aborted) return;
    showTurnError(turn, cleanError(error), `Turn failed: ${cleanError(error)}`);
  }
}

async function toggleTalk(source = 'button', mode = settings.mode) {
  if (currentTurn?.recording && !currentTurn.stopping) {
    releaseTurn(currentTurn.mode, source);
    return false;
  }
  if (currentTurn) {
    abortTurn(source === 'tray' ? 'tray stop' : 'button stop');
    return false;
  }
  return beginTurn(mode, source);
}

async function runMicTest() {
  if (currentTurn) throw new Error('Finish the current turn before testing the microphone.');
  if (micTestRunning) throw new Error('A microphone test is already running.');
  speechController?.abort(); sendToPlayer('tts:stop-audio', {});
  speechController = null;
  micTestRunning = true;
  try {
    sendToDashboard('microphone:test-progress', 'Recording 3 seconds…');
    const result = await queueRecorderOperation(() => recorderRequest('test', {
      deviceId: settings.microphoneId,
      durationMs: LIMITS.MIC_TEST_DURATION_MS
    }, 30000));
    const audio = toBuffer(result?.audio);
    if (!audio.length) throw new Error('The microphone returned no audio.');
    if (Number(result.durationMs) < LIMITS.MIN_AUDIO_MS || Number(result.rms) < LIMITS.SILENCE_RMS) {
      throw new Error(MESSAGES.HEARD_NOTHING);
    }
    sendToDashboard('microphone:test-progress', 'Transcribing…');
    const transcript = await transcribeAudio(audio, result.mime, null);
    if (!transcript) throw new Error(MESSAGES.HEARD_NOTHING);
    sendToDashboard('microphone:test-result', { transcript });
    logger.info('microphone test', transcript.slice(0, 500));
    return { transcript };
  } finally {
    micTestRunning = false;
  }
}

function previewOverlay(status, message) {
  if (currentTurn) throw new Error('Finish the current turn before previewing the overlay.');
  if (chatSession.open) throw new Error('Close chat before previewing the overlay.');
  const allowed = ['idle', 'listening', 'thinking', 'executing', 'verifying', 'answer', 'approval', 'error', 'done', 'chat', 'feed'];
  const next = allowed.includes(String(status).toLowerCase()) ? String(status).toLowerCase() : 'listening';
  if (next === 'idle') {
    clearOverlayHideTimer();
    overlay.hide();
    return true;
  }
  const isChat = next === 'chat';
  const isFeed = next === 'feed';
  const approval = next === 'approval'
    ? { id: 'preview', title: 'Allow this sample action?', detail: message || 'This is a preview; no action will run.', tool: 'preview' }
    : null;
  overlay.show({
    status: next,
    mode: settings.mode,
    message: isChat || isFeed ? '' : message || `Overlay preview · ${next}`,
    approval,
    notifications: isFeed ? galleryNotifications() : [],
    feedPreview: isFeed,
    canCopy: next === 'answer',
    chatOpen: isChat,
    chatPreview: isChat,
    chatStreaming: false,
    speaking: next === 'answer' && Boolean(settings.spokenReplies)
  });
  const motionScale = overlay.state().slowMotion ? 4 : 1;
  scheduleOverlayHide((next === 'approval' ? 8000 : next === 'done' ? 3200 : 6000) * motionScale);
  return true;
}

// Reference 1 feed samples for the gallery. These are Voxa-internal events by
// design (labels, thumbnails, timestamps); real producers arrive in Phases E/H.
function galleryNotifications() {
  const now = Date.now();
  return [
    { id: 'sample-turn', title: 'Agent finished the task', body: 'Opened Notepad and typed the review notes. Everything went through the approval you allowed.', ts: now, kind: 'turn', tone: 'highlight' },
    { id: 'sample-download', title: 'Whisper model downloaded', body: 'Voice recognition model staged and ready to transcribe.', ts: now - 14 * 60000, kind: 'download', tone: 'neutral' },
    { id: 'sample-media', title: 'Media controls connected', body: 'Playback info and controls are wired to the island.', ts: now - 52 * 60000, kind: 'media', tone: 'neutral' }
  ];
}

function senderRole(event) {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner.isDestroyed()) return null;
  const role = owner === dashboardWindow
    ? 'dashboard'
    : owner === recorderWindow
      ? 'recorder'
      : owner === overlay?.getWindow()
        ? 'overlay'
        : null;
  if (!role) return null;
  const url = event.senderFrame?.url || event.sender.getURL();
  return typeof url === 'string' && url.startsWith('file://') ? role : null;
}

function trustedSender(event) {
  return Boolean(senderRole(event));
}

function assertTrusted(event, expectedRole = '') {
  const role = senderRole(event);
  if (role && (!expectedRole || role === expectedRole)) return role;
  logger.warn('ipc', `Blocked a message from ${role || 'an untrusted'} renderer.`);
  throw new Error('Untrusted IPC sender.');
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrusted(event, 'dashboard');
    return handler(...args);
  });
}

function listen(channel, handler, roles = ['dashboard']) {
  ipcMain.on(channel, (event, ...args) => {
    const role = senderRole(event);
    if (!role || !roles.includes(role)) {
      logger.warn('ipc', `Blocked ${role || 'untrusted'} ${channel} message.`);
      return;
    }
    try {
      const result = handler(...args);
      if (result && typeof result.catch === 'function') result.catch((error) => logger.error('ipc', `${channel}: ${cleanError(error)}`));
    } catch (error) {
      logger.error('ipc', `${channel}: ${cleanError(error)}`);
    }
  });
}

function registerIpc() {
  handle('app:state', () => buildDashboardState());
  handle('updater:get-status', () => updater.getStatus());
  handle('updater:check', () => updater.checkNow());
  handle('updater:download', () => updater.downloadUpdate());
  handle('updater:install', () => updater.installNow());
  handle('settings:save', (patch) => saveSettingsPatch(patch));
  handle('provider:save-key', (provider, key) => {
    if (typeof provider !== 'string' || !Object.hasOwn(settings.providers, provider) || provider === 'local') throw new Error('Unknown provider.');
    const value = String(key || '').trim();
    if (value.includes('\n') || value.includes('\r') || value.length > 10000) throw new Error('That API key is not valid.');
    const nextSecrets = { ...secrets };
    if (value) nextSecrets[provider] = value;
    else delete nextSecrets[provider];
    store.writeSecrets(nextSecrets);
    secrets = nextSecrets;
    clearModelCache(provider);
    if (!value && settings.fallbackEnabled && settings.fallbackProvider === provider && isCloudProvider(provider)) {
      settings.fallbackEnabled = false;
      persistSettings();
      broadcast('settings:updated', publicSettings());
      logger.warn('settings', `Fallback was disabled because the ${provider} API key was removed.`);
    }
    logger.info('provider', `${provider} key ${value ? 'saved' : 'removed'}`);
    if (settings.chatProvider === provider) healthChecks().catch((error) => logger.warn('health', cleanError(error)));
    return { saved: Boolean(value) };
  });
  handle('provider:models', async (provider, config = {}, options = {}) => {
    return loadProviderModels(provider, config, Boolean(options?.force));
  });
  handle('provider:test', async (provider, config = {}, apiKey = '') => {
    if (typeof provider !== 'string' || !Object.hasOwn(settings.providers, provider)) return { ok: false, message: 'Unknown provider.' };
    const base = { ...settings.providers[provider] };
    const url = store.normalizeProviderUrl(provider, config?.url || base.url);
    if (!url) return { ok: false, message: store.BASE_URL_ERROR };
    base.url = url;
    if (config?.model) base.model = String(config.model).trim().slice(0, 200);
    const key = providerNeedsKey(provider) ? String(apiKey || '').trim() || secrets[provider] || '' : '';
    if (providerNeedsKey(provider) && !key) return { ok: false, message: `Add an API key for ${provider} first.` };
    try {
      const result = await services.checkHealth(provider, base, key, null, base.model);
      clearModelCache(provider);
      return {
        ok: Boolean(result.modelAvailable),
        connected: true,
        message: result.modelAvailable ? `Connection successful · ${result.model}` : `Connected, but ${result.model} is not in the model list.`
      };
    } catch (error) {
      return { ok: false, message: cleanError(error) };
    }
  });
  handle('provider:detect', () => services.detectFreeLlmApi());
  handle('ollama:pull', async () => {
    if (ollamaPullRunning) throw new Error('An Ollama model download is already running.');
    const base = services.ollamaBase(settings.providers.local.url);
    const model = settings.providers.local.model;
    ollamaPullRunning = true;
    try {
      await services.ensureOllamaRunning(base, logger);
      const result = await services.pullOllamaModel(base, model, (progress) => {
        sendToDashboard('ollama:pull-progress', progress);
      }, logger);
      await healthChecks().catch((error) => logger.warn('health', cleanError(error)));
      return result;
    } finally {
      ollamaPullRunning = false;
    }
  });
  handle('ollama:open-download', () => openExternalLink('https://ollama.com/download/windows'));
  handle('whisper:models', async () => {
    const health = await services.whisperHealth(WHISPER_PORT);
    if (health.status === 'unreachable') {
      return {
        ok: false,
        error: health.error || 'Whisper is not running.',
        models: whisperModelSummary(health)
      };
    }
    return services.whisperModels(WHISPER_PORT);
  });
  handle('whisper:load', (model) => switchWhisperModel(model));
  handle('whisper:cancel', () => cancelWhisperSwitch());
  handle('health:check', () => healthChecks());
  handle('microphone:list', () => queueRecorderOperation(() => recorderRequest('enumerate', {}, 20000)));
  handle('microphone:test', async () => {
    try {
      return await runMicTest();
    } catch (error) {
      sendToDashboard('microphone:test-error', cleanError(error));
      throw error;
    }
  });
  handle('microphone:monitor', (enabled, deviceId = settings.microphoneId) => queueRecorderOperation(() => recorderRequest(
    enabled ? 'monitor-start' : 'monitor-stop',
    enabled ? { deviceId } : {},
    15000
  )));
  handle('assistant:toggle', async () => ({ active: await toggleTalk('button', settings.mode) }));
  handle('assistant:stop', () => {
    // If we have an active speech controller, abort it to stop speech output immediately.
    speechController?.abort(); sendToPlayer('tts:stop-audio', {});
    speechController = null;
    // Stop renderer playback.
    sendToPlayer('tts:stop-audio', {});
    return { stopped: abortTurn('stop button') };
  });
  handle('assistant:set-mode', (payload = {}) => {
    const patch = {};
    if (payload.mode !== undefined) {
      if (!['agent', 'dictation'].includes(payload.mode)) throw new Error('Unknown assistant mode.');
      patch.mode = payload.mode;
    }
    if (payload.provider !== undefined) {
      if (!Object.hasOwn(settings.providers, payload.provider)) throw new Error('Unknown provider.');
      patch.chatProvider = payload.provider;
      patch.activeMode = payload.provider === 'local' ? 'local' : 'cloud';
      if (payload.provider !== 'local') patch.lastCloudProvider = payload.provider;
    }
    const saved = saveSettingsPatch(patch);
    broadcast('provider-mode', { mode: saved.activeMode, provider: saved.chatProvider });
    return saved;
  });
  handle('history:clear', () => {
    history = [];
    store.writeJson('history.json', history);
    broadcast('history:updated', []);
    if (!chatSession.controller) {
      chatSession.messages = [];
      if (chatSession.open) sendChatHistory();
    }
    return true;
  });
  handle('apps:refresh', () => apps.refreshApps(logger).map((item) => item.name));
  handle('logs:read', () => logger.read(LIMITS.MAX_LOG_LINES));
  handle('overlay:preview', (status, message) => previewOverlay(status, message));
  handle('overlay:test', () => previewOverlay('listening', 'Overlay test from the dashboard.'));
  handle('overlay:gallery-options', (options = {}) => {
    overlay?.setPreviewOptions({ slowMotion: Boolean(options?.slowMotion) });
    return true;
  });
  handle('tts:health', () => {
    const kokoro = require('./lib/tts-kokoro.cjs');
    const variant = settings.ttsModelVariant || 'quantized';
    const spec = kokoro.MODEL_VARIANTS[variant] || kokoro.MODEL_VARIANTS.quantized;
    const modelReady = kokoro.isModelReady(variant);
    const hasConsent = kokoro.hasConsent();
    const running = kokoro.kokoroStatus().running;
    return {
      status: modelReady ? (running ? 'ready' : 'downloaded') : (hasConsent ? 'not-downloaded' : 'needs-consent'),
      modelReady,
      hasConsent,
      running,
      variant,
      sizeBytes: spec.sizeBytes,
      filename: spec.filename,
      error: kokoro.kokoroStatus().error || ''
    };
  });
  handle('tts:download', async () => {
    if (kokoroDownloadController) throw new Error('A Kokoro download is already running.');
    const kokoro = require('./lib/tts-kokoro.cjs');
    const variant = settings.ttsModelVariant || 'quantized';
    const spec = kokoro.MODEL_VARIANTS[variant] || kokoro.MODEL_VARIANTS.quantized;
    const sizeMb = Math.round(spec.sizeBytes / 1_048_576);
    // Show consent dialog (no-op if already granted).
    const granted = await kokoro.requestConsent(sizeMb);
    if (!granted) {
      publishKokoroHealth({ status: 'needs-consent', modelReady: false, hasConsent: false, variant });
      return { ok: false, message: 'Download cancelled.' };
    }
    const controller = new AbortController();
    kokoroDownloadController = controller;
    publishKokoroHealth({ status: 'downloading', modelReady: false, hasConsent: true, variant, progress: { percent: 0, totalBytes: spec.sizeBytes, downloadedBytes: 0 } });
    try {
      await kokoro.ensureModelFile(variant, controller.signal, {
        info: (_tag, msg) => {
          logger.info('kokoro download', msg);
          const match = msg.match(/(\d+)%/);
          const pct = match ? parseInt(match[1], 10) : null;
          publishKokoroHealth({ status: 'downloading', modelReady: false, hasConsent: true, variant,
            progress: { percent: pct, totalBytes: spec.sizeBytes, downloadedBytes: pct != null ? Math.round(pct / 100 * spec.sizeBytes) : 0 }
          });
        }
      });
      if (controller.signal.aborted) {
        publishKokoroHealth({ status: 'not-downloaded', modelReady: false, hasConsent: true, variant });
        return { ok: false, message: 'Download cancelled.' };
      }
      publishKokoroHealth({ status: 'downloaded', modelReady: true, hasConsent: true, variant });
      logger.info('kokoro', `Model ${spec.filename} ready.`);
      return { ok: true, message: 'Kokoro model downloaded.' };
    } catch (err) {
      if (!err.cancelled) logger.warn('kokoro', `Download failed: ${cleanError(err)}`);
      publishKokoroHealth({ status: err.cancelled ? 'not-downloaded' : 'error', modelReady: false, hasConsent: true, variant, error: cleanError(err) });
      if (err.cancelled) return { ok: false, message: 'Download cancelled.' };
      throw new Error(cleanError(err));
    } finally {
      if (kokoroDownloadController === controller) kokoroDownloadController = null;
    }
  });
  handle('tts:cancel-download', () => {
    if (!kokoroDownloadController) return { ok: false };
    kokoroDownloadController.abort();
    kokoroDownloadController = null;
    return { ok: true };
  });
  handle('tts:speak', async (text, settings, signal) => {
    const tts = {
      ttsEngine: settings?.ttsEngine || 'windows',
      ttsVoice: settings?.ttsVoice,
      ttsSpeed: settings?.ttsSpeed,
      ttsVolume: settings?.ttsVolume,
      ttsGpu: settings?.ttsGpu,
      ttsModelVariant: settings?.ttsModelVariant
    };
    try {
      await services.speakStreaming(String(text || ''), tts, signal, logger, (buffer) => {
        sendToDashboard('tts:play-audio', buffer);
      });
      return { ok: true };
    } catch (error) {
      logger.warn('speech', cleanError(error));
      return { ok: false, error: cleanError(error) };
    }
  });
  handle('voice:test', async () => {
    if (currentTurn) throw new Error('Finish the current turn before testing voice.');
    if (micTestRunning) throw new Error('Wait for the microphone test to finish before testing voice.');
    speechController?.abort(); sendToPlayer('tts:stop-audio', {});
    const controller = new AbortController();
    speechController = controller;
    try {
      const tts = {
        ttsEngine: settings.ttsEngine,
        ttsVoice: settings.ttsVoice,
        ttsSpeed: settings.ttsSpeed,
        ttsVolume: settings.ttsVolume,
        ttsGpu: settings.ttsGpu,
        ttsModelVariant: settings.ttsModelVariant
      };
      await services.speakStreaming(`This is a voice test from ${APP_NAME}.`, tts, controller.signal, logger, (buffer) => {
        sendToDashboard('tts:play-audio', buffer);
      });
      if (controller.signal.aborted) return { ok: false, message: 'Voice test stopped.' };
      const engine = settings.ttsEngine === 'kokoro' ? 'Kokoro' : 'Windows';
      return { ok: true, message: `${engine} voice test finished.` };
    } finally {
      if (speechController === controller) speechController = null;
    }
  });
  handle('window:action', (action) => {
    if (String(action).startsWith('zoom:')) {
      const zoom = Math.max(0.75, Math.min(2, Number(String(action).slice(5)) || 1));
      if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.setZoomFactor(zoom);
      return true;
    }
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return false;
    if (action === 'minimize') dashboardWindow.minimize();
    else if (action === 'maximize') dashboardWindow.isMaximized() ? dashboardWindow.unmaximize() : dashboardWindow.maximize();
    else if (action === 'close') dashboardWindow.hide();
    else if (action === 'quit') app.quit();
    return true;
  });

  listen('approval:respond', (payload) => {
    if (payload && typeof payload === 'object') return respondApproval(payload.id, payload.allowed);
    return false;
  }, ['overlay', 'dashboard']);
  listen('overlay:resize', (size) => {
    if (!size || typeof size !== 'object') return;
    overlay.resize(Number(size.width) || 0, Number(size.height) || 0);
  }, ['overlay']);
  listen('overlay:interactive', (active) => {
    overlay?.setInteractive(Boolean(active));
  }, ['overlay']);
  listen('overlay:hidden', () => {
    overlay?.acknowledgeHide();
  }, ['overlay']);
  listen('overlay:expand', (payload) => {
    const mode = String(payload?.mode || '');
    overlay?.setExpand(mode);
  }, ['overlay']);
  listen('overlay:dismiss-pause', () => {
    pauseOverlayHide();
  }, ['overlay']);
  listen('overlay:dismiss-resume', () => {
    resumeOverlayHide();
  }, ['overlay']);
  listen('overlay:stop', () => {
    abortTurn('overlay stop button');
  }, ['overlay']);
  listen('overlay:copy', (text) => {
    clipboard.writeText(String(text || '').slice(0, 20000));
  }, ['overlay']);
  listen('overlay:notification-dismiss', (payload) => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    if (!id) return false;
    overlay?.dismissNotification(id);
    return true;
  }, ['overlay']);
  listen('chat:open', () => openChat(), ['overlay']);
  listen('chat:close', () => closeChat(), ['overlay']);
  listen('chat:request-history', () => sendChatHistory(), ['overlay']);
  listen('chat:send', (payload) => sendChat(payload), ['overlay']);
  listen('chat:cancel', () => cancelChat(), ['overlay']);
  listen('recorder:response', (message) => {
    if (!message || typeof message.id !== 'number') return;
    const pending = pendingRecorderRequests.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRecorderRequests.delete(message.id);
    if (message.ok) pending.resolve(message.data);
    else pending.reject(new Error(message.error || 'Microphone request failed.'));
  }, ['recorder']);
  listen('recorder:audio-level', (payload) => {
    const peak = Math.max(0, Math.min(1, Number(payload?.peak) || 0));
    sendToDashboard('audio-level', { peak });
    overlay?.audioLevel(peak);
  }, ['recorder']);
  listen('recorder:test-progress', (text) => sendToDashboard('microphone:test-progress', String(text || '')), ['recorder']);
  listen('recorder:audio', (payload) => {
    const turn = currentTurn;
    if (!turn || !payload || payload.sessionId !== turn.recorderId) {
      logger.warn('recording', 'Ignored audio from a stale recording session.');
      return;
    }
    if (!turn.audioRequested) return;
    clearTimeout(turn.audioTimer);
    const audio = toBuffer(payload.audio);
    const durationMs = Number(payload.durationMs) || 0;
    const rms = Number(payload.rms) || 0;
    if (!audio.length) {
      showTurnError(turn, MESSAGES.HEARD_NOTHING, 'The recorder returned no audio bytes.');
      return;
    }
    if (durationMs < LIMITS.MIN_AUDIO_MS || rms < LIMITS.SILENCE_RMS) {
      logger.info('recording', `Rejected quiet audio: duration=${durationMs}ms rms=${rms}`);
      showTurnError(turn, MESSAGES.HEARD_NOTHING, 'Audio was below the silence threshold.');
      return;
    }
    logger.info('recording', `Audio received: ${audio.length} bytes, ${durationMs} ms, rms=${rms.toFixed(4)}`);
    void processTurn(turn, audio, payload.mime || 'audio/webm');
  }, ['recorder']);
  listen('recorder:error', (payload) => {
    const message = String(payload?.message || payload || 'Microphone error.');
    logger.error('recorder', message);
    const turn = currentTurn;
    if (turn && (!payload?.sessionId || payload.sessionId === turn.recorderId)) {
      if (turn.recorderId) recorderManager?.cancel(turn.recorderId, 'microphone error');
      showTurnError(turn, `Microphone error: ${message}`);
    } else {
      sendToDashboard('microphone:test-error', message);
    }
  }, ['recorder']);
  listen('recorder:ready', () => logger.info('recorder', 'Microphone renderer ready'), ['recorder']);
}

app.on('second-instance', (_event, argv) => {
  showDashboard();
  if (argv.includes('--gallery') || argv.includes('--ui-gallery')) {
    sendToDashboardWhenReady('settings:refresh');
  }
});

app.on('activate', () => {
  showDashboard();
});

app.on('window-all-closed', () => {
  if (quitting) app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  currentTurn?.controller.abort();
  chatSession.controller?.abort();
  approvalGate.cancelAll();
  if (currentTurn?.recorderId) recorderManager?.cancel(currentTurn.recorderId, 'app quit');
  speechController?.abort(); sendToPlayer('tts:stop-audio', {});
  speechController = null;
  hotkeys?.stop();
  desktop.disposeFocusHelper();
  services.stopWhisper();
  services.stopKokoro();
  overlay?.destroy();
  if (recorderWindow && !recorderWindow.isDestroyed()) recorderWindow.destroy();
});

process.on('uncaughtException', (error) => {
  console.error('[voxa] Uncaught exception:', error);
  try {
    logger.error('app', `Uncaught exception: ${error.message}`);
  } catch {
    // The process is already in a bad state; keep the console trace.
  }
});
process.on('unhandledRejection', (error) => {
  console.error('[voxa] Unhandled rejection:', error);
  try {
    logger.error('app', `Unhandled rejection: ${error?.message || error}`);
  } catch {
    // Ignore logger failure during shutdown.
  }
});

function prepareLogFile() {
  const file = path.join(app.getPath('userData'), 'activation.log');
  try {
    const stat = fs.statSync(file);
    if (stat.size > 0) {
      const descriptor = fs.openSync(file, 'r');
      const first = Buffer.alloc(1);
      fs.readSync(descriptor, first, 0, 1, 0);
      fs.closeSync(descriptor);
      if (first[0] !== 0x7b) {
        const archived = `${file}.legacy-${Date.now()}`;
        fs.renameSync(file, archived);
        console.warn(`[voxa] Archived the previous plain-text log at ${archived}. It may contain old keystrokes and can be deleted.`);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`[voxa] Could not inspect the old log: ${error.message}`);
  }
  return file;
}

async function initialize() {
  try {
    const logPath = prepareLogFile();
    logger.setLogFile(logPath);
    logger.subscribe((entry) => sendToDashboard('log:entry', entry));
    logger.info('app', `${APP_NAME} ${app.getVersion()} starting on Electron ${process.versions.electron}`);
    settings = store.loadSettings(defaults(userName), userName, logger, isValidHotkey);
    normalizeSettings();
    secrets = store.readSecrets(logger);
    if (settings.fallbackEnabled && isCloudProvider(settings.fallbackProvider) && !secrets[settings.fallbackProvider]) {
      settings.fallbackEnabled = false;
      persistSettings();
      logger.warn('settings load', `Fallback was disabled because no API key is saved for ${settings.fallbackProvider}.`);
    }
    history = store.loadHistory(logger);
    memory = store.loadMemory(logger);
    Menu.setApplicationMenu(null);
    desktop.warmFocusHelper();
    configureRecorderSession();
    registerIpc();
    overlay = createOverlay({ log: logger });
    overlay.create();
    overlay.setStyle(settings.overlayStyle);
    overlay.setState({ companionEnabled: settings.companionEnabled, speaking: false });
    attachConsoleLogging(overlay.getWindow(), 'overlay');
    recorderManager = createRecorderManager({ getWindow: () => recorderWindow, log: logger });
    hotkeys = createHotkeys({
      log: logger,
      onDictation: () => { beginTurn('dictation', 'hotkey').catch((error) => logger.error('hotkey', cleanError(error))); },
      onAgent: () => { beginTurn('agent', 'hotkey').catch((error) => logger.error('hotkey', cleanError(error))); },
      onDictationEnd: () => releaseTurn('dictation', 'hotkey released'),
      onAgentEnd: () => releaseTurn('agent', 'hotkey released')
    });
    screen.on('display-metrics-changed', () => overlay.reposition());
    screen.on('display-added', () => overlay.reposition());
    screen.on('display-removed', () => overlay.reposition());
    await ensureRecorder();
    createTray();
    if (!GALLERY) {
      hotkeys.configure({ dictationHotkey: settings.dictationHotkey, agentHotkey: settings.agentHotkey });
      const hook = hotkeys.start();
      if (!hook.ok) {
        logger.warn('hotkeys', hook.error || 'Global shortcut listener unavailable.');
        overlay.show({ status: 'error', message: `Global shortcuts unavailable. ${hook.error || 'Use the dashboard Talk now button.'}`, approval: null, canCopy: false });
        scheduleOverlayHide(8000);
      }
    }
    if (SELF_TEST) {
      const { runRuntimeSelfTest } = require('./lib/selftest-runtime.cjs');
      createDashboard(false);
      await runRuntimeSelfTest({
        app,
        logger,
        settings,
        store,
        services,
        apps,
        overlay,
        recorder: recorderManager,
        screen,
        getDashboard: () => dashboardWindow,
        ensureRecorder,
        recorderRequest,
        queueRecorderOperation,
        transcribeAudio,
        healthChecks,
        ensureWhisper,
        WHISPER_PORT,
        hotkeys
      });
      return;
    }
    if (GALLERY || !START_HIDDEN) showDashboard();
    updater.init(() => dashboardWindow, store, logger, {
      isBusy: () => Boolean(currentTurn || turnRunning || micTestRunning),
      onStatus: (status) => broadcast('updater:status', status)
    });
    applyAutostart();
    if (!GALLERY) warmServices();
    // Initial Kokoro health check
    const kokoro = require('./lib/tts-kokoro.cjs');
    kokoro.kokoroHealth().then(publishKokoroHealth).catch((err) => logger.warn('kokoro', `Initial health check failed: ${err.message}`));
    logger.info('app', 'Startup complete');
  } catch (error) {
    const message = cleanError(error);
    console.error('[voxa] Startup failed:', error);
    try {
      logger.error('startup', message);
    } catch {
      // Logger may not be configured yet.
    }
    dialog.showErrorBox(`${APP_NAME} could not start`, message);
    app.quit();
  }
}

if (SELF_TEST || app.requestSingleInstanceLock()) {
  app.whenReady().then(initialize).then(() => {
  setTimeout(() => {
    if (settings && settings.ttsEngine === 'kokoro') {
      const started = Date.now();
      require('./lib/kokoro-tts.cjs').warmup()
        .then(() => logger.info('speech', 'kokoro warmup done in ' + (Date.now() - started) + ' ms'))
        .catch((e) => logger.warn('speech', 'kokoro warmup failed: ' + e.message));
    }
  }, 5000);
});
} else {
  app.quit();
}
