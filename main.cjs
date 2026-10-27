'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {
  app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, powerMonitor, screen, session, shell
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
const { createAsrService } = require('./lib/asr-service.cjs');
const { optionalEngine, summarizeAsr, normalizeAsrModels, BUSY_STATES } = require('./lib/asr-health.cjs');
const { createRecorderManager } = require('./lib/recorder.cjs');
const { createOverlay } = require('./lib/overlay.cjs');
const { createHotkeys, isValidHotkey } = require('./lib/hotkeys.cjs');
const mediaSmtc = require('./lib/media-smtc.cjs');
const ttsText = require('./lib/tts-text.cjs');
const {
  whisperIslandDownload,
  whisperStartingIslandDownload,
  kokoroIslandDownload,
  ollamaIslandDownload
} = require('./lib/island-download.cjs');
const {
  APP_NAME, APPROVABLE_TOOLS, ASR_ENGINES, LIMITS, MESSAGES, NOTCH_OPTIONS, NOTCH_OFFSET_RANGE, NOTCH_SCALE_RANGE,
  STT_CLOUD_PROVIDERS, TOOL_DEFINITIONS, TOOL_NAMES, WHISPER_MODELS, WHISPER_PRESETS, defaults
} = require('./lib/constants.cjs');

const START_HIDDEN = process.argv.includes('--hidden');
const GALLERY = process.argv.includes('--gallery') || process.argv.includes('--ui-gallery');
const SELF_TEST = process.argv.includes('--selftest-worker') || Boolean(process.env.VOXA_SELFTEST_OUTPUT);
const RECORDER_PARTITION = 'persist:voxa-recorder';
const WHISPER_PORT = LIMITS.WHISPER_PORT;
let whisperPort = WHISPER_PORT;

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('Could not reserve a local port for Whisper.'))));
    });
  });
}

// Port 8000 is also a common ad-hoc HTTP port. If another service owns it,
// keep Voxa's Whisper server on an ephemeral loopback port instead of sending
// control requests to that service (which may answer /load_model with 501).
async function resolveWhisperPort() {
  const health = await services.whisperHealth(WHISPER_PORT);
  const voxaLike = health.status !== 'http-error'
    && health.status !== 'unreachable'
    && (Object.hasOwn(health, 'launch_id') || Object.hasOwn(health, 'active_model') || Array.isArray(health.models));
  if (voxaLike) {
    whisperPort = WHISPER_PORT;
    return whisperPort;
  }
  // A loopback bind can succeed while another listener still answers on
  // 127.0.0.1 (the Python http.server case on Windows), so an HTTP error at
  // /health means the port is effectively taken even if bind() says otherwise.
  if (health.status !== 'http-error' && await portAvailable(WHISPER_PORT)) {
    whisperPort = WHISPER_PORT;
    return whisperPort;
  }
  whisperPort = await freePort();
  logger.warn('whisper server', `Port ${WHISPER_PORT} is already used by another service; using port ${whisperPort} for Whisper.`);
  return whisperPort;
}

let userName = 'User';
try {
  userName = os.userInfo().username || userName;
} catch {
  // Keep the generic fallback if the OS account name is unavailable.
}

let settings;
let secrets = {};
let history = [];
let historyEpoch = 0;
let memory = [];
let lastOpenedApp = null;
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
  asr: { mode: 'bundled', engine: 'whisper', status: 'bundled', message: 'The bundled Whisper server handles local dictation.' },
  kokoro: { status: 'unknown' }
};
let asrService = null;
let asrLastStatus = null;
let asrLastError = '';
let asrTranscribing = false;
let asrWatchTimer = null;
let asrWatchToken = 0;
let kokoroDownloadController = null;
let currentTurn = null;
let turnRunning = false;
let nextTurnId = 1;
let nextChatId = 1;
const chatSession = {
  open: false,
  requestId: 0,
  generation: 0,
  controller: null,
  messages: []
};
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const modelListCache = new Map();
const approvalGate = createApprovalGate({
  timeoutMs: LIMITS.APPROVAL_TIMEOUT_MS,
  onTimeout: () => {
    clearApprovalFallback();
    logger.warn('approval', 'The approval request timed out and was denied.');
    if (currentTurn) overlay?.setState({ status: 'thinking', message: 'Approval timed out. Nothing was run.', approval: null });
  }
});
const APPROVAL_NATIVE_FALLBACK_MS = 2000;
let approvalFallbackTimer = null;
let approvalNativeDialogId = '';
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
// What the settle of the hide timer does by default: hide the overlay ('hide')
// or fold an open chat back to the idle pill ('chat'). Hover pause/resume only
// applies to the disposition that is actually counting down.
let hideDisposition = 'hide';
// The chevron / a finished chat reply never closes the island outright: the
// pill folds back to the compact idle band and lingers this long before any
// real hide starts (reset by new messages, replies or speech).
const CHAT_LINGER_MS = 10000;
let speechController = null;
let quitting = false;

function userDataDirFromArgv(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '');
    if (arg === '--user-data-dir') {
      const value = String(argv[index + 1] || '').trim();
      if (value && !value.startsWith('--')) return path.resolve(value);
    } else if (arg.startsWith('--user-data-dir=')) {
      const value = arg.slice('--user-data-dir='.length).trim();
      if (value) return path.resolve(value);
    }
  }
  return '';
}

const USER_DATA_DIR = process.env.VOXA_USER_DATA
  ? path.resolve(process.env.VOXA_USER_DATA)
  : userDataDirFromArgv(process.argv) || path.join(app.getPath('appData'), 'my-voice-app');
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

function overlayAppearance(source = settings) {
  return {
    notchSize: source.notchSize,
    notchScale: source.notchScale,
    notchPosition: source.notchPosition,
    notchOffsetY: source.notchOffsetY,
    notchBehavior: source.notchBehavior,
    notchCast: source.notchCast,
    notchPalette: source.notchPalette,
    companionFollow: source.companionFollow
  };
}

