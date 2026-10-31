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

const VOICE_COMMAND_MODES = Object.freeze([
  {
    id: 'smart',
    label: 'Smart',
    description: 'Answer plain questions directly; attach desktop tools only to task-like commands.'
  },
  {
    id: 'always',
    label: 'Always',
    description: 'Send every agent command to the model with desktop tools attached.'
  }
]);
const VOICE_COMMAND_MODE_IDS = new Set(VOICE_COMMAND_MODES.map((mode) => mode.id));

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
  // Single source of truth for the local Whisper port. The app passes this to
  // the server with --port and uses it for every health/control request.
  WHISPER_PORT: 8000,
  // Optional non-Whisper ASR service. It is started lazily only when one of
  // these engines is selected; the bundled Whisper path never uses it.
  ASR_PORT: 8756,
  ASR_START_TIMEOUT_MS: 120000,
  ASR_TRANSCRIBE_TIMEOUT_MS: 60 * 60 * 1000,
  ASR_PROGRESS_POLL_MS: 700,
  OLLAMA_PULL_TIMEOUT_MS: 60 * 60 * 1000,
  MIC_ENUMERATION_TIMEOUT_MS: 15000,
  MIC_TEST_DURATION_MS: 3000,

  // TTS (Kokoro) limits. The server port lives beside the server lifecycle in
  // lib/tts-kokoro.cjs (KOKORO_PORT) and is not a tunable limit.
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
  TTS_SENTENCE_MAX_CHARS: 200,

  // cua-driver MCP transport. Desktop jobs legitimately need more rounds than
  // the built-in action tools because the model must inspect a window, act,
  // then inspect again to verify.
  CUA_START_TIMEOUT_MS: 20000,
  CUA_CALL_TIMEOUT_MS: 45000,
  CUA_AGENT_TIMEOUT_MS: 240000,
  CUA_MAX_TOOL_ROUNDS: 12,
  CUA_MAX_TOOL_CALLS: 20,
  CUA_MAX_TOOL_RESULT_CHARS: 9000,
  CUA_MAX_ARGUMENT_CHARS: 9000,
  CUA_CONFIRM_RECORD_MS: 3200,
  CUA_CONFIRM_TIMEOUT_MS: 20000,
  CUA_CONFIRM_ATTEMPTS: 2
};

const MESSAGES = {
  HEARD_NOTHING: "I didn't hear anything, check your mic",
  HOLD_TOO_SHORT: 'Hold for at least 250 ms to speak.',
  WHISPER_UNREACHABLE: 'Whisper server is unreachable. Start whisper-server and check its virtual environment.',
  CANCELLED: 'Turn cancelled.'
};

const TRAY_ICON_FILE = 'tray.png';

const WHISPER_MODELS = Object.freeze([
  { id: 'tiny', label: 'Tiny', sizeBytes: 75525797, repoId: 'Systran/faster-whisper-tiny' },
  { id: 'base', label: 'Base', sizeBytes: 145466455, repoId: 'Systran/faster-whisper-base' },
  { id: 'small', label: 'Small', sizeBytes: 484190939, repoId: 'Systran/faster-whisper-small' },
  { id: 'medium', label: 'Medium', sizeBytes: 1530000000, repoId: 'Systran/faster-whisper-medium' },
  { id: 'large-v3-turbo', label: 'Large v3 Turbo', sizeBytes: 1620000000, repoId: 'mobiuslabsgmbh/faster-whisper-large-v3-turbo' },
  { id: 'large-v3', label: 'Large v3', sizeBytes: 3090000000, repoId: 'Systran/faster-whisper-large-v3' }
]);

const WHISPER_PRESETS = Object.freeze({
  fast: { label: 'Fast', model: 'base', description: 'Lower latency and a smaller download.' },
  balanced: { label: 'Balanced', model: 'small', description: 'Good everyday speed and accuracy.' },
  accurate: { label: 'Accurate', model: 'large-v3', description: 'Best accuracy with the largest download.' },
  custom: { label: 'Custom', model: '', description: 'Choose any installed or downloadable model.' }
});

