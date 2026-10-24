'use strict';

const api = window.voiceAgent;
const updaterApi = window.voxa?.updater;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const WHISPER_MODELS = [
  { id: 'tiny', label: 'Tiny', sizeBytes: 75525797 },
  { id: 'base', label: 'Base', sizeBytes: 145466455 },
  { id: 'small', label: 'Small', sizeBytes: 484190939 },
  { id: 'medium', label: 'Medium', sizeBytes: 1530000000 },
  { id: 'large-v3-turbo', label: 'Large v3 Turbo', sizeBytes: 1620000000 },
  { id: 'large-v3', label: 'Large v3', sizeBytes: 3090000000 }
];
const WHISPER_PRESETS = {
  fast: { label: 'Fast', model: 'base', description: 'Lower latency and a smaller download.' },
  balanced: { label: 'Balanced', model: 'small', description: 'Good everyday speed and accuracy.' },
  accurate: { label: 'Accurate', model: 'large-v3', description: 'Best accuracy with the largest download.' },
  custom: { label: 'Custom', model: '', description: 'Choose any installed or downloadable model.' }
};
// Kokoro voice language group labels — derived from tts-text.cjs lang codes.
const TTS_LANG_LABELS = {
  a: 'American English',
  b: 'British English',
  e: 'Spanish',
  f: 'French',
  h: 'Hindi',
  i: 'Italian',
  j: 'Japanese',
  p: 'Portuguese',
  z: 'Mandarin'
};

// Full Kokoro voice list (mirrors VOICES in lib/tts-text.cjs).
const TTS_VOICES = [
  { id: 'af_heart',    lang: 'a', label: 'Heart' },
  { id: 'af_alloy',    lang: 'a', label: 'Alloy' },
  { id: 'af_aoede',    lang: 'a', label: 'Aoede' },
  { id: 'af_bella',    lang: 'a', label: 'Bella' },
  { id: 'af_jessica',  lang: 'a', label: 'Jessica' },
  { id: 'af_kore',     lang: 'a', label: 'Kore' },
  { id: 'af_nicole',   lang: 'a', label: 'Nicole' },
  { id: 'af_nova',     lang: 'a', label: 'Nova' },
  { id: 'af_river',    lang: 'a', label: 'River' },
  { id: 'af_sarah',    lang: 'a', label: 'Sarah' },
  { id: 'af_sky',      lang: 'a', label: 'Sky' },
  { id: 'am_adam',     lang: 'a', label: 'Adam' },
  { id: 'am_echo',     lang: 'a', label: 'Echo' },
  { id: 'am_eric',     lang: 'a', label: 'Eric' },
  { id: 'am_fenrir',   lang: 'a', label: 'Fenrir' },
  { id: 'am_liam',     lang: 'a', label: 'Liam' },
  { id: 'am_michael',  lang: 'a', label: 'Michael' },
  { id: 'am_onyx',     lang: 'a', label: 'Onyx' },
  { id: 'am_puck',     lang: 'a', label: 'Puck' },
  { id: 'am_santa',    lang: 'a', label: 'Santa' },
  { id: 'bf_alice',    lang: 'b', label: 'Alice' },
  { id: 'bf_emma',     lang: 'b', label: 'Emma' },
  { id: 'bf_isabella', lang: 'b', label: 'Isabella' },
  { id: 'bf_lily',     lang: 'b', label: 'Lily' },
  { id: 'bm_daniel',   lang: 'b', label: 'Daniel' },
  { id: 'bm_fable',    lang: 'b', label: 'Fable' },
  { id: 'bm_george',   lang: 'b', label: 'George' },
  { id: 'bm_lewis',    lang: 'b', label: 'Lewis' },
  { id: 'ef_dora',     lang: 'e', label: 'Dora' },
  { id: 'em_alex',     lang: 'e', label: 'Alex' },
  { id: 'em_santa',    lang: 'e', label: 'Santa' },
  { id: 'ff_siwis',    lang: 'f', label: 'Siwis' },
  { id: 'hf_alpha',    lang: 'h', label: 'Alpha' },
  { id: 'hf_beta',     lang: 'h', label: 'Beta' },
  { id: 'hm_omega',    lang: 'h', label: 'Omega' },
  { id: 'hm_psi',      lang: 'h', label: 'Psi' },
  { id: 'if_sara',     lang: 'i', label: 'Sara' },
  { id: 'im_nicola',   lang: 'i', label: 'Nicola' },
  { id: 'jf_alpha',      lang: 'j', label: 'Alpha' },
  { id: 'jf_gongitsune', lang: 'j', label: 'Gongitsune' },
  { id: 'jf_nezumi',     lang: 'j', label: 'Nezumi' },
  { id: 'jf_tebukuro',   lang: 'j', label: 'Tebukuro' },
  { id: 'jm_kumo',       lang: 'j', label: 'Kumo' },
  { id: 'pf_dora',     lang: 'p', label: 'Dora' },
  { id: 'pm_alex',     lang: 'p', label: 'Alex' },
  { id: 'pm_santa',    lang: 'p', label: 'Santa' },
  { id: 'zf_xiaobei',  lang: 'z', label: 'Xiaobei' },
  { id: 'zf_xiaoni',   lang: 'z', label: 'Xiaoni' },
  { id: 'zf_xiaoxiao', lang: 'z', label: 'Xiaoxiao' },
  { id: 'zf_xiaoyi',   lang: 'z', label: 'Xiaoyi' },
  { id: 'zm_yunjian',  lang: 'z', label: 'Yunjian' },
  { id: 'zm_yunxi',    lang: 'z', label: 'Yunxi' },
  { id: 'zm_yunxia',   lang: 'z', label: 'Yunxia' },
  { id: 'zm_yunyang',  lang: 'z', label: 'Yunyang' }
];