// Battery saver keeps Kokoro (and its model load) off the battery by routing
// spoken replies through the built-in Windows voice. The dashboard and the
// notch settings sheet both save the switch; the routing is live here.
function speechSettings(source = settings, extra = {}) {
  const batterySaver = source.ttsBatterySaver !== false && powerMonitor.isOnBatteryPower();
  return {
    ttsEngine: batterySaver ? 'windows' : source.ttsEngine,
    ttsVoice: source.ttsVoice,
    ttsSpeed: source.ttsSpeed,
    ttsVolume: source.ttsVolume,
    ttsGpu: Boolean(source.ttsGpu),
    ttsAutoVoice: source.ttsAutoVoice !== false,
    ttsModelVariant: source.ttsModelVariant,
    ...extra
  };
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
  const health = structuredClone(lastHealth);
  if (!Array.isArray(health.whisper?.models) || health.whisper.models.length === 0) {
    health.whisper = whisperHealthSummary(health.whisper || {});
  }
  return {
    appName: APP_NAME,
    appVersion: app.getVersion(),
    userName,
    gallery: GALLERY,
    settings: publicSettings(),
    turns: structuredClone(history),
    memory: [...memory],
    health,
    asrEngines: structuredClone(ASR_ENGINES),
    activationLogs: logger.read(LIMITS.MAX_LOG_LINES),
    hotkey: hotkeyStatus(),
    apps: apps.appNames(80),
    ttsVoices: ttsText.allVoices(),
    ttsLanguages: ttsText.LANG_LABELS,
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
    transparent: true,
    backgroundColor: '#00000000',
    // Keep the standard Windows thick frame so native edge and corner resizing
    // keeps working; the transparent renderer paints the rounded silhouette.
    thickFrame: true,
    show: false,
    title: APP_NAME,
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
  // The renderer owns the rounded window silhouette, so it has to know when
  // Windows maximizes the window (where square corners are correct).
  const sendWindowState = () => {
    if (!dashboardWindow || dashboardWindow.isDestroyed()) return;
    dashboardWindow.webContents.send('window:state', { maximized: dashboardWindow.isMaximized() });
  };
  dashboardWindow.on('maximize', sendWindowState);
  dashboardWindow.on('unmaximize', sendWindowState);
  dashboardWindow.webContents.on('did-finish-load', sendWindowState);
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

function openNotchSettings() {
  overlay?.setPanel('settings');
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
  // A dashboard unload (for example the Dictation page's beforeunload
  // monitor-stop) must not recreate the microphone window after before-quit
  // destroyed it; a window created during shutdown keeps Voxa alive.
  if (quitting) throw new Error('Voxa is shutting down.');
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
    { label: 'Notch settings', click: openNotchSettings },
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
  const asrEngineChanged = next.asrEngine !== settings.asrEngine;
  const asrDeviceChanged = next.asrDevice !== settings.asrDevice;
  const asrComputeTypeChanged = next.asrComputeType !== settings.asrComputeType;
  const asrChunkChanged = Number(next.asrChunkSeconds) !== Number(settings.asrChunkSeconds);
  const asrLifecycleChanged = asrEngineChanged || asrDeviceChanged || asrComputeTypeChanged || asrChunkChanged;
  const asrOptionalTouched = asrLifecycleChanged
    && (settings.asrEngine !== 'whisper' || next.asrEngine !== 'whisper');
  const hotkeysChanged = next.dictationHotkey !== settings.dictationHotkey || next.agentHotkey !== settings.agentHotkey;
  const overlayStyleChanged = next.overlayStyle !== settings.overlayStyle;
  const companionEnabledChanged = next.companionEnabled !== settings.companionEnabled;
  const appearanceChanged = ['notchSize', 'notchScale', 'notchPosition', 'notchOffsetY', 'notchBehavior', 'notchCast', 'notchPalette', 'companionFollow']
    .some((key) => next[key] !== settings[key]);
  const ttsGpuChanged = Boolean(next.ttsGpu) !== Boolean(settings.ttsGpu);
  const pausedNow = next.paused === true && settings.paused !== true;
  const previousNotchBehavior = settings.notchBehavior;
  const chatChanged = next.chatProvider !== settings.chatProvider
    || JSON.stringify(next.providers) !== JSON.stringify(settings.providers);
  if (hotkeysChanged && (turnRunning || currentTurn)) {
    throw new Error('Finish or cancel the current turn before changing shortcuts.');
  }
  if (asrOptionalTouched && (turnRunning || currentTurn || asrBusy())) {
    throw new Error('Finish or cancel the current turn, download, or model load before changing the speech engine settings.');
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
  if (appearanceChanged) {
    overlay?.setAppearance(overlayAppearance(next));
    if (next.notchBehavior === 'stay-open') clearOverlayHideTimer();
    else if (previousNotchBehavior === 'stay-open') scheduleOverlayHide(4500);
  }
  if (companionEnabledChanged) overlay?.setState({ companionEnabled: next.companionEnabled });
  if (pausedNow) abortTurn('paused', { hide: !overlay?.state().panel });
  if (ttsGpuChanged) {
    services.stopKokoro();
    logger.info('kokoro', `Compute preference changed to ${next.ttsGpu ? 'CUDA' : 'CPU'}; the voice server will restart on the next reply.`);
  }
  if (next.notchBehavior === 'stay-open' && !next.paused && overlay && !overlay.state().visible && !currentTurn && !chatSession.open) {
    showRestingNotch();
  }
  if (whisperDeviceChanged) {
    stopWhisperWatch();
    services.stopWhisper();
    logger.info('whisper server', 'Whisper will restart with the new compute device.');
  } else if (whisperModelChanged) {
    logger.info('whisper server', `Whisper model selection changed to ${next.whisperModel}; the active model stays loaded until the switch is requested.`);
  }
  if (asrEngineChanged && next.asrEngine !== 'whisper') {
    // One active local engine at a time: switching to an optional backend
    // releases Whisper instead of leaving it resident beside the new model.
    stopWhisperWatch();
    services.stopWhisper();
    logger.info('asr', `Speech engine changed to ${next.asrEngine}; Whisper was stopped and the optional service will start only on request.`);
  }
  if (asrOptionalTouched) {
    // Device, compute, chunk size, and engine changes take effect on the next
    // service start. Saving never starts, loads, or downloads an optional ASR
    // model.
    const optionalStopped = Promise.resolve(
      asrService?.stopAndWait ? asrService.stopAndWait() : asrService?.stop()
    );
    stopAsrWatch();
    asrLastStatus = null;
    asrLastError = '';
    logger.info('asr', 'The optional speech service was stopped; it will restart on the next explicit Load or Check status.');
    if (asrEngineChanged && next.asrEngine === 'whisper' && next.sttProvider === 'local') {
      // Returning to the bundled engine preloads Whisper again so the next
      // dictation does not pay the model-load cost. Optional engines themselves
      // stay lazy and never start just because settings were saved.
      optionalStopped
        .catch(() => false)
        .then((exited) => {
          if (!exited) logger.warn('asr', 'The optional speech service did not report a clean exit before Whisper restarted.');
          if (quitting || settings.sttProvider !== 'local' || settings.asrEngine !== 'whisper') return null;
          return ensureWhisper();
        })
        .catch((error) => logger.warn('whisper server', cleanError(error)));
    }
  }
  if (asrLifecycleChanged) publishAsrHealth();
  refreshTray();
  broadcast('settings:updated', publicSettings());
  sendToOverlay('settings:updated', publicSettings());
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
  if (settings.paused) abortTurn('paused', { hide: !overlay?.state().panel });
  // Resuming from the tray while the notch is hidden must honor stay-open just
  // like the dashboard save path does.
  if (!settings.paused && settings.notchBehavior === 'stay-open' && overlay && !overlay.state().visible && !currentTurn && !chatSession.open) {
    showRestingNotch();
  }
  refreshTray();
  broadcast('settings:updated', publicSettings());
  sendToOverlay('settings:updated', publicSettings());
  logger.info('app', settings.paused ? 'Listening paused' : 'Listening resumed');
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function whisperModelSummary(health = {}) {
  const installed = services.whisperInstalledModels();
  const source = Array.isArray(health.models) ? health.models : [];
  const remote = new Map(source.map((item) => [String(item.id || ''), item]));
  return WHISPER_MODELS.map((item) => {
    const live = remote.get(item.id) || {};
    const downloaded = installed[item.id] === true || live.downloaded === true;
    const active = Boolean(live.active);
    return {
      id: item.id,
      label: String(live.label || item.label || item.id),
      sizeBytes: Number(live.size_bytes ?? live.sizeBytes ?? item.sizeBytes) || 0,
      downloaded,
      active,
      status: active ? 'Active' : downloaded ? 'Installed' : 'Not installed'
    };
  });
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
  else if (rawStatus === 'http-error') status = 'error';
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
  // Phase H: the voice-pack download is a real long activity with a percent —
  // mirror it on the island; every other status (ready/cancelled/consent) is a
  // no-op null sync that clears any stale pill state.
  syncIslandDownload(kokoroIslandDownload(status));
}

// One model-readiness shape for getState, tts:health, and startup. The old
// startup probe reported the *server* status ("unreachable" when no Kokoro
// process was listening), which is not the same thing as "model not
// downloaded" and overwrote the real file status in lastHealth.kokoro.
function kokoroModelHealth() {
  const kokoro = require('./lib/tts-kokoro.cjs');
  const variant = settings.ttsModelVariant || 'quantized';
  const spec = kokoro.MODEL_VARIANTS[variant] || kokoro.MODEL_VARIANTS.quantized;
  const modelReady = kokoro.isModelReady(variant);
  const voiceReady = kokoro.isVoiceReady(settings.ttsVoice || 'af_heart');
  const hasConsent = kokoro.hasConsent();
  const running = kokoro.kokoroStatus().running;
  return {
    status: modelReady && voiceReady
      ? (running ? 'ready' : 'downloaded')
      : (hasConsent ? 'not-downloaded' : 'needs-consent'),
    modelReady,
    voiceReady,
    hasConsent,
    running,
    variant,
    sizeBytes: spec.sizeBytes,
    filename: spec.filename,
    error: kokoro.kokoroStatus().error || ''
  };
}

function publishWhisperHealth(health) {
  const summary = whisperHealthSummary(health);
  lastHealth = {
    ...lastHealth,
    whisper: summary,
    checkedAt: new Date().toISOString()
  };
  sendToDashboard('health:updated', structuredClone(lastHealth));
  // Phase H: while a model downloads or loads, the pill mirrors the real
  // progress; on ordinary health states this is a no-op null sync.
  syncIslandDownload(whisperIslandDownload(summary));
}

function selectedAsrEngine() {
  return ASR_ENGINES.find((engine) => engine.id === settings?.asrEngine) || ASR_ENGINES[0];
}

function usingOptionalAsr() {
  return settings?.sttProvider === 'local' && selectedAsrEngine().id !== 'whisper';
}

function asrLaunchConfig(model = settings?.asrEngine) {
  return {
    model: String(model || settings.asrEngine),
    device: settings.asrDevice,
    computeType: settings.asrComputeType,
    language: settings.asrLanguage || '',
    chunkSeconds: settings.asrChunkSeconds
  };
}

function asrSummary(status = asrLastStatus, extra = {}) {
  return summarizeAsr({
    status,
    engineId: settings?.asrEngine || 'whisper',
    running: Boolean(asrService?.isRunning()),
    error: asrLastError,
    ...extra
  });
}

function publishAsrHealth(status, extra = {}) {
  if (status !== undefined) asrLastStatus = status;
  const summary = asrSummary(asrLastStatus, extra);
  lastHealth = {
    ...lastHealth,
    asr: summary,
    checkedAt: new Date().toISOString()
  };
  sendToDashboard('health:updated', structuredClone(lastHealth));
  return summary;
}

function stopAsrWatch(token = 0) {
  if (token && token !== asrWatchToken) return;
  asrWatchToken += 1;
  clearInterval(asrWatchTimer);
  asrWatchTimer = null;
}

function asrBusy() {
  return asrTranscribing
    || Boolean(asrLastStatus?.download_active)
    || BUSY_STATES.has(String(asrLastStatus?.status || '').toLowerCase());
}

function startAsrWatch() {
  if (!asrService) return;
  const token = ++asrWatchToken;
  clearInterval(asrWatchTimer);
  let polling = false;
  const tick = async () => {
    if (token !== asrWatchToken || polling) return;
    polling = true;
    try {
      if (!asrService.isRunning()) {
        asrLastStatus = null;
        stopAsrWatch(token);
        publishAsrHealth();
        return;
      }
      const status = await asrService.peekStatus();
      if (token !== asrWatchToken) return;
      if (status) {
        asrLastStatus = status;
        asrLastError = '';
        publishAsrHealth();
      }
      const busy = asrTranscribing
        || Boolean(status?.download_active)
        || BUSY_STATES.has(String(status?.status || '').toLowerCase());
      if (!busy) stopAsrWatch(token);
    } catch (error) {
      if (token !== asrWatchToken) return;
      asrLastError = cleanError(error);
      stopAsrWatch(token);
      publishAsrHealth();
    } finally {
      polling = false;
    }
  };
  // Install the interval before the first tick so a tick that immediately
  // stops the watch cannot leave a stale timer behind.
  asrWatchTimer = setInterval(() => void tick(), LIMITS.ASR_PROGRESS_POLL_MS);
  void tick();
}

async function ensureAsrStatus() {
  if (!asrService?.isRunning()) {
    return { status: null, summary: publishAsrHealth(null) };
  }
  try {
    const status = await asrService.peekStatus();
    if (status) {
      asrLastStatus = status;
      asrLastError = '';
    }
    return { status, summary: publishAsrHealth(status) };
  } catch (error) {
    asrLastError = cleanError(error);
    return { status: null, summary: publishAsrHealth(asrLastStatus) };
  }
}

async function asrHealthSnapshot() {
  if (!usingOptionalAsr()) return asrSummary();
  if (!asrService?.isRunning()) return asrSummary(null);
  try {
    const status = await asrService.peekStatus();
    if (status) {
      asrLastStatus = status;
      asrLastError = '';
    }
    return asrSummary(status);
  } catch (error) {
    return asrSummary(asrLastStatus, { serviceError: cleanError(error) });
  }
}

async function checkAsrModels() {
  const engine = optionalEngine(settings.asrEngine);
  if (!engine) throw new Error('Choose an optional speech engine first. Whisper stays on the bundled server.');
  if (!asrService) throw new Error('The optional ASR service is unavailable in this build.');
  try {
    const payload = await asrService.models(asrLaunchConfig(engine.id));
    const status = payload?.status || await asrService.peekStatus();
    asrLastStatus = status || null;
    asrLastError = '';
    return {
      ok: true,
      models: normalizeAsrModels(payload, engine.id),
      summary: publishAsrHealth(asrLastStatus)
    };
  } catch (error) {
    asrLastError = cleanError(error);
    publishAsrHealth(asrLastStatus);
    throw error;
  }
}

async function loadAsrModel(model = settings.asrEngine) {
  const target = String(model || '').trim();
  const engine = optionalEngine(target);
  if (!engine) throw new Error('Only the optional speech engines can be loaded here.');
  if (target !== settings.asrEngine) throw new Error('Save the selected speech engine before loading it.');
  if (currentTurn || turnRunning) throw new Error('Finish or cancel the current turn before loading a speech model.');
  if (asrBusy()) throw new Error('An ASR model is already downloading, loading, or transcribing. Wait or cancel it first.');
  if (!asrService) throw new Error('The optional ASR service is unavailable in this build.');
  asrLastError = '';
  try {
    const payload = await asrService.load(asrLaunchConfig(target), {
      model: target,
      device: settings.asrDevice,
      compute_type: settings.asrComputeType,
      language: settings.asrLanguage || null
    });
    const status = payload?.status || await asrService.peekStatus();
    asrLastStatus = status || null;
    const summary = publishAsrHealth(asrLastStatus);
    startAsrWatch();
    return summary;
  } catch (error) {
    asrLastError = cleanError(error);
    publishAsrHealth(asrLastStatus);
    throw error;
  }
}

async function downloadAsrModel(model = settings.asrEngine) {
  const target = String(model || '').trim();
  const engine = optionalEngine(target);
  if (!engine) throw new Error('Only the optional speech engines can be downloaded here.');
  if (target !== settings.asrEngine) throw new Error('Save the selected speech engine before downloading it.');
  if (asrBusy()) throw new Error('An ASR model is already downloading, loading, or transcribing. Wait or cancel it first.');
  if (!asrService) throw new Error('The optional ASR service is unavailable in this build.');
  asrLastError = '';
  try {
    await asrService.download(asrLaunchConfig(target), target);
    const status = await asrService.peekStatus();
    asrLastStatus = status || null;
    const summary = publishAsrHealth(asrLastStatus);
    startAsrWatch();
    return summary;
  } catch (error) {
    asrLastError = cleanError(error);
    publishAsrHealth(asrLastStatus);
    throw error;
  }
}

async function cancelAsrModel() {
  if (!asrService?.isRunning()) return publishAsrHealth(null);
  try {
    const payload = await asrService.cancel();
    const status = payload?.status || await asrService.peekStatus();
    asrLastStatus = status || null;
    asrLastError = '';
    return publishAsrHealth(asrLastStatus);
  } catch (error) {
    asrLastError = cleanError(error);
    publishAsrHealth(asrLastStatus);
    throw error;
  }
}

async function unloadAsrModel() {
  if (asrTranscribing || currentTurn || turnRunning) {
    throw new Error('Finish or cancel the current turn before unloading the speech model.');
  }
  if (!asrService?.isRunning()) return publishAsrHealth(null);
  try {
    const payload = await asrService.unload();
    asrLastStatus = payload?.status || await asrService.peekStatus();
    asrLastError = '';
    stopAsrWatch();
    return publishAsrHealth(asrLastStatus);
  } catch (error) {
    asrLastError = cleanError(error);
    publishAsrHealth(asrLastStatus);
    throw error;
  }
}

async function ensureWhisper() {
  try {
    // Always go through startWhisper so it can validate the running server's
    // build identity and compute setting before reusing it.
    const health = await services.startWhisper({
      port: whisperPort,
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
      const health = await services.whisperHealth(whisperPort);
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
      // Phase H: while the *server* is starting (no download progress yet),
      // the pill still shows the real long activity; a start that expired
      // clears it so nothing pretends progress never ended.
      if (starting && !startExpired) {
        syncIslandDownload(whisperStartingIslandDownload(settings.whisperModel));
      } else if (startExpired) {
        syncIslandDownload(null);
      }
      if (!active || health.status === 'error' || startExpired) stopWhisperWatch(token);
    } finally {
      polling = false;
    }
  };
  void tick();
  whisperWatchTimer = setInterval(() => void tick(), LIMITS.WHISPER_PROGRESS_POLL_MS);
}

async function cancelWhisperSwitch() {
  await services.cancelWhisperModel(whisperPort);
  const health = await services.whisperHealth(whisperPort);
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
  const feedLabel = WHISPER_MODELS.find((item) => item.id === target)?.label || target;
  const existing = await services.whisperHealth(whisperPort);
  if (existing.status === 'http-error') {
    const message = `${existing.error || `Port ${whisperPort} is already used by another service.`} Stop that service and try again.`;
    publishWhisperHealth({
      ok: false,
      status: 'error',
      error: message,
      active_model: null,
      target_model: target
    });
    throw new Error(message);
  }
  // Only send /load_model to a server that identifies as this build. A stale
  // build or another service on the port may not implement the route (the
  // Python http.server case answers it with 501), so restart through the
  // normal launcher instead.
  let verified = false;
  if (existing.status !== 'unreachable') {
    try {
      verified = String(existing.launch_id || '') === services.whisperExpectedLaunchId();
    } catch {
      verified = false;
    }
  }
  if (verified) {
    await services.loadWhisperModel(whisperPort, target);
    startWhisperWatch();
    // Phase E feed: model swaps are recorded once the new model is serving.
    pushFeedEvent({ title: 'Whisper model switched', body: `${feedLabel} is now transcribing your voice.`, kind: 'system', tone: 'neutral' });
  } else {
    startWhisperWatch(true);
    ensureWhisper().catch((error) => {
      if (services.whisperStatus().running) return;
      stopWhisperWatch();
      pushFeedEvent({ title: 'Whisper model switch failed', body: cleanError(error), kind: 'error', tone: 'highlight' });
      publishWhisperHealth({
        ok: false,
        status: 'error',
        error: cleanError(error),
        active_model: null,
        target_model: target,
        models: whisperModelSummary({})
      });
    });
  }
  const health = await services.whisperHealth(whisperPort);
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
  const engine = selectedAsrEngine();
  if (engine.id !== 'whisper') {
    if (!asrService) throw new Error('The optional ASR service is unavailable in this build.');
    // Dictation never starts the optional service or downloads a model by
    // itself. Load is an explicit dashboard action so a mis-selected engine
    // cannot pull several gigabytes in the middle of a recording.
    if (!asrService.isRunning()) {
      throw new Error(`${engine.label} is not loaded. Open Dictation and choose Load model before recording.`);
    }
    const knownReady = asrLastStatus?.status === 'ready' && asrLastStatus.active_model === engine.id;
    if (!knownReady) {
      const readyStatus = await asrService.peekStatus().catch(() => null);
      if (readyStatus?.status !== 'ready' || readyStatus.active_model !== engine.id) {
        throw new Error(`${engine.label} is not loaded. Open Dictation and choose Load model before recording.`);
      }
      asrLastStatus = readyStatus;
    }
    if (asrBusy()) {
      throw new Error('The speech engine is already loading or transcribing. Wait or cancel it before dictating.');
    }
    asrTranscribing = true;
    asrLastError = '';
    startAsrWatch();
    try {
      const result = await asrService.transcribe(bytes, mime, {
        model: engine.id,
        language: settings.asrLanguage || undefined,
        wordTimestamps: settings.asrWordTimestamps === true,
        vad: settings.asrVad !== false,
        timeout: LIMITS.ASR_TRANSCRIBE_TIMEOUT_MS,
        signal
      });
      if (Array.isArray(result?.warnings) && result.warnings.length) {
        logger.warn('asr', result.warnings.join(' | ').slice(0, 1000));
      }
      const text = String(result?.text || '');
      if (!text.trim()) throw new Error('The speech model returned no text.');
      return text.slice(0, LIMITS.MAX_TRANSCRIPT_CHARS);
    } finally {
      asrTranscribing = false;
      if (asrService?.isRunning()) startAsrWatch();
    }
  }
  await ensureWhisper();
  const result = await services.transcribe(
    `http://127.0.0.1:${whisperPort}`,
    bytes,
    mime,
    settings.whisperModel,
    signal,
    { language: settings.asrLanguage || '' }
  );
  return result.text.slice(0, LIMITS.MAX_TRANSCRIPT_CHARS);
}

async function healthChecks() {
  const localConfig = settings.providers.local;
  const providerName = settings.chatProvider;
  const providerConfig = settings.providers[providerName] || localConfig;
  const providerKey = providerNeedsKey(providerName) ? secrets[providerName] || '' : '';
  const ollamaInstalled = Boolean(services.ollamaExecutable());
  const [ollamaResult, whisperResult, remoteChatResult, asrResult] = await Promise.all([
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
    (async () => whisperHealthSummary(await services.whisperHealth(whisperPort)))(),
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
    })(),
    asrHealthSnapshot()
  ]);
  if (whisperResult.switching || ['downloading', 'loading'].includes(whisperResult.status)) startWhisperWatch();
  const chatResult = providerName === 'local'
    ? { ...ollamaResult, provider: 'local' }
    : remoteChatResult;
  lastHealth = {
    ...lastHealth,
    ollama: ollamaResult,
    chat: chatResult,
    whisper: whisperResult,
    asr: asrResult,
    checkedAt: new Date().toISOString()
  };
  sendToDashboard('health:updated', lastHealth);
  return structuredClone(lastHealth);
}

function warmServices() {
  setTimeout(async () => {
    await healthChecks().catch((error) => logger.warn('health', cleanError(error)));
    if (settings.sttProvider === 'local' && settings.asrEngine === 'whisper') {
      try {
        await ensureWhisper();
        await healthChecks();
      } catch (error) {
        logger.warn('whisper server', cleanError(error));
      }
    }
  }, 1200).unref?.();
}

function addTurn(said, did, epoch = historyEpoch) {
  // A cleared history invalidates turns that were already in flight, and the
  // user can opt out of writing new turns entirely.
  if (epoch !== historyEpoch) return;
  if (settings.historyEnabled === false) return;
  history = [{ time: new Date().toISOString(), said: said.slice(0, LIMITS.MAX_TRANSCRIPT_CHARS), did: did.slice(0, LIMITS.MAX_TRANSCRIPT_CHARS) }, ...history].slice(0, LIMITS.MAX_TURNS);
  try {
    store.writeJson('history.json', history);
  } catch (error) {
    logger.error('history', cleanError(error));
  }
  broadcast('history:updated', structuredClone(history));
}

function clearHistoryStore() {
  historyEpoch += 1;
  history = [];
  store.writeJson('history.json', history);
  broadcast('history:updated', []);
}

function chatReplyAlive(generation, controller) {
  return generation === chatSession.generation && !controller.signal.aborted;
}

function resetChatSession() {
  chatSession.generation += 1;
  const controller = chatSession.controller;
  chatSession.controller = null;
  if (controller) controller.abort();
  chatSession.requestId = 0;
  chatSession.messages = [];
  overlay?.setState({ chatStreaming: false });
  if (chatSession.open) sendChatHistory();
}

async function clearLocalData() {
  clearHistoryStore();
  memory = [];
  store.writeJson('memory.json', memory);
  resetChatSession();
  if (currentTurn) abortTurn('local data cleared');
  try {
    services.stopKokoro();
  } catch {
    // No Kokoro server was loaded.
  }
  try {
    asrService?.stop();
    stopAsrWatch();
    asrLastStatus = null;
    asrLastError = '';
  } catch {
    // No optional ASR service was loaded.
  }
  // Windows may keep the model files busy while taskkill unwinds.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const removed = [];
  const failed = [];
  for (const name of ['kokoro', 'kokoro-cache']) {
    const target = path.join(USER_DATA_DIR, name);
    try {
      fs.rmSync(target, { recursive: true, force: true });
      if (fs.existsSync(target)) failed.push(name);
      else removed.push(name);
    } catch {
      failed.push(name);
    }
  }
  const logsCleared = logger.clear();
  modelListCache.clear();
  overlayEvents = [];
  overlay?.setNotifications([], false);
  broadcast('memory-updated', []);
  const variant = settings.ttsModelVariant || 'quantized';
  publishKokoroHealth({ status: 'needs-consent', modelReady: false, voiceReady: false, hasConsent: false, variant });
  logger.info('privacy', `History, memory, logs, and voice caches cleared${failed.length ? ` (failed: ${failed.join(', ')})` : ''}.`);
  return { ok: logsCleared && failed.length === 0, logsCleared, removed, failed };
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
  if (approvalGate.cancelTurn(turn.id)) clearApprovalFallback();
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
  hideDisposition = 'hide';
  overlay?.setDismiss(null);
}

function scheduleOverlayHide(delay, chatLinger = false) {
  if (chatSession.open && !chatLinger) return;
  if (overlay?.state().panel) return;
  if (settings.notchBehavior === 'stay-open') {
    clearOverlayHideTimer();
    return;
  }
  clearTimeout(hideTimer);
  hidePaused = false;
  hideDisposition = chatLinger ? 'chat' : 'hide';
  hideDuration = Math.max(0, Number(delay) || 0);
  hideRemaining = hideDuration;
  hideDeadline = Date.now() + hideRemaining;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    hidePaused = false;
    hideRemaining = 0;
    if (currentTurn) return;
    if (overlay?.state().panel) return;
    if (settings.notchBehavior === 'stay-open') return;
    if (chatSession.open) {
      // The chat countdown never hides the window while chat is open; it folds
      // the island back to the compact idle pill first (which starts a fresh,
      // ordinary dismiss round that hover can pause).
      chatLingerFold();
      return;
    }
    hideDisposition = 'hide';
    // While media plays, turns end on the now-playing pill instead of leaving
    // the desktop bare; stop presses set mediaSnoozeUntil to opt out. If the
    // status is still media, that is an expiring gallery sample — hand the
    // pill back to the live SMTC data.
    if (mediaLast) showMediaOverlay();
    else overlay?.hide();
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
  if (hidePaused || (!hideTimer && !hideRemaining)) return;
  if (chatSession.open && hideDisposition !== 'chat') return;
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
  if (!hidePaused) return;
  if (chatSession.open && hideDisposition !== 'chat') return;
  if (settings.notchBehavior === 'stay-open' || overlay?.state().panel) return;
  hidePaused = false;
  hideDeadline = Date.now() + hideRemaining;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    hideRemaining = 0;
    if (currentTurn) return;
    if (overlay?.state().panel) return;
    if (settings.notchBehavior === 'stay-open') return;
    if (chatSession.open) {
      chatLingerFold();
      return;
    }
    hideDisposition = 'hide';
    if (mediaLast) showMediaOverlay();
    else overlay?.hide();
  }, hideRemaining);
  hideTimer.unref?.();
  overlay?.setDismiss({
    duration: hideDuration || hideRemaining,
    startedAt: Date.now() - Math.max(0, (hideDuration || hideRemaining) - hideRemaining),
    paused: false,
    remaining: hideRemaining
  });
}

// Shared close path for the chat: the session ends but the island stays on
// screen as the compact idle pill under a fresh (linger) dismiss round.
function foldChatToIdle() {
  if (!chatSession.open) return false;
  chatSession.open = false;
  overlay?.setState({
    chatOpen: false,
    chatPreview: false,
    status: 'idle',
    message: '',
    approval: null,
    canCopy: false,
    streaming: false,
    chatStreaming: false,
    speaking: false
  });
  overlay?.setKeyboardFocus(false);
  scheduleOverlayHide(CHAT_LINGER_MS);
  return true;
}

// Fires when the chat-linger round runs out with chat still open.
function chatLingerFold() {
  if (!chatSession.open || overlay?.state().status !== 'chat') return;
  foldChatToIdle();
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
  // Phase E feed: a failed turn keeps a card after the 6-second banner hides.
  pushFeedEvent({
    title: turn.mode === 'dictation' ? 'Dictation failed' : 'Agent turn failed',
    body: message,
    kind: 'error',
    tone: 'highlight'
  });
  overlay?.show({ status: 'error', message, approval: null, canCopy: false, mode: turn.mode, streaming: false });
  scheduleOverlayHide(6000);
}

function failTurn(turn, message, detail = '') {
  if (!turn || currentTurn !== turn) return;
  showTurnError(turn, message, detail);
}

function abortTurn(reason = 'cancelled', options = {}) {
  const hide = options.hide !== false;
  const turn = currentTurn;
  clearOverlayHideTimer();
  if (turn) {
    logger.info('turn', `Cancelled: ${reason}`);
    turn.controller.abort();
    if (turn.recorderId) recorderManager?.cancel(turn.recorderId, reason);
    finishTurn(turn);
    if (hide) overlay?.hide();
  } else {
    speechController?.abort(); sendToPlayer('tts:stop-audio', {});
    speechController = null;
    // A stop press with no turn under way means "put the island away"; snooze
    // the now-playing pill so it does not immediately resurface. The snooze
    // length is a real setting (Phase I).
    if (mediaLast && overlay?.state().status === 'media') mediaSnoozeUntil = Date.now() + settings.mediaSnoozeMinutes * 60000;
    if (hide) overlay?.hide();
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
  // Real activity resumes: drop the gallery-preview guard and publish the
  // live event stack (gallery previews swap in sample cards).
  galleryPreviewActive = false;
  clearTimeout(galleryPreviewRevert);
  galleryPreviewRevert = null;
  overlay?.setNotifications(overlayEvents, false);
  clearOverlayHideTimer();
  const turn = {
    id: nextTurnId++,
    mode,
    origin,
    historyEpoch,
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

function replyLanguageInstruction() {
  const raw = String(settings?.asrLanguage || '').trim();
  if (!raw) return '';
  const base = raw.split(/[-_]/)[0].toLowerCase();
  if (!/^[a-z]{2,20}$/.test(base)) return '';
  try {
    const label = new Intl.DisplayNames(['en'], { type: 'language' }).of(base);
    if (!label) return '';
    return `Reply in ${label.charAt(0).toUpperCase()}${label.slice(1)}.`;
  } catch {
    return '';
  }
}

function chatSystemPrompt() {
  const notes = memory.length ? memory.join(' | ') : '(none)';
  const replyLanguage = replyLanguageInstruction();
  return [
    'You are Voxa, a concise desktop assistant.',
    ...(replyLanguage ? [replyLanguage] : []),
    'This is a typed chat inside a small overlay. Answer directly and keep replies short unless the user asks for detail.',
    'Typed chat cannot use desktop tools or perform actions. Never claim you opened, typed, clicked, or changed anything.',
    'If the user asks for a desktop action, tell them to use voice or agent mode.',
    `User notes: ${notes}.`,
    `Current time: ${new Date().toISOString()}.`
  ].join(' ');
}

function chatMessagesFor() {
  const messages = [{ role: 'system', content: chatSystemPrompt() }];
  const sessionMessages = chatSession.messages
    .filter((message) => message
      && (message.role === 'user' || message.role === 'assistant')
      && !message.error
      && String(message.content || '').trim())
    .slice(-40);
  // The first typed message after a launch starts from an empty buffer: seed it
  // with the recent voice/chat history so continuity survives a restart.
  if (sessionMessages.length <= 1) {
    const recent = history
      .filter((turn) => turn && turn.said && turn.did && turn.did !== 'Dictated into the focused app.')
      .slice(0, 6)
      .reverse();
    for (const turn of recent) {
      messages.push({ role: 'user', content: String(turn.said).slice(0, LIMITS.MAX_CHAT_CHARS) });
      messages.push({ role: 'assistant', content: String(turn.did).slice(0, LIMITS.MAX_CHAT_CHARS) });
    }
  }
  for (const message of sessionMessages) {
    messages.push({ role: message.role, content: String(message.content).slice(0, LIMITS.MAX_CHAT_CHARS) });
  }
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
  // The chevron ("up-arrow") folds the island back to the compact idle pill
  // and leaves it visible under the standard dismiss window — it no longer
  // closes the island outright. The 10s countdown pauses on hover through the
  // existing overlay:dismiss-pause/resume path and resets when chat reopens,
  // a new message/reply lands, or a voice turn starts (its callers all
  // clear/re-schedule the timer).
  if (!foldChatToIdle()) return false;
  logger.info('chat', 'Chat collapsed to the idle pill.');
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

// A rejected send leaves the pill on screen: start (or restart) the
// chat-linger countdown so the island folds back to the idle band on its own
// schedule instead of stranding the user under a chat view that cannot send.
// With the session already closed the countdown still expires the visible
// shell under the ordinary hide disposition.
function rejectChat(message, text = '') {
  sendToOverlay('chat:error', { message, text });
  scheduleOverlayHide(CHAT_LINGER_MS, chatSession.open);
}

async function sendChat(payload) {
  const rawText = typeof payload?.text === 'string' ? payload.text.trim() : '';
  if (!chatSession.open) {
    logger.warn('chat', 'A typed message was ignored because chat is closed.');
    rejectChat('Chat was closed before the message could be sent.', rawText);
    return;
  }
  if (currentTurn) {
    rejectChat('Finish the voice turn before typing.', rawText);
    return;
  }
  if (chatSession.controller) {
    rejectChat('Please wait for the current reply to finish.', rawText);
    return;
  }
  const text = rawText;
  if (!text) {
    rejectChat('Type a message first.', rawText);
    return;
  }
  if (text.length > LIMITS.MAX_CHAT_CHARS) {
    rejectChat(`Messages are limited to ${LIMITS.MAX_CHAT_CHARS} characters.`, rawText);
    return;
  }
  const providerName = settings.chatProvider;
  const config = settings.providers?.[providerName];
  if (!config) {
    rejectChat(`Unknown chat provider: ${providerName}`, rawText);
    return;
  }
  const key = providerNeedsKey(providerName) ? secrets[providerName] : '';
  if (providerNeedsKey(providerName) && !key) {
    rejectChat(`Add an API key for ${providerName} in the dashboard.`, rawText);
    return;
  }

  const id = nextChatId++;
  const controller = new AbortController();
  const generation = chatSession.generation;
  chatSession.controller = controller;
  chatSession.requestId = id;
  chatSession.messages.push({ role: 'user', content: text }, { role: 'assistant', content: '', streaming: true });
  if (chatSession.messages.length > 40) chatSession.messages.splice(0, chatSession.messages.length - 40);
  // A new message voids any countdown (chat linger or plain hide).
  clearOverlayHideTimer();
  overlay?.setState({ chatStreaming: true });
  sendToOverlay('chat:started', { id, text });
  logger.info('chat', `Sending ${text.length} characters to ${providerName}/${config.model || 'default'}`);

  try {
    const chatSettings = structuredClone(settings);
    const reply = await services.chatStream(
      chatSettings,
      key,
      chatMessagesFor(),
      controller.signal,
      (partial) => {
        if (!chatReplyAlive(generation, controller)) return;
        const display = chatDisplayText(partial);
        const last = chatSession.messages[chatSession.messages.length - 1];
        if (last?.role === 'assistant') last.content = display;
        sendToOverlay('chat:delta', { id, text: display });
      }
    );
    if (!chatReplyAlive(generation, controller)) return;
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
    // Reply finished: start the chat-linger countdown (10s, hover-pausable,
    // folds to the idle pill — never an instant hide).
    scheduleOverlayHide(CHAT_LINGER_MS, true);
    logger.info('chat', `Reply received from ${providerName}`);
  } catch (error) {
    if (generation !== chatSession.generation) {
      logger.info('chat', 'A cleared reply was dropped.');
      return;
    }
    const last = chatSession.messages[chatSession.messages.length - 1];
    if (controller.signal.aborted) {
      if (last?.role === 'assistant') {
        last.streaming = false;
        last.cancelled = true;
      }
      sendToOverlay('chat:done', { id, text: last?.content || '', cancelled: true });
      scheduleOverlayHide(CHAT_LINGER_MS, true);
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
      // A failed reply still ends the turn: linger, then fold to idle.
      scheduleOverlayHide(CHAT_LINGER_MS, true);
      logger.warn('chat', message);
    }
  } finally {
    if (chatSession.controller === controller) chatSession.controller = null;
    if (generation === chatSession.generation) overlay?.setState({ chatStreaming: false });
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
  return TOOL_DEFINITIONS.map((tool) => {
    const entries = Object.entries(tool.parameters);
    const properties = Object.fromEntries(entries.map(([name, spec]) => {
      const definition = typeof spec === 'string' ? { type: spec } : spec;
      const property = { type: definition.type || 'string' };
      if (definition.description) property.description = definition.description;
      if (Object.hasOwn(definition, 'default')) property.default = definition.default;
      return [name, property];
    }));
    const required = entries
      .filter(([, spec]) => typeof spec === 'string' || spec?.optional !== true)
      .map(([name]) => name);
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties,
          required,
          additionalProperties: false
        }
      }
    };
  });
}

function systemPrompt(target) {
  const allApps = apps.discoverApps();
  const appNames = allApps.slice(0, LIMITS.MAX_PROMPT_APPS).map((item) => item.name);
  const installed = appNames.length
    ? `${appNames.join('; ')}${allApps.length > appNames.length ? ` (${allApps.length - appNames.length} more available)` : ''}`
    : '(none discovered)';
  const recentNotes = memory.slice(-LIMITS.MAX_PROMPT_NOTES).reverse();
  const notes = recentNotes.length
    ? `${recentNotes.join(' | ')}${memory.length > recentNotes.length ? ` (${memory.length - recentNotes.length} more available)` : ''}`
    : '(none)';
  const replyLanguage = replyLanguageInstruction();
  return [
    'You are Voxa, a concise desktop voice assistant.',
    ...(replyLanguage ? [replyLanguage] : []),
    'Answer ordinary questions directly in one to three short sentences.',
    'Use tools when the user asks you to perform an action on their computer.',
    'Never claim an action succeeded unless a tool result says it did.',
    'After web_search, do not claim you found, read, or summarized results; say you opened the search in the browser and ask the user to look at it.',
    'Routine actions may run without a prompt based on the saved permission mode; sensitive actions still require approval.',
    'Use close_app to close an app by name; never use press_keys or Alt+F4 to close an app. Pass the app name. Set force only when the user says "force close" or "kill".',
    'If the user denies approval, accept it and do not retry the same action.',
    'Do not end with generic questions such as "Anything else?".',
    `Focused app when the turn began: ${target?.title || 'unknown'}.`,
    `Installed apps: ${installed}.`,
    `User notes: ${notes}.`,
    `Current time: ${new Date().toISOString()}.`
  ].join(' ');
}

function clearApprovalFallback() {
  clearTimeout(approvalFallbackTimer);
  approvalFallbackTimer = null;
}

function overlayApprovalVisible() {
  const window = overlay?.getWindow();
  return Boolean(window && !window.isDestroyed() && window.isVisible());
}

async function showNativeApproval(id, request) {
  if (approvalGate.current()?.id !== id || approvalNativeDialogId === id) return;
  approvalNativeDialogId = id;
  try {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Voxa needs approval',
      message: String(request.title || 'Allow this action?').slice(0, 300),
      detail: String(request.detail || '').slice(0, 2000),
      buttons: ['Deny', 'Allow'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    respondApproval(id, response === 1);
  } catch (error) {
    logger.warn('approval', `Native approval dialog failed: ${cleanError(error)}`);
  } finally {
    if (approvalNativeDialogId === id) approvalNativeDialogId = '';
  }
}

async function askApproval(turn, request) {
  if (!turnAlive(turn)) return false;
  const id = `${turn.id}-${++turn.approvalCount}`;
  const detail = String(request.detail || '').slice(0, 2000);
  logger.info('approval', `${request.tool}: ${request.title}`);
  const decision = approvalGate.request(id, turn.id);
  clearApprovalFallback();
  let shown = true;
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
    shown = false;
    logger.warn('approval', `Island approval prompt failed: ${cleanError(error)}`);
    showNativeApproval(id, request);
  }
  // If the island never becomes visible, the OS dialog keeps the turn from
  // waiting the full approval timeout with no usable prompt.
  if (shown) {
    approvalFallbackTimer = setTimeout(() => {
      approvalFallbackTimer = null;
      if (approvalGate.current()?.id !== id) return;
      if (overlayApprovalVisible()) return;
      logger.warn('approval', 'The island did not show the approval; using a native dialog.');
      showNativeApproval(id, request);
    }, APPROVAL_NATIVE_FALLBACK_MS);
    approvalFallbackTimer.unref?.();
  }
  return decision;
}

function respondApproval(id, allowed) {
  if (!approvalGate.respond(id, allowed)) return false;
  clearApprovalFallback();
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
    if (query.length > 200) throw new Error('The app name is too long.');
    const entry = apps.findApp(query);
    return {
      title: `Open ${entry?.name || query}?`,
      detail: entry?.launch || query,
      run: async () => {
        const opened = await apps.openAppByName(query);
        lastOpenedApp = { name: opened.name, launch: opened.launch || '' };
        return `Opened ${opened.name}.`;
      }
    };
  }
  if (name === 'close_app') {
    const query = String(args.name || '').trim();
    if (query.length > 200) throw new Error('The app name is too long.');
    const force = args.force === true;
    const useLast = !query || /^(it|that)$/i.test(query);
    const lastApp = useLast ? lastOpenedApp : null;
    const entry = query && !useLast
      ? apps.findApp(query)
      : (lastApp?.name ? apps.findApp(lastApp.name) : null);
    const focusTarget = useLast && !lastApp ? (turn.target || null) : null;
    const label = useLast
      ? (lastApp?.name || focusTarget?.title || focusTarget?.processName || 'the focused window')
      : (entry?.name || query);
    const refusal = desktop.closeAppRefusal(query)
      || (entry?.name ? desktop.closeAppRefusal(entry.name) : null)
      || (focusTarget ? desktop.closeAppRefusal(focusTarget.processName) : null);
    if (refusal) throw new Error(refusal);
    return {
      title: `Close ${label}?`,
      detail: force ? `${label}\n\nForce close will kill the process if it stays open.` : label,
      run: async () => desktop.closeApp(useLast ? '' : query, {
        force,
        lastApp: useLast ? lastApp : null,
        focusedTarget: focusTarget
      })
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
        return `Opened a Google search for '${query}' in the browser. I cannot read the results.`;
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

function summarizeToolArgs(name, args) {
  if (name === 'type_text') return `${String(args.text || '').length} characters of text`;
  if (name === 'remember_note') return `${String(args.note || '').length} character note`;
  const text = JSON.stringify(args || {});
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
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
  const argsSummary = summarizeToolArgs(name, args);
  if (name === 'refresh_apps') {
    const list = apps.refreshApps(logger);
    logger.info('tool', `action=refresh_apps args=${argsSummary} result=ok`);
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
  const fullAccess = settings.agentFullAccess === true;
  if (fullAccess) {
    logger.info('permission', `${name} allowed by full access.`);
  } else if (permission.requiresApproval) {
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
    logger.info('tool', `action=${name} args=${argsSummary} result=ok`);
    return { ok: true, message: message || `Completed ${name.replaceAll('_', ' ')}.` };
  } catch (error) {
    if (error.cancelled) return { ok: false, cancelled: true, error: 'Turn cancelled.' };
    logger.warn('tool', `action=${name} args=${argsSummary} result=error error=${cleanError(error)}`);
    return { ok: false, error: cleanError(error) };
  }
}

function recentVoiceHistory() {
  const recent = history
    .filter((turn) => turn && turn.said && turn.did && turn.did !== 'Dictated into the focused app.')
    .slice(0, LIMITS.MAX_VOICE_HISTORY_TURNS);
  let chars = recent.reduce((total, turn) => total + turn.said.length + turn.did.length, 0);
  while (recent.length && chars > LIMITS.MAX_VOICE_HISTORY_CHARS) {
    const dropped = recent.pop();
    chars -= dropped.said.length + dropped.did.length;
  }
  return recent.reverse();
}

async function runConversation(turn, transcript, providerName, target) {
  const key = providerNeedsKey(providerName) ? secrets[providerName] : '';
  if (providerNeedsKey(providerName) && !key) throw new Error(`Add an API key for ${providerName} in the dashboard.`);
  const conversationSettings = providerName === settings.chatProvider ? settings : { ...settings, chatProvider: providerName };
  const messages = [{ role: 'system', content: systemPrompt(target) }];
  for (const past of recentVoiceHistory()) {
    messages.push({ role: 'user', content: String(past.said) });
    messages.push({ role: 'assistant', content: String(past.did) });
  }
  messages.push({ role: 'user', content: transcript });
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
    // Extract TTS settings with safe defaults, including battery routing.
    const tts = speechSettings();
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
    if (settings.historyEnabled === false) {
      logger.info('transcript', `Not saved (${transcript.length} characters).`);
    } else {
      logger.info('transcript', transcript.slice(0, 1000));
    }
    if (turn.mode === 'dictation') {
      if (!turnAlive(turn)) return;
      overlay.setState({ status: 'thinking', message: 'Typing into your app…' });
      const target = await requireTurnTarget(turn);
      await desktop.typeText(transcript, target, turn.controller.signal);
      if (!turnAlive(turn)) return;
      addTurn(transcript, 'Dictated into the focused app.', turn.historyEpoch);
      // Phase E feed: completed dictations land in the island feed.
      pushFeedEvent({ title: 'Dictation typed', body: transcript, kind: 'turn', tone: 'neutral' });
      finishTurn(turn);
      overlay.show({ status: 'answer', mode: 'dictation', message: transcript, canCopy: true, approval: null, streaming: false, speaking: false });
      scheduleOverlayHide(3500);
      return;
    }
    overlay.setState({ status: 'thinking', message: 'Thinking…' });
    const answer = await runAgent(turn, transcript);
    if (!turnAlive(turn)) return;
    finishTurn(turn);
    addTurn(transcript, answer, turn.historyEpoch);
    // Phase E feed: finished agent turns surface their first reply sentence.
    pushFeedEvent({ title: 'Agent finished the task', body: feedSentence(answer), kind: 'turn', tone: 'highlight' });
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
    // Phase E feed: a passing microphone test is recorded with what it heard.
    pushFeedEvent({ title: 'Microphone test passed', body: transcript, kind: 'system', tone: 'neutral' });
    logger.info('microphone test', transcript.slice(0, 500));
    return { transcript };
  } finally {
    micTestRunning = false;
  }
}

/* Phase E feed producers: every island feed card is a real Voxa-internal
   event (turn results, health checks, tests, downloads) recorded here and
   published through the existing notifications state. No new channels,
   settings, or dependencies — and nothing mirrors Windows notifications. */
const FEED_MAX_EVENTS = 12; // mirrors lib/overlay.cjs MAX_NOTIFICATIONS
const FEED_KINDS = ['turn', 'download', 'media', 'system', 'error', 'approval'];
const PROVIDER_FEED_LABELS = {
  local: 'Local',
  freellmapi: 'FreeLLMAPI',
  openai: 'OpenAI',
  groq: 'Groq',
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  custom: 'Custom'
};
let overlayEvents = [];
let overlayEventSeq = 0;
let galleryPreviewActive = false;
let galleryPreviewRevert = null;

// First sentence of a longer reply, markdown stripped, for card bodies.
function feedSentence(text) {
  const flat = String(text || '').replace(/[#*_`>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return (flat.split(/(?<=[.!?])\s/, 1)[0] || flat).slice(0, 200);
}

function providerFeedLabel(provider) {
  return PROVIDER_FEED_LABELS[provider] || String(provider || 'Provider');
}

function pushFeedEvent({ title, body = '', kind = 'system', tone = 'neutral' } = {}) {
  const cleanTitle = String(title || '').trim().slice(0, 120);
  if (!cleanTitle) return;
  overlayEventSeq += 1;
  const event = {
    id: `ev-${Date.now().toString(36)}-${overlayEventSeq.toString(36)}`,
    title: cleanTitle,
    body: String(body || '').trim().slice(0, 400),
    ts: Date.now(),
    kind: FEED_KINDS.includes(kind) ? kind : 'system',
    tone: tone === 'highlight' ? 'highlight' : 'neutral'
  };
  overlayEvents = [event, ...overlayEvents].slice(0, FEED_MAX_EVENTS);
  const logBody = event.body && (settings.historyEnabled !== false || event.kind !== 'turn')
    ? ` - ${event.body.slice(0, 120)}`
    : '';
  logger.info('feed', `${event.title}${logBody} (${event.id})`);
  if (!galleryPreviewActive) {
    overlay?.setNotifications(overlayEvents, false);
    popRestingPill();
  }
}

// Stay-open mode keeps a resting notch on screen even with no turn in flight.
function showRestingNotch() {
  overlay?.show({
    status: 'idle',
    message: '',
    approval: null,
    canCopy: false,
    streaming: false,
    speaking: false,
    chatOpen: false,
    chatPreview: false
  });
}

// Phase H: a resting pill pop is shared behavior - anything the user could not
// otherwise see (new feed events, a download starting) raises the idle pill as
// a toast. Never steals the stage from a turn, chat, an approval, or the media
// pill; respects the media snooze so a stop press keeps the island away.
function popRestingPill() {
  if (currentTurn || turnRunning) return;
  if (chatSession.open) return;
  if (mediaLast) return;
  if (Date.now() < mediaSnoozeUntil) return;
  const current = overlay?.state();
  if (current && current.visible) return;
  overlay?.show({
    status: 'idle',
    message: '',
    approval: null,
    canCopy: false,
    streaming: false,
    speaking: false,
    chatOpen: false,
    chatPreview: false
  });
  // Phase I: the unread toast dwell is a real setting.
  scheduleOverlayHide(settings.feedToastSeconds * 1000);
}

/* Phase H: the download live activity. Producers (whisper health, kokoro
   download, ollama pull) call syncIslandDownload with either null or a
   { phase, label, percent } summary from lib/island-download.cjs. Only real
   changes reach the pill; the first activation pops the resting pill once so
   the user learns the download began. Completion is announced by the existing
   feed event (which already pops with the unread count). */
let islandDownloadLast = null;
function syncIslandDownload(next) {
  const previous = islandDownloadLast;
  if (!next && !previous) return;
  if (previous && next && previous.phase === next.phase
    && previous.label === next.label && previous.percent === next.percent) return;
  islandDownloadLast = next ? { ...next } : null;
  overlay?.setDownload(next);
  if (next && !previous) popRestingPill();
}

// Dismissal bookkeeping: drop the id from main's stack so the next push never
// resurrects a card the user already cleared.
function forgetFeedEvent(id) {
  const target = String(id || '').trim();
  if (!target) return;
  overlayEvents = overlayEvents.filter((item) => item.id !== target);
}

/* --- Phase F media (SMTC) ----------------------------------------------- */
/* Real system now-playing: lib/media-smtc.cjs polls the Windows session
   manager through a long-lived PowerShell process and reports changes only.
   The island renders metadata + transport controls; never audio levels. */
let mediaController = null;
let mediaLast = null;
const mediaSeenApps = new Set();
let mediaPreviewUntil = 0;
let mediaSnoozeUntil = 0;

function showMediaOverlay() {
  if (!mediaLast || currentTurn || turnRunning) return;
  if (Date.now() < mediaSnoozeUntil) return;
  overlay?.show({
    status: 'media',
    message: '',
    media: mediaLast,
    approval: null,
    canCopy: false,
    streaming: false,
    speaking: false,
    chatOpen: false,
    chatPreview: false
  });
}

function broadcastMediaState(next) {
  mediaLast = next;
  if (!next) {
    overlay?.setState({ media: null });
    if (overlay?.state().status === 'media') {
      if (settings.notchBehavior === 'stay-open') showRestingNotch();
      else if (!overlay?.state().panel) overlay?.hide();
    }
    // Playback ended: surface any unread events that arrived mid-playback.
    popRestingPill();
    return;
  }
  // Keep pill data fresh even while a turn or a preview owns the stage; the
  // pill itself only surfaces when nothing else is showing.
  overlay?.setState({ media: next });
  if (currentTurn || turnRunning) return;
  const current = overlay?.state();
  if (!current) return;
  if (Date.now() < mediaPreviewUntil) return;
  if (current.status === 'media' || !current.visible) showMediaOverlay();
}

function handleMediaUpdate(raw) {
  if (raw && raw.error) {
    logger.warn('media', `SMTC watcher error: ${raw.error}`);
    return;
  }
  const next = mediaSmtc.normalizeMedia(raw);
  if (next && next.app && !mediaSeenApps.has(next.app)) {
    mediaSeenApps.add(next.app);
    pushFeedEvent({
      title: 'Media controls connected',
      body: `${next.app} is now linked to the island.`,
      kind: 'media',
      tone: 'neutral'
    });
  }
  broadcastMediaState(next);
}

function previewOverlay(status, message) {
  if (currentTurn) throw new Error('Finish the current turn before previewing the overlay.');
  if (chatSession.open) throw new Error('Close chat before previewing the overlay.');
  const allowed = ['idle', 'listening', 'thinking', 'executing', 'verifying', 'answer', 'approval', 'error', 'done', 'chat', 'feed', 'media'];
  const next = allowed.includes(String(status).toLowerCase()) ? String(status).toLowerCase() : 'listening';
  if (next === 'idle') {
    clearOverlayHideTimer();
    overlay.hide();
    return true;
  }
  const isChat = next === 'chat';
  const isFeed = next === 'feed';
  const isMedia = next === 'media';
  const motionScale = overlay.state().slowMotion ? 4 : 1;
  // While the gallery samples sit on screen, real producers keep recording but
  // do not repaint the preview; they take over when it expires or a real turn
  // starts.
  if (isFeed) galleryPreviewActive = true;
  else galleryPreviewActive = false;
  // Same rule for the media preview: real SMTC updates refresh pill data but
  // must not replace the sample mid-preview.
  mediaPreviewUntil = isMedia ? Date.now() + 6000 * motionScale : 0;
  const approval = next === 'approval'
    ? { id: 'preview', title: 'Allow this sample action?', detail: message || 'This is a preview; no action will run.', tool: 'preview' }
    : null;
  overlay.show({
    status: next,
    mode: settings.mode,
    message: isChat || isFeed || isMedia ? '' : message || `Overlay preview · ${next}`,
    approval,
    notifications: isFeed ? galleryNotifications() : [],
    feedPreview: isFeed,
    media: isMedia ? galleryMedia() : undefined,
    canCopy: next === 'answer',
    chatOpen: isChat,
    chatPreview: isChat,
    chatStreaming: false,
    speaking: next === 'answer' && Boolean(settings.spokenReplies)
  });
  scheduleOverlayHide((next === 'approval' ? 8000 : next === 'done' ? 3200 : 6000) * motionScale);
  // Mirror the feed preview's 6-second dwell: when the samples leave, put the
  // real event stack back (a sooner turn resets this too).
  if (isFeed) {
    galleryPreviewRevert = setTimeout(() => {
      galleryPreviewRevert = null;
      galleryPreviewActive = false;
      overlay?.setNotifications(overlayEvents, false);
    }, 6000 * motionScale);
  }
  return true;
}

// Reference 1 feed samples for the gallery. Real producers (Phase E) live in
// pushFeedEvent; these samples exist only for the dashboard's preview states
// and are always labeled with the preview badge.
function galleryNotifications() {
  const now = Date.now();
  return [
    { id: 'sample-turn', title: 'Agent finished the task', body: 'Opened Notepad and typed the review notes. Everything went through the approval you allowed.', ts: now, kind: 'turn', tone: 'highlight' },
    { id: 'sample-download', title: 'Whisper model downloaded', body: 'Voice recognition model staged and ready to transcribe.', ts: now - 14 * 60000, kind: 'download', tone: 'neutral' },
    { id: 'sample-media', title: 'Media controls connected', body: 'Playback info and controls are wired to the island.', ts: now - 52 * 60000, kind: 'media', tone: 'neutral' }
  ];
}

// Reference media sample for the gallery preview. Transport buttons behave
// (real SMTC wiring below), but the metadata is a labeled sample like the feed
// preview cards.
function galleryMedia() {
  return {
    title: 'Sample track',
    artist: 'Sample artist',
    app: 'Sample player',
    playing: true,
    canToggle: true,
    canNext: true,
    canPrev: true
  };
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

function handle(channel, handler, role = 'dashboard') {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrusted(event, role);
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

function overlaySettingsCatalog() {
  return {
    appName: APP_NAME,
    settings: publicSettings(),
    voices: ttsText.allVoices(),
    languages: ttsText.LANG_LABELS,
    permissionModes: permissions.PERMISSION_MODES.map(({ id, label, description }) => ({ id, label, description })),
    permissionCategories: permissions.ROUTINE_CATEGORIES.map(({ id, label, detail }) => ({ id, label, detail })),
    options: {
      overlayStyle: ['island', 'notch'],
      mode: ['agent', 'dictation'],
      ttsEngine: ['windows', 'kokoro'],
      ...NOTCH_OPTIONS,
      feedToastSeconds: [2, 4, 6, 8, 12],
      feedDwellSeconds: [4, 8, 12, 20, 30],
      mediaSnoozeMinutes: [1, 3, 5, 10, 15]
    },
    ranges: {
      notchScale: NOTCH_SCALE_RANGE,
      notchOffsetY: NOTCH_OFFSET_RANGE,
      ttsSpeed: [0.7, 1.4],
      ttsVolume: [0, 1]
    }
  };
}

function registerIpc() {
  handle('app:state', () => buildDashboardState());
  handle('updater:get-status', () => updater.getStatus());
  handle('updater:check', () => updater.checkNow());
  handle('updater:download', () => updater.downloadUpdate());
  handle('updater:install', () => updater.installNow());
  handle('settings:save', (patch) => saveSettingsPatch(patch));
  handle('overlay:settings-catalog', () => overlaySettingsCatalog(), 'overlay');
  handle('overlay:settings-save', (patch) => saveSettingsPatch(patch), 'overlay');
  handle('overlay:panel', (panel) => {
    const state = overlay.setPanel(panel);
    if (!state.panel && state.status === 'idle') {
      if (settings.paused) {
        // Paused means asleep: closing the sheet must not leave a resting
        // notch behind, even when stay-open is selected.
        if (state.visible) overlay.hide();
      } else if (settings.notchBehavior === 'stay-open') {
        // Resuming from inside the sheet (or merely closing it) should honor
        // stay-open even when the sheet was opened from a hidden notch.
        if (!state.visible) showRestingNotch();
      } else if (state.visible) {
        scheduleOverlayHide(3500);
      }
    }
    return { panel: state.panel };
  }, 'overlay');
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
      const message = result.modelAvailable
        ? `Connection successful · ${result.model}`
        : `Connected, but ${result.model} is not in the model list.`;
      // Phase E feed: health probes produce cards, successful or not — the
      // missing-model case is a warning tone rather than a hard error.
      pushFeedEvent({
        title: result.modelAvailable ? `${providerFeedLabel(provider)} connection passed` : `${providerFeedLabel(provider)} connected, model missing`,
        body: message,
        kind: 'system',
        tone: result.modelAvailable ? 'neutral' : 'highlight'
      });
      return {
        ok: Boolean(result.modelAvailable),
        connected: true,
        message
      };
    } catch (error) {
      const message = cleanError(error);
      pushFeedEvent({ title: `${providerFeedLabel(provider)} connection failed`, body: message, kind: 'error', tone: 'highlight' });
      return { ok: false, message };
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
        // Phase H: the pull is a real long activity — mirror the stream's
        // percent on the island.
        syncIslandDownload(ollamaIslandDownload(progress, model));
      }, logger);
      await healthChecks().catch((error) => logger.warn('health', cleanError(error)));
      // Phase E feed: finished model pulls are recorded as download cards.
      pushFeedEvent({ title: 'Ollama model ready', body: `${model} finished downloading.`, kind: 'download', tone: 'highlight' });
      return result;
    } catch (error) {
      pushFeedEvent({ title: 'Ollama model download failed', body: cleanError(error), kind: 'error', tone: 'highlight' });
      throw error;
    } finally {
      // Phase H: a pull that ends (success, error, or cancelled) always clears
      // the pill state.
      syncIslandDownload(null);
      ollamaPullRunning = false;
    }
  });
  handle('ollama:open-download', () => openExternalLink('https://ollama.com/download/windows'));
  handle('whisper:models', async () => {
    const health = await services.whisperHealth(whisperPort);
    if (health.status === 'unreachable' || health.status === 'http-error') {
      return {
        ok: false,
        error: health.error || 'Whisper is not running.',
        models: whisperModelSummary(health)
      };
    }
    return services.whisperModels(whisperPort);
  });
  handle('whisper:load', (model) => switchWhisperModel(model));
  handle('whisper:cancel', () => cancelWhisperSwitch());
  handle('asr:status', async () => (await ensureAsrStatus()).summary);
  handle('asr:models', () => checkAsrModels());
  handle('asr:load', (model) => loadAsrModel(model || settings.asrEngine));
  handle('asr:download', (model) => downloadAsrModel(model || settings.asrEngine));
  handle('asr:cancel', () => cancelAsrModel());
  handle('asr:unload', () => unloadAsrModel());
  handle('health:check', () => healthChecks());
  handle('microphone:list', () => queueRecorderOperation(() => recorderRequest('enumerate', {}, 20000)));
  handle('microphone:test', async () => {
    try {
      return await runMicTest();
    } catch (error) {
      const reason = cleanError(error);
      sendToDashboard('microphone:test-error', reason);
      // Phase E feed: failing tests persist as error cards.
      pushFeedEvent({ title: 'Microphone test failed', body: reason, kind: 'error', tone: 'highlight' });
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
    clearHistoryStore();
    resetChatSession();
    return true;
  });
  handle('data:clear-all', () => clearLocalData());
  handle('apps:refresh', () => apps.refreshApps(logger).map((item) => item.name));
  handle('logs:read', () => logger.read(LIMITS.MAX_LOG_LINES));
  handle('overlay:preview', (status, message) => previewOverlay(status, message));
  handle('overlay:test', () => previewOverlay('listening', 'Overlay test from the dashboard.'));
  handle('overlay:gallery-options', (options = {}) => {
    overlay?.setPreviewOptions({ slowMotion: Boolean(options?.slowMotion) });
    return true;
  });
  handle('tts:health', () => kokoroModelHealth());
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
        publishKokoroHealth({ status: 'not-downloaded', modelReady: true, voiceReady: false, hasConsent: true, variant });
        return { ok: false, message: 'Download cancelled.' };
      }
      // The model alone cannot synthesize speech; the voice pack is required.
      publishKokoroHealth({
        status: 'downloading',
        modelReady: true,
        voiceReady: false,
        hasConsent: true,
        variant,
        message: 'Downloading the Kokoro voice pack…',
        progress: { percent: null, totalBytes: 0, downloadedBytes: 0 }
      });
      await kokoro.ensureVoiceFile(settings.ttsVoice || 'af_heart', controller.signal, logger);
      if (controller.signal.aborted) {
        publishKokoroHealth({ status: 'not-downloaded', modelReady: true, voiceReady: false, hasConsent: true, variant });
        return { ok: false, message: 'Download cancelled.' };
      }
      publishKokoroHealth({ status: 'downloaded', modelReady: true, voiceReady: true, hasConsent: true, variant });
      // Phase E feed: voice model staged and ready.
      pushFeedEvent({ title: 'Voice model downloaded', body: `${spec.filename} and the voice pack are ready for spoken replies.`, kind: 'download', tone: 'highlight' });
      logger.info('kokoro', `Model ${spec.filename} and voice pack ready.`);
      return { ok: true, message: 'Kokoro model and voices downloaded.' };
    } catch (err) {
      if (!err.cancelled) logger.warn('kokoro', `Download failed: ${cleanError(err)}`);
      if (!err.cancelled) pushFeedEvent({ title: 'Voice model download failed', body: cleanError(err), kind: 'error', tone: 'highlight' });
      publishKokoroHealth({ status: err.cancelled ? 'not-downloaded' : 'error', modelReady: kokoro.isModelReady(variant), voiceReady: kokoro.isVoiceReady(settings.ttsVoice || 'af_heart'), hasConsent: true, variant, error: cleanError(err) });
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
  handle('tts:speak', async (text, requested, signal) => {
    const tts = speechSettings({ ...settings, ...(requested || {}) });
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
      const tts = speechSettings();
      await services.speakStreaming(`This is a voice test from ${APP_NAME}.`, tts, controller.signal, logger, (buffer) => {
        sendToDashboard('tts:play-audio', buffer);
      });
      if (controller.signal.aborted) return { ok: false, message: 'Voice test stopped.' };
      const engine = tts.ttsEngine === 'kokoro' ? 'Kokoro' : 'Windows';
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
  listen('overlay:hit-rect', (rect) => {
    overlay?.setHitRect(rect);
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
    // Keep main's stack in sync so later pushes never resurrect the card.
    forgetFeedEvent(id);
    return true;
  }, ['overlay']);
  listen('overlay:media-control', (payload) => {
    const action = typeof payload?.action === 'string' ? payload.action : '';
    if (!['toggle', 'next', 'previous'].includes(action)) {
      logger.warn('media', `Ignored unknown media control: ${action}`);
      return;
    }
    void mediaController?.runCommand(action).then((result) => {
      if (!result.ok) logger.info('media', `Control '${action}' not delivered: ${result.reason}`);
      else logger.info('media', `Control '${action}' delivered.`);
    });
  }, ['overlay']);
  // Phase G: the only real way to browse the event stack. Hovering makes the
  // head click-receptive (already true) and pauses dismissal, so the click
  // toggles the live feed; gallery previews keep their own badge path.
  listen('overlay:feed-toggle', () => {
    if (currentTurn || turnRunning) return;
    if (chatSession.open) return;
    const current = overlay?.state();
    if (current && current.status === 'feed') {
      clearOverlayHideTimer();
      overlay?.hide();
      return;
    }
    if (current && current.visible && current.status !== 'idle') return;
    overlay?.show({
      status: 'feed',
      notifications: [...overlayEvents],
      feedPreview: false,
      approval: null,
      canCopy: false,
      streaming: false,
      speaking: false,
      chatOpen: false,
      chatPreview: false,
      message: ''
    });
    // Phase I: the live feed dwell is a real setting.
    scheduleOverlayHide(settings.feedDwellSeconds * 1000);
  }, ['overlay']);
  // Stage 2: the expanded tab rail carries a round settings button that opens
  // the dashboard settings window. The overlay pill keeps its own state.
  listen('overlay:open-settings', () => {
    showDashboard();
  }, ['overlay']);
  // The in-overlay quick rail owns a pause action so listening can be stopped
  // without opening the dashboard.
  listen('overlay:pause-toggle', () => togglePaused(), ['overlay']);
  // Clear the whole alert stack from the notch panel. Main owns the list, so
  // both the feed state and the rendered cards are reset together.
  listen('overlay:feed-clear', () => {
    overlayEvents = [];
    overlay?.setNotifications([], false);
    return true;
  }, ['overlay']);
  // The kit's activity pill owns a real cancel button. It aborts whichever
  // long download currently owns the pill; Ollama pulls have no cancel path.
  listen('overlay:cancel-download', () => {
    if (kokoroDownloadController) {
      kokoroDownloadController.abort();
      kokoroDownloadController = null;
      return true;
    }
    if (lastHealth?.whisper?.switching) {
      void cancelWhisperSwitch().catch((error) => {
        logger.warn('health', `Could not cancel the Whisper download: ${cleanError(error)}`);
      });
      return true;
    }
    return false;
  }, ['overlay']);
  // The kit's error card retry button starts a fresh capture in the current
  // mode. It cannot use assistant:toggle directly because that invoke is
  // dashboard-scoped by the trusted-sender guard.
  listen('overlay:retry', () => toggleTalk('button', settings.mode), ['overlay']);
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
    overlay?.audioLevel(peak, Array.isArray(payload?.bins) ? payload.bins : null);
  }, ['recorder']);
  listen('recorder:speech-level', (payload) => {
    overlay?.speechLevel(Math.max(0, Math.min(1, Number(payload?.level) || 0)));
  }, ['recorder', 'dashboard']);
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
  mediaController?.stop();
  mediaController = null;
  desktop.disposeFocusHelper();
  services.stopWhisper();
  services.stopKokoro();
  asrService?.stop();
  stopAsrWatch();
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
    await resolveWhisperPort();
    // The optional ASR service is instantiated here but never started here.
    // Selecting an optional engine only changes the route; Load/Download/Check
    // status are the explicit actions that spawn its Python process.
    asrService = createAsrService({
      log: logger,
      appRoot: app.getAppPath(),
      userDataDir: USER_DATA_DIR,
      cacheDir: path.join(USER_DATA_DIR, 'asr-models'),
      whisperCacheDir: path.join(USER_DATA_DIR, 'whisper-models'),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged
    });
    lastHealth.asr = summarizeAsr({ engineId: settings.asrEngine, running: false });
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
    overlay.setAppearance(overlayAppearance());
    overlay.setState({ companionEnabled: settings.companionEnabled, speaking: false });
    if (settings.notchBehavior === 'stay-open' && !settings.paused) showRestingNotch();
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
        // Fixed dwell: app-startup error cards are not the alert feed or the
        // unread toast, so the Phase I knobs deliberately do not touch this.
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
        WHISPER_PORT: whisperPort,
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
    // Initial Kokoro model check: report file readiness, not whether the
    // synthesis server happens to be running (it starts lazily on first use).
    publishKokoroHealth(kokoroModelHealth());
    logger.info('app', 'Startup complete');
    // SMTC watcher: real system media metadata + transport. Skipped for the
    // gallery preview build and self-test workers; keep the pill honest.
    if (!GALLERY && !SELF_TEST) {
      mediaController = mediaSmtc.startMediaWatcher({
        log: logger,
        onUpdate: handleMediaUpdate
      });
    }
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
  app.whenReady().then(initialize);
} else {
  app.quit();
}