// The first entry is the bundled faster-whisper path. Every other entry is an
// optional offline backend served by the lazily started Python ASR service.
// Sizes are artifact sizes, not promised accuracy or promised download size.
const ASR_ENGINES = Object.freeze([
  {
    id: 'whisper',
    label: 'Whisper (bundled)',
    backend: 'faster-whisper',
    sizeBytes: 0,
    languageHint: true,
    deviceHint: 'Uses the Whisper model and compute setting below. Supports a language hint.',
    notes: 'The existing local Whisper server. No optional Python runtime is needed.'
  },
  {
    id: 'parakeet-tdt-0.6b-v3',
    label: 'NVIDIA Parakeet TDT 0.6B v3',
    backend: 'transformers-tdt',
    sizeBytes: 2508311120,
    languageHint: false,
    deviceHint: '25 European languages, detected internally. The language hint is ignored. Token timestamps; no language label.',
    notes: 'Needs the optional Transformers runtime. Token timestamps are not word timestamps.'
  },
  {
    id: 'qwen3-asr-1.7b',
    label: 'Qwen3-ASR 1.7B',
    backend: 'qwen-asr',
    sizeBytes: 4700000000,
    languageHint: true,
    deviceHint: '30 languages with automatic detection, long-form input, and an optional language hint.',
    notes: 'Needs its own qwen-asr environment. Word timestamps need a separate forced aligner.'
  },
  {
    id: 'granite-speech-5.0-470m-turboctc',
    label: 'IBM Granite Speech 5.0 470M TurboCTC',
    backend: 'granite-transformers',
    sizeBytes: 946311576,
    languageHint: false,
    deviceHint: 'Compact multilingual CTC model. It detects the language internally; the hint is ignored. Text only.',
    notes: 'Needs the optional Transformers runtime (transformers 5.16 or newer).'
  }
]);

const ASR_COMPUTE_TYPES = Object.freeze(['auto', 'float32', 'float16', 'bfloat16']);
const ASR_DEVICES = Object.freeze(['auto', 'cpu', 'cuda']);

function defaults(userName = 'User') {
  return {
    settingsVersion: 8,
    dictationHotkey: 'Ctrl+Q',
    agentHotkey: 'Alt+Q',
    dictationEnabled: true,
    agentEnabled: true,
    agentFullAccess: false,
    voiceCommandMode: 'smart',
    mode: 'agent',
    whisperModel: 'small',
    whisperDevice: 'cpu',
    performancePreset: 'balanced',
    // Runtime speech-engine selection. 'whisper' keeps the existing bundled
    // server; any other id opts into the optional local ASR service.
    asrEngine: 'whisper',
    asrDevice: 'auto',
    asrComputeType: 'auto',
    asrLanguage: 'en',
    asrWordTimestamps: false,
    asrVad: true,
    asrChunkSeconds: 30,
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
    historyEnabled: true,
    spokenReplies: true,
    companionEnabled: true,
    companionFollow: true,
    overlayStyle: 'island',

    // Notch appearance. The notch kit stays locked; these fields only drive the
    // wrapper geometry, resting pill size, cast/palette, and auto-hide policy.
    notchSize: 'auto',
    notchScale: 100,
    notchPosition: 'center',
    notchOffsetY: 0,
    notchBehavior: 'auto',
    notchCast: 'bob',
    notchPalette: 'auto',

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

/* Notch appearance options shared by load/save validation, the dashboard, and
   the in-overlay settings sheet. `auto` resting size keeps the kit's compact
   idle pill; the other sizes only override idle, never answers or approvals. */
const NOTCH_OPTIONS = {
  notchSize: ['auto', 'compact', 'medium', 'expanded'],
  notchPosition: ['left', 'center', 'right'],
  notchBehavior: ['auto', 'stay-open'],
  notchCast: ['bob', 'girl', 'boy', 'couple'],
  notchPalette: ['auto', 'wine', 'ember', 'mint', 'sky', 'plum', 'brick', 'boy']
};

const NOTCH_SCALE_RANGE = [80, 120];
const NOTCH_OFFSET_RANGE = [0, 64];

module.exports = {
  APP_NAME,
  PROVIDERS,
  TOOL_DEFINITIONS,
  APPROVABLE_TOOLS,
  TOOL_NAMES,
  STT_CLOUD_PROVIDERS,
  VOICE_COMMAND_MODES,
  VOICE_COMMAND_MODE_IDS,
  LIMITS,
  MESSAGES,
  TRAY_ICON_FILE,
  WHISPER_MODELS,
  WHISPER_PRESETS,
  ASR_ENGINES,
  ASR_COMPUTE_TYPES,
  ASR_DEVICES,
  ISLAND_DWELL_OPTIONS,
  NOTCH_OPTIONS,
  NOTCH_SCALE_RANGE,
  NOTCH_OFFSET_RANGE,
  defaults
};
