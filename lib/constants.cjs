'use strict';

const { APP_NAME } = require('../brand.cjs');
const { defaultPermissionSettings } = require('./permissions.cjs');

const PROVIDERS = {
  local: { url: 'http://localhost:11434/v1', model: 'qwen3:8b' },
  freellmapi: { url: 'http://127.0.0.1:31415/v1', model: 'auto' },
  openai: { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  groq: { url: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash' },
  anthropic: { url: 'https://api.anthropic.com/v1', model: 'claude-3-5-haiku-latest' },
  custom: { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }
};

const TOOL_DEFINITIONS = [
  { name: 'type_text', description: 'Paste text into the app that was focused when speaking.', parameters: { text: 'string' }, requiresApproval: true },
  { name: 'open_url', description: 'Open an HTTPS page.', parameters: { url: 'string' }, requiresApproval: true },
  { name: 'open_app', description: 'Open a discovered installed app by name.', parameters: { app: 'string' }, requiresApproval: true },
  {
    name: 'close_app',
    description: 'Close an app by name, even when it is minimized, unfocused, or running in the background. Use force only when the user says force close or kill.',
    parameters: {
      name: { type: 'string', optional: true, description: 'App name. Leave empty to close the last app Voxa opened, or the focused window.' },
      force: { type: 'boolean', optional: true, default: false, description: 'Kill the process if it stays open. Only when the user says force close or kill.' }
    },
    requiresApproval: true
  },
  { name: 'web_search', description: "Open a Google search page in the user's browser. Returns no results to the model.", parameters: { query: 'string' }, requiresApproval: true },
  { name: 'open_folder', description: 'Open a folder by name or by a path inside the user folders.', parameters: { folder: 'string' }, requiresApproval: true },
  { name: 'open_file', description: 'Open a file from the user Home, Desktop, Documents, Downloads, Pictures, Music, or Videos folders.', parameters: { path: 'string' }, requiresApproval: true },
  { name: 'read_file', description: 'Read a text file from the user Home, Desktop, Documents, Downloads, Pictures, Music, or Videos folders.', parameters: { path: 'string' }, requiresApproval: true },
  { name: 'press_keys', description: 'Send a keyboard shortcut.', parameters: { shortcut: 'string' }, requiresApproval: true },
  { name: 'remember_note', description: 'Save a short note when the user explicitly asks you to remember it.', parameters: { note: 'string' }, requiresApproval: true },
  { name: 'refresh_apps', description: 'Refresh installed apps when asked by the user.', parameters: {}, requiresApproval: false }
];

const APPROVABLE_TOOLS = TOOL_DEFINITIONS.filter((tool) => tool.requiresApproval).map((tool) => tool.name);
const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);
const STT_CLOUD_PROVIDERS = Object.freeze(['openai', 'groq']);

const LIMITS = {
  MIN_HOLD_MS: 250,
  TAIL_MS: 300,
  MIN_AUDIO_MS: 500,
  SILENCE_RMS: 0.002,
  MAX_AUDIO_BYTES: 25 * 1024 * 1024,
  MAX_TRANSCRIPT_CHARS: 20000,
  MAX_CHAT_CHARS: 8000,
  MAX_TOOL_TEXT_CHARS: 4000,
  MAX_TOOL_ARGUMENT_CHARS: 4000,
  MAX_TOOL_CALLS: 12,
  MAX_CONSECUTIVE_TOOL_FAILURES: 3,
  AGENT_TIMEOUT_MS: 180000,
  APPROVAL_TIMEOUT_MS: 120000,
  MAX_MEMORY_ENTRIES: 100,
  MAX_MEMORY_CHARS: 300,
  MAX_PROMPT_APPS: 40,
  MAX_PROMPT_NOTES: 20,
  MAX_VOICE_HISTORY_TURNS: 3,
  MAX_VOICE_HISTORY_CHARS: 4000,
  MAX_PROFILE_NAME_CHARS: 50,
  MAX_COMMUNITY_URL_CHARS: 500,
  MAX_TURNS: 50,
  MAX_LOG_LINES: 500,
  MAX_TOOL_ROUNDS: 4,
  HOTKEY_STALE_MS: 5000,
  OVERLAY_HIDE_DELAY_MS: 160,
  OVERLAY_EXIT_FALLBACK_MS: 2200,
  OVERLAY_SHOW_TIMEOUT_MS: 4000,
  HEALTH_TIMEOUT_MS: 3000,
  MODEL_LIST_TIMEOUT_MS: 5000,
  CHAT_TIMEOUT_MS: 90000,
  TRANSCRIBE_TIMEOUT_MS: 180000,
  SPEECH_TIMEOUT_MS: 120000,
  WHISPER_START_TIMEOUT_MS: 30 * 60 * 1000,
  WHISPER_STALL_TIMEOUT_MS: 60000,
  WHISPER_PROGRESS_POLL_MS: 500,
  OLLAMA_PULL_TIMEOUT_MS: 60 * 60 * 1000,
  MIC_ENUMERATION_TIMEOUT_MS: 15000,
  MIC_TEST_DURATION_MS: 3000,

  // TTS (Kokoro) limits — Phase 1 scaffolding; the pipeline itself lands in later phases.
  TTS_PORT: 8000,
  TTS_SYNTHESIZE_TIMEOUT_MS: 12000,
  TTS_MIN_SPEED: 0.7,
  TTS_MAX_SPEED: 1.4,
  TTS_MIN_VOLUME: 0,
  TTS_MAX_VOLUME: 1,
  TTS_FAST_RTF: 0.3,
  TTS_WEAK_RTF: 0.8,
  TTS_IDLE_UNLOAD_MS: 5 * 60 * 1000,
  TTS_CIRCUIT_FAILURES: 3,
  TTS_CIRCUIT_COOLDOWN_MS: 60000,
  TTS_SENTENCE_MAX_CHARS: 200
};

const MESSAGES = {
  HEARD_NOTHING: "I didn't hear anything, check your mic",
  HOLD_TOO_SHORT: 'Hold for at least 250 ms to speak.',
  WHISPER_UNREACHABLE: 'Whisper server is unreachable. Start whisper-server and check its virtual environment.',
  CANCELLED: 'Turn cancelled.'
};

const TRAY_ICON_FILE = 'tray.png';

const WHISPER_MODELS = Object.freeze([
  { id: 'tiny', label: 'Tiny', sizeBytes: 75525797 },
  { id: 'base', label: 'Base', sizeBytes: 145466455 },
  { id: 'small', label: 'Small', sizeBytes: 484190939 },
  { id: 'medium', label: 'Medium', sizeBytes: 1530000000 },
  { id: 'large-v3-turbo', label: 'Large v3 Turbo', sizeBytes: 1620000000 },
  { id: 'large-v3', label: 'Large v3', sizeBytes: 3090000000 }
]);

const WHISPER_PRESETS = Object.freeze({
  fast: { label: 'Fast', model: 'base', description: 'Lower latency and a smaller download.' },
  balanced: { label: 'Balanced', model: 'small', description: 'Good everyday speed and accuracy.' },
  accurate: { label: 'Accurate', model: 'large-v3', description: 'Best accuracy with the largest download.' },
  custom: { label: 'Custom', model: '', description: 'Choose any installed or downloadable model.' }
});

function defaults(userName = 'User') {
  return {
    settingsVersion: 5,
    dictationHotkey: 'Ctrl+Q',
    agentHotkey: 'Alt+Q',
    dictationEnabled: true,
    agentEnabled: true,
    agentFullAccess: false,
    mode: 'agent',
    whisperModel: 'small',
    whisperDevice: 'cpu',
    performancePreset: 'balanced',
    ollamaModel: PROVIDERS.local.model,
    chatProvider: 'local',
    providers: structuredClone(PROVIDERS),
    sttProvider: 'local',
    sttCloudProvider: 'openai',
    sttModel: 'whisper-1',
    fallbackEnabled: false,
    fallbackProvider: 'none',
    activeMode: 'local',
    lastCloudProvider: 'openai',
    microphoneId: '',
    approval: Object.fromEntries(APPROVABLE_TOOLS.map((tool) => [tool, true])),
    ...defaultPermissionSettings(),
    startWithWindows: false,
    paused: false,
    spokenReplies: true,
    companionEnabled: true,
    overlayStyle: 'island',

    // Phase I: the real producer-driven dwells Phases F/G/H left hard-coded.
    // Seconds/minutes, validated against ISLAND_DWELL_OPTIONS on every load
    // and save; main reads them at the actual use sites.
    feedToastSeconds: 4,
    feedDwellSeconds: 8,
    mediaSnoozeMinutes: 5,

    displayName: userName,
    communityUrl: '',

    // TTS (Kokoro-82M) — Phase 1 scaffolding. Kokoro itself is not wired yet; these
    // defaults keep the Windows voice behaviour unchanged until the pipeline lands.
    ttsEngine: 'windows',
    ttsVoice: 'af_heart',
    ttsSpeed: 1.0,
    ttsVolume: 1.0,
    ttsGpu: false,
    ttsAutoVoice: true,
    ttsTier: null,
    ttsModelVariant: 'quantized',
    ttsBatterySaver: true,
    ttsLatencyMs: 0
  };
}

/* Phase I: whitelisted island dwell values. The pill's timing shows real
   seconds to the user; arbitrary values would let a mistyped save race the
   producer flows, so both load and save accept only these options. */
const ISLAND_DWELL_OPTIONS = {
  feedToastSeconds: [2, 4, 6, 8, 12],
  feedDwellSeconds: [4, 8, 12, 20, 30],
  mediaSnoozeMinutes: [1, 3, 5, 10, 15]
};

module.exports = {
  APP_NAME,
  PROVIDERS,
  TOOL_DEFINITIONS,
  APPROVABLE_TOOLS,
  TOOL_NAMES,
  STT_CLOUD_PROVIDERS,
  LIMITS,
  MESSAGES,
  TRAY_ICON_FILE,
  WHISPER_MODELS,
  WHISPER_PRESETS,
  ISLAND_DWELL_OPTIONS,
  defaults
};
