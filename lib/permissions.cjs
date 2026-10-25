'use strict';

const PERMISSION_MODES = Object.freeze([
  {
    id: 'ask',
    label: 'Ask Every Time',
    description: 'Show an approval in the notch before every desktop action.'
  },
  {
    id: 'routine',
    label: 'Allow Routine Actions',
    description: 'Open files, folders, apps, and websites, and read files in your folders without asking. Sensitive actions still ask.'
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Choose which routine action categories run without asking.'
  }
]);

const PERMISSION_MODE_IDS = new Set(PERMISSION_MODES.map((mode) => mode.id));

const ROUTINE_CATEGORIES = Object.freeze([
  {
    id: 'open_files',
    label: 'Open files',
    detail: 'Open documents and media from your Home, Desktop, Documents, Downloads, Pictures, Music, or Videos folders.'
  },
  {
    id: 'open_folders',
    label: 'Open folders',
    detail: 'Navigate to ordinary folders inside Home, Desktop, Documents, Downloads, Pictures, Music, or Videos.'
  },
  {
    id: 'launch_apps',
    label: 'Launch applications',
    detail: 'Start applications discovered from the Start menu.'
  },
  {
    id: 'close_apps',
    label: 'Close applications',
    detail: 'Close apps by name, including minimized, background, and Store apps.'
  },
  {
    id: 'browse_web',
    label: 'Open websites and search',
    detail: 'Open HTTPS pages and run Google searches.'
  },
  {
    id: 'read_files',
    label: 'Read files in your folders',
    detail: 'Read text from non-sensitive files in your user folders.'
  },
  {
    id: 'save_notes',
    label: 'Save memory notes',
    detail: 'Save a short note when you explicitly ask Voxa to remember it.'
  }
]);

const ROUTINE_CATEGORY_IDS = new Set(ROUTINE_CATEGORIES.map((category) => category.id));

const SENSITIVE_CATEGORIES = Object.freeze([
  {
    id: 'type_text',
    label: 'Type text, send messages, or submit forms',
    detail: 'Typing can send a message or submit a form in the focused app.'
  },
  {
    id: 'keyboard',
    label: 'Send keyboard shortcuts',
    detail: 'Shortcuts can delete data, change settings, or trigger commands.'
  },
  {
    id: 'execute_files',
    label: 'Run scripts or downloaded executables',
    detail: 'Scripts, installers, shortcuts, and downloaded programs can change the computer.'
  },
  {
    id: 'delete_files',
    label: 'Delete or overwrite files',
    detail: 'Destructive file changes always need a separate confirmation.'
  },
  {
    id: 'elevated',
    label: 'Run administrator-level commands',
    detail: 'Elevated actions can change the whole computer and may show a Windows UAC prompt.'
  },
  {
    id: 'credentials',
    label: 'Access credentials or change security settings',
    detail: 'Credentials, tokens, browser logins, and security settings are protected.'
  }
]);

const SENSITIVE_CATEGORY_IDS = new Set(SENSITIVE_CATEGORIES.map((category) => category.id));

const TOOL_CATEGORIES = Object.freeze({
  open_file: 'open_files',
  open_folder: 'open_folders',
  open_app: 'launch_apps',
  close_app: 'close_apps',
  open_url: 'browse_web',
  web_search: 'browse_web',
  read_file: 'read_files',
  remember_note: 'save_notes',
  type_text: 'type_text',
  press_keys: 'keyboard'
});

const NON_APPROVAL_TOOLS = new Set(['refresh_apps']);

const EXECUTABLE_EXTENSIONS = new Set([
  '.appx', '.bat', '.cmd', '.com', '.cpl', '.exe', '.gadget', '.hta', '.jar',
  '.js', '.jse', '.lnk', '.msc', '.msi', '.msix', '.msp', '.pif', '.ps1',
  '.reg', '.scr', '.url', '.vb', '.vbe', '.vbs', '.wsf', '.wsh'
]);

const CREDENTIAL_FILE_PATTERN = /^(?:\.env(?:\..*)?|\.netrc|credentials?(?:\..*)?|cookies(?:\..*)?|login data(?:-journal)?|logins\.json|key[0-9]?\.db|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|provider-keys\.enc|settings\.json|history\.json|activation\.log(?:\..*)?|.*\.(?:key|pem|pfx|p12|kdbx))$/i;
const CREDENTIAL_DIRECTORIES = new Set(['.ssh', '.aws', '.azure', '.gnupg', 'appdata', 'cookies', 'login data']);

function isValidPermissionMode(value) {
  return typeof value === 'string' && PERMISSION_MODE_IDS.has(value);
}

function normalizePermissionMode(value, fallback = 'ask') {
  return isValidPermissionMode(value) ? value : (isValidPermissionMode(fallback) ? fallback : 'ask');
}

function defaultCustomPermissions() {
  return Object.fromEntries(ROUTINE_CATEGORIES.map((category) => [category.id, false]));
}

