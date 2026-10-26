'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const APP_NAME = ipcRenderer.sendSync('brand:name');

const INVOKE_CHANNELS = new Set([
  'app:state',
  'settings:save',
  'provider:save-key',
  'provider:models',
  'provider:test',
  'provider:detect',
  'ollama:pull',
  'ollama:open-download',
  'whisper:models',
  'whisper:load',
  'whisper:cancel',
  'health:check',
  'microphone:list',
  'microphone:test',
  'microphone:monitor',
  'assistant:toggle',
  'assistant:stop',
  'assistant:set-mode',
  'history:clear',
  'data:clear-all',
  'apps:refresh',
  'logs:read',
  'overlay:preview',
  'overlay:test',
  'overlay:gallery-options',
  'voice:test',
  'tts:health',
  'tts:download',
  'tts:cancel-download',
  'tts:speak',
  'window:action',
  'updater:get-status',
  'updater:check',
  'updater:download',
  'updater:install'
]);

const SEND_CHANNELS = new Set([
  'approval:respond',
  'overlay:resize',
  'overlay:stop',
  'overlay:copy',
  'overlay:interactive',
  'overlay:hit-rect',
  'overlay:hidden',
  'overlay:expand',
  'overlay:dismiss-pause',
  'overlay:dismiss-resume',
  'overlay:notification-dismiss',
  'overlay:media-control',
  'overlay:feed-toggle',
  'overlay:open-settings',
  'overlay:cancel-download',
  'overlay:retry',
  'chat:send',
  'chat:cancel',
  'chat:open',
  'chat:close',
  'chat:request-history',
  'recorder:audio',
  'recorder:error',
  'recorder:audio-level',
  'recorder:speech-level',
  'recorder:test-progress',
  'recorder:response',
  'recorder:ready'
]);

const EVENT_CHANNELS = new Set([
  'settings:refresh',
  'settings:updated',
  'hotkey-status',
  'mode-status',
  'provider-mode',
  'ptt-state',
  'log:entry',
  'audio-level',
  'microphone:test-progress',
  'microphone:test-result',
  'microphone:test-error',
  'history:updated',
  'memory-updated',
  'health:updated',
  'ollama:pull-progress',
  'tts:health-updated',
  'tts:play-audio',
  'tts:stop-audio',
  'overlay:state',
  'overlay:audio-level',
  'overlay:speech-level',
  'overlay:cursor',
  'chat:started',
  'chat:delta',
  'chat:done',
  'chat:error',
  'chat:history',
  'recorder:start',
  'recorder:stop',
  'recorder:cancel',
  'recorder:request',
  'updater:status'
]);

