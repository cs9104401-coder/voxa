'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const { PROVIDERS, LIMITS, STT_CLOUD_PROVIDERS } = require('./constants.cjs');
const {
  isValidPermissionMode,
  normalizePermissionMode,
  normalizeCustomPermissions,
  legacyPermissionSettings
} = require('./permissions.cjs');

function userFile(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(name, fallback, log) {
  const file = userFile(name);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
      log?.warn('settings load', `Could not parse ${name}; moved it to ${path.basename(backup)} and used defaults. ${error.message}`);
    } catch (renameError) {
      log?.error('settings load', `Could not parse ${name}; using defaults. ${error.message}. Backup failed: ${renameError.message}`);
    }
    return fallback;
  }
}

function writeJson(name, value) {
  const file = userFile(name);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // The original write error is more useful than cleanup failure.
    }
    throw new Error(`Could not save ${name}: ${error.message}`);
  }
}

function readSecrets(log) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return {};
    const file = userFile('provider-keys.enc');
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([name, value]) => (
      Object.hasOwn(PROVIDERS, name)
      && name !== 'local'
      && typeof value === 'string'
      && value.length > 0
      && value.length <= 10000
      && !/[\r\n]/.test(value)
    )));
  } catch (error) {
    if (error.code !== 'ENOENT') log?.error('provider keys', `Could not read encrypted provider keys: ${error.message}`);
    return {};
  }
}

function writeSecrets(value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage is unavailable. API keys were not saved.');
  const file = userFile('provider-keys.enc');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(value)));
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Keep the original error.
    }
    throw new Error(`Could not save provider keys: ${error.message}`);
  }
}

