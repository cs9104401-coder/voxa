'use strict';

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');
const { LIMITS } = require('./constants.cjs');

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function createOverlay({ log }) {
  let window = null;
  let loaded = false;
  let state = { visible: false, mode: 'agent', status: 'idle', message: '', streaming: false };
  let hideTimer = null;
  let showFallback = null;
  let width = 460;
  let height = 160;

  function targetDisplay() {
    const point = screen.getCursorScreenPoint();
    return screen.getDisplayNearestPoint(point);
  }

  function boundsFor(size = { width, height }) {
    const display = targetDisplay();
    const area = display.workArea;
    const nextWidth = clamp(Math.round(size.width || width), 320, 720);
    const nextHeight = clamp(Math.round(size.height || height), 96, 560);
    return {
      width: nextWidth,
      height: nextHeight,
      x: Math.round(area.x + (area.width - nextWidth) / 2),
      y: Math.round(area.y)
    };
  }

  function applyBounds(size) {
    if (!window || window.isDestroyed()) return;
    const bounds = boundsFor(size || { width, height });
    width = bounds.width;
    height = bounds.height;
    window.setBounds(bounds, false);
  }

  function create() {
    if (window && !window.isDestroyed()) return window;
    const bounds = boundsFor();
    width = bounds.width;
    height = bounds.height;
    window = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      title: 'Voxa',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    });
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('did-finish-load', () => {
      loaded = true;
      window?.webContents.send('overlay:state', state);
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      log?.error('overlay', `Renderer exited: ${details.reason}`);
      const crashed = window;
      window = null;
      loaded = false;
      if (crashed && !crashed.isDestroyed()) crashed.destroy();
    });
    window.on('closed', () => {
      window = null;
      loaded = false;
      clearTimeout(hideTimer);
      clearTimeout(showFallback);
    });
    window.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html')).catch((error) => {
      log?.error('overlay', `Could not load overlay: ${error.message}`);
    });
    return window;
  }

  function sendState() {
    if (!window || window.isDestroyed() || !loaded) return;
    try {
      window.webContents.send('overlay:state', state);
    } catch (error) {
      log?.warn('overlay', `Could not update overlay: ${error.message}`);
    }
  }

  function setState(patch) {
    state = { ...state, ...patch };
    sendState();
    return { ...state };
  }

  function show(patch = {}) {
    clearTimeout(hideTimer);
    hideTimer = null;
    create();
    state = { ...state, ...patch, visible: true };
    applyBounds();
    sendState();
    if (!window.isVisible()) window.showInactive();
    else window.moveTop();
    window.setAlwaysOnTop(true, 'screen-saver');
    clearTimeout(showFallback);
    showFallback = setTimeout(() => {
      if (!window || window.isDestroyed() || !state.visible || window.isVisible()) return;
      log?.warn('overlay', 'Overlay did not become visible; retrying.');
      window.showInactive();
      window.moveTop();
    }, LIMITS.OVERLAY_SHOW_TIMEOUT_MS);
    return { ...state };
  }

  function hide(afterMs = LIMITS.OVERLAY_HIDE_DELAY_MS) {
    clearTimeout(hideTimer);
    clearTimeout(showFallback);
    showFallback = null;
    state = { ...state, visible: false };
    sendState();
    if (!window || window.isDestroyed()) return;
    hideTimer = setTimeout(() => {
      if (!window || window.isDestroyed() || state.visible) return;
      window.hide();
    }, Math.max(0, afterMs));
  }

  function hideNow() {
    clearTimeout(hideTimer);
    clearTimeout(showFallback);
    hideTimer = null;
    showFallback = null;
    state = { ...state, visible: false };
    sendState();
    if (window && !window.isDestroyed()) window.hide();
  }

  function resize(nextWidth, nextHeight) {
    if (!nextWidth && !nextHeight) return;
    applyBounds({
      width: nextWidth || width,
      height: nextHeight || height
    });
  }

  function audioLevel(peak) {
    if (!window || window.isDestroyed() || !loaded) return;
    try {
      window.webContents.send('overlay:audio-level', { peak: clamp(Number(peak) || 0, 0, 1) });
    } catch {
      // A closing window is not an error worth logging at audio-frame rates.
    }
  }

  function reposition() {
    applyBounds();
  }

  function destroy() {
    clearTimeout(hideTimer);
    clearTimeout(showFallback);
    if (window && !window.isDestroyed()) window.destroy();
    window = null;
    loaded = false;
  }

  function getWindow() {
    return window;
  }

  return {
    create,
    show,
    hide,
    hideNow,
    setState,
    resize,
    audioLevel,
    reposition,
    destroy,
    getWindow,
    state: () => ({ ...state }),
    size: () => ({ width, height })
  };
}

module.exports = { createOverlay };
