'use strict';

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');
const { LIMITS } = require('./constants.cjs');

const WINDOW_WIDTH = 720;
// Tall enough for the expanded stack (128px head band + up to 400px card + shadow) to fit unclipped.
const WINDOW_HEIGHT = 640;
// The pill floats 10px below the top edge (overlay-stage padding); the rest keeps
// the bottom shadow clear of the window edge and feeds the renderer's fit clamp.
const STAGE_TOP_GAP = 10;
const STAGE_BOTTOM_CLEAR = 6;

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
    chatPreview: false,
    notifications: [],
    feedPreview: false,
    download: null,
    expand: 'auto',
    stageMax: 0
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

  // Usable stage height for this display: the renderer clamps the expanded card
  // to it so the pill and its shadow always stay inside the window and work area.
  function stageMaxFor(bounds) {
    return Math.max(160, Math.round(bounds.height) - STAGE_TOP_GAP - STAGE_BOTTOM_CLEAR);
  }

  function applyBounds() {
    if (!window || window.isDestroyed()) return;
    const bounds = boundsFor();
    const nextStageMax = stageMaxFor(bounds);
    if (state.stageMax !== nextStageMax) {
      state = { ...state, stageMax: nextStageMax };
      sendState();
    }
    window.setBounds(bounds, false);
  }

  function create() {
    if (window && !window.isDestroyed()) return window;
    const bounds = boundsFor();
    state = { ...state, stageMax: stageMaxFor(bounds) };
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
      stopCursorFeed();
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

  // A collapse applies to the activity the user was looking at; a fresh status
  // shows its natural size again. Pinned expansion persists across statuses.
  function normalizeExpand(patch) {
    if (state.expand !== 'collapsed' || !patch || patch.expand) return patch;
    if (!patch.status || patch.status === state.status) return patch;
    return { ...patch, expand: 'auto' };
  }

  function setState(patch) {
    state = { ...state, ...normalizeExpand(normalizeDownloadPatch(patch)) };
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
    state = { ...state, ...normalizeExpand(normalizeDownloadPatch(patch)), visible: true, dismiss: null };
    if (window && !window.isDestroyed()) {
      window.setIgnoreMouseEvents(true, { forward: true });
      sendState();
      if (!window.isVisible()) window.showInactive();
      else window.moveTop();
      window.setAlwaysOnTop(true, 'screen-saver');
      startCursorFeed();
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
    stopCursorFeed();
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
      chatPreview: false,
      expand: 'auto'
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
      chatPreview: false,
      expand: 'auto'
    };
    sendState();
    if (window && !window.isDestroyed()) {
      window.setIgnoreMouseEvents(true, { forward: true });
      window.hide();
      stopCursorFeed();
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

  function setExpand(mode = 'auto') {
    const next = mode === 'pinned' || mode === 'collapsed' ? mode : 'auto';
    if (state.expand === next) return;
    state = { ...state, expand: next };
    sendState();
  }

  function setDismiss(dismiss = null) {
    state = { ...state, dismiss: dismiss ? { ...dismiss } : null };
    sendState();
  }

  /* Notification feed (Phase B): items ride overlay:state. Main owns the list;
     this only normalizes, caps, and repaints. Real producers arrive in later
     phases — the feed is Voxa-internal events, never Windows-notifications. */
  const MAX_NOTIFICATIONS = 12;
  const NOTIFICATION_KINDS = ['turn', 'download', 'media', 'system', 'error', 'approval'];
  function normalizeNotifications(list) {
    if (!Array.isArray(list)) return [];
    const items = [];
    for (const item of list.slice(0, MAX_NOTIFICATIONS)) {
      if (!item || typeof item !== 'object') continue;
      const title = String(item.title || '').trim().slice(0, 120);
      if (!title) continue;
      items.push({
        id: String(item.id || `feed-${items.length}`).trim().slice(0, 80) || `feed-${items.length}`,
        title,
        body: String(item.body || '').slice(0, 400),
        ts: Number(item.ts) || Date.now(),
        kind: NOTIFICATION_KINDS.includes(item.kind) ? item.kind : 'system',
        tone: item.tone === 'highlight' ? 'highlight' : 'neutral'
      });
    }
    return items;
  }

  /* Download live activity (Phase H): main owns real producer progress. This
     keeps only what the pill can honestly display — phase, a short label, and
     the server-reported percent — and drops byte churn (it updates every poll
     tick) so the renderer repaints only on real percent/phase changes. */
  const DOWNLOAD_PHASES = ['starting', 'downloading', 'loading'];
  function normalizeDownload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (!DOWNLOAD_PHASES.includes(payload.phase) || !String(payload.label || '').trim()) return null;
    // Number(null) is 0 — "no percent" must survive as null, never surface as
    // a fabricated 0%. Only a genuinely reported finite number is kept.
    const value = payload.percent == null ? null : Number(payload.percent);
    return {
      phase: payload.phase,
      label: String(payload.label).trim().slice(0, 60),
      percent: value == null || !Number.isFinite(value) ? null
        : Math.max(0, Math.min(100, Math.round(value)))
    };
  }
  function normalizeDownloadPatch(patch) {
    if (!patch || patch.download === undefined) return patch;
    return { ...patch, download: normalizeDownload(patch.download) };
  }
  function setDownload(download) {
    const next = normalizeDownload(download);
    const current = state.download;
    if (!next && !current) return { ...state };
    if (next && current && next.phase === current.phase && next.label === current.label
      && next.percent === current.percent) return { ...state };
    state = { ...state, download: next };
    sendState();
    return { ...state };
  }

  function setNotifications(items, feedPreview) {
    const next = normalizeNotifications(items);
    state = {
      ...state,
      notifications: next,
      feedPreview: feedPreview === undefined ? state.feedPreview : Boolean(feedPreview)
    };
    sendState();
    return { ...state };
  }

  function dismissNotification(id) {
    const target = String(id || '').trim();
    if (!target) return { ...state };
    const next = state.notifications.filter((item) => item.id !== target);
    if (next.length === state.notifications.length) return { ...state };
    state = { ...state, notifications: next };
    sendState();
    return { ...state };
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

  function audioLevel(peak, bins) {
    if (!window || window.isDestroyed() || !loaded) return;
    const payload = { peak: clamp(Number(peak) || 0, 0, 1) };
    if (Array.isArray(bins) && bins.length) {
      payload.bins = bins.slice(0, 16).map((value) => clamp(Number(value) || 0, 0, 1));
    }
    try {
      window.webContents.send('overlay:audio-level', payload);
    } catch {
      // A closing window is not an error worth logging at audio-frame rates.
    }
  }

  // Real TTS playback level from the analyser tap in tts-player.js (dashboard or
  // recorder window). The overlay uses it only to modulate the companion.
  function speechLevel(level) {
    if (!window || window.isDestroyed() || !loaded) return;
    try {
      window.webContents.send('overlay:speech-level', { level: clamp(Number(level) || 0, 0, 1) });
    } catch {
      // Audio-frame rate: transient races are not worth logging.
    }
  }

  // Ambient eye-tracking feed: polls the cursor at ~30fps and forwards it to the
  // overlay as window-relative DIP coordinates, only while the pill is visible.
  // Skips sends while hidden and stops entirely when the window hides or closes.
  let cursorTimer = null;
  function startCursorFeed() {
    if (cursorTimer) return;
    cursorTimer = setInterval(() => {
      if (!window || window.isDestroyed()) { stopCursorFeed(); return; }
      if (!state.visible || !window.isVisible()) return;
      try {
        const point = screen.getCursorScreenPoint();
        const bounds = window.getBounds();
        window.webContents.send('overlay:cursor', {
          x: Math.round(point.x - bounds.x),
          y: Math.round(point.y - bounds.y)
        });
      } catch {
        // Frame-rate polling: never log transient races.
      }
    }, 33);
  }
  function stopCursorFeed() {
    clearInterval(cursorTimer);
    cursorTimer = null;
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
    setExpand,
    setDismiss,
    setNotifications,
    dismissNotification,
    setDownload,
    setInteractive,
    setKeyboardFocus,
    acknowledgeHide,
    audioLevel,
    speechLevel,
    reposition,
    destroy,
    getWindow,
    state: () => ({ ...state }),
    size: () => ({ width, height })
  };
}

module.exports = { createOverlay };
