'use strict';

const { app } = require('electron');

const INITIAL_CHECK_DELAY_MS = 15 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_RELEASE_NOTES_CHARS = 4000;

let updaterInstance = null;
let initialized = false;
let configured = false;
let windowGetter = () => null;
let storeApi = null;
let log = null;
let busyCheck = () => false;
let statusSink = null;
let currentStatus = null;
let updateInfo = { version: '', releaseNotes: '' };
let initialTimer = null;
let intervalTimer = null;
let checking = false;
let downloading = false;
let lastLoggedPercent = -1;

function isPackaged() {
  try {
    return Boolean(app?.isPackaged);
  } catch {
    return false;
  }
}

function appVersion() {
  try {
    return app && typeof app.getVersion === 'function' ? String(app.getVersion() || '') : '';
  } catch {
    return '';
  }
}

function errorText(error) {
  return String(error?.message || error || 'Unknown update error').split(/\r?\n/)[0].trim().slice(0, 300);
}

function logInfo(message) {
  try {
    log?.info?.('updater', message);
  } catch {
    // Update logging must never interfere with the updater.
  }
}

function logWarn(message) {
  try {
    log?.warn?.('updater', message);
  } catch {
    // Update logging must never interfere with the updater.
  }
}

function logError(message) {
  try {
    log?.error?.('updater', message);
  } catch {
    // Update logging must never interfere with the updater.
  }
}

function cleanVersion(value) {
  return String(value || '').trim().slice(0, 40);
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function releaseNotesText(value) {
  const parts = Array.isArray(value)
    ? value.map((item) => (typeof item === 'string' ? item : item?.note || ''))
    : [value];
  const combined = parts.filter((item) => typeof item === 'string' && item.trim()).join('\n\n');
  if (!combined) return '';
  return decodeEntities(
    combined
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|li|h[1-6])>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_RELEASE_NOTES_CHARS);
}

function idleStatus() {
  return {
    state: 'idle',
    currentVersion: appVersion(),
    version: '',
    releaseNotes: '',
    percent: null,
    message: 'Not checked yet.',
    queued: false
  };
}

function notify() {
  if (!currentStatus) return;
  const snapshot = { ...currentStatus };
  if (typeof statusSink === 'function') {
    try {
      statusSink(snapshot);
    } catch (error) {
      logWarn(`Could not publish update status: ${errorText(error)}`);
    }
    return;
  }
  try {
    const window = windowGetter?.();
    if (window && !window.isDestroyed?.()) window.webContents?.send('updater:status', snapshot);
  } catch (error) {
    logWarn(`Could not send update status to the dashboard: ${errorText(error)}`);
  }
}

function setStatus(state, extra = {}) {
  currentStatus = {
    state,
    currentVersion: appVersion(),
    version: extra.version ?? updateInfo.version,
    releaseNotes: extra.releaseNotes ?? updateInfo.releaseNotes,
    percent: extra.percent ?? null,
    message: extra.message || '',
    queued: Boolean(extra.queued)
  };
  notify();
  return getStatus();
}

function getStatus() {
  if (!isPackaged()) return { state: 'disabled-dev' };
  if (!currentStatus) currentStatus = idleStatus();
  return { ...currentStatus };
}

function updater() {
  if (!updaterInstance) updaterInstance = require('electron-updater').autoUpdater;
  return updaterInstance;
}

function autoCheckEnabled() {
  try {
    if (!storeApi || typeof storeApi.readJson !== 'function') return true;
    const saved = storeApi.readJson('settings.json', {}, log);
    return saved?.autoCheckUpdates !== false;
  } catch (error) {
    logWarn(`Could not read the automatic update setting: ${errorText(error)}`);
    return true;
  }
}

function handleFailure(step, error) {
  if (currentStatus?.state === 'error') return;
  const message = step === 'download'
    ? 'The update could not be downloaded. Voxa will keep the current version.'
    : step === 'install'
      ? 'The update could not be installed. Your current version is unchanged.'
      : 'Could not check for updates. Voxa will try again later.';
  logWarn(`${step} failed: ${errorText(error)}`);
  setStatus('error', { message });
}

function configureEvents(instance) {
  instance.on('checking-for-update', () => {
    if (currentStatus?.state !== 'checking') setStatus('checking', { message: 'Checking for updates…' });
  });

  instance.on('update-available', (info = {}) => {
    updateInfo = {
      version: cleanVersion(info.version),
      releaseNotes: releaseNotesText(info.releaseNotes)
    };
    setStatus('available', {
      message: updateInfo.version ? `Version ${updateInfo.version} is available to download.` : 'A new version is available to download.'
    });
    logInfo(`Update available${updateInfo.version ? `: ${updateInfo.version}` : ''}. Download waits for the user.`);
  });

  instance.on('update-not-available', () => {
    updateInfo = { version: '', releaseNotes: '' };
    setStatus('not-available', { message: 'Voxa is up to date.' });
    logInfo('No newer release was found.');
  });

  instance.on('download-progress', (progress = {}) => {
    const raw = progress.percent == null ? NaN : Number(progress.percent);
    const percent = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : null;
    setStatus('downloading', {
      percent,
      message: percent == null ? 'Downloading update…' : `Downloading update… ${percent}%`
    });
    if (percent != null && (lastLoggedPercent < 0 || percent - lastLoggedPercent >= 25)) {
      lastLoggedPercent = percent;
      logInfo(`Update download progress: ${percent}%.`);
    }
  });

  instance.on('update-downloaded', (info = {}) => {
    updateInfo = {
      version: cleanVersion(info.version) || updateInfo.version,
      releaseNotes: releaseNotesText(info.releaseNotes) || updateInfo.releaseNotes
    };
    lastLoggedPercent = -1;
    setStatus('downloaded', {
      message: updateInfo.version
        ? `Version ${updateInfo.version} is ready. It will install when Voxa quits.`
        : 'The update is ready. It will install when Voxa quits.'
    });
    logInfo(`Update downloaded${updateInfo.version ? `: ${updateInfo.version}` : ''}. It will install on quit or when restarted.`);
  });

  instance.on('error', (error) => {
    const step = downloading || currentStatus?.state === 'downloading' ? 'download' : 'check';
    handleFailure(step, error);
  });
}

