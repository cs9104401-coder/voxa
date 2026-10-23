'use strict';

const { APP_NAME } = require('../brand.cjs');
const { defaultPermissionSettings } = require('./permissions.cjs');

const PROVIDERS = {
  local: { url: 'http://localhost:11434/v1', model: 'qwen3:8b' },
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
  { name: 'web_search', description: 'Search Google.', parameters: { query: 'string' }, requiresApproval: true },
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
  MAX_TOOL_TEXT_CHARS: 4000,
  MAX_TOOL_ARGUMENT_CHARS: 4000,
  MAX_TOOL_CALLS: 12,
  MAX_CONSECUTIVE_TOOL_FAILURES: 3,
  AGENT_TIMEOUT_MS: 180000,
  APPROVAL_TIMEOUT_MS: 120000,
  MAX_MEMORY_ENTRIES: 100,
  MAX_MEMORY_CHARS: 300,
  MAX_PROFILE_NAME_CHARS: 50,
  MAX_COMMUNITY_URL_CHARS: 500,
  MAX_TURNS: 50,
  MAX_LOG_LINES: 500,
  MAX_TOOL_ROUNDS: 4,
  HOTKEY_STALE_MS: 5000,
  OVERLAY_HIDE_DELAY_MS: 160,
  OVERLAY_SHOW_TIMEOUT_MS: 4000,
  HEALTH_TIMEOUT_MS: 3000,
  MODEL_LIST_TIMEOUT_MS: 5000,
  CHAT_TIMEOUT_MS: 90000,
  TRANSCRIBE_TIMEOUT_MS: 180000,
  SPEECH_TIMEOUT_MS: 120000,
  WHISPER_START_TIMEOUT_MS: 30 * 60 * 1000,
  WHISPER_STALL_TIMEOUT_MS: 180000,
  WHISPER_PROGRESS_POLL_MS: 500,
  OLLAMA_PULL_TIMEOUT_MS: 60 * 60 * 1000,
  MIC_ENUMERATION_TIMEOUT_MS: 15000,
  MIC_TEST_DURATION_MS: 3000
};

const MESSAGES = {
  HEARD_NOTHING: "I didn't hear anything, check your mic",
  HOLD_TOO_SHORT: 'Hold for at least 250 ms to speak.',
  WHISPER_UNREACHABLE: 'Whisper server is unreachable. Start whisper-server and check its virtual environment.',
  CANCELLED: 'Turn cancelled.'
};

const TRAY_ICON_FILE = 'tray.png';

function defaults(userName = 'User') {
  return {
    settingsVersion: 2,
    dictationHotkey: 'Ctrl+Q',
    agentHotkey: 'Alt+Q',
    dictationEnabled: true,
    agentEnabled: true,
    mode: 'agent',
    whisperModel: 'small',
    whisperDevice: 'cpu',
    ollamaModel: PROVIDERS.local.model,
    chatProvider: 'local',
    providers: structuredClone(PROVIDERS),
    sttProvider: 'local',
    sttCloudProvider: 'openai',
    sttModel: 'whisper-1',
    fallbackEnabled: false,
    fallbackProvider: 'openai',
    activeMode: 'local',
    lastCloudProvider: 'openai',
    microphoneId: '',
    approval: Object.fromEntries(APPROVABLE_TOOLS.map((tool) => [tool, true])),
    ...defaultPermissionSettings(),
    startWithWindows: false,
    paused: false,
    spokenReplies: true,
    displayName: userName,
    communityUrl: ''
  };
}

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
  defaults
};