function invoke(channel, ...args) {
  if (!INVOKE_CHANNELS.has(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
  return ipcRenderer.invoke(channel, ...args);
}

function send(channel, ...args) {
  if (!SEND_CHANNELS.has(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
  ipcRenderer.send(channel, ...args);
}

function on(channel, callback) {
  if (!EVENT_CHANNELS.has(channel) || typeof callback !== 'function') return () => {};
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('voiceAgent', {
  appName: APP_NAME,
  platform: process.platform,
  getState: () => invoke('app:state'),
  getSettings: () => invoke('app:state'),
  saveSettings: (patch) => invoke('settings:save', patch),
  saveProfile: (profile) => invoke('settings:save', profile),
  saveProviderKey: (provider, key) => invoke('provider:save-key', provider, key),
  listModels: (provider, config, options) => invoke('provider:models', provider, config, options),
  ollamaModels: (url) => invoke('provider:models', 'local', { url }),
  pullOllamaModel: () => invoke('ollama:pull'),
  openOllamaDownload: () => invoke('ollama:open-download'),
  whisperModels: () => invoke('whisper:models'),
  loadWhisperModel: (model) => invoke('whisper:load', model),
  cancelWhisperLoad: () => invoke('whisper:cancel'),
  testProvider: (provider, config, apiKey) => invoke('provider:test', provider, config, apiKey),
  detectProvider: () => invoke('provider:detect'),
  health: () => invoke('health:check'),
  microphones: () => invoke('microphone:list'),
  microphoneMonitor: (enabled, deviceId) => invoke('microphone:monitor', enabled, deviceId),
  testMicrophone: () => invoke('microphone:test'),
  toggleTalk: () => invoke('assistant:toggle'),
  stop: () => invoke('assistant:stop'),
  cancel: () => invoke('assistant:stop'),
  setMode: (mode, provider) => invoke('assistant:set-mode', { mode, provider }),
  clearHistory: () => invoke('history:clear'),
  clearAllData: () => invoke('data:clear-all'),
  refreshApps: () => invoke('apps:refresh'),
  readLogs: () => invoke('logs:read'),
  previewOverlay: (status, message) => invoke('overlay:preview', status, message),
  testOverlay: () => invoke('overlay:test'),
  setOverlayOptions: (options) => invoke('overlay:gallery-options', options),
  testVoice: () => invoke('voice:test'),
  ttsHealth: () => invoke('tts:health'),
  ttsDownload: () => invoke('tts:download'),
  ttsCancelDownload: () => invoke('tts:cancel-download'),
  windowAction: (action) => invoke('window:action', action),
  respondApproval: (id, allowed) => send('approval:respond', { id, allowed }),
  on,
  chat: {
    open: () => send('chat:open'),
    close: () => send('chat:close'),
    send: (text) => send('chat:send', { text }),
    cancel: () => send('chat:cancel'),
    requestHistory: () => send('chat:request-history'),
    onStarted: (callback) => on('chat:started', callback),
    onDelta: (callback) => on('chat:delta', callback),
    onDone: (callback) => on('chat:done', callback),
    onError: (callback) => on('chat:error', callback),
    onHistory: (callback) => on('chat:history', callback)
  },
  recorder: {
    onStart: (callback) => on('recorder:start', callback),
    onStop: (callback) => on('recorder:stop', callback),
    onCancel: (callback) => on('recorder:cancel', callback),
    onRequest: (callback) => on('recorder:request', callback),
    audio: (payload) => send('recorder:audio', payload),
    error: (payload) => send('recorder:error', payload),
    level: (payload) => send('recorder:audio-level', payload),
    speechLevel: (payload) => send('recorder:speech-level', payload),
    progress: (text) => send('recorder:test-progress', text),
    respond: (id, payload) => send('recorder:response', { id, ...payload }),
    ready: () => send('recorder:ready')
  },
  overlay: {
    onState: (callback) => on('overlay:state', callback),
    onAudioLevel: (callback) => on('overlay:audio-level', callback),
    onSpeechLevel: (callback) => on('overlay:speech-level', callback),
    onCursor: (callback) => on('overlay:cursor', callback),
    resize: (width, height) => send('overlay:resize', { width, height }),
    stop: () => send('overlay:stop'),
    approve: (id, allowed) => send('approval:respond', { id, allowed }),
    copy: (text) => send('overlay:copy', text),
    interactive: (active) => send('overlay:interactive', Boolean(active)),
    hitRect: (rect) => send('overlay:hit-rect', rect),
    hidden: () => send('overlay:hidden'),
    expand: (mode) => send('overlay:expand', { mode }),
    pauseDismiss: () => send('overlay:dismiss-pause'),
    resumeDismiss: () => send('overlay:dismiss-resume'),
    dismissNotification: (id) => send('overlay:notification-dismiss', { id: String(id || '') }),
    mediaControl: (action) => send('overlay:media-control', { action: String(action || '') }),
    feedToggle: () => send('overlay:feed-toggle', {}),
    openSettings: () => send('overlay:open-settings', {}),
    cancelDownload: () => send('overlay:cancel-download'),
    retry: () => send('overlay:retry')
  }
});

contextBridge.exposeInMainWorld('voxa', {
  updater: {
    getStatus: () => invoke('updater:get-status'),
    check: () => invoke('updater:check'),
    download: () => invoke('updater:download'),
    install: () => invoke('updater:install'),
    onStatus: (callback) => on('updater:status', callback)
  }
});