function configureUpdater() {
  const instance = updater();
  instance.logger = null;
  instance.autoDownload = false;
  instance.autoInstallOnAppQuit = true;
  instance.allowPrerelease = false;
  configureEvents(instance);
  if (!currentStatus) currentStatus = idleStatus();
  notify();
}

function autoCheckDue() {
  if (!autoCheckEnabled() || checking || downloading) return false;
  return !['available', 'downloaded'].includes(currentStatus?.state);
}

function scheduleAutoChecks() {
  initialTimer = setTimeout(() => {
    initialTimer = null;
    if (autoCheckDue()) void checkNow();
  }, INITIAL_CHECK_DELAY_MS);
  initialTimer.unref?.();

  intervalTimer = setInterval(() => {
    if (autoCheckDue()) void checkNow();
  }, CHECK_INTERVAL_MS);
  intervalTimer.unref?.();
}

async function checkNow() {
  if (!isPackaged() || !configured) return getStatus();
  if (checking || downloading || currentStatus?.state === 'downloaded') return getStatus();
  checking = true;
  updateInfo = { version: '', releaseNotes: '' };
  setStatus('checking', { message: 'Checking for updates…' });
  logInfo(`Checking GitHub Releases for updates from version ${appVersion() || 'unknown'}.`);
  try {
    await updater().checkForUpdates();
  } catch (error) {
    handleFailure('check', error);
  } finally {
    checking = false;
  }
  return getStatus();
}

async function downloadUpdate() {
  if (!isPackaged() || !configured) return getStatus();
  if (downloading) return getStatus();
  if (currentStatus?.state !== 'available') return getStatus();
  downloading = true;
  lastLoggedPercent = -1;
  setStatus('downloading', {
    percent: 0,
    message: updateInfo.version ? `Starting the download for version ${updateInfo.version}…` : 'Starting the update download…'
  });
  logInfo(`User approved downloading update${updateInfo.version ? ` ${updateInfo.version}` : ''}.`);
  try {
    await updater().downloadUpdate();
    if (currentStatus?.state === 'downloading') {
      lastLoggedPercent = -1;
      setStatus('downloaded', {
        message: updateInfo.version
          ? `Version ${updateInfo.version} is ready. It will install when Voxa quits.`
          : 'The update is ready. It will install when Voxa quits.'
      });
      logInfo('Update download finished.');
    }
  } catch (error) {
    handleFailure('download', error);
  } finally {
    downloading = false;
  }
  return getStatus();
}

function installNow() {
  if (!isPackaged() || !configured) return getStatus();
  if (currentStatus?.state !== 'downloaded') return getStatus();
  let busy = true;
  try {
    busy = Boolean(busyCheck());
  } catch {
    busy = true;
  }
  if (busy) {
    setStatus('downloaded', {
      queued: true,
      message: 'Update ready. Voxa will install it when it quits after the current activity finishes.'
    });
    logInfo('Update install queued until the current recording, action, or approval finishes and Voxa quits.');
    return getStatus();
  }
  logInfo(`Restarting to install update${updateInfo.version ? ` ${updateInfo.version}` : ''}.`);
  setStatus('downloaded', { message: 'Restarting to install the update…' });
  try {
    updater().quitAndInstall(false, true);
  } catch (error) {
    handleFailure('install', error);
  }
  return getStatus();
}

function init(mainWindowGetter, store, logger, options = {}) {
  if (typeof mainWindowGetter === 'function') windowGetter = mainWindowGetter;
  storeApi = store || null;
  log = logger || null;
  if (options && typeof options === 'object') {
    if (typeof options.isBusy === 'function') busyCheck = options.isBusy;
    if (typeof options.onStatus === 'function') statusSink = options.onStatus;
  }
  if (initialized) return getStatus();
  initialized = true;
  if (!isPackaged()) return getStatus();
  try {
    configureUpdater();
    configured = true;
    scheduleAutoChecks();
  } catch (error) {
    logError(`Could not initialize update checks: ${errorText(error)}`);
    if (!currentStatus) currentStatus = idleStatus();
    currentStatus = { ...currentStatus, state: 'error', message: 'Updates are unavailable in this build.' };
    notify();
  }
  return getStatus();
}

module.exports = {
  init,
  checkNow,
  downloadUpdate,
  installNow,
  getStatus
};