function normalizeCustomPermissions(raw, base = {}) {
  const result = defaultCustomPermissions();
  for (const category of ROUTINE_CATEGORIES) {
    if (typeof raw?.[category.id] === 'boolean') result[category.id] = raw[category.id];
    else if (typeof base?.[category.id] === 'boolean') result[category.id] = base[category.id];
  }
  return result;
}

function defaultPermissionSettings() {
  return {
    permissionMode: 'ask',
    permissionCustom: defaultCustomPermissions()
  };
}

function legacyPermissionSettings(approval) {
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) return null;
  const permissionCustom = defaultCustomPermissions();
  let selected = false;
  for (const [tool, allowed] of Object.entries(approval)) {
    if (allowed !== false) continue;
    const category = TOOL_CATEGORIES[tool];
    if (!ROUTINE_CATEGORY_IDS.has(category)) continue;
    permissionCustom[category] = true;
    selected = true;
  }
  return selected ? { permissionMode: 'custom', permissionCustom } : null;
}

function isExecutableFile(filePath) {
  return EXECUTABLE_EXTENSIONS.has(String(filePath || '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '');
}

function isSensitiveFileName(name) {
  return CREDENTIAL_FILE_PATTERN.test(String(name || ''));
}

function isSensitiveDirectory(name) {
  return CREDENTIAL_DIRECTORIES.has(String(name || '').toLowerCase());
}

function categoryForTool(tool, context = {}) {
  if (tool === 'open_file') {
    if (context.sensitiveKind === 'credentials') return 'credentials';
    if (context.sensitiveKind === 'executable') return 'execute_files';
    return 'open_files';
  }
  if (tool === 'open_folder') {
    return context.sensitiveKind === 'credentials' ? 'credentials' : 'open_folders';
  }
  if (tool === 'read_file') {
    return context.sensitiveKind === 'credentials' ? 'credentials' : 'read_files';
  }
  return TOOL_CATEGORIES[tool] || null;
}

function categoryDetails(categoryId) {
  return ROUTINE_CATEGORIES.find((category) => category.id === categoryId)
    || SENSITIVE_CATEGORIES.find((category) => category.id === categoryId)
    || null;
}

function actionFingerprint(tool, rawArgs) {
  let args;
  try {
    args = JSON.parse(rawArgs || '{}');
  } catch {
    return `${tool}:${String(rawArgs || '').trim()}`;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return `${tool}:${String(rawArgs || '').trim()}`;
  const normalized = Object.fromEntries(Object.keys(args).sort().map((key) => [
    key,
    typeof args[key] === 'string' ? args[key].trim().toLowerCase() : args[key]
  ]));
  return `${tool}:${JSON.stringify(normalized)}`;
}

function resolvePermission(settings, tool, context = {}) {
  const mode = normalizePermissionMode(settings?.permissionMode);
  const category = categoryForTool(tool, context);
  const fullAccess = settings?.agentFullAccess === true;
  if (!category) {
    const safe = NON_APPROVAL_TOOLS.has(tool);
    return {
      mode,
      category: null,
      sensitive: false,
      autoAllowed: fullAccess || safe,
      requiresApproval: fullAccess ? false : !safe,
      fullAccess,
      details: null
    };
  }
  const sensitive = SENSITIVE_CATEGORY_IDS.has(category);
  const externalRead = tool === 'read_file' && context.cloudRead === true;
  if (fullAccess) {
    return {
      mode,
      category,
      sensitive,
      external: externalRead,
      autoAllowed: true,
      requiresApproval: false,
      fullAccess: true,
      details: categoryDetails(category)
    };
  }
  let autoAllowed = false;
  if (!sensitive && !externalRead) {
    if (mode === 'routine') autoAllowed = true;
    else if (mode === 'custom') autoAllowed = settings?.permissionCustom?.[category] === true;
  }
  return {
    mode,
    category,
    sensitive,
    external: externalRead,
    autoAllowed,
    requiresApproval: !autoAllowed,
    fullAccess: false,
    details: categoryDetails(category)
  };
}

module.exports = {
  PERMISSION_MODES,
  PERMISSION_MODE_IDS,
  ROUTINE_CATEGORIES,
  ROUTINE_CATEGORY_IDS,
  SENSITIVE_CATEGORIES,
  SENSITIVE_CATEGORY_IDS,
  TOOL_CATEGORIES,
  NON_APPROVAL_TOOLS,
  EXECUTABLE_EXTENSIONS,
  isValidPermissionMode,
  normalizePermissionMode,
  defaultCustomPermissions,
  normalizeCustomPermissions,
  defaultPermissionSettings,
  legacyPermissionSettings,
  isExecutableFile,
  isSensitiveFileName,
  isSensitiveDirectory,
  categoryForTool,
  categoryDetails,
  actionFingerprint,
  resolvePermission
};
