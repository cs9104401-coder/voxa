'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const APP_NAME = ipcRenderer.sendSync('brand:name');

const INVOKE_CHANNELS = new Set([
  'app:state',
  'settings:save',
  'provider:save-key',
  'provider:models',
  'provider:test',
  'ollama:pull',
  'ollama:open-download',
  'health:check',
  'microphone:list',
  'microphone:test',
  'microphone:monitor',
  'assistant:toggle',
  'assistant:stop',
  'assistant:set-mode',
  'history:clear',
  'apps:refresh',
  'logs:read',
  'overlay:preview',
  'overlay:test',
  'voice:test',
  'window:action'
]);

const SEND_CHANNELS = new Set([
  'approval:respond',
  'overlay:resize',
  'overlay:stop',
  'overlay:copy',
  'recorder:audio',
  'recorder:error',
  'recorder:audio-level',
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
  'overlay:state',
  'overlay:audio-level',
  'recorder:start',
  'recorder:stop',
  'recorder:cancel',
  'recorder:request'
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
  listModels: (provider, config) => invoke('provider:models', provider, config),
  ollamaModels: (url) => invoke('provider:models', 'local', { url }),
  pullOllamaModel: () => invoke('ollama:pull'),
  openOllamaDownload: () => invoke('ollama:open-download'),
  testProvider: (provider, config, apiKey) => invoke('provider:test', provider, config, apiKey),
  health: () => invoke('health:check'),
  microphones: () => invoke('microphone:list'),
  microphoneMonitor: (enabled, deviceId) => invoke('microphone:monitor', enabled, deviceId),
  testMicrophone: () => invoke('microphone:test'),
  toggleTalk: () => invoke('assistant:toggle'),
  stop: () => invoke('assistant:stop'),
  cancel: () => invoke('assistant:stop'),
  setMode: (mode, provider) => invoke('assistant:set-mode', { mode, provider }),
  clearHistory: () => invoke('history:clear'),
  refreshApps: () => invoke('apps:refresh'),
  readLogs: () => invoke('logs:read'),
  previewOverlay: (status, message) => invoke('overlay:preview', status, message),
  testOverlay: () => invoke('overlay:test'),
  testVoice: () => invoke('voice:test'),
  windowAction: (action) => invoke('window:action', action),
  respondApproval: (id, allowed) => send('approval:respond', { id, allowed }),
  on,
  recorder: {
    onStart: (callback) => on('recorder:start', callback),
    onStop: (callback) => on('recorder:stop', callback),
    onCancel: (callback) => on('recorder:cancel', callback),
    onRequest: (callback) => on('recorder:request', callback),
    audio: (payload) => send('recorder:audio', payload),
    error: (payload) => send('recorder:error', payload),
    level: (payload) => send('recorder:audio-level', payload),
    progress: (text) => send('recorder:test-progress', text),
    respond: (id, payload) => send('recorder:response', { id, ...payload }),
    ready: () => send('recorder:ready')
  },
  overlay: {
    onState: (callback) => on('overlay:state', callback),
    onAudioLevel: (callback) => on('overlay:audio-level', callback),
    resize: (width, height) => send('overlay:resize', { width, height }),
    stop: () => send('overlay:stop'),
    approve: (id, allowed) => send('approval:respond', { id, allowed }),
    copy: (text) => send('overlay:copy', text)
  }
});
