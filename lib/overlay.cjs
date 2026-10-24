'use strict';

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');
const { LIMITS } = require('./constants.cjs');

const WINDOW_WIDTH = 720;
const WINDOW_HEIGHT = 540;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function createOverlay({ log }) {
  let window = null;
  let loaded = false;
  let state = {
    visible: false,
    mode: 'agent',
    status: 'idle',
    message: '',
    streaming: false,
    speaking: false,
    companionEnabled: true,
    style: 'island',
    slowMotion: false,
    dismiss: null,
    chatOpen: false,
    chatStreaming: false,
    chatPreview: false
  };
  let hideTimer = null;
  let showFallback = null;
  let width = WINDOW_WIDTH;
  let height = WINDOW_HEIGHT;

  function targetDisplay() {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  function boundsFor() {
    const display = targetDisplay();
    const area = display.workArea;
    const nextWidth = Math.min(WINDOW_WIDTH, Math.max(320, area.width));
    const nextHeight = Math.min(WINDOW_HEIGHT, Math.max(96, area.height));
    width = nextWidth;
    height = nextHeight;
    return {
      width: nextWidth,
      height: nextHeight,
      x: Math.round(area.x + (area.width - nextWidth) / 2),
      y: Math.round(area.y)
    };
  }

  function applyBounds() {
    if (!window || window.isDestroyed()) return;
    window.setBounds(boundsFor(), false);
  }

  function create() {
    if (window && !window.isDestroyed()) return window;
    const bounds = boundsFor();
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
        spellcheck: false,
        backgroundThrottling: false
      }
    });
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setMenuBarVisibility(false);
    window.setIgnoreMouseEvents(true, { forward: true });
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
    clearTimeout(showFallback);
    hideTimer = null;
    showFallback = null;
    create();
    applyBounds();
    if (!(patch.status === 'chat' && patch.chatOpen && !patch.chatPreview)) setKeyboardFocus(false);
    state = { ...state, ...patch, visible: true, dismiss: null };
    if (window && !window.isDestroyed()) {
      window.setIgnoreMouseEvents(true, { forward: true });
      sendState();
      if (!window.isVisible()) window.showInactive();
      else window.moveTop();
      window.setAlwaysOnTop(true, 'screen-saver');
    }
    clearTimeout(showFallback);
    showFallback = setTimeout(() => {
      if (!window || window.isDestroyed() || !state.visible || window.isVisible()) return;
      log?.warn('overlay', 'Overlay did not become visible; retrying.');
      window.showInactive();
      window.moveTop();
    }, LIMITS.OVERLAY_SHOW_TIMEOUT_MS);
    return { ...state };
  }

  function finishHide() {
    clearTimeout(hideTimer);
    hideTimer = null;
    if (!window || window.isDestroyed() || state.visible) return;
    window.hide();
  }

  function hide(afterMs = LIMITS.OVERLAY_EXIT_FALLBACK_MS) {
    clearTimeout(hideTimer);
    clearTimeout(showFallback);
    showFallback = null;
    setKeyboardFocus(false);
    state = {
      ...state,
      visible: false,
      dismiss: null,
      speaking: false,
      chatOpen: false,
      chatStreaming: false,
      chatPreview: false
    };
    sendState();
    if (!window || window.isDestroyed()) return;
    window.setIgnoreMouseEvents(true, { forward: true });
    hideTimer = setTimeout(finishHide, Math.max(0, afterMs));
  }

  function acknowledgeHide() {
    if (!state.visible) finishHide();
  }

  function hideNow() {
    clearTimeout(hideTimer);
    clearTimeout(showFallback);
    hideTimer = null;
    showFallback = null;
    setKeyboardFocus(false);
    state = {
      ...state,
      visible: false,
      dismiss: null,
      speaking: false,
      chatOpen: false,
      chatStreaming: false,
      chatPreview: false
    };
    sendState();
    if (window && !window.isDestroyed()) {
      window.setIgnoreMouseEvents(true, { forward: true });
      window.hide();
    }
  }

  function resize() {
    // The overlay window is intentionally fixed-size; the pill morphs inside it.
  }

  function setStyle(style) {
    const next = style === 'notch' ? 'notch' : 'island';
    if (state.style === next) return;
    state = { ...state, style: next };
    sendState();
  }

  function setPreviewOptions(options = {}) {
    const slowMotion = Boolean(options.slowMotion);
    if (state.slowMotion === slowMotion) return;
    state = { ...state, slowMotion };
    sendState();
  }

  function setDismiss(dismiss = null) {
    state = { ...state, dismiss: dismiss ? { ...dismiss } : null };
    sendState();
  }

  function setInteractive(interactive) {
    if (!window || window.isDestroyed()) return;
    window.setIgnoreMouseEvents(!interactive, { forward: true });
  }

  function setKeyboardFocus(active) {
    if (!window || window.isDestroyed()) return;
    if (active) {
      window.setFocusable(true);
      window.show();
      window.moveTop();
      window.focus();
      return;
    }
    if (!window.isFocusable()) return;
    try {
      window.blur();
    } catch {
      // The window may already be closing.
    }
    window.setFocusable(false);
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
    setStyle,
    setPreviewOptions,
    setDismiss,
    setInteractive,
    setKeyboardFocus,
    acknowledgeHide,
    audioLevel,
    reposition,
    destroy,
    getWindow,
    state: () => ({ ...state }),
    size: () => ({ width, height })
  };
}

module.exports = { createOverlay };