function normalizeUrl(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 500) return null;
  try {
    const parsed = new URL(text);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function normalizeProviderUrl(providerName, value) {
  const url = normalizeUrl(value);
  if (!url) return null;
  if (providerName !== 'local' && !url.startsWith('https://')) return null;
  return url;
}

function normalizeProviders(raw, base) {
  const result = structuredClone(base);
  if (!raw || typeof raw !== 'object') return result;
  for (const name of Object.keys(base)) {
    const candidate = raw[name];
    if (!candidate || typeof candidate !== 'object') continue;
    const url = normalizeProviderUrl(name, candidate.url);
    const model = typeof candidate.model === 'string' ? candidate.model.trim().slice(0, 200) : '';
    if (url) result[name].url = url;
    if (model) result[name].model = model;
  }
  return result;
}

function loadSettings(base, userName, log, isValidHotkey) {
  const raw = readJson('settings.json', {}, log);
  const settings = { ...structuredClone(base), displayName: userName };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return settings;

  const stringFields = {
    whisperModel: 120,
    sttModel: 120,
    sttCloudProvider: 40,
    fallbackProvider: 40,
    lastCloudProvider: 40,
    microphoneId: 300,
    communityUrl: LIMITS.MAX_COMMUNITY_URL_CHARS,
    displayName: LIMITS.MAX_PROFILE_NAME_CHARS
  };
  for (const [key, max] of Object.entries(stringFields)) {
    if (typeof raw[key] === 'string') {
      settings[key] = raw[key].replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    }
  }
  const booleanFields = ['dictationEnabled', 'agentEnabled', 'fallbackEnabled', 'startWithWindows', 'paused', 'spokenReplies'];
  for (const key of booleanFields) {
    if (typeof raw[key] === 'boolean') settings[key] = raw[key];
  }
  if (['agent', 'dictation'].includes(raw.mode)) settings.mode = raw.mode;
  if (['cpu', 'cuda'].includes(raw.whisperDevice)) settings.whisperDevice = raw.whisperDevice;
  if (['local', 'cloud'].includes(raw.sttProvider)) settings.sttProvider = raw.sttProvider;
  if (['local', 'cloud'].includes(raw.activeMode)) settings.activeMode = raw.activeMode;
  if (['island', 'notch'].includes(raw.overlayStyle)) settings.overlayStyle = raw.overlayStyle;
  if (typeof raw.chatProvider === 'string' && Object.hasOwn(PROVIDERS, raw.chatProvider)) settings.chatProvider = raw.chatProvider;
  if (typeof raw.sttCloudProvider === 'string' && STT_CLOUD_PROVIDERS.includes(raw.sttCloudProvider)) settings.sttCloudProvider = raw.sttCloudProvider;
  else if (typeof raw.sttCloudProvider === 'string') log?.warn('settings load', `Unsupported transcription provider "${raw.sttCloudProvider}" was reset to ${settings.sttCloudProvider}.`);
  if (typeof raw.fallbackProvider === 'string' && raw.fallbackProvider !== 'local' && Object.hasOwn(PROVIDERS, raw.fallbackProvider)) settings.fallbackProvider = raw.fallbackProvider;
  else if (typeof raw.fallbackProvider === 'string') log?.warn('settings load', `Invalid fallback provider "${raw.fallbackProvider}" was reset to ${settings.fallbackProvider}.`);
  if (typeof raw.lastCloudProvider === 'string' && raw.lastCloudProvider !== 'local' && Object.hasOwn(PROVIDERS, raw.lastCloudProvider)) settings.lastCloudProvider = raw.lastCloudProvider;
  else if (typeof raw.lastCloudProvider === 'string') log?.warn('settings load', `Invalid last cloud provider "${raw.lastCloudProvider}" was reset to ${settings.lastCloudProvider}.`);

  for (const key of ['dictationHotkey', 'agentHotkey']) {
    if (typeof raw[key] === 'string' && isValidHotkey(raw[key])) settings[key] = raw[key];
    else if (typeof raw[key] === 'string') log?.warn('settings load', `${key} value "${raw[key]}" is not supported; using ${settings[key]}.`);
  }
  if (settings.dictationHotkey === settings.agentHotkey) {
    log?.warn('settings load', 'Both modes used the same shortcut; Agent was reset to its default.');
    settings.agentHotkey = base.agentHotkey;
    if (settings.agentHotkey === settings.dictationHotkey) settings.dictationHotkey = base.dictationHotkey;
  }

  const settingsVersion = Number.isInteger(raw.settingsVersion) ? raw.settingsVersion : 1;
  if (settingsVersion < 2 && settings.whisperModel === 'large-v3') {
    settings.whisperModel = base.whisperModel;
    settings.whisperDevice = base.whisperDevice;
    log?.info('settings load', `Migrated the old Whisper default to ${base.whisperModel} on ${base.whisperDevice}. Select large-v3 in Dictation to use it again.`);
  }
  settings.settingsVersion = base.settingsVersion;

  settings.providers = normalizeProviders(raw.providers, base.providers);
  if (!raw.providers?.local?.model && typeof raw.ollamaModel === 'string') {
    const legacyModel = raw.ollamaModel.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (legacyModel) {
      settings.providers.local.model = legacyModel;
      log?.info('settings load', `Migrated the old Ollama model setting to ${legacyModel}.`);
    }
  }
  settings.approval = { ...base.approval };
  if (raw.approval && typeof raw.approval === 'object') {
    for (const tool of Object.keys(settings.approval)) {
      if (typeof raw.approval[tool] === 'boolean') settings.approval[tool] = raw.approval[tool];
    }
  }
  settings.permissionMode = normalizePermissionMode(raw.permissionMode, base.permissionMode);
  settings.permissionCustom = normalizeCustomPermissions(raw.permissionCustom, base.permissionCustom);
  if (raw.permissionMode === undefined) {
    const legacy = legacyPermissionSettings(raw.approval);
    if (legacy) {
      settings.permissionMode = legacy.permissionMode;
      settings.permissionCustom = legacy.permissionCustom;
      log?.info('settings load', 'Migrated legacy per-tool approval switches to Custom permission mode.');
    }
  }
  settings.activeMode = settings.chatProvider === 'local' ? 'local' : 'cloud';
  if (settings.chatProvider !== 'local') settings.lastCloudProvider = settings.chatProvider;
  if (!settings.displayName) settings.displayName = userName;
  if (settings.communityUrl && normalizeUrl(settings.communityUrl)?.startsWith('https://') !== true) settings.communityUrl = '';
  return settings;
}

function sanitizeSettingsPatch(value, current, isValidHotkey) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings payload is invalid.');
  const patch = {};
  for (const key of ['dictationHotkey', 'agentHotkey']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || !isValidHotkey(value[key])) throw new Error(`Choose a supported shortcut for ${key === 'dictationHotkey' ? 'Dictation' : 'Agent'}.`);
    patch[key] = value[key];
  }
  const nextDictation = patch.dictationHotkey || current.dictationHotkey;
  const nextAgent = patch.agentHotkey || current.agentHotkey;
  if (nextDictation === nextAgent) throw new Error('Dictation and Agent must use different shortcuts.');

  for (const key of ['dictationEnabled', 'agentEnabled', 'fallbackEnabled', 'startWithWindows', 'paused', 'spokenReplies']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') throw new Error(`${key} must be true or false.`);
      patch[key] = value[key];
    }
  }
  if (value.mode !== undefined) {
    if (!['agent', 'dictation'].includes(value.mode)) throw new Error('Unknown assistant mode.');
    patch.mode = value.mode;
  }
  if (value.overlayStyle !== undefined) {
    if (!['island', 'notch'].includes(value.overlayStyle)) throw new Error('Overlay style must be Island or Notch.');
    patch.overlayStyle = value.overlayStyle;
  }
  for (const key of ['whisperModel', 'sttModel']) {
    if (value[key] === undefined) continue;
    const text = String(value[key]).trim();
    if (!text || text.length > 120) throw new Error('Model names must be between 1 and 120 characters.');
    patch[key] = text;
  }
  if (value.whisperDevice !== undefined) {
    if (!['cpu', 'cuda'].includes(value.whisperDevice)) throw new Error('Whisper device must be CPU or CUDA.');
    patch.whisperDevice = value.whisperDevice;
  }
  if (value.sttProvider !== undefined) {
    if (!['local', 'cloud'].includes(value.sttProvider)) throw new Error('Transcription provider is invalid.');
    patch.sttProvider = value.sttProvider;
  }
  for (const key of ['chatProvider', 'sttCloudProvider', 'fallbackProvider', 'lastCloudProvider']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || !Object.hasOwn(PROVIDERS, value[key])) throw new Error(`Unknown provider: ${value[key]}.`);
    if (key === 'sttCloudProvider' && !STT_CLOUD_PROVIDERS.includes(value[key])) {
      throw new Error('Cloud transcription supports OpenAI or Groq only.');
    }
    if (key !== 'chatProvider' && value[key] === 'local') {
      throw new Error(`${key} must be a cloud provider.`);
    }
    patch[key] = value[key];
  }
  if (value.activeMode !== undefined) {
    if (!['local', 'cloud'].includes(value.activeMode)) throw new Error('Provider mode is invalid.');
    patch.activeMode = value.activeMode;
  }
  if (value.microphoneId !== undefined) {
    if (typeof value.microphoneId !== 'string' || value.microphoneId.length > 300) throw new Error('Microphone selection is invalid.');
    patch.microphoneId = value.microphoneId;
  }
  if (value.displayName !== undefined) {
    if (typeof value.displayName !== 'string') throw new Error('Display name must be text.');
    const name = value.displayName.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.MAX_PROFILE_NAME_CHARS);
    patch.displayName = name || current.displayName;
  }
  if (value.communityUrl !== undefined) {
    if (typeof value.communityUrl !== 'string' || value.communityUrl.length > LIMITS.MAX_COMMUNITY_URL_CHARS) throw new Error('Community URL is too long.');
    const url = value.communityUrl.trim();
    if (url) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error('Community URL must be a valid HTTPS address.');
      }
      if (parsed.protocol !== 'https:') throw new Error('Community URL must use HTTPS.');
      if (parsed.username || parsed.password) throw new Error('Community URL cannot contain credentials.');
      patch.communityUrl = parsed.href;
    } else {
      patch.communityUrl = '';
    }
  }
  if (value.approval !== undefined) {
    if (!value.approval || typeof value.approval !== 'object' || Array.isArray(value.approval)) throw new Error('Approval rules are invalid.');
    patch.approval = { ...current.approval };
    for (const tool of Object.keys(patch.approval)) {
      if (typeof value.approval[tool] === 'boolean') patch.approval[tool] = value.approval[tool];
    }
  }
  if (value.permissionMode !== undefined) {
    if (!isValidPermissionMode(value.permissionMode)) throw new Error('Permission mode is invalid.');
    patch.permissionMode = value.permissionMode;
  }
  if (value.permissionCustom !== undefined) {
    if (!value.permissionCustom || typeof value.permissionCustom !== 'object' || Array.isArray(value.permissionCustom)) {
      throw new Error('Custom permission rules are invalid.');
    }
    for (const [category, allowed] of Object.entries(value.permissionCustom)) {
      if (!Object.hasOwn(current.permissionCustom || {}, category)) throw new Error(`Unknown permission category: ${category}.`);
      if (typeof allowed !== 'boolean') throw new Error(`Custom permission for ${category} must be true or false.`);
    }
    patch.permissionCustom = normalizeCustomPermissions(value.permissionCustom, current.permissionCustom);
  }
  if (value.providers !== undefined) {
    if (!value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers)) throw new Error('Provider settings are invalid.');
    const providers = structuredClone(current.providers);
    for (const [name, config] of Object.entries(value.providers)) {
      if (!Object.hasOwn(PROVIDERS, name)) continue;
      if (!config || typeof config !== 'object') throw new Error(`Provider settings for ${name} are invalid.`);
      if (config.url !== undefined) {
        const url = normalizeProviderUrl(name, config.url);
        if (!url) throw new Error(`Base URL for ${name} must be ${name === 'local' ? 'a valid HTTP or HTTPS address' : 'a valid HTTPS address'}.`);
        providers[name].url = url;
      }
      if (config.model !== undefined) {
        const model = String(config.model).trim();
        if (!model || model.length > 200) throw new Error(`Model name for ${name} is invalid.`);
        providers[name].model = model;
      }
    }
    patch.providers = providers;
  }
  return patch;
}

function loadHistory(log) {
  const raw = readJson('history.json', [], log);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((turn) => turn && typeof turn === 'object' && typeof turn.said === 'string' && typeof turn.did === 'string')
    .slice(0, LIMITS.MAX_TURNS)
    .map((turn) => ({
      time: Number.isNaN(Date.parse(turn.time)) ? new Date().toISOString() : turn.time,
      said: turn.said.slice(0, LIMITS.MAX_TRANSCRIPT_CHARS),
      did: turn.did.slice(0, LIMITS.MAX_TRANSCRIPT_CHARS)
    }));
}

function loadMemory(log) {
  const raw = readJson('memory.json', [], log);
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry) => typeof entry === 'string').slice(-LIMITS.MAX_MEMORY_ENTRIES).map((entry) => entry.slice(0, LIMITS.MAX_MEMORY_CHARS));
}

module.exports = {
  userFile,
  readJson,
  writeJson,
  readSecrets,
  writeSecrets,
  normalizeUrl,
  normalizeProviderUrl,
  loadSettings,
  sanitizeSettingsPatch,
  loadHistory,
  loadMemory
};