function ttsVoiceOptions(selected) {
  // Group voices by language, emit <optgroup> per group.
  const groups = new Map();
  for (const v of TTS_VOICES) {
    if (!groups.has(v.lang)) groups.set(v.lang, []);
    groups.get(v.lang).push(v);
  }
  return [...groups.entries()].map(([lang, voices]) => {
    const groupLabel = TTS_LANG_LABELS[lang] || lang;
    const opts = voices.map((v) => `<option value="${esc(v.id)}" ${selected === v.id ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
    return `<optgroup label="${esc(groupLabel)}">${opts}</optgroup>`;
  }).join('');
}

function updateTtsVoiceSelect() {
  const engine = $('#ttsEngine');
  const voice = $('#ttsVoice');
  if (!engine || !voice) return;
  voice.disabled = engine.value !== 'kokoro';
}

const PERMISSION_MODES = [
  ['ask', 'Ask Every Time', 'Show an approval prompt before every desktop action.'],
  ['routine', 'Allow Routine Actions', 'Open files, folders, apps, and websites without repeated prompts. Sensitive actions still ask.'],
  ['custom', 'Custom', 'Choose which routine action categories Voxa may use without asking.']
];
const PERMISSION_CATEGORIES = [
  ['open_files', 'Open files', 'Open documents and media from your user folders.'],
  ['open_folders', 'Open folders', 'Navigate to ordinary folders inside Home, Desktop, Documents, Downloads, Pictures, Music, or Videos.'],
  ['launch_apps', 'Launch applications', 'Start apps discovered from the Start menu.'],
  ['browse_web', 'Open websites and search', 'Open HTTPS pages and run Google searches.'],
  ['read_files', 'Read files in your folders', 'Read text from non-sensitive files in your user folders.'],
  ['save_notes', 'Save memory notes', 'Save a short note when you explicitly ask Voxa to remember it.']
];
const SENSITIVE_PERMISSION_LABELS = [
  'Typing text, sending messages, or submitting forms',
  'Sending keyboard shortcuts',
  'Running scripts or downloaded executables',
  'Deleting or overwriting files',
  'Running administrator-level commands',
  'Accessing credentials or changing security settings'
];

let data = { settings: {} };
let settings = {};
let updaterStatus = { state: 'idle' };
let activePage = 'dashboard';
let historyQuery = '';
let logQuery = '';
let settingsDirty = false;
let toastTimer = null;
let monitorActive = false;
let micTestRunning = false;
let lastFocused = null;
let gallerySlowMotion = false;
let galleryLoop = false;
let gallerySequenceToken = 0;
let gallerySequenceRunning = false;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function note(text) {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = String(text || '');
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

function icon(path) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
}

function chip(text, kind = '') {
  return `<span class="badge ${kind}">${esc(text)}</span>`;
}

const FREELLMAPI_PROVIDER = 'freellmapi';
const FREELLMAPI_RECOMMENDED = ['auto', 'auto:fast', 'auto:smart'];
const modelMemory = new Map();
const comboStates = new WeakMap();

function providerLabel(name) {
  return ({
    local: 'Local',
    freellmapi: 'FreeLLMAPI',
    openai: 'OpenAI',
    groq: 'Groq',
    gemini: 'Gemini',
    anthropic: 'Anthropic',
    custom: 'Custom'
  })[name] || String(name || 'Agent');
}

function providerNeedsKey(name) {
  return name !== 'local' && name !== FREELLMAPI_PROVIDER;
}

function isCloudProvider(name) {
  return Boolean(name && name !== 'none' && !['local', FREELLMAPI_PROVIDER].includes(name));
}

function serviceStatus(service = {}, name) {
  if (service.status === 'downloading') {
    const percent = service.progress?.percent;
    const stalled = Boolean(service.progress?.stalled);
    return {
      text: stalled ? `${name} Download stalled` : percent == null ? `${name} Downloading` : `${name} Downloading ${percent}%`,
      kind: stalled ? 'bad' : 'info',
      title: service.message || `Downloading ${service.model || name}.`
    };
  }
  if (service.status === 'loading') {
    return { text: `${name} Loading`, kind: 'info', title: service.message || `Loading ${service.model || name}.` };
  }
  if (service.ok) return { text: `${name} Ready`, kind: 'good', title: service.message || '' };
  if (service.status === 'mismatch') {
    return { text: `${name} Mismatch`, kind: 'bad', title: service.message || '' };
  }
  if (service.status === 'error') {
    return { text: `${name} Error`, kind: 'bad', title: service.message || '' };
  }
  return { text: `${name} Offline`, kind: 'bad', title: service.message || '' };
}

function formatBytes(value, empty = 'Unknown size') {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return empty;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function formatSpeed(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB/s`;
}

function whisperCatalog() {
  const health = data.health?.whisper;
  const source = Array.isArray(health?.models) && health.models.length ? health.models : null;
  if (source) {
    return source.map((item) => ({
      id: String(item.id || ''),
      label: String(item.label || item.id || ''),
      sizeBytes: Number(item.sizeBytes ?? item.size_bytes) || 0,
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

function whisperPresetForSelection(model) {
  const current = settings.performancePreset;
  if (current && current !== 'custom' && WHISPER_PRESETS[current]?.model === model) return current;
  return 'custom';
}

function healthChip(id, status) {
  return `<span id="${esc(id)}" class="badge ${status.kind}" title="${esc(status.title)}">${esc(status.text)}</span>`;
}

function updateHealthBadges() {
  const provider = settings.chatProvider || 'local';
  const chatService = data.health?.chat || data.health?.ollama;
  const statuses = {
    healthOllama: serviceStatus(chatService, provider === 'local' ? 'Ollama' : providerLabel(provider)),
    healthWhisper: serviceStatus(data.health?.whisper, 'Whisper'),
    settingsHealthOllama: serviceStatus(data.health?.ollama, 'Ollama'),
    settingsHealthWhisper: serviceStatus(data.health?.whisper, 'Whisper')
  };
  for (const [id, status] of Object.entries(statuses)) {
    const element = document.getElementById(id);
    if (!element) continue;
    element.textContent = status.text;
    element.className = `badge ${status.kind}`;
    element.title = status.title;
  }
}

function whisperProgressState(service = {}) {
  const status = service.status;
  if (!['downloading', 'loading'].includes(status)) {
    return { visible: false, status, percent: null, text: '', stalled: false, cancellable: false };
  }
  const progress = service.progress || {};
  const raw = progress.percent == null ? NaN : Number(progress.percent);
  const percent = status === 'loading' ? null : Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : null;
  const stalled = Boolean(progress.stalled);
  const speed = formatSpeed(progress.speedBps);
  const detail = Number(progress.totalBytes) > 0
    ? `${formatBytes(progress.downloadedBytes, '0 MB')} of ${formatBytes(progress.totalBytes)}`
    : '';
  let text = service.message || (status === 'loading' ? 'Loading the speech model…' : 'Downloading the speech model…');
  if (status === 'downloading' && detail) text += ` · ${detail}`;
  if (!stalled && speed) text += ` · ${speed}`;
  if (stalled) text += ' · No progress for 60 seconds. Retry or cancel.';
  return {
    visible: true,
    status,
    percent,
    text,
    stalled,
    cancellable: status === 'downloading' || status === 'loading'
  };
}

function whisperProgressRow() {
  return `<div class="row download-row" id="whisperProgressRow" hidden>
    <span class="row-icon">${icon('M12 3v12m0 0 4-4m-4 4-4-4M5 21h14')}</span>
    <div class="row-main"><b>Speech model</b><small id="whisperProgressText">Preparing the model…</small><div class="progress-track"><i id="whisperProgressBar"></i></div></div>
    <div class="row-side"><span id="whisperProgressPercent" class="badge info">Working</span><button class="button" data-action="whisper-cancel" hidden>Cancel</button><button class="button" data-action="whisper-retry" hidden>Retry</button></div>
  </div>`;
}

function whisperProgressPanel() {
  return `<div class="whisper-download" id="dictationWhisperProgress" hidden>
    <div class="row-side" style="justify-content:space-between"><b>Whisper model</b><span class="badge info" id="dictationWhisperPercent">Working</span></div>
    <div class="progress-track"><i id="dictationWhisperBar"></i></div>
    <small class="card-note" id="dictationWhisperText"></small>
    <div class="row-side" style="justify-content:flex-end;margin-top:10px"><button class="button" data-action="whisper-cancel" hidden>Cancel</button><button class="button primary" data-action="whisper-retry" hidden>Retry</button></div>
  </div>`;
}

function kokoroProgressPanel() {
  return `<div class="whisper-download" id="dictationKokoroProgress" hidden>
    <div class="row-side" style="justify-content:space-between"><b>Kokoro model</b><span class="badge info" id="dictationKokoroPercent">Working</span></div>
    <div class="progress-track"><i id="dictationKokoroBar"></i></div>
    <small class="card-note" id="dictationKokoroText"></small>
  </div>`;
}

function updateKokoroProgress() {
  const status = data.health?.kokoro || {};
  const panel = document.getElementById('dictationKokoroProgress');
  if (!panel) return;
  const isDownloading = status.status === 'downloading';
  const isWorking = isDownloading || status.status === 'loading';
  panel.hidden = !isWorking;
  const bar = document.getElementById('dictationKokoroBar');
  const text = document.getElementById('dictationKokoroText');
  const percentBadge = document.getElementById('dictationKokoroPercent');
  if (bar) {
    const pct = status.progress?.percent;
    bar.style.width = Number.isFinite(pct) ? `${pct}%` : '';
    bar.classList.toggle('indeterminate', !Number.isFinite(pct));
  }
  if (text) {
    text.textContent = isDownloading && status.progress?.totalBytes
      ? `Downloading Kokoro model (${formatBytes(status.progress.downloadedBytes)} of ${formatBytes(status.progress.totalBytes)})`
      : status.error || 'Downloading Kokoro-82M model (~86 MB)…';
  }
  if (percentBadge) {
    const pct = status.progress?.percent;
    percentBadge.textContent = Number.isFinite(pct) ? `${pct}%` : 'Working';
  }
}

function updateWhisperProgress() {
  const state = whisperProgressState(data.health?.whisper);
  const targets = [
    ['whisperProgressRow', 'whisperProgressText', 'whisperProgressBar', 'whisperProgressPercent'],
    ['dictationWhisperProgress', 'dictationWhisperText', 'dictationWhisperBar', 'dictationWhisperPercent']
  ];
  for (const [rowId, textId, barId, percentId] of targets) {
    const row = document.getElementById(rowId);
    if (!row) continue;
    row.hidden = !state.visible;
    const text = document.getElementById(textId);
    const bar = document.getElementById(barId);
    const percent = document.getElementById(percentId);
    const cancel = row.querySelector('[data-action="whisper-cancel"]');
    const retry = row.querySelector('[data-action="whisper-retry"]');
    if (cancel) cancel.hidden = !state.visible || !state.cancellable;
    if (retry) retry.hidden = !state.visible || !state.stalled;
    if (!state.visible) continue;
    if (text) text.textContent = state.text;
    if (bar) {
      bar.classList.toggle('indeterminate', state.percent == null && !state.stalled);
      bar.style.width = state.percent == null ? '' : `${state.percent}%`;
    }
    if (percent) {
      percent.textContent = state.stalled ? 'Stalled' : state.percent == null ? 'Working' : `${state.percent}%`;
      percent.className = `badge ${state.stalled ? 'bad' : 'info'}`;
    }
  }
}

function whisperInfoFor(model) {
  const id = String(model || '');
  return whisperCatalog().find((item) => item.id === id)
    || WHISPER_MODELS.find((item) => item.id === id)
    || { id, label: id || 'Whisper', sizeBytes: 0, downloaded: null, active: false, status: 'Unknown' };
}

function whisperModelLabel(model) {
  return whisperInfoFor(model).label || model || 'Whisper';
}

function whisperOptionText(item, activeModel = '') {
  const active = item.active || (activeModel && activeModel === item.id);
  const status = active ? 'Active' : item.downloaded === true ? 'Downloaded' : item.downloaded === false ? 'Not downloaded' : 'Status unknown';
  return `${item.label} · ${formatBytes(item.sizeBytes)} · ${status}`;
}

function whisperModelOptions(selected) {
  const models = whisperCatalog();
  if (selected && !models.some((item) => item.id === selected)) {
    models.push({ ...whisperInfoFor(selected), id: selected });
  }
  const activeModel = data.health?.whisper?.activeModel || '';
  return models.map((item) => `<option value="${esc(item.id)}" ${selected === item.id ? 'selected' : ''}>${esc(whisperOptionText(item, activeModel))}</option>`).join('');
}

function whisperModelCard() {
  const selected = settings.whisperModel || 'small';
  const info = whisperInfoFor(selected);
  return `<div class="whisper-model-card" id="whisperModelCard">
    <div class="row-side" style="justify-content:space-between;align-items:flex-start">
      <div class="row-main"><b id="whisperSelectedName">${esc(info.label)}</b><small class="card-note" id="whisperSelectedMeta">${esc(info.status || 'Status unknown')}</small></div>
      <span class="badge info" id="whisperStatusBadge">${esc(info.status || 'Status unknown')}</span>
    </div>
    <div class="whisper-facts"><span>Download <b id="whisperSize">${esc(formatBytes(info.sizeBytes))}</b></span><span>Active model <b id="whisperActiveModel">None</b></span></div>
    <div class="row-side" style="justify-content:space-between;margin-top:10px"><span class="card-note" id="whisperActionNote"></span><button class="button primary" id="whisperAction" type="button" data-action="whisper-switch" data-model="${esc(selected)}">Download</button></div>
  </div>`;
}

function updateWhisperModelControls() {
  const select = $('#whisper');
  const selected = select?.value || settings.whisperModel || 'small';
  const info = whisperInfoFor(selected);
  const health = data.health?.whisper || {};
  const activeModel = health.activeModel || health.active_model || '';
  const downloaded = info.downloaded;
  const isActive = Boolean(activeModel ? activeModel === selected : info.active);
  const switching = Boolean(health.switching) || ['downloading', 'loading'].includes(health.status);
  const stalled = Boolean(health.progress?.stalled);
  const targetModel = health.targetModel || health.target_model || '';
  const targetMatches = !targetModel || targetModel === selected;
  const switchError = targetMatches ? health.switchError || health.switch_error || '' : '';
  const failedForSelection = targetMatches && health.status === 'error';
  const statusText = isActive ? 'Active' : downloaded === true ? 'Downloaded' : downloaded === false ? 'Not downloaded' : 'Status unknown';
  const badgeKind = isActive || downloaded === true ? 'good' : 'info';
  const name = $('#whisperSelectedName');
  const meta = $('#whisperSelectedMeta');
  const badge = $('#whisperStatusBadge');
  const size = $('#whisperSize');
  const active = $('#whisperActiveModel');
  const action = $('#whisperAction');
  const actionNote = $('#whisperActionNote');
  const preset = $('#performancePreset');
  const presetNote = $('#performancePresetNote');
  if (name) name.textContent = info.label;
  if (meta) meta.textContent = statusText;
  if (badge) {
    badge.textContent = statusText;
    badge.className = `badge ${badgeKind}`;
  }
  if (size) size.textContent = formatBytes(info.sizeBytes);
  if (active) active.textContent = activeModel ? whisperModelLabel(activeModel) : 'None';
  if (preset) {
    preset.disabled = switching;
    if (document.activeElement !== preset) preset.value = settings.performancePreset || 'custom';
  }
  if (presetNote) {
    const presetValue = preset?.value || settings.performancePreset || 'custom';
    presetNote.textContent = WHISPER_PRESETS[presetValue]?.description || WHISPER_PRESETS.custom.description;
  }
  if (select) {
    select.disabled = switching;
    for (const option of select.options) {
      option.textContent = whisperOptionText(whisperInfoFor(option.value), activeModel);
    }
    if (!switching) select.value = selected;
  }
  if (action) {
    const activeWork = switching && !stalled;
    action.disabled = isActive || activeWork;
    action.dataset.model = selected;
    action.textContent = isActive ? 'Active' : activeWork ? 'Switching…' : stalled || failedForSelection || switchError ? 'Retry' : downloaded === true ? 'Switch' : 'Download';
  }
  if (actionNote) {
    const noteError = isActive ? '' : switchError;
    actionNote.textContent = stalled
      ? 'Download stalled. Retry or cancel.'
      : switching
        ? health.message || `Preparing ${whisperModelLabel(targetModel || selected)}.`
        : failedForSelection
          ? health.message || 'The Whisper model failed to load.'
          : noteError
            ? `Switch failed: ${noteError}`
            : downloaded === false
              ? activeModel
                ? 'Not downloaded yet. Choose Download; the current model keeps working until the switch completes.'
                : 'Not downloaded yet. Choose Download to fetch it.'
              : downloaded == null
                ? 'Start Whisper to check whether this model is installed.'
                : isActive ? 'This model is ready for dictation.' : 'Ready to switch without restarting the app.';
  }
}

function localOllamaModel() {
  return settings.providers?.local?.model || 'qwen3:8b';
}

function ollamaSetupState(service = {}) {
  const model = localOllamaModel();
  if (service.ok) {
    return { title: `${model} is ready`, text: 'Ollama is running and the local model is installed.' };
  }
  if (service.modelAvailable === false) {
    return { title: 'Ollama is running', text: `The ${model} model is not installed yet. Pull it once to use local answers.` };
  }
  if (service.installed) {
    return { title: 'Ollama is installed but not running', text: 'The pull button starts Ollama and downloads the selected model automatically.' };
  }
  return { title: 'Ollama is not installed', text: 'Install Ollama for Windows from the download link, then use Pull model to finish setup.' };
}

function ollamaSetupCard() {
  const state = ollamaSetupState(data.health?.ollama || {});
  const model = localOllamaModel();
  return `<article class="card" id="ollamaSetup">
    <h2 class="card-title">Local model · Ollama</h2>
    <div class="setup-step">
      <span class="row-icon">${icon('M4 5h16v14H4zM8 9h8M8 13h5')}</span>
      <div class="row-main"><b id="ollamaTitle">${esc(state.title)}</b><small id="ollamaText">${esc(state.text)}</small></div>
      <div class="row-side"><button class="button" data-action="ollama-download">Download Ollama</button><button class="button primary" id="ollamaPullButton" data-action="ollama-pull">Pull ${esc(model)}</button><button class="button" data-action="health">Check again</button></div>
    </div>
    <div class="whisper-download" id="ollamaPullProgress" hidden>
      <div class="row-side" style="justify-content:space-between"><b id="ollamaPullStatus">Starting Ollama…</b><span class="badge info" id="ollamaPullPercent">Working</span></div>
      <div class="progress-track"><i id="ollamaPullBar"></i></div>
    </div>
    <p class="card-note">The model is downloaded once into Ollama's local storage. It stays on this computer.</p>
  </article>`;
}

function updateOllamaSetup() {
  const title = document.getElementById('ollamaTitle');
  if (!title) return;
  const state = ollamaSetupState(data.health?.ollama || {});
  title.textContent = state.title;
  const text = document.getElementById('ollamaText');
  if (text) text.textContent = state.text;
  const button = document.getElementById('ollamaPullButton');
  if (button) button.textContent = `Pull ${localOllamaModel()}`;
}

function ollamaProgressLabel(status) {
  const text = String(status || 'Working').replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function updateOllamaProgress(progress = {}) {
  const panel = document.getElementById('ollamaPullProgress');
  if (!panel) return;
  panel.hidden = false;
  const raw = Number(progress.percent);
  const percent = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : null;
  const bar = document.getElementById('ollamaPullBar');
  if (bar) {
    bar.classList.toggle('indeterminate', percent == null);
    bar.style.width = percent == null ? '' : `${percent}%`;
  }
  const label = document.getElementById('ollamaPullStatus');
  if (label) label.textContent = progress.message || ollamaProgressLabel(progress.status);
  const badge = document.getElementById('ollamaPullPercent');
  if (badge) badge.textContent = percent == null ? 'Working' : `${percent}%`;
}

function toggle(id, checked, label, setting = '', tool = '', permission = '') {
  return `<label class="toggle" aria-label="${esc(label)}"><input id="${esc(id)}" type="checkbox" ${checked ? 'checked' : ''} data-setting="${esc(setting)}" data-tool="${esc(tool)}"${permission ? ` data-permission="${esc(permission)}"` : ''}><span></span></label>`;
}

function updaterStatusText(status) {
  switch (status?.state) {
    case 'disabled-dev': return 'Updates are available in installed builds.';
    case 'checking': return 'Checking for updates…';
    case 'available': return status.version ? `Version ${status.version} is available.` : 'An update is available.';
    case 'not-available': return 'Voxa is up to date.';
    case 'downloading': return status.percent == null ? 'Downloading update…' : `Downloading update… ${status.percent}%`;
    case 'downloaded': return status.version ? `Version ${status.version} is ready. It will install when Voxa quits.` : 'The update is ready. It will install when Voxa quits.';
    case 'error': return 'Could not check for updates. Voxa will try again later.';
    default: return 'Not checked yet.';
  }
}

function updateUpdaterUi(status = updaterStatus) {
  updaterStatus = status || updaterStatus;
  const state = updaterStatus.state || 'idle';
  const version = $('#updateCurrentVersion');
  const currentVersion = updaterStatus.currentVersion || data.appVersion || '';
  if (version) version.textContent = currentVersion ? `Version ${currentVersion}` : 'Development build';
  const text = $('#updateStatusText');
  if (text) text.textContent = updaterStatus.message || updaterStatusText(updaterStatus);
  const check = $('#updateCheck');
  if (check) check.disabled = state === 'disabled-dev' || state === 'checking' || state === 'downloading';
  const download = $('#updateDownload');
  if (download) {
    download.hidden = state !== 'available';
    download.disabled = false;
  }
  const progress = $('#updateProgress');
  if (progress) progress.hidden = state !== 'downloading';
  const rawPercent = updaterStatus.percent == null ? NaN : Number(updaterStatus.percent);
  const percent = Number.isFinite(rawPercent) ? Math.max(0, Math.min(100, Math.round(rawPercent))) : null;
  const bar = $('#updateProgressBar');
  if (bar) {
    bar.classList.toggle('indeterminate', percent == null);
    bar.style.width = percent == null ? '' : `${percent}%`;
  }
  const progressText = $('#updateProgressText');
  if (progressText) progressText.textContent = percent == null ? 'Downloading…' : `${percent}%`;
  const install = $('#updateInstall');
  if (install) {
    install.hidden = state !== 'downloaded';
    install.disabled = false;
  }
  const notes = $('#updateReleaseNotes');
  if (notes) {
    const releaseNotes = String(updaterStatus.releaseNotes || '');
    notes.textContent = releaseNotes;
    notes.hidden = !releaseNotes;
  }
}

function keycap(key) {
  const label = ({ Ctrl: 'Control', Alt: 'Alt', Shift: 'Shift', Win: 'Windows' })[key] || key;
  return `<span class="keycap">${esc(label)}</span>`;
}

function heading(title, subtitle, avatar = false) {
  return `<header class="page-heading"><div class="greeting">${avatar ? `<span class="avatar">${esc((settings.displayName || data.userName || 'V')[0].toUpperCase())}</span>` : ''}<div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div></div></header>`;
}

function modeCard(mode, title, copy, hotkey, enabled) {
  return `<article class="card mode-card" data-edit-hotkey="${mode}">
    <div class="mode-top">
      <span class="mode-icon">${icon(mode === 'dictation' ? 'M9 3h6v12H9zM5 11a7 7 0 0 0 14 0M12 18v3' : 'M12 3v3m0 12v3M4 8h4m8 0h4M4 16h4m8 0h4')}</span>
      <div class="mode-title"><h3>${esc(title)}</h3><p>${esc(copy)}</p></div>
      <span class="mode-status"><i class="status-dot ${enabled ? '' : 'off'}"></i>${enabled ? 'Ready' : 'Off'}</span>
    </div>
    <div class="mode-hotkey">Hold ${String(hotkey).split('+').map(keycap).join(' + ')} in any text field</div>
    <div class="mode-bottom"><span>Click to edit shortcut</span>${toggle(`${mode}Enabled`, enabled, `${title} enabled`, `${mode}Enabled`)}</div>
  </article>`;
}

function gallery() {
  if (!data.gallery) return '';
  const samples = [
    ['idle', 'Idle', ''],
    ['listening', 'Listening', 'Listening · release to ask'],
    ['thinking', 'Thinking', 'Thinking…'],
    ['executing', 'Executing', 'Opening Notepad…'],
    ['verifying', 'Verifying', 'Checking the result…'],
    ['answer', 'Answer', 'Here is a sample answer from Voxa. The island grows to fit the card, and the height follows the text as it streams in.'],
    ['approval', 'Approval', 'Allow this sample action? Nothing will run.'],
    ['error', 'Error', 'A sample microphone or service error.'],
    ['done', 'Done', 'Done.']
  ];
  const style = settings.overlayStyle === 'notch' ? 'notch' : 'island';
  return `<div class="gallery-banner"><span><b>Gallery preview</b> · Check every island state without starting a turn.</span></div>
  <div class="card gallery-control">
    <b>Overlay playground</b>
    <div class="gallery-row"><span class="gallery-label">States</span>${samples.map(([status, label, detail]) => `<button class="button" data-preview-status="${status}" data-preview-detail="${esc(detail)}">${label}</button>`).join('')}</div>
    <div class="gallery-row"><span class="gallery-label">Sequence</span><button class="button primary" data-action="play-sequence">${gallerySequenceRunning ? 'Restart sequence' : 'Play full sequence'}</button><button class="button" data-gallery-slow aria-pressed="${gallerySlowMotion}">Slow motion · 0.25x</button><button class="button" data-gallery-loop aria-pressed="${galleryLoop}">Loop</button></div>
    <div class="gallery-row"><span class="gallery-label">Style</span><button class="button ${style === 'island' ? 'is-active' : ''}" data-gallery-style="island" aria-pressed="${style === 'island'}">Island</button><button class="button ${style === 'notch' ? 'is-active' : ''}" data-gallery-style="notch" aria-pressed="${style === 'notch'}">Notch</button></div>
    <p class="gallery-hint">The sequence plays appear, listening, thinking, streamed answer, approval, done, and disappear. Slow motion also affects the island springs.</p>
  </div>`;
}

function galleryDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function playGallerySequence() {
  const token = ++gallerySequenceToken;
  gallerySequenceRunning = true;
  if (activePage === 'dashboard') refreshPage('dashboard');
  const steps = [
    ['listening', 'Listening · release to ask', 900],
    ['thinking', 'Thinking…', 900],
    ['executing', 'Opening Notepad…', 900],
    ['answer', 'Here is a sample answer from Voxa. Words fade in as the island settles into its expanded card, and the height follows the content without a jump.', 2200],
    ['approval', 'Allow this sample action? Nothing will run in the gallery.', 1500],
    ['done', 'Done.', 900],
    ['idle', '', 850]
  ];
  try {
    await api.setOverlayOptions({ slowMotion: gallerySlowMotion });
    do {
      for (const [status, message, ms] of steps) {
        if (token !== gallerySequenceToken) return;
        await api.previewOverlay(status, message);
        await galleryDelay(ms * (gallerySlowMotion ? 4 : 1));
      }
    } while (galleryLoop && token === gallerySequenceToken);
  } catch (error) {
    note(error.message || 'The gallery sequence stopped.');
  } finally {
    if (token === gallerySequenceToken) {
      gallerySequenceRunning = false;
      if (activePage === 'dashboard') refreshPage('dashboard');
    }
  }
}

function dashboard() {
  const health = data.health || {};
  const provider = settings.chatProvider || 'local';
  const config = settings.providers?.[provider] || {};
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = settings.displayName || data.userName || 'there';
  const tips = [
    ['Dictation', 'Hold your dictation shortcut, speak, and release to type.'],
    ['Agent', 'Ask for help, then approve any desktop action in the notch.'],
    ['Memory', 'Say “remember that…” to save a short note for later.'],
    ['Privacy', 'Transcripts and history stay in your local Voxa data folder.']
  ];
  return `${gallery()}${heading(`${greeting}, ${name}`, 'Your voice workspace is ready when you are.', true)}
  <div class="mode-grid">
    ${modeCard('dictation', 'Dictation Mode', 'Speak and type into the focused field.', settings.dictationHotkey || 'Ctrl+Q', settings.dictationEnabled !== false)}
    ${modeCard('agent', 'Agent Mode', 'Ask for help and approve desktop actions.', settings.agentHotkey || 'Alt+Q', settings.agentEnabled !== false)}
  </div>
  <div class="section-head"><h2>Quick stats</h2></div>
  <div class="card rows-card">
    <div class="row"><span class="row-icon">${icon('M4 5h16v14H4zM8 9h8M8 13h5')}</span><div class="row-main"><b>Health</b><small>Speech and answer services</small></div><div class="row-side">${healthChip('healthOllama', serviceStatus(health.ollama, 'Ollama'))}${healthChip('healthWhisper', serviceStatus(health.whisper, 'Whisper'))}<button class="button" data-action="health">Check</button></div></div>
    ${whisperProgressRow()}
    <div class="row"><span class="row-icon">${icon('M4 5h16v14H4zM8 9h8M8 13h5')}</span><div class="row-main"><b>Model</b><small>${esc(provider)} · ${esc(config.model || 'No model selected')}</small></div><div class="row-side"><button class="button" data-page-link="agent">Switch</button></div></div>
    <div class="row"><span class="row-icon">${icon('M9 3h6v12H9zM5 11a7 7 0 0 0 14 0')}</span><div class="row-main"><b>Voice replies</b><small>Read agent answers aloud</small></div><div class="row-side">${toggle('spokenReplies', settings.spokenReplies !== false, 'Spoken replies', 'spokenReplies')}</div></div>
  </div>
  <div class="section-head tips-head"><div><h2>Tips</h2><p>Small ideas to get started.</p></div><div class="carousel-controls"><button class="icon-button" data-carousel="-1" aria-label="Previous tips">‹</button><button class="icon-button" data-carousel="1" aria-label="Next tips">›</button></div></div>
  <div class="carousel" id="tips">${tips.map(([title, copy], index) => `<article class="tip-card"><span class="badge">${index + 1} / ${tips.length}</span><h3>${esc(title)}</h3><p>${esc(copy)}</p></article>`).join('')}</div>`;
}

function insights() {
  const turns = data.turns || [];
  const bars = Array(7).fill(0);
  turns.forEach((turn) => {
    const days = Math.floor((Date.now() - new Date(turn.time).getTime()) / 86400000);
    if (days >= 0 && days < 7) bars[6 - days] += 1;
  });
  const max = Math.max(1, ...bars);
  const points = bars.map((count, index) => `${35 + index * 125},${170 - (count / max) * 125}`).join(' ');
  return `${heading('Insights', 'A quiet view of recent voice activity.')}
  <div class="stats"><article class="stat-card"><b>${turns.length}</b><small>Saved turns</small></article><article class="stat-card"><b>${turns.filter((turn) => /dictat/i.test(turn.did)).length}</b><small>Dictation turns</small></article><article class="stat-card"><b>${esc(settings.mode || 'agent')}</b><small>Current mode</small></article></div>
  <div class="section-head"><h2>Last seven days</h2></div>
  <div class="chart-card"><svg viewBox="0 0 850 205" role="img" aria-label="Voice turns by day"><path d="M30 178H835M30 110H835M30 42H835" stroke="#30323a"/><polyline points="${points}" fill="none" stroke="#8bbcff" stroke-width="3"/>${bars.map((count, index) => `<circle cx="${35 + index * 125}" cy="${170 - (count / max) * 125}" r="4" fill="#a8ceff"/>`).join('')}<text x="35" y="200" class="chart-label">6 days ago</text><text x="770" y="200" class="chart-label">Today</text></svg></div>`;
}

function historyResults() {
  const found = (data.turns || []).filter((turn) => `${turn.said} ${turn.did}`.toLowerCase().includes(historyQuery.toLowerCase()));
  const days = {};
  found.forEach((turn) => {
    const day = new Date(turn.time).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    (days[day] ||= []).push(turn);
  });
  const content = Object.entries(days).map(([day, items]) => `<div class="section-head"><h2>${esc(day)}</h2>${chip(`${items.length} turns`)}</div><div class="card rows-card">${items.map((turn) => `<div class="row"><span class="row-icon">${icon('M12 4v16m-7-8h14')}</span><div class="row-main"><b>${esc(turn.said)}</b><small>${esc(turn.did)}</small></div><small>${new Date(turn.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></div>`).join('')}</div>`).join('');
  return content || '<div class="empty">No matching turns yet.</div>';
}

function historyPage() {
  return `${heading('History', 'Search a past request and its result.')}
  <div class="history-tools"><input id="historySearch" class="input" aria-label="Search history" placeholder="Search history" value="${esc(historyQuery)}"><button class="button" data-action="clear-history">Clear</button></div>
  <div id="historyResults">${historyResults()}</div>`;
}

function dictation() {
  const microphones = settings._microphones || [];
  const selected = settings.microphoneId || '';
  const selectedModel = settings.whisperModel || 'small';
  const preset = Object.hasOwn(WHISPER_PRESETS, settings.performancePreset) ? settings.performancePreset : 'custom';
  const presetInfo = WHISPER_PRESETS[preset];
  return `${heading('Dictation', 'Set up how Voxa listens and types.')}
  <div class="page-stack">
    <article class="card"><h2 class="card-title">Dictation shortcut</h2><p class="card-note">Hold the shortcut to record. Releasing it sends the transcript. Ctrl+Space may conflict with Windows input switching.</p><div class="row-side"><button class="button" data-edit-hotkey="dictation">Edit · ${esc(settings.dictationHotkey || 'Ctrl+Q')}</button>${toggle('dictationEnabled', settings.dictationEnabled !== false, 'Enable dictation', 'dictationEnabled')}</div></article>
    <article class="card"><h2 class="card-title">Speech recognition</h2>
      <div class="form-grid">
        <label class="field">Transcription<select class="select" id="sttProvider"><option value="local" ${settings.sttProvider !== 'cloud' ? 'selected' : ''}>Local Whisper</option><option value="cloud" ${settings.sttProvider === 'cloud' ? 'selected' : ''}>Cloud API</option></select></label>
        <label class="field">Cloud service<select class="select" id="sttCloudProvider">${['openai', 'groq'].map((provider) => `<option value="${provider}" ${settings.sttCloudProvider === provider ? 'selected' : ''}>${provider}</option>`).join('')}</select></label>
        <label class="field">Cloud model<input class="input" id="sttModel" value="${esc(settings.sttModel || 'whisper-1')}"></label>
        <label class="field">Performance preset<select class="select" id="performancePreset">${Object.entries(WHISPER_PRESETS).map(([id, item]) => `<option value="${esc(id)}" ${preset === id ? 'selected' : ''}>${esc(item.label)}${item.model ? ` · ${esc(item.model)}` : ''}</option>`).join('')}</select><small class="card-note" id="performancePresetNote">${esc(presetInfo.description)}</small></label>
        <label class="field">Whisper model<select class="select" id="whisper">${whisperModelOptions(selectedModel)}</select></label>
        <label class="field">Compute<select class="select" id="device"><option value="cpu" ${settings.whisperDevice !== 'cuda' ? 'selected' : ''}>CPU · int8</option><option value="cuda" ${settings.whisperDevice === 'cuda' ? 'selected' : ''}>NVIDIA GPU · float16</option></select></label>
        <label class="field">Microphone<select class="select" id="mic"><option value="">System default</option>${microphones.map((item) => `<option value="${esc(item.id)}" ${selected === item.id ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select></label>
        <button class="button" id="refreshMic" type="button">Refresh microphones</button>
        <div class="field"><span>Input level</span><div class="input-meter"><i id="settingsMicLevel"></i></div></div>
        <div class="row-side field full"><button class="button" id="micTest" type="button" ${micTestRunning ? 'disabled' : ''}>Mic test · record 3 seconds</button><span id="micTestResult" class="card-note">Records, plays back, then transcribes.</span></div>
      </div>
      <article class="card"><h2 class="card-title">Voice replies</h2>
        <div class="form-grid">
          <label class="field">Engine<select class="select" id="ttsEngine"><option value="windows" ${(settings.ttsEngine || 'windows') === 'windows' ? 'selected' : ''}>Windows (built-in)</option><option value="kokoro" ${settings.ttsEngine === 'kokoro' ? 'selected' : ''}>Kokoro · natural voice</option></select></label>
          <label class="field">Voice<select class="select" id="ttsVoice" ${(settings.ttsEngine || 'windows') !== 'kokoro' ? 'disabled' : ''}>${ttsVoiceOptions(settings.ttsVoice || 'af_heart')}</select><small class="card-note">Voice selection applies to Kokoro only.</small></label>
          <label class="field">Speed · <span id="ttsSpeedVal">${(settings.ttsSpeed || 1.0).toFixed(1)}×</span><input type="range" class="full" id="ttsSpeed" min="0.5" max="2.0" step="0.1" value="${settings.ttsSpeed || 1.0}"></label>
          <label class="field">Volume · <span id="ttsVolumeVal">${Math.round((settings.ttsVolume ?? 1.0) * 100)}%</span><input type="range" class="full" id="ttsVolume" min="0" max="1" step="0.05" value="${settings.ttsVolume ?? 1.0}"></label>
          <div class="row-side field full"><button class="button primary" id="ttsPreview" type="button">Preview voice</button><span id="ttsPreviewResult" class="card-note"></span></div>
        </div>
        <div class="whisper-model-card" id="kokoroModelCard" style="margin-top:14px">
          <div class="row-side" style="justify-content:space-between;align-items:flex-start">
            <div class="row-main"><b id="kokoroSelectedName">Kokoro-82M Model</b><small class="card-note" id="kokoroSelectedMeta">Checking model status…</small></div>
            <span class="badge info" id="kokoroStatusBadge">Checking</span>
          </div>
          <div class="whisper-facts"><span>Download <b>~86 MB</b></span><span>Location <b>AppData/kokoro</b></span></div>
          <div class="row-side" style="justify-content:space-between;margin-top:10px"><span class="card-note" id="kokoroActionNote">One-time download required for natural voice replies.</span><button class="button primary" id="kokoroAction" type="button" data-action="kokoro-download">Download model</button><button class="button" id="kokoroCancel" type="button" data-action="kokoro-cancel" hidden>Cancel</button></div>
        </div>
        ${kokoroProgressPanel()}
      </article>
      ${whisperModelCard()}
      ${whisperProgressPanel()}
      <p class="card-note">Models download into AppData. Downloads run in the background, show real progress here and on the Dashboard, and can be canceled or retried. Switching keeps the current model active until the new one is ready.</p>
    </article>
    <button class="button primary" data-action="save-page">Save dictation settings</button>
  </div>`;
}

function modelCombo(id, value, providerSource, kind, placeholder = 'Choose a model or type a custom name') {
  return `<div class="combo" data-model-combo data-model-kind="${esc(kind)}" data-model-id="${esc(id)}" data-provider-source="${esc(providerSource)}"${kind === 'chat' ? ' data-url-source="chatUrl"' : ''}>
    <div class="combo-input-wrap">
      <input class="input combo-input" id="${esc(id)}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${esc(id)}List" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" value="${esc(value)}">
      <button type="button" class="combo-toggle" data-combo-toggle aria-label="Show models" tabindex="-1">▾</button>
    </div>
    <div class="combo-pop" id="${esc(id)}List" role="listbox" aria-label="Models" hidden>
      <div class="combo-status" data-combo-status hidden></div>
      <div class="combo-groups" data-combo-groups></div>
    </div>
    <small class="card-note combo-meta" data-combo-meta></small>
  </div>`;
}

function comboState(combo) {
  let state = comboStates.get(combo);
  if (!state) {
    state = {
      models: [],
      loaded: false,
      loading: false,
      error: '',
      filter: '',
      active: -1,
      options: [],
      requestId: 0,
      provider: ''
    };
    comboStates.set(combo, state);
  }
  return state;
}

function comboInput(combo) {
  return combo.querySelector('input[role="combobox"]');
}

function comboProvider(combo) {
  const source = combo.dataset.providerSource;
  const select = source ? document.getElementById(source) : null;
  return select?.value || '';
}

function modelMemoryKey(kind, provider) {
  return `${kind}:${provider}`;
}

function rememberComboValue(combo) {
  const provider = combo.dataset.provider || comboProvider(combo);
  const input = comboInput(combo);
  if (!provider || !input) return;
  modelMemory.set(modelMemoryKey(combo.dataset.modelKind, provider), input.value.trim());
}

function updateComboMeta(combo) {
  const state = comboState(combo);
  const meta = combo.querySelector('[data-combo-meta]');
  if (!meta) return;
  if (state.loading && !state.models.length) {
    meta.textContent = 'Loading models…';
  } else if (state.error) {
    meta.textContent = '';
  } else if (state.loaded) {
    const count = state.models.length;
    meta.textContent = `${count} model${count === 1 ? '' : 's'} available`;
  } else {
    meta.textContent = '';
  }
}

function groupedModels(provider, models) {
  const available = [...new Set((models || []).filter((model) => typeof model === 'string' && model.trim()))];
  const groups = [];
  const pinned = provider === FREELLMAPI_PROVIDER ? [...FREELLMAPI_RECOMMENDED] : [];
  if (pinned.length) groups.push({ title: 'Recommended', models: pinned });
  const pinnedSet = new Set(pinned);
  const remaining = available.filter((model) => !pinnedSet.has(model));
  if (provider !== FREELLMAPI_PROVIDER) {
    if (remaining.length) groups.push({ title: '', models: remaining.sort((a, b) => a.localeCompare(b)) });
    return groups;
  }

  const byProvider = new Map();
  for (const model of remaining) {
    const slash = model.indexOf('/');
    const colon = model.indexOf(':');
    let separator = slash;
    if (separator < 0 || (colon >= 0 && colon < separator)) separator = colon;
    const group = separator > 0 ? model.slice(0, separator) : 'Other';
    if (!byProvider.has(group)) byProvider.set(group, []);
    byProvider.get(group).push(model);
  }
  const names = [...byProvider.keys()].sort((a, b) => {
    if (a === 'Other') return 1;
    if (b === 'Other') return -1;
    return a.localeCompare(b);
  });
  for (const name of names) {
    const items = byProvider.get(name).sort((a, b) => a.localeCompare(b));
    if (items.length) groups.push({ title: name, models: items });
  }
  return groups;
}

function renderComboList(combo) {
  const state = comboState(combo);
  const input = comboInput(combo);
  const provider = comboProvider(combo);
  const status = combo.querySelector('[data-combo-status]');
  const groupsBox = combo.querySelector('[data-combo-groups]');
  if (!input || !status || !groupsBox) return;

  if (state.loading) {
    status.hidden = false;
    status.innerHTML = '<span class="combo-loading"><i></i>Loading models…</span>';
  } else if (state.error) {
    status.hidden = false;
    status.innerHTML = `<span class="combo-error">Couldn't load models: ${esc(state.error)}</span> <button type="button" class="link-button" data-combo-retry>Retry</button>`;
  } else {
    status.hidden = true;
    status.innerHTML = '';
  }

  const filter = state.filter.trim().toLowerCase();
  const groups = groupedModels(provider, state.models)
    .map((group) => ({
      title: group.title,
      models: group.models.filter((model) => !filter || model.toLowerCase().includes(filter))
    }))
    .filter((group) => group.models.length);

  if (groups.length) {
    groupsBox.innerHTML = groups.map((group, groupIndex) => `<div class="combo-group">
      ${group.title ? `<div class="combo-group-title">${esc(group.title)}</div>` : ''}
      ${group.models.map((model, index) => `<div class="combo-option" role="option" id="${esc(combo.dataset.modelId)}Option${groupIndex}-${index}" data-combo-value="${esc(model)}" aria-selected="${input.value === model ? 'true' : 'false'}">${esc(model)}</div>`).join('')}
    </div>`).join('');
  } else if (!state.loading && !state.error) {
    const message = filter
      ? `No models match. Press Enter to use “${esc(input.value.trim())}” as a custom model.`
      : state.loaded ? 'The provider returned no models. Type a model name to use it anyway.' : 'Open the list to load models.';
    groupsBox.innerHTML = `<div class="combo-empty">${message}</div>`;
  } else {
    groupsBox.innerHTML = '';
  }

  state.options = [...groupsBox.querySelectorAll('[data-combo-value]')];
  const selected = state.options.findIndex((option) => option.dataset.comboValue === input.value);
  state.active = selected >= 0 ? selected : (state.options.length ? 0 : -1);
  state.options.forEach((option, index) => option.classList.toggle('is-active', index === state.active));
  if (state.active >= 0) input.setAttribute('aria-activedescendant', state.options[state.active].id);
  else input.removeAttribute('aria-activedescendant');
}

function setActiveComboOption(combo, index) {
  const state = comboState(combo);
  const input = comboInput(combo);
  if (!state.options.length) {
    state.active = -1;
    input?.removeAttribute('aria-activedescendant');
    return;
  }
  state.active = (index + state.options.length) % state.options.length;
  state.options.forEach((option, optionIndex) => option.classList.toggle('is-active', optionIndex === state.active));
  input?.setAttribute('aria-activedescendant', state.options[state.active].id);
  state.options[state.active].scrollIntoView({ block: 'nearest' });
}

function openCombo(combo, resetFilter = true) {
  const provider = comboProvider(combo);
  const pop = combo.querySelector('.combo-pop');
  const input = comboInput(combo);
  if (!pop || !input || !provider || provider === 'none') return;
  const state = comboState(combo);
  const providerChanged = state.provider && state.provider !== provider;
  if (providerChanged) {
    state.models = [];
    state.loaded = false;
    state.error = '';
  }
  state.provider = provider;
  if (resetFilter) state.filter = '';
  pop.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  renderComboList(combo);
  if (!state.loading || providerChanged) void refreshComboModels(combo);
}

function closeCombo(combo) {
  const pop = combo.querySelector('.combo-pop');
  const input = comboInput(combo);
  if (pop) pop.hidden = true;
  if (input) {
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
}

function selectComboValue(combo, value) {
  const input = comboInput(combo);
  if (!input) return;
  input.value = value;
  const provider = comboProvider(combo);
  if (provider) modelMemory.set(modelMemoryKey(combo.dataset.modelKind, provider), value);
  closeCombo(combo);
  settingsDirty = activePage === 'agent';
}

async function refreshComboModels(combo, { force = false } = {}) {
  const provider = comboProvider(combo);
  const state = comboState(combo);
  const input = comboInput(combo);
  if (!input) return;
  if (!provider || provider === 'none') {
    state.models = [];
    state.loaded = false;
    state.loading = false;
    state.error = '';
    updateComboMeta(combo);
    renderComboList(combo);
    return;
  }
  const requestId = ++state.requestId;
  state.provider = provider;
  state.loading = true;
  state.error = '';
  updateComboMeta(combo);
  renderComboList(combo);
  const config = {};
  const urlSource = combo.dataset.urlSource;
  if (urlSource) {
    const urlInput = document.getElementById(urlSource);
    if (urlInput?.value.trim()) config.url = urlInput.value.trim();
  }
  if (providerNeedsKey(provider)) {
    const keyInput = combo.dataset.modelKind === 'fallback' ? $('#fallbackKey') : $('#chatKey');
    const typedKey = keyInput?.value.trim();
    if (typedKey) config.apiKey = typedKey;
  }
  try {
    const models = await api.listModels(provider, config, { force });
    if (requestId !== state.requestId || provider !== comboProvider(combo)) return;
    state.models = Array.isArray(models) ? models.filter((model) => typeof model === 'string' && model) : [];
    state.loaded = true;
    state.loading = false;
    state.error = '';
  } catch (error) {
    if (requestId !== state.requestId || provider !== comboProvider(combo)) return;
    state.models = [];
    state.loaded = false;
    state.loading = false;
    state.error = String(error?.message || 'The provider did not respond.').replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '').split(/\r?\n/)[0].trim();
  }
  updateComboMeta(combo);
  renderComboList(combo);
}

async function refreshAllModelCombos(options = {}) {
  await Promise.all($$('[data-model-combo]').map((combo) => refreshComboModels(combo, options)));
}

function restoreComboModel(kind, provider) {
  const combo = $(`[data-model-combo][data-model-kind="${kind}"]`);
  if (!combo) return;
  const input = comboInput(combo);
  if (!input) return;
  const remembered = modelMemory.get(modelMemoryKey(kind, provider));
  const configured = settings.providers?.[provider]?.model || '';
  input.value = remembered !== undefined ? remembered : configured || (provider === FREELLMAPI_PROVIDER ? 'auto' : '');
  const state = comboState(combo);
  state.models = [];
  state.loaded = false;
  state.loading = false;
  state.error = '';
  state.filter = '';
  state.active = -1;
  state.provider = provider;
  combo.dataset.provider = provider;
  updateComboMeta(combo);
  closeCombo(combo);
  renderComboList(combo);
}

function updateProviderControls() {
  const provider = $('#chatProvider')?.value || settings.chatProvider || 'local';
  const detect = $('#detectProvider');
  if (detect) detect.hidden = provider !== FREELLMAPI_PROVIDER;
  const key = $('#chatKey');
  if (key) {
    key.placeholder = data.keyStatus?.[provider]
      ? 'Saved securely · enter to replace'
      : providerNeedsKey(provider) ? 'Required' : 'Not needed for this provider';
  }
}

function updateFallbackControls() {
  const select = $('#fallbackProvider');
  if (!select) return;
  const provider = select.value || 'none';
  const cloud = isCloudProvider(provider);
  const keySaved = Boolean(data.keyStatus?.[provider]);
  const modelField = $('#fallbackModelField');
  const keyField = $('#fallbackKeyField');
  const warning = $('#fallbackWarning');
  const hint = $('#fallbackHint');
  const keyInput = $('#fallbackKey');
  const toggleInput = $('#fallbackEnabled');
  if (modelField) modelField.hidden = provider === 'none';
  if (keyField) keyField.hidden = provider === 'none' || !cloud;
  if (keyInput) keyInput.placeholder = keySaved ? 'Saved securely · enter to replace' : 'Required';
  if (warning) {
    warning.hidden = !cloud;
    warning.textContent = cloud ? `Prompts will be sent to ${providerLabel(provider)} when the local model fails.` : '';
  }
  if (toggleInput) {
    const blocked = provider === 'none' || (cloud && !keySaved);
    toggleInput.disabled = blocked;
    if (blocked) toggleInput.checked = false;
  }
  if (hint) {
    hint.textContent = provider === 'none'
      ? 'No cloud fallback is used.'
      : cloud && !keySaved
        ? `Save an API key for ${providerLabel(provider)} to allow this cloud fallback.`
        : 'The fallback runs only when the local model fails before any desktop action starts.';
  }
}

function initializeModelCombos() {
  $$('[data-model-combo]').forEach((combo) => {
    if (combo.dataset.comboBound) return;
    combo.dataset.comboBound = '1';
    const input = comboInput(combo);
    const provider = comboProvider(combo);
    combo.dataset.provider = provider;
    if (provider && input?.value.trim() && !modelMemory.has(modelMemoryKey(combo.dataset.modelKind, provider))) {
      modelMemory.set(modelMemoryKey(combo.dataset.modelKind, provider), input.value.trim());
    }
    const state = comboState(combo);
    state.provider = provider;

    input.addEventListener('focus', () => openCombo(combo));
    input.addEventListener('click', () => openCombo(combo));
    input.addEventListener('input', () => {
      const activeProvider = comboProvider(combo);
      if (activeProvider) modelMemory.set(modelMemoryKey(combo.dataset.modelKind, activeProvider), input.value.trim());
      state.filter = input.value;
      const pop = combo.querySelector('.combo-pop');
      if (pop?.hidden) {
        const current = comboProvider(combo);
        if (current && current !== 'none') {
          pop.hidden = false;
          input.setAttribute('aria-expanded', 'true');
          void refreshComboModels(combo);
        }
      }
      renderComboList(combo);
    });
    input.addEventListener('keydown', (event) => {
      const pop = combo.querySelector('.combo-pop');
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (pop?.hidden) openCombo(combo);
        if (!state.options.length && state.loaded) renderComboList(combo);
        setActiveComboOption(combo, state.active < 0 ? 0 : state.active + (event.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (event.key === 'Enter') {
        if (pop?.hidden) return;
        event.preventDefault();
        const option = state.options[state.active] || state.options[0];
        if (option) selectComboValue(combo, option.dataset.comboValue);
        else closeCombo(combo);
        return;
      }
      if (event.key === 'Escape') {
        if (!pop?.hidden) {
          event.preventDefault();
          event.stopPropagation();
          closeCombo(combo);
        }
        return;
      }
      if (event.key === 'Tab') closeCombo(combo);
    });

    const toggle = combo.querySelector('[data-combo-toggle]');
    if (toggle) {
      toggle.addEventListener('mousedown', (event) => event.preventDefault());
      toggle.addEventListener('click', () => {
        const pop = combo.querySelector('.combo-pop');
        if (pop?.hidden) openCombo(combo);
        else closeCombo(combo);
        input.focus();
      });
    }
    const pop = combo.querySelector('.combo-pop');
    if (pop) {
      pop.addEventListener('mousedown', (event) => event.preventDefault());
      pop.addEventListener('click', (event) => {
        const retry = event.target.closest('[data-combo-retry]');
        if (retry) {
          void refreshComboModels(combo, { force: true });
          return;
        }
        const option = event.target.closest('[data-combo-value]');
        if (option) selectComboValue(combo, option.dataset.comboValue);
      });
    }
  });
}

document.addEventListener('mousedown', (event) => {
  $$('[data-model-combo]').forEach((combo) => {
    if (!combo.contains(event.target)) closeCombo(combo);
  });
});

function agent() {
  const providers = settings.providers || {};
  const provider = settings.chatProvider || 'local';
  const config = providers[provider] || {};
  const keySaved = Boolean(data.keyStatus?.[provider]);
  const fallbackProvider = settings.fallbackProvider || 'none';
  const fallbackConfig = providers[fallbackProvider] || {};
  const fallbackCloud = isCloudProvider(fallbackProvider);
  const fallbackKeySaved = Boolean(data.keyStatus?.[fallbackProvider]);
  const fallbackBlocked = fallbackProvider === 'none' || (fallbackCloud && !fallbackKeySaved);
  const fallbackModel = fallbackProvider === 'none' ? '' : fallbackConfig.model || '';
  const providerOptions = Object.keys(providers).map((name) => `<option value="${esc(name)}" ${provider === name ? 'selected' : ''}>${esc(name === 'local' ? 'Local · Ollama' : providerLabel(name))}</option>`).join('');
  const fallbackOptions = ['none', ...Object.keys(providers).filter((name) => name !== 'local')]
    .map((name) => `<option value="${esc(name)}" ${fallbackProvider === name ? 'selected' : ''}>${esc(name === 'none' ? 'None' : providerLabel(name))}</option>`).join('');
  return `${heading('Agent', 'Choose a model and the actions it can request.')}
  <div class="page-stack">
    <article class="card"><h2 class="card-title">Agent shortcut</h2><p class="card-note">Hold both keys to ask. Releasing either sends the request. Alt shortcuts are detected but Windows may also react to them.</p><div class="row-side"><button class="button" data-edit-hotkey="agent">Edit · ${esc(settings.agentHotkey || 'Alt+Q')}</button>${toggle('agentEnabled', settings.agentEnabled !== false, 'Enable agent', 'agentEnabled')}</div></article>
    <article class="card"><h2 class="card-title">Provider</h2>
      <div class="form-grid">
        <label class="field">Provider<select class="select" id="chatProvider">${providerOptions}</select></label>
        <div class="field"><label for="chatUrl">Base URL</label><div class="input-action"><input class="input" id="chatUrl" value="${esc(config.url || '')}"><button class="button" id="detectProvider" type="button" data-action="detect-provider" ${provider === FREELLMAPI_PROVIDER ? '' : 'hidden'}>Detect</button></div><small class="card-note">Remote addresses must use HTTPS. http:// is allowed only for localhost.</small></div>
        <div class="field"><label for="chatModel">Model</label>${modelCombo('chatModel', config.model || '', 'chatProvider', 'chat')}</div>
        <label class="field">API key<input class="input" id="chatKey" type="password" autocomplete="off" placeholder="${keySaved ? 'Saved securely · enter to replace' : providerNeedsKey(provider) ? 'Required' : 'Not needed for this provider'}"></label>
        <label class="field">Fallback provider<select class="select" id="fallbackProvider">${fallbackOptions}</select></label>
        <div class="field" id="fallbackModelField" ${fallbackProvider === 'none' ? 'hidden' : ''}><label for="fallbackModel">Fallback model</label>${modelCombo('fallbackModel', fallbackModel, 'fallbackProvider', 'fallback')}</div>
        <label class="field" id="fallbackKeyField" ${fallbackProvider === 'none' || !fallbackCloud ? 'hidden' : ''}>Fallback API key<input class="input" id="fallbackKey" type="password" autocomplete="off" placeholder="${fallbackKeySaved ? 'Saved securely · enter to replace' : 'Required'}"></label>
        <label class="field">Use fallback if local fails<div>${toggle('fallbackEnabled', Boolean(settings.fallbackEnabled) && !fallbackBlocked, 'Enable fallback', 'fallbackEnabled')}</div></label>
      </div>
      <p class="card-note fallback-warning" id="fallbackWarning" ${fallbackCloud ? '' : 'hidden'}>${fallbackCloud ? esc(`Prompts will be sent to ${providerLabel(fallbackProvider)} when the local model fails.`) : ''}</p>
      <p class="card-note" id="fallbackHint">${esc(fallbackProvider === 'none' ? 'No cloud fallback is used.' : fallbackCloud && !fallbackKeySaved ? `Save an API key for ${providerLabel(fallbackProvider)} to allow this cloud fallback.` : 'The fallback runs only when the local model fails before any desktop action starts.')}</p>
      <div class="row-side" style="margin-top:14px"><button class="button" data-action="test-provider">Test connection</button><button class="button" data-action="refresh-models">Refresh models</button><span id="providerStatus" class="card-note"></span></div>
    </article>
    ${provider === 'local' ? ollamaSetupCard() : ''}
    <article class="card"><h2 class="card-title">Permission Mode</h2><p class="card-note">Choose how Agent Mode handles desktop permissions. Routine actions can run without a prompt; sensitive actions always ask.</p>
      <label class="field" style="margin-top:12px">Permission Mode<select class="select" id="permissionMode">${PERMISSION_MODES.map(([id, label]) => `<option value="${id}" ${(settings.permissionMode || 'ask') === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>
      <p id="permissionModeNote" class="card-note">${esc(PERMISSION_MODES.find(([id]) => id === (settings.permissionMode || 'ask'))?.[2] || '')}</p>
      <div class="rows-card" style="padding:0;margin-top:14px">${PERMISSION_CATEGORIES.map(([id, label, detail]) => `<div class="row"><div class="row-main"><b>${esc(label)}</b><small>${esc(detail)}</small></div><div class="row-side">${toggle(`permission-${id}`, settings.permissionCustom?.[id] === true, `${label} permission`, '', '', id)}</div></div>`).join('')}</div>
      <p class="card-note">Custom switches apply when Permission Mode is set to Custom. Other routine actions still ask.</p>
      <div class="divider"></div>
      <div class="row"><div class="row-main"><b>Sensitive actions</b><small>${esc(SENSITIVE_PERMISSION_LABELS.join('; '))}</small></div><span class="badge">Always ask</span></div>
      <div class="row-side" style="margin-top:12px"><button class="button danger" data-action="reset-permissions">Reset saved permissions</button><span class="card-note">Returns to Ask Every Time.</span></div>
    </article>
    <button class="button primary" data-action="save-page">Save agent settings</button>
  </div>`;
}

function apps() {
  const names = data.apps || [];
  return `${heading('Apps', 'Your local app catalog and connected tools.')}
  <div class="section-head"><h2>Discovered apps</h2><button class="button" data-action="refresh-apps">Refresh</button></div>
  <div class="card app-list">${names.length ? names.map((name) => `<div class="app-row"><span class="row-icon">${icon('M4 4h16v16H4zM8 8h8v8H8z')}</span><b>${esc(name)}</b>${chip('Start menu')}</div>`).join('') : '<div class="empty">App discovery is loading. Refresh to scan the Start menu.</div>'}</div>
  <div class="section-head"><h2>MCP connections</h2></div>
  <article class="card"><div class="row"><span class="row-icon">${icon('M5 12h14M12 5v14')}</span><div class="row-main"><b>Model Context Protocol</b><small>No MCP servers are configured for this profile.</small></div>${chip('Disconnected')}</div><p class="card-note">Voxa currently uses local app discovery and built-in approved actions.</p></article>`;
}

function settingsPage() {
  const hotkey = data.hotkey || {};
  const health = data.health || {};
  return `${heading('Settings', 'Personalize your workspace.')}
  <div class="page-stack">
    <article class="card"><h2 class="card-title">Profile</h2><div class="form-grid"><label class="field">Display name<input class="input" id="displayName" value="${esc(settings.displayName || data.userName || '')}"></label><label class="field">Community URL<input class="input" id="communityUrl" value="${esc(settings.communityUrl || '')}" placeholder="Optional HTTPS link"></label></div><div class="row-side" style="margin-top:12px"><button class="button primary" data-action="save-profile">Save profile</button></div></article>
    <article class="card"><h2 class="card-title">Preferences</h2>
      <div class="row"><div class="row-main"><b>Start with Windows</b><small>Keep Voxa ready in the tray.</small></div>${toggle('startup', Boolean(settings.startWithWindows), 'Start with Windows', 'startWithWindows')}</div>
      <div class="row"><div class="row-main"><b>Spoken replies</b><small>Use the Windows built-in voice.</small></div>${toggle('spokenRepliesSettings', settings.spokenReplies !== false, 'Spoken replies', 'spokenReplies')}<button class="button" data-action="test-voice">Test voice</button></div>
      <div class="row"><div class="row-main"><b>Overlay style</b><small>Island floats below the work area; Notch stays attached to the top edge.</small></div><div class="row-side"><select class="select" id="overlayStyle" aria-label="Overlay style"><option value="island" ${settings.overlayStyle !== 'notch' ? 'selected' : ''}>Island</option><option value="notch" ${settings.overlayStyle === 'notch' ? 'selected' : ''}>Notch</option></select><button class="button" data-action="save-page">Save appearance</button></div></div>
    </article>
    <article class="card"><h2 class="card-title">Updates</h2>
      <div class="row"><div class="row-main"><b id="updateCurrentVersion">Current version</b><small id="updateStatusText">Not checked yet.</small></div><div class="row-side"><button class="button" id="updateCheck" data-action="update-check">Check for updates</button><button class="button primary" id="updateDownload" data-action="update-download" hidden>Download update</button><button class="button primary" id="updateInstall" data-action="update-install" hidden>Restart and install</button></div></div>
      <div id="updateProgress" hidden><div class="progress-track"><i id="updateProgressBar"></i></div><p class="card-note" id="updateProgressText"></p></div>
      <p class="card-note" id="updateReleaseNotes" style="white-space:pre-wrap" hidden></p>
      <div class="row"><div class="row-main"><b>Automatically check for updates</b><small>Check GitHub Releases after launch and every six hours.</small></div>${toggle('autoCheckUpdates', settings.autoCheckUpdates !== false, 'Automatically check for updates', 'autoCheckUpdates')}</div>
    </article>
    <article class="card"><h2 class="card-title">Diagnostics</h2><div class="row-side"><span class="badge info">Mode · ${esc(settings.mode || 'agent')}</span><span class="badge ${hotkey.mode === 'uiohook' ? 'good' : 'bad'}">Hotkey · ${esc(hotkey.mode || 'Unknown')}</span>${healthChip('settingsHealthOllama', serviceStatus(health.ollama, 'Ollama'))}${healthChip('settingsHealthWhisper', serviceStatus(health.whisper, 'Whisper'))}</div><p class="card-note">${esc(hotkey.error || 'Global shortcuts are active.')}</p><div class="row-side" style="margin:12px 0"><button class="button" data-action="test-overlay">Test overlay</button><button class="button" data-action="test-voice">Test voice</button><button class="button" data-page-link="logs">Open logs</button></div></article>
  </div>`;
}

function about() {
  return `${heading(`About ${api.appName}`, 'A calm voice workspace for everyday work.')}
  <article class="card"><h2 class="card-title">${esc(api.appName)}</h2><p class="card-note">Voice notes, focused dictation, and approved desktop actions in one local workspace. Audio and turn history stay on this computer unless you choose a cloud model or transcription provider.</p></article>`;
}

function filteredLogLines() {
  const query = logQuery.trim().toLowerCase();
  return (data.activationLogs || [])
    .filter((line) => !query || String(line).toLowerCase().includes(query))
    .slice(-500);
}

function logsPage() {
  const lines = filteredLogLines().join('\n');
  return `${heading('Logs', 'Activation, microphone, transcription, model, and tool events.')}
  <div class="page-stack"><article class="card"><div class="row-side"><input id="logFilter" class="input" aria-label="Filter logs" placeholder="Filter logs" value="${esc(logQuery)}"><span class="card-note">Saved to your local activation log.</span><button class="button" id="refreshLogs">Refresh</button></div><pre class="log-box" id="logsPage">${esc(lines)}</pre></article></div>`;
}

const renderers = {
  dashboard,
  insights,
  history: historyPage,
  dictation,
  agent,
  apps,
  logs: logsPage,
  settings: settingsPage,
  about
};

function renderAll() {
  for (const [name, render] of Object.entries(renderers)) {
    const page = $(`#page-${name}`);
    if (page) page.innerHTML = render();
  }
  wire();
  updateShell();
  updateUpdaterUi();
}

function refreshPage(name) {
  const render = renderers[name];
  const page = $(`#page-${name}`);
  if (!render || !page) return;
  page.innerHTML = render();
  wire();
  updateShell();
  updateUpdaterUi();
}

function updateShell() {
  const name = settings.displayName || data.userName || 'User';
  $('#sideName').textContent = name;
  $('#sideAvatar').textContent = name[0]?.toUpperCase() || 'V';
  $('#brandName').textContent = api.appName;
  document.title = api.appName;
  $('#tierBadge').textContent = isCloudProvider(settings.chatProvider) ? 'CLOUD' : 'LOCAL';
  const community = $('#community');
  if (community) {
    community.hidden = !settings.communityUrl;
    community.href = settings.communityUrl || '#';
  }
  const status = $('#appStatus');
  const provider = settings.chatProvider || 'local';
  const providerName = providerLabel(provider);
  const chat = data.health?.chat;
  const chatOk = chat ? Boolean(chat.ok) : Boolean(data.health?.ollama?.ok);
  const needsKey = providerNeedsKey(provider) && !data.keyStatus?.[provider];
  const whisperStatus = data.health?.whisper?.status;
  const whisperPercent = data.health?.whisper?.progress?.percent;
  const preparing = whisperStatus === 'downloading' || whisperStatus === 'loading';
  status.classList.toggle('bad', !chatOk && !preparing);
  $('#appStatusText').textContent = preparing
    ? whisperStatus === 'downloading'
      ? whisperPercent == null ? 'Downloading speech model' : `Downloading speech model ${whisperPercent}%`
      : 'Loading speech model'
    : chatOk ? `${providerName} and ready` : needsKey ? `${providerName} key required` : provider === 'local' ? 'Check local services' : `${providerName} unavailable`;
  updateHealthBadges();
  updateWhisperModelControls();
  updateWhisperProgress();
  updateOllamaSetup();
}

function startMicMonitor() {
  if (monitorActive) return;
  monitorActive = true;
  api.microphoneMonitor(true, settings.microphoneId || '').catch((error) => {
    monitorActive = false;
    if (activePage === 'dictation') note(`Microphone monitor: ${error.message}`);
  });
}

function stopMicMonitor() {
  if (!monitorActive) return;
  monitorActive = false;
  api.microphoneMonitor(false).catch(() => {});
}

async function refreshMicrophones() {
  try {
    const list = await api.microphones();
    settings._microphones = list;
    const select = $('#mic');
    if (select) {
      const selected = settings.microphoneId || '';
      select.innerHTML = '<option value="">System default</option>' + list.map((item) => `<option value="${esc(item.id)}" ${selected === item.id ? 'selected' : ''}>${esc(item.label)}</option>`).join('');
    }
    return list;
  } catch (error) {
    note(`Could not list microphones: ${error.message}`);
    return [];
  }
}

function nav(page, force = false) {
  if (!renderers[page]) page = 'dashboard';
  const previous = activePage;
  activePage = page;
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  $$('.page').forEach((section) => section.classList.toggle('active', section.id === `page-${page}`));
  $('.page-scroll').scrollTop = 0;
  try {
    window.history.replaceState(null, '', `#${page}`);
  } catch {
    try {
      window.location.hash = page;
    } catch {}
  }
  if (previous === page && !force) return;
  if (previous === 'dashboard' && page !== 'dashboard' && data.gallery) {
    gallerySequenceToken += 1;
    gallerySequenceRunning = false;
    gallerySlowMotion = false;
    void api.setOverlayOptions({ slowMotion: false }).catch(() => {});
    void api.previewOverlay('idle').catch(() => {});
  }
  if (previous === 'dictation') stopMicMonitor();
  if (page === 'dictation') {
    void refreshMicrophones();
    startMicMonitor();
  }
}

function collectPagePatch() {
  const patch = {};
  if (activePage === 'dictation') {
    patch.sttProvider = $('#sttProvider')?.value || settings.sttProvider;
    patch.sttCloudProvider = $('#sttCloudProvider')?.value || settings.sttCloudProvider;
    patch.sttModel = $('#sttModel')?.value || settings.sttModel;
    patch.performancePreset = $('#performancePreset')?.value || settings.performancePreset;
    patch.whisperModel = $('#whisper')?.value || settings.whisperModel;
    if (patch.performancePreset !== 'custom' && WHISPER_PRESETS[patch.performancePreset]?.model !== patch.whisperModel) {
      patch.performancePreset = 'custom';
    }
    patch.whisperDevice = $('#device')?.value || settings.whisperDevice;
    patch.microphoneId = $('#mic')?.value ?? settings.microphoneId;
    patch.ttsEngine = $('#ttsEngine')?.value || settings.ttsEngine;
    patch.ttsVoice = $('#ttsVoice')?.value || settings.ttsVoice;
    patch.ttsSpeed = parseFloat($('#ttsSpeed')?.value || settings.ttsSpeed || 1.0);
    patch.ttsVolume = parseFloat($('#ttsVolume')?.value || settings.ttsVolume || 1.0);
  } else if (activePage === 'agent') {
    const provider = $('#chatProvider')?.value || settings.chatProvider;
    const fallbackProvider = $('#fallbackProvider')?.value || settings.fallbackProvider || 'none';
    patch.chatProvider = provider;
    patch.activeMode = provider === 'local' ? 'local' : 'cloud';
    if (provider !== 'local') patch.lastCloudProvider = provider;
    patch.fallbackProvider = fallbackProvider;
    patch.fallbackEnabled = fallbackProvider === 'none' ? false : Boolean($('#fallbackEnabled')?.checked);
    const providersPatch = {
      [provider]: {
        url: $('#chatUrl')?.value || settings.providers?.[provider]?.url,
        model: $('#chatModel')?.value.trim() || settings.providers?.[provider]?.model
      }
    };
    if (fallbackProvider !== 'none' && fallbackProvider !== provider) {
      providersPatch[fallbackProvider] = {
        model: $('#fallbackModel')?.value.trim() || settings.providers?.[fallbackProvider]?.model
      };
    }
    patch.providers = providersPatch;
    if ($('#permissionMode')) {
      patch.permissionMode = $('#permissionMode').value;
      patch.permissionCustom = {};
      PERMISSION_CATEGORIES.forEach(([id]) => {
        patch.permissionCustom[id] = $(`#permission-${id}`)?.checked ?? settings.permissionCustom?.[id] === true;
      });
    }
  } else if (activePage === 'settings') {
    patch.displayName = $('#displayName')?.value ?? settings.displayName;
    patch.communityUrl = $('#communityUrl')?.value ?? settings.communityUrl;
    patch.overlayStyle = $('#overlayStyle')?.value ?? settings.overlayStyle;
  }
  return patch;
}

async function savePage() {
  try {
    const patch = collectPagePatch();
    let savedKey = false;
    if (activePage === 'agent') {
      const provider = $('#chatProvider')?.value;
      const key = $('#chatKey')?.value.trim();
      if (provider && key) {
        await api.saveProviderKey(provider, key);
        savedKey = true;
        if (data.keyStatus) data.keyStatus[provider] = true;
      }
      const fallbackProvider = $('#fallbackProvider')?.value;
      const fallbackKey = $('#fallbackKey')?.value.trim();
      if (fallbackProvider && fallbackProvider !== 'none' && fallbackKey) {
        await api.saveProviderKey(fallbackProvider, fallbackKey);
        if (data.keyStatus) data.keyStatus[fallbackProvider] = true;
      }
    }
    const previousMicrophone = settings.microphoneId || '';
    const saved = await api.saveSettings(patch);
    settings = { ...settings, ...saved };
    data.settings = settings;
    settingsDirty = false;
    if ($('#chatKey')) $('#chatKey').value = '';
    if ($('#fallbackKey')) $('#fallbackKey').value = '';
    if (data.keyStatus) data.keyStatus[settings.chatProvider] = savedKey || Boolean(data.keyStatus?.[settings.chatProvider]);
    note('Saved.');
    renderAll();
    if (activePage === 'agent') {
      initializeModelCombos();
      updateProviderControls();
      updateFallbackControls();
      void refreshAllModelCombos({ force: true });
    }
    if (activePage === 'dictation' && previousMicrophone !== (settings.microphoneId || '') && monitorActive) {
      stopMicMonitor();
      startMicMonitor();
    }
  } catch (error) {
    note(error.message || 'Could not save settings.');
  }
}

async function saveInlineToggle(input) {
  const previous = input.checked;
  try {
    const patch = {};
    if (input.dataset.permission) {
      patch.permissionCustom = { [input.dataset.permission]: input.checked };
    } else if (input.dataset.tool) {
      patch.approval = { [input.dataset.tool]: input.checked };
    } else if (input.dataset.setting) {
      patch[input.dataset.setting] = input.checked;
      if (input.id === 'fallbackEnabled') {
        patch.fallbackProvider = $('#fallbackProvider')?.value || settings.fallbackProvider;
      }
    } else {
      return;
    }
    const saved = await api.saveSettings(patch);
    settings = { ...settings, ...saved };
    data.settings = settings;
    note('Saved.');
    renderAll();
  } catch (error) {
    input.checked = !previous;
    note(error.message || 'Could not save that setting.');
  }
}

async function loadWhisperSelection(model, presetId = '') {
  const target = String(model || '').trim();
  if (!target) return;
  const preset = presetId || whisperPresetForSelection(target);
  const saved = await api.saveSettings({
    whisperModel: target,
    performancePreset: preset
  });
  settings = { ...settings, ...saved };
  data.settings = settings;
  updateWhisperModelControls();
  const health = await api.loadWhisperModel(target);
  data.health = data.health || {};
  data.health.whisper = health;
  updateShell();
}

async function chooseWhisperModel(model) {
  const target = String(model || '').trim();
  if (!target) return;
  try {
    const info = whisperInfoFor(target);
    const saved = await api.saveSettings({ whisperModel: target, performancePreset: 'custom' });
    settings = { ...settings, ...saved };
    data.settings = settings;
    if (info.active) {
      note(`${info.label} is already the active model.`);
      updateWhisperModelControls();
      return;
    }
    if (info.downloaded === true) {
      await loadWhisperSelection(target, 'custom');
      note(`Switching to ${info.label} in the background.`);
      return;
    }
    updateWhisperModelControls();
    note(info.downloaded === false
      ? `${info.label} is selected. Choose Download to fetch it.`
      : `${info.label} is selected. Choose Download to start Whisper.`);
  } catch (error) {
    const select = $('#whisper');
    if (select) select.value = settings.whisperModel || '';
    updateWhisperModelControls();
    note(error.message || 'Could not select that Whisper model.');
  }
}

async function chooseWhisperPreset(presetId) {
  const preset = WHISPER_PRESETS[presetId];
  if (!preset) return;
  try {
    if (presetId === 'custom') {
      const saved = await api.saveSettings({ performancePreset: 'custom' });
      settings = { ...settings, ...saved };
      data.settings = settings;
      updateWhisperModelControls();
      note('Custom model selection enabled.');
      return;
    }
    const select = $('#whisper');
    if (select) select.value = preset.model;
    const info = whisperInfoFor(preset.model);
    const saved = await api.saveSettings({ whisperModel: preset.model, performancePreset: presetId });
    settings = { ...settings, ...saved };
    data.settings = settings;
    if (info.active) {
      note(`${info.label} is already the active model.`);
      updateWhisperModelControls();
      return;
    }
    if (info.downloaded === true) {
      await loadWhisperSelection(preset.model, presetId);
      note(`Switching to ${info.label} in the background.`);
      return;
    }
    updateWhisperModelControls();
    note(info.downloaded === false
      ? `${info.label} is selected. Choose Download to fetch it.`
      : `${info.label} is selected. Choose Download to start Whisper.`);
  } catch (error) {
    const select = $('#whisper');
    if (select) select.value = settings.whisperModel || '';
    const preset = $('#performancePreset');
    if (preset) preset.value = settings.performancePreset || 'custom';
    updateWhisperModelControls();
    note(error.message || 'Could not apply that performance preset.');
  }
}

function currentCombo(down) {
  const has = (prefix) => [...down.keys()].some((code) => code.startsWith(prefix));
  const parts = [];
  if (has('Control')) parts.push('Ctrl');
  if (has('Alt')) parts.push('Alt');
  if (has('Shift')) parts.push('Shift');
  if (has('Meta')) parts.push('Win');
  const keys = [...down.entries()].filter(([code]) => !/^(Control|Alt|Shift|Meta)/.test(code));
  const key = keys.length ? keys[keys.length - 1][1] : '';
  if (key) parts.push(key);
  return { value: parts.join('+'), key, modifiers: parts.length - (key ? 1 : 0) };
}

function keyToken(event) {
  if (event.code === 'Space') return 'Space';
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(event.code)) return event.code;
  return '';
}

function editHotkey(mode) {
  const modal = document.createElement('div');
  modal.className = 'modal-shade';
  modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h2>Edit ${esc(mode)} shortcut</h2><p>Press a key combination. Ctrl+Space can conflict with Windows input switching; F9 and Alt+Q are safe defaults.</p><div class="row-side"><button class="button" data-hotkey-preset="F9">F9</button><button class="button" data-hotkey-preset="Alt+Q">Alt+Q</button><button class="button" data-hotkey-preset="Ctrl+Space">Ctrl+Space</button></div><button id="capture" class="button primary" style="width:100%;margin-top:12px">Click, then press your keys</button><div id="captureValue" style="padding:15px 0;color:var(--muted)">Waiting…</div><div id="hotkeyWarning" class="card-note"></div><div class="modal-actions"><button id="cancel" class="button">Cancel</button><button id="use" class="button primary" disabled>Use shortcut</button></div></div>`;
  document.body.append(modal);
  const capture = modal.querySelector('#capture');
  const valueBox = modal.querySelector('#captureValue');
  const warning = modal.querySelector('#hotkeyWarning');
  const use = modal.querySelector('#use');
  let value = '';
  const down = new Map();
  let closed = false;

  function update(valueToUse) {
    value = valueToUse;
    valueBox.textContent = value || 'Waiting…';
    use.disabled = !value;
    const other = mode === 'dictation' ? settings.agentHotkey : settings.dictationHotkey;
    warning.textContent = value && value === other
      ? 'That shortcut is already used by the other mode.'
      : value === 'Ctrl+Space'
        ? 'Ctrl+Space may also switch Windows keyboard layouts.'
        : '';
  }

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    modal.remove();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && !down.size) {
      event.preventDefault();
      close();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (/^(Control|Alt|Shift|Meta)/.test(event.code)) down.set(event.code, '');
    else {
      const token = keyToken(event);
      if (token) down.set(event.code, token);
    }
    const combo = currentCombo(down);
    if (combo.key && (combo.modifiers > 0 || /^F([1-9]|1[0-2])$/.test(combo.key))) update(combo.value);
  }

  function onKeyUp(event) {
    event.preventDefault();
    event.stopPropagation();
    const combo = currentCombo(down);
    down.delete(event.code);
    if (combo.key && (combo.modifiers > 0 || /^F([1-9]|1[0-2])$/.test(combo.key))) update(combo.value);
  }

  modal.querySelectorAll('[data-hotkey-preset]').forEach((button) => {
    button.onclick = () => {
      down.clear();
      update(button.dataset.hotkeyPreset);
    };
  });
  capture.onclick = () => capture.focus();
  modal.querySelector('#cancel').onclick = close;
  use.onclick = async () => {
    if (!value) return;
    use.disabled = true;
    try {
      const saved = await api.saveSettings({ [`${mode}Hotkey`]: value });
      settings = { ...settings, ...saved };
      data.settings = settings;
      close();
      note('Shortcut saved.');
      renderAll();
    } catch (error) {
      use.disabled = false;
      warning.textContent = error.message || 'That shortcut is not supported.';
    }
  };
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  capture.focus();
}

async function saveProfile() {
  await savePage();
}

function wire() {
  $$('.nav-item[data-page]').forEach((button) => {
    button.onclick = () => nav(button.dataset.page);
  });
  $$('[data-page-link]').forEach((button) => {
    button.onclick = () => nav(button.dataset.pageLink);
  });
  $$('[data-window]').forEach((button) => {
    button.onclick = () => {
      void api.windowAction(button.dataset.window).catch((error) => note(error.message));
    };
  });
  $$('[data-edit-hotkey]').forEach((element) => {
    element.onclick = (event) => {
      if (event.target.closest('.toggle')) return;
      editHotkey(element.dataset.editHotkey);
    };
  });
  $$('.toggle input').forEach((input) => {
    input.onchange = () => {
      void saveInlineToggle(input);
    };
  });
  $$('[data-carousel]').forEach((button) => {
    button.onclick = () => $('#tips')?.scrollBy({ left: Number(button.dataset.carousel) * 354, behavior: 'smooth' });
  });
  $$('[data-preview-status]').forEach((button) => {
    button.onclick = async () => {
      try {
        await api.previewOverlay(button.dataset.previewStatus, button.dataset.previewDetail);
      } catch (error) {
        note(error.message);
      }
    };
  });
  $$('[data-gallery-slow]').forEach((button) => {
    button.onclick = () => {
      gallerySlowMotion = !gallerySlowMotion;
      button.setAttribute('aria-pressed', String(gallerySlowMotion));
      void api.setOverlayOptions({ slowMotion: gallerySlowMotion }).catch((error) => note(error.message));
    };
  });
  $$('[data-gallery-loop]').forEach((button) => {
    button.onclick = () => {
      galleryLoop = !galleryLoop;
      button.setAttribute('aria-pressed', String(galleryLoop));
    };
  });
  $$('[data-gallery-style]').forEach((button) => {
    button.onclick = async () => {
      try {
        const saved = await api.saveSettings({ overlayStyle: button.dataset.galleryStyle });
        settings = { ...settings, ...saved };
        data.settings = settings;
        note(`Overlay style · ${button.dataset.galleryStyle === 'notch' ? 'Notch' : 'Island'}`);
        refreshPage('dashboard');
      } catch (error) {
        note(error.message || 'Could not change the overlay style.');
      }
    };
  });

  const talk = $('#talkNow');
  if (talk) {
    talk.onclick = async () => {
      try {
        const result = await api.toggleTalk();
        talk.querySelector('span').textContent = result.active ? 'Stop' : 'Talk now';
      } catch (error) {
        note(error.message);
      }
    };
  }

  const userMenu = $('#userMenu');
  if (userMenu) {
    userMenu.onclick = () => {
      const dropdown = $('#userDropdown');
      if (dropdown) dropdown.hidden = !dropdown.hidden;
    };
  }
  $$('[data-menu]').forEach((button) => {
    button.onclick = () => {
      const action = button.dataset.menu;
      $('#userDropdown').hidden = true;
      if (action === 'settings' || action === 'about') nav(action);
      else void api.windowAction('quit').catch((error) => note(error.message));
    };
  });

  const community = $('#community');
  if (community) {
    community.onclick = (event) => {
      if (!settings.communityUrl) event.preventDefault();
    };
  }

  const historySearch = $('#historySearch');
  if (historySearch) {
    historySearch.oninput = () => {
      historyQuery = historySearch.value;
      const results = $('#historyResults');
      if (results) results.innerHTML = historyResults();
    };
  }

  const logFilter = $('#logFilter');
  if (logFilter) {
    logFilter.oninput = () => {
      logQuery = logFilter.value;
      const box = $('#logsPage');
      if (box) box.textContent = filteredLogLines().join('\n');
    };
  }

  const permissionMode = $('#permissionMode');
  if (permissionMode) {
    permissionMode.onchange = () => {
      const noteBox = $('#permissionModeNote');
      const selected = PERMISSION_MODES.find(([id]) => id === permissionMode.value);
      if (noteBox) noteBox.textContent = selected?.[2] || '';
    };
  }

  initializeModelCombos();
  updateProviderControls();
  updateFallbackControls();

  const chatProvider = $('#chatProvider');
  if (chatProvider) {
    chatProvider.onchange = () => {
      const provider = chatProvider.value;
      const config = settings.providers?.[provider] || {};
      const combo = $('[data-model-combo][data-model-kind="chat"]');
      if (combo) rememberComboValue(combo);
      if ($('#chatUrl')) $('#chatUrl').value = config.url || (provider === FREELLMAPI_PROVIDER ? 'http://127.0.0.1:31415/v1' : '');
      if ($('#chatKey')) $('#chatKey').value = '';
      if ($('#providerStatus')) $('#providerStatus').textContent = '';
      restoreComboModel('chat', provider);
      updateProviderControls();
      if (combo) void refreshComboModels(combo);
    };
  }

  const fallbackProvider = $('#fallbackProvider');
  if (fallbackProvider) {
    fallbackProvider.onchange = () => {
      const combo = $('[data-model-combo][data-model-kind="fallback"]');
      if (combo) rememberComboValue(combo);
      if ($('#fallbackKey')) $('#fallbackKey').value = '';
      restoreComboModel('fallback', fallbackProvider.value);
      updateFallbackControls();
    };
  }

  const ttsEngineSelect = $('#ttsEngine');
  if (ttsEngineSelect) {
    ttsEngineSelect.onchange = () => {
      updateTtsVoiceSelect();
      settingsDirty = activePage === 'dictation';
    };
  }

  const ttsSpeedSlider = $('#ttsSpeed');
  if (ttsSpeedSlider) {
    ttsSpeedSlider.oninput = () => {
      const label = $('#ttsSpeedVal');
      if (label) label.textContent = `${parseFloat(ttsSpeedSlider.value).toFixed(1)}×`;
    };
  }

  const ttsVolumeSlider = $('#ttsVolume');
  if (ttsVolumeSlider) {
    ttsVolumeSlider.oninput = () => {
      const label = $('#ttsVolumeVal');
      if (label) label.textContent = `${Math.round(parseFloat(ttsVolumeSlider.value) * 100)}%`;
    };
  }

  const ttsPreview = $('#ttsPreview');
  if (ttsPreview) {
    ttsPreview.onclick = async () => {
      ttsPreview.disabled = true;
      const result = $('#ttsPreviewResult');
      if (result) result.textContent = 'Speaking…';
      try {
        // Save current slider values first so the test uses what's shown.
        const patch = {};
        if ($('#ttsEngine')) patch.ttsEngine = $('#ttsEngine').value;
        if ($('#ttsVoice')) patch.ttsVoice = $('#ttsVoice').value;
        if ($('#ttsSpeed')) patch.ttsSpeed = parseFloat($('#ttsSpeed').value);
        if ($('#ttsVolume')) patch.ttsVolume = parseFloat($('#ttsVolume').value);
        const saved = await api.saveSettings(patch);
        settings = { ...settings, ...saved };
        data.settings = settings;
        const res = await api.testVoice();
        if (result) result.textContent = res?.message || 'Done.';
      } catch (error) {
        if (result) result.textContent = error.message || 'Voice test failed.';
      } finally {
        ttsPreview.disabled = false;
      }
    };
  }

  const refreshMic = $('#refreshMic');
  if (refreshMic) refreshMic.onclick = () => void refreshMicrophones();
  const micTest = $('#micTest');
  if (micTest) micTest.onclick = () => void runMicTest();
  const performancePreset = $('#performancePreset');
  if (performancePreset) performancePreset.onchange = () => void chooseWhisperPreset(performancePreset.value);
  const whisperSelect = $('#whisper');
  if (whisperSelect) whisperSelect.onchange = () => void chooseWhisperModel(whisperSelect.value);
  const refreshLogs = $('#refreshLogs');
  if (refreshLogs) {
    refreshLogs.onclick = async () => {
      try {
        data.activationLogs = await api.readLogs();
        refreshPage('logs');
      } catch (error) {
        note(error.message);
      }
    };
  }

  $$('[data-action]').forEach((button) => {
    button.onclick = () => handleAction(button.dataset.action, button);
  });
}

async function handleAction(action, button) {
  try {
    if (action === 'save-page') return await savePage();
    if (action === 'save-profile') return await saveProfile();
    if (action === 'update-check') {
      if (!updaterApi) return note('Updates are unavailable.');
      button.disabled = true;
      updaterStatus = await updaterApi.check();
      updateUpdaterUi();
      return;
    }
    if (action === 'update-download') {
      if (!updaterApi) return note('Updates are unavailable.');
      button.disabled = true;
      updaterStatus = await updaterApi.download();
      updateUpdaterUi();
      return;
    }
    if (action === 'update-install') {
      if (!updaterApi) return note('Updates are unavailable.');
      button.disabled = true;
      updaterStatus = await updaterApi.install();
      updateUpdaterUi();
      return;
    }
    if (action === 'reset-permissions') {
      if (!window.confirm('Reset saved permissions and return to Ask Every Time?')) return;
      const saved = await api.saveSettings({
        permissionMode: 'ask',
        permissionCustom: Object.fromEntries(PERMISSION_CATEGORIES.map(([id]) => [id, false]))
      });
      settings = { ...settings, ...saved };
      data.settings = settings;
      settingsDirty = false;
      note('Saved permissions were reset. Agent Mode will ask every time.');
      renderAll();
      return;
    }
    if (action === 'whisper-switch') {
      const model = button.dataset.model || settings.whisperModel;
      button.disabled = true;
      await loadWhisperSelection(model);
      note(`Preparing ${whisperModelLabel(model)}.`);
      return;
    }
    if (action === 'whisper-retry') {
      const model = data.health?.whisper?.targetModel || settings.whisperModel;
      button.disabled = true;
      try {
        await loadWhisperSelection(model);
        note(`Retrying ${whisperModelLabel(model)}.`);
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (action === 'whisper-cancel') {
      button.disabled = true;
      try {
        const health = await api.cancelWhisperLoad();
        data.health = data.health || {};
        data.health.whisper = health;
        updateShell();
        note('Whisper model switch canceled.');
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (action === 'health') {
      button.disabled = true;
      data.health = await api.health();
      button.disabled = false;
      renderAll();
      note('Service status refreshed.');
      return;
    }
    if (action === 'clear-history') {
      if (!window.confirm('Clear all saved turns?')) return;
      await api.clearHistory();
      data.turns = [];
      note('History cleared.');
      refreshPage('history');
      return;
    }
    if (action === 'refresh-apps') {
      button.disabled = true;
      data.apps = await api.refreshApps();
      button.disabled = false;
      note('App list refreshed.');
      refreshPage('apps');
      return;
    }
    if (action === 'ollama-download') {
      await api.openOllamaDownload();
      return;
    }
    if (action === 'ollama-pull') {
      const model = localOllamaModel();
      const panel = $('#ollamaPullProgress');
      if (panel) panel.hidden = false;
      button.disabled = true;
      updateOllamaProgress({ status: 'starting Ollama' });
      try {
        await api.pullOllamaModel();
        note(`${model} is ready.`);
        data.health = await api.health();
        updateShell();
        if (activePage === 'agent') refreshPage('agent');
      } catch (error) {
        updateOllamaProgress({ status: 'error', message: error.message || 'The model could not be pulled.' });
        note(error.message || 'The model could not be pulled.');
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (action === 'test-provider') {
      const provider = $('#chatProvider')?.value;
      const status = $('#providerStatus');
      if (!provider) return;
      button.disabled = true;
      if (status) status.textContent = 'Testing…';
      const result = await api.testProvider(provider, {
        url: $('#chatUrl')?.value.trim(),
        model: $('#chatModel')?.value.trim()
      }, $('#chatKey')?.value.trim());
      button.disabled = false;
      if (status) status.textContent = result.message;
      if (result.connected || result.ok) {
        const combo = $('[data-model-combo][data-model-kind="chat"]');
        if (combo) void refreshComboModels(combo, { force: true });
      }
      return;
    }
    if (action === 'refresh-models') {
      const combos = $$('[data-model-combo]').filter((combo) => comboProvider(combo) && comboProvider(combo) !== 'none');
      button.disabled = true;
      try {
        await Promise.all(combos.map((combo) => refreshComboModels(combo, { force: true })));
        const total = combos.reduce((sum, combo) => sum + comboState(combo).models.length, 0);
        note(`${total} model${total === 1 ? '' : 's'} found.`);
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (action === 'detect-provider') {
      const provider = $('#chatProvider')?.value;
      if (provider !== FREELLMAPI_PROVIDER) return;
      button.disabled = true;
      const status = $('#providerStatus');
      if (status) status.textContent = 'Detecting FreeLLMAPI…';
      try {
        const result = await api.detectProvider();
        if ($('#chatUrl')) $('#chatUrl').value = result.url;
        if (status) status.textContent = `Detected FreeLLMAPI at ${result.url}`;
        const combo = $('[data-model-combo][data-model-kind="chat"]');
        if (combo) void refreshComboModels(combo, { force: true });
      } catch (error) {
        if (status) status.textContent = error.message || 'No FreeLLMAPI server was found.';
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (action === 'test-overlay') {
      await api.previewOverlay('listening', 'Overlay test from settings. Nothing is recording.');
      return;
    }
    if (action === 'play-sequence') {
      await playGallerySequence();
      return;
    }
    if (action === 'test-voice') {
      button.disabled = true;
      const result = await api.testVoice();
      button.disabled = false;
      note(result.message || 'Voice test finished.');
    }
  } catch (error) {
    button.disabled = false;
    note(error.message || 'That action failed.');
  }
}

async function runMicTest() {
  if (micTestRunning) return;
  micTestRunning = true;
  stopMicMonitor();
  const resultBox = $('#micTestResult');
  const button = $('#micTest');
  if (button) button.disabled = true;
  if (resultBox) resultBox.textContent = 'Recording 3 seconds…';
  try {
    const result = await api.testMicrophone();
    if (resultBox) resultBox.textContent = `Transcript: ${result.transcript || '(empty)'}`;
  } catch (error) {
    if (resultBox) resultBox.textContent = error.message || 'Microphone test failed.';
  } finally {
    micTestRunning = false;
    if (button) button.disabled = false;
    if (activePage === 'dictation') startMicMonitor();
  }
}

async function load() {
  try {
    data = await api.getState();
    if (updaterApi) {
      try {
        updaterStatus = await updaterApi.getStatus();
      } catch (error) {
        console.error('updater status failed', error);
      }
    }
    if (data.gallery) {
      data.turns = [
        { time: new Date().toISOString(), said: 'Summarize my meeting notes', did: 'A concise summary is ready.' },
        { time: new Date(Date.now() - 3600000).toISOString(), said: 'Write a short follow-up', did: 'Draft prepared for review.' },
        { time: new Date(Date.now() - 86400000).toISOString(), said: 'Open my documents', did: 'Opened Documents.' }
      ];
      data.apps = ['Calendar', 'Mail', 'Notes', 'Browser'];
      data.health = { ollama: { ok: true, message: 'Ready' }, whisper: { ok: true, message: 'Ready' } };
      data.memory = ['Prefers concise replies', 'Workday starts at 9:00'];
    }
    settings = data.settings || {};
    settings._microphones = [];
    renderAll();
    const initial = location.hash.slice(1);
    nav(renderers[initial] ? initial : 'dashboard', true);
    if (data.gallery) nav('dashboard', true);
  } catch (error) {
    console.error('dashboard load failed', error);
    note(error.message || 'Could not load the workspace.');
  }
}

api.on('settings:refresh', (target) => {
  if (settingsDirty) {
    note('You have unsaved changes. Save or reload before refreshing settings.');
    return;
  }
  void load().then(() => {
    settingsDirty = false;
    if (target === 'settings') nav('settings', true);
  });
});
api.on('settings:updated', (next) => {
  if (!next || document.querySelector('.modal-shade')) return;
  settings = { ...settings, ...next };
  data.settings = settings;
  updateShell();
});
api.on('hotkey-status', (status) => {
  data.hotkey = status;
  if (activePage === 'settings') refreshPage('settings');
});
api.on('mode-status', ({ mode } = {}) => {
  if (!mode) return;
  settings.mode = mode;
  data.settings = settings;
  if (activePage === 'dashboard') refreshPage('dashboard');
});
api.on('provider-mode', ({ mode, provider } = {}) => {
  if (provider) settings.chatProvider = provider;
  if (mode) settings.activeMode = mode;
  if (provider && provider !== 'local') settings.lastCloudProvider = provider;
  updateShell();
});
api.on('ptt-state', ({ active } = {}) => {
  const talk = $('#talkNow');
  if (talk) talk.querySelector('span').textContent = active ? 'Stop' : 'Talk now';
});
api.on('log:entry', (entry) => {
  if (!entry) return;
  const line = `${entry.time} [${entry.level}] [${entry.step}]${entry.detail ? ` ${entry.detail}` : ''}`;
  const log = $('#logsPage');
  if (!log) return;
  if (logQuery.trim() && !line.toLowerCase().includes(logQuery.trim().toLowerCase())) return;
  log.textContent = `${log.textContent}\n${line}`.split('\n').slice(-500).join('\n');
});
api.on('audio-level', ({ peak = 0 } = {}) => {
  const meter = $('#settingsMicLevel');
  if (meter) meter.style.width = `${Math.min(100, Math.max(0, peak) * 800)}%`;
});
api.on('microphone:test-progress', (text) => {
  const result = $('#micTestResult');
  if (result) result.textContent = String(text || '');
});
api.on('microphone:test-result', (result) => {
  const box = $('#micTestResult');
  if (box) box.textContent = `Transcript: ${result?.transcript || '(empty)'}`;
});
api.on('microphone:test-error', (message) => {
  const box = $('#micTestResult');
  if (box) box.textContent = String(message || 'Microphone test failed.');
});
api.on('history:updated', (turns) => {
  data.turns = Array.isArray(turns) ? turns : [];
  if (activePage === 'history') {
    const results = $('#historyResults');
    if (results) results.innerHTML = historyResults();
  }
  if (activePage === 'insights') refreshPage('insights');
});
api.on('memory-updated', (memory) => {
  data.memory = Array.isArray(memory) ? memory : [];
});
api.on('health:updated', (health) => {
  data.health = health;
  updateShell();
});
api.on('ollama:pull-progress', (progress) => {
  updateOllamaProgress(progress || {});
});
updaterApi?.onStatus((status) => {
  if (!status) return;
  updaterStatus = status;
  updateUpdaterUi();
});

api.on('tts:play-audio', (buffer) => {
  window.ttsPlayer?.play(new Uint8Array(buffer));
});

window.addEventListener('hashchange', () => {
  const page = location.hash.slice(1);
  if (renderers[page] && page !== activePage) nav(page);
});
window.addEventListener('beforeunload', () => {
  stopMicMonitor();
  if (data.gallery) {
    gallerySequenceToken += 1;
    void api.setOverlayOptions({ slowMotion: false }).catch(() => {});
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopMicMonitor();
  else if (activePage === 'dictation') startMicMonitor();
});

function markSettingsDirty(event) {
  if (!['agent', 'dictation', 'settings'].includes(activePage)) return;
  const target = event.target;
  if (!(target instanceof Element) || target.closest('.toggle')) return;
  settingsDirty = true;
}

document.addEventListener('input', markSettingsDirty, true);
document.addEventListener('change', markSettingsDirty, true);

window.addEventListener('error', (event) => {
  console.error('dashboard error', event.error || event.message || 'unknown error');
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('dashboard unhandled rejection', event.reason || 'unknown rejection');
});

void load();
