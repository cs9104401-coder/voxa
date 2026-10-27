'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const permissions = require('./lib/permissions.cjs');

const root = __dirname;
const reportPath = path.join(root, 'selftest-report.txt');
const runtimePath = path.join(root, '.selftest-runtime.json');
const results = [];
const generatedDirectories = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '.venv-asr', '.venv-asr-qwen', '__pycache__']);

function record(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail || '').replace(/\0/g, '').slice(0, 5000) });
}

function relative(file) {
  return path.relative(root, file).replaceAll('\\', '/');
}

function collectJavaScript(dir, found = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (generatedDirectories.has(item.name)) continue;
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) collectJavaScript(fullPath, found);
    else if (/\.(?:js|cjs|mjs)$/.test(item.name)) found.push(fullPath);
  }
  return found;
}

function checkJavaScript() {
  const files = collectJavaScript(root);
  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      failures.push(`${relative(file)}: ${(result.stderr || result.stdout).trim().split('\n').slice(0, 3).join(' ')}`);
    }
  }
  record(
    'JavaScript syntax',
    failures.length === 0,
    failures.length ? failures.join('\n') : `${files.length} project files parsed; generated dependency trees were skipped.`
  );
}

function quotedValues(block) {
  return new Set([...block.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]));
}

function setFromPreload(source, name) {
  const block = source.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  if (!block) throw new Error(`preload.cjs is missing ${name}.`);
  return quotedValues(block[1]);
}

function checkMarkup() {
  const dashboard = fs.readFileSync(path.join(root, 'renderer', 'settings.html'), 'utf8');
  const overlay = fs.readFileSync(path.join(root, 'renderer', 'overlay.html'), 'utf8');
  const dashboardIds = [
    'page-dashboard', 'page-insights', 'page-history', 'page-dictation', 'page-agent',
    'page-apps', 'page-logs', 'page-settings', 'page-about', 'sideName', 'sideAvatar',
    'brandName', 'tierBadge', 'talkNow', 'userMenu', 'userDropdown', 'appStatus', 'appStatusText', 'toast', 'community'
  ];
  const overlayIds = ['notch'];
  const overlayAssets = ['overlay.js', 'overlay-extras.js', 'overlay-shell.css', 'overlay-extras.css', 'notch-kit.css', 'notch-kit.js'];
  const missing = [
    ...dashboardIds.filter((id) => !dashboard.includes(`id="${id}"`)).map((id) => `settings.html:${id}`),
    ...overlayIds.filter((id) => !overlay.includes(`id="${id}"`)).map((id) => `overlay.html:${id}`),
    ...overlayAssets.filter((file) => !overlay.includes(file)).map((file) => `overlay.html:${file}`)
  ];
  record(
    'Renderer markup',
    missing.length === 0,
    missing.length ? `Missing required elements: ${missing.join(', ')}` : `${dashboardIds.length} dashboard elements and the CSP-safe notch host are present.`
  );
}

function checkContentSecurityPolicy() {
  const files = ['settings.html', 'overlay.html', 'recorder.html'];
  const missing = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, 'renderer', file), 'utf8');
    if (!/http-equiv="Content-Security-Policy"/.test(source) || !/script-src 'self'/.test(source)) missing.push(file);
  }
  record(
    'Renderer content security policy',
    missing.length === 0,
    missing.length ? `Missing a restrictive CSP: ${missing.join(', ')}` : 'All three renderer documents restrict scripts to local files.'
  );
}

function checkToolSchema() {
  try {
    const { parseToolArguments } = require('./lib/tool-schema.cjs');
    const throws = (callback) => {
      try {
        callback();
        return false;
      } catch {
        return true;
      }
    };
    const cases = [
      ['valid text argument', parseToolArguments('type_text', '{"text":"hello"}').text === 'hello'],
      ['object argument accepted', parseToolArguments('remember_note', { note: 'Remember this' }).note === 'Remember this'],
      ['unknown argument rejected', throws(() => parseToolArguments('type_text', '{"text":"hi","extra":"no"}'))],
      ['missing argument rejected', throws(() => parseToolArguments('type_text', '{}'))],
      ['non-text argument rejected', throws(() => parseToolArguments('type_text', '{"text":42}'))],
      ['invalid JSON rejected', throws(() => parseToolArguments('type_text', '{not-json'))],
      ['oversized argument rejected', throws(() => parseToolArguments('type_text', JSON.stringify({
        text: 'x'.repeat(LIMITS.MAX_TOOL_ARGUMENT_CHARS + 1)
      })))],
      ['unknown action rejected', throws(() => parseToolArguments('run_anything', '{}'))],
      ['safe refresh accepts empty arguments', Object.keys(parseToolArguments('refresh_apps', '{}')).length === 0],
      ['safe refresh rejects extra arguments', throws(() => parseToolArguments('refresh_apps', '{"reason":"because"}'))]
    ];
    const failures = cases.filter(([, ok]) => !ok).map(([name]) => name);
    record(
      'Tool argument schema',
      failures.length === 0,
      failures.length ? `Failed: ${failures.join('; ')}` : `${cases.length} strict parsing cases passed.`
    );
  } catch (error) {
    record('Tool argument schema', false, error.stack || error.message);
  }
}

function checkLogRedaction() {
  try {
    const logger = require('./lib/logger.cjs');
    const source = 'Authorization: Bearer sk-abcdefgh12345678 api_key=mysecretvalue password=hunter2 oauth_token=abcd1234';
    const redacted = logger.redact(source);
    const leaked = ['sk-abcdefgh12345678', 'mysecretvalue', 'hunter2', 'abcd1234'].filter((value) => redacted.includes(value));
    record(
      'Log secret redaction',
      leaked.length === 0 && redacted.includes('[redacted'),
      leaked.length ? `Leaked: ${leaked.join(', ')}` : 'Bearer tokens, API keys, passwords, and auth tokens were redacted.'
    );
  } catch (error) {
    record('Log secret redaction', false, error.stack || error.message);
  }
}

function checkIpcPairs() {
  const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');
  const modules = ['lib/overlay.cjs', 'lib/recorder.cjs']
    .map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
    .join('\n');

  const invokeChannels = setFromPreload(preload, 'INVOKE_CHANNELS');
  const sendChannels = setFromPreload(preload, 'SEND_CHANNELS');
  const eventChannels = setFromPreload(preload, 'EVENT_CHANNELS');
  const syncChannels = new Set([...preload.matchAll(/ipcRenderer\.sendSync\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]));
  const handled = new Set([...main.matchAll(/\bhandle\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]));
  const listened = new Set([
    ...[...main.matchAll(/\blisten\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]),
    ...[...main.matchAll(/ipcMain\.on\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
  ]);
  const emitted = new Set([
    ...[...main.matchAll(/\b(?:sendToDashboard|sendToDashboardWhenReady|sendToPlayer|sendToOverlay|broadcast)\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]),
    ...[...`${main}\n${modules}`.matchAll(/\.webContents\.send\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]),
    ...[...modules.matchAll(/\bsend\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
  ]);

  const problems = [];
  for (const channel of invokeChannels) {
    if (!handled.has(channel)) problems.push(`invoke:${channel} has no main handler`);
  }
  for (const channel of handled) {
    if (!invokeChannels.has(channel)) problems.push(`main handler ${channel} is not exposed by preload`);
  }
  for (const channel of sendChannels) {
    if (!listened.has(channel)) problems.push(`send:${channel} has no main listener`);
  }
  for (const channel of syncChannels) {
    if (!listened.has(channel)) problems.push(`sendSync:${channel} has no main listener`);
  }
  for (const channel of listened) {
    if (!sendChannels.has(channel) && !syncChannels.has(channel)) problems.push(`main listener ${channel} is not exposed by preload`);
  }
  for (const channel of emitted) {
    if (!eventChannels.has(channel)) problems.push(`event:${channel} is emitted by main but absent from preload EVENT_CHANNELS`);
  }
  for (const channel of eventChannels) {
    if (!emitted.has(channel)) problems.push(`preload event ${channel} is never emitted by main`);
  }

  record(
    'IPC channel pairing',
    problems.length === 0,
    problems.length
      ? problems.join('\n')
      : `${invokeChannels.size} invoke, ${sendChannels.size + syncChannels.size} send, and ${eventChannels.size} event channels are paired.`
  );

  const roleScoped = /function senderRole\(event\)/.test(main)
    && /assertTrusted\(event, role\)/.test(main)
    && /\}, \['recorder'\]\)/.test(main)
    && /\['overlay', 'dashboard'\]/.test(main);
  record(
    'IPC renderer roles',
    roleScoped,
    roleScoped
      ? 'Dashboard invokes, overlay events, and recorder audio are scoped to their owning windows.'
      : 'One or more IPC paths are not restricted to the expected renderer window.'
  );

  const recorderNames = [
    ...fs.readFileSync(path.join(root, 'lib/recorder.cjs'), 'utf8')
      .matchAll(/send\(\s*['"]([^'"]+)['"]/g)
  ].map((match) => match[1]);
  record(
    'Recorder event names',
    recorderNames.length === 3 && recorderNames.every((name) => name.startsWith('recorder:')),
    recorderNames.join(', ')
  );

  const recorderPolicy = /setPermissionRequestHandler/.test(main)
    && /setPermissionCheckHandler/.test(main)
    && /backgroundThrottling\s*:\s*false/.test(main)
    && /persist:voxa-recorder/.test(main);
  record(
    'Recorder permission and throttling policy',
    recorderPolicy,
    recorderPolicy
      ? 'Media permissions are scoped to the recorder partition and background throttling is disabled.'
      : 'Recorder permission handlers, partition, or backgroundThrottling:false are missing.'
  );

  const trustworthy = /function trustedSender/.test(main)
    && /assertTrusted/.test(main)
    && /startsWith\('file:\/\/'\)/.test(main);
  record(
    'IPC sender validation',
    trustworthy,
    trustworthy ? 'Privileged handlers require a known local renderer.' : 'IPC sender allowlisting is missing.'
  );
}

function checkPermissionPolicy() {
  try {
    const custom = permissions.defaultCustomPermissions();
    custom.open_folders = true;
    const ask = { permissionMode: 'ask', permissionCustom: permissions.defaultCustomPermissions() };
    const routine = { permissionMode: 'routine', permissionCustom: permissions.defaultCustomPermissions() };
    const selected = { permissionMode: 'custom', permissionCustom: custom };
    const cases = [
      ['ask prompts for open_app', permissions.resolvePermission(ask, 'open_app').requiresApproval === true],
      ['routine allows open_app', permissions.resolvePermission(routine, 'open_app').requiresApproval === false],
      ['routine allows open_folder', permissions.resolvePermission(routine, 'open_folder').requiresApproval === false],
      ['routine allows open_file', permissions.resolvePermission(routine, 'open_file', { sensitiveKind: '' }).requiresApproval === false],
      ['routine allows read_file', permissions.resolvePermission(routine, 'read_file', { sensitiveKind: '' }).requiresApproval === false],
      ['routine allows browsing', permissions.resolvePermission(routine, 'open_url').requiresApproval === false],
      ['routine still asks for type_text', permissions.resolvePermission(routine, 'type_text').requiresApproval === true],
      ['routine still asks for press_keys', permissions.resolvePermission(routine, 'press_keys').requiresApproval === true],
      ['routine still asks for executables', permissions.resolvePermission(routine, 'open_file', { sensitiveKind: 'executable' }).requiresApproval === true],
      ['routine still asks for credentials', permissions.resolvePermission(routine, 'read_file', { sensitiveKind: 'credentials' }).requiresApproval === true],
      ['cloud file reads need approval', permissions.resolvePermission(routine, 'read_file', { sensitiveKind: '', cloudRead: true }).requiresApproval === true],
      ['unknown tools fail closed', permissions.resolvePermission(routine, 'unexpected_tool').requiresApproval === true
        && permissions.resolvePermission(routine, 'unexpected_tool').autoAllowed === false],
      ['safe app refresh never prompts', permissions.resolvePermission(ask, 'refresh_apps').requiresApproval === false],
      ['custom allows only selected categories', permissions.resolvePermission(selected, 'open_folder').requiresApproval === false
        && permissions.resolvePermission(selected, 'open_app').requiresApproval === true],
      ['custom cannot bypass sensitive actions', permissions.resolvePermission(selected, 'type_text').requiresApproval === true],
      ['legacy approval rules migrate to custom', (() => {
        const migrated = permissions.legacyPermissionSettings({ open_app: false, type_text: false });
        return migrated?.permissionMode === 'custom'
          && migrated.permissionCustom.launch_apps === true
          && migrated.permissionCustom.type_text === undefined;
      })()],
      ['executables and credentials are recognized', permissions.isExecutableFile('setup.exe')
        && permissions.isExecutableFile('script.ps1')
        && permissions.isSensitiveFileName('.env')
        && permissions.isSensitiveFileName('id_rsa')
        && permissions.isSensitiveFileName('private.pem')],
      ['duplicate actions share an approval key', permissions.actionFingerprint('open_app', '{"app":"Notepad"}')
        === permissions.actionFingerprint('open_app', ' { "app" : " notepad " } ')]
    ];
    const failures = cases.filter(([, ok]) => !ok).map(([name]) => name);
    record(
      'Permission policy',
      failures.length === 0,
      failures.length ? `Failed: ${failures.join('; ')}` : `${cases.length} mode, category, and sensitive-action cases passed.`
    );
  } catch (error) {
    record('Permission policy', false, error.stack || error.message);
  }
}

function formatReport(title) {
  const failed = results.filter((result) => !result.ok);
  const lines = [
    title,
    `Run at: ${new Date().toISOString()}`,
    '',
    'STATIC AND RUNTIME RESULTS',
    ...results.map((result) => {
      const detail = result.detail ? `\n    ${result.detail.replace(/\r?\n/g, '\n    ')}` : '';
      return `${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${detail}`;
    }),
    '',
    failed.length ? `${failed.length} of ${results.length} checks failed.` : `All ${results.length} checks passed.`
  ];
  const text = `${lines.join('\n')}\n`;
  fs.writeFileSync(reportPath, text, 'utf8');
  process.stdout.write(text);
  process.exitCode = failed.length ? 1 : 0;
  return failed.length;
}

function runRuntime() {
  let child = null;
  try {
    fs.rmSync(runtimePath, { force: true });
    const electronPath = require('electron');
    child = spawnSync(electronPath, ['.', '--selftest-worker'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 600000,
      env: { ...process.env, VOXA_SELFTEST_OUTPUT: runtimePath },
      windowsHide: false
    });
    if (!fs.existsSync(runtimePath)) {
      const output = `${child.error?.message || ''}\n${child.stdout || ''}\n${child.stderr || ''}`.trim();
      record(
        'Electron runtime checks',
        false,
        (output || `Electron exited with code ${child.status} without writing a report.`).slice(-5000)
      );
      return;
    }
    const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    if (!Array.isArray(runtime)) throw new Error('The runtime report is not an array.');
    for (const result of runtime) {
      if (!result || typeof result.name !== 'string') continue;
      record(result.name, result.ok, result.detail);
    }
    if (!runtime.length) record('Electron runtime checks', false, 'The runtime report was empty.');
  } catch (error) {
    record('Electron runtime checks', false, error.message);
  } finally {
    fs.rmSync(runtimePath, { force: true });
  }
}

function checkTtsNormaliser() {
  try {
    const { normaliseForSpeech } = require('./lib/tts-text.cjs');
    const cases = [
      // Strip markdown headings
      ['heading', normaliseForSpeech('## Hello world'), 'Hello world'],
      // Strip bold emphasis
      ['bold', normaliseForSpeech('This is **important** text'), 'This is important text'],
      // Fenced code block → "code block"
      ['code block', normaliseForSpeech('Run this:\n```js\nconsole.log(1);\n```\nDone.'), (r) => r.includes('code block') && !r.includes('console')],
      // Inline code → unwrap
      ['inline code', normaliseForSpeech('Use `npm install` here'), (r) => r.includes('npm install') && !r.includes('`')],
      // URL → domain only
      ['url domain', normaliseForSpeech('See https://example.com/path?q=1 for details'), (r) => r.includes('example.com') && !r.includes('/path')],
      // Emoji removed
      ['emoji', normaliseForSpeech('Hello 😊 world 🎉'), (r) => !r.includes('😊') && !r.includes('🎉') && r.includes('Hello') && r.includes('world')],
      // Rupee currency
      ['rupee', normaliseForSpeech('Price: ₹1,250'), (r) => r.includes('rupee') && (r.includes('thousand') || r.includes('one thousand'))],
      // Dollar currency
      ['dollar', normaliseForSpeech('Cost $5'), (r) => r.includes('dollar')],
      // Percentage
      ['percent', normaliseForSpeech('95% complete'), (r) => r.includes('percent') && !r.includes('%')],
      // Number spoken
      ['number', normaliseForSpeech('There are 42 items'), (r) => r.includes('forty') && !r.includes('42')],
      // Hindi danda — passes through normaliser intact (it's a segmenter concern)
      ['hindi danda', normaliseForSpeech('नमस्ते। कैसे हो।'), (r) => typeof r === 'string' && r.length > 0],
      // Bullet list — strip marker, keep text
      ['bullets', normaliseForSpeech('- First item\n- Second item'), (r) => r.includes('First item') && !r.includes('- ')],
    ];
    const failures = [];
    for (const [name, result, expected] of cases) {
      const ok = typeof expected === 'function' ? expected(result) : result.trim() === expected;
      if (!ok) failures.push(`${name}: got "${String(result).slice(0, 80)}"`);
    }
    record(
      'TTS normaliser',
      failures.length === 0,
      failures.length ? failures.join('; ') : `${cases.length} normalisation cases passed.`
    );
  } catch (error) {
    record('TTS normaliser', false, error.stack || error.message);
  }
}

function checkTtsSegmenter() {
  try {
    const { segmentSentences } = require('./lib/tts-text.cjs');
    const cases = [
      // Basic multi-sentence
      ['basic split', segmentSentences('Hello world. How are you? Fine!'), (r) => r.length === 3],
      // Abbreviation protection: "Dr." must not split
      ['abbreviation', segmentSentences('Dr. Smith went to the store.'), (r) => r.length === 1],
      // Decimal protection: "3.14" must not split
      ['decimal', segmentSentences('Pi is 3.14 exactly.'), (r) => r.length === 1],
      // Ellipsis treated as one terminator
      ['ellipsis', segmentSentences('Wait... then proceed.'), (r) => r.length >= 1 && r.every((s) => s.length > 0)],
      // Hindi danda treated as terminator
      ['danda', segmentSentences('नमस्ते। मैं ठीक हूँ।'), (r) => r.length >= 1],
      // Quoted sentence: "She said 'hello.' He left." → split after closing quote
      ['quoted', segmentSentences('She said "hello." He left.'), (r) => r.length === 2],
      // List item (no bullet, just text with periods)
      ['list item', segmentSentences('Item one. Item two. Item three.'), (r) => r.length === 3],
      // Overlong sentence at comma (~200 chars)
      ['overlong', segmentSentences('This is a very long sentence that goes on and on and on, and it keeps going and going and going, and eventually it becomes quite long indeed, and then it splits here, because it has now exceeded the two-hundred character limit.'), (r) => r.length >= 2],
      // Empty string
      ['empty', segmentSentences(''), (r) => r.length === 0],
      // Single word (no terminator)
      ['single word', segmentSentences('Hello'), (r) => r.length === 1 && r[0] === 'Hello'],
    ];
    const failures = [];
    for (const [name, result, check] of cases) {
      const ok = check(result);
      if (!ok) failures.push(`${name}: got ${JSON.stringify(result).slice(0, 120)}`);
    }
    record(
      'TTS segmenter',
      failures.length === 0,
      failures.length ? failures.join('; ') : `${cases.length} segmentation cases passed.`
    );
  } catch (error) {
    record('TTS segmenter', false, error.stack || error.message);
  }
}

function checkTtsSettings() {
  try {
    const { defaults } = require('./lib/constants.cjs');
    const base = defaults('TestUser');
    const required = ['ttsEngine', 'ttsVoice', 'ttsSpeed', 'ttsVolume', 'ttsGpu', 'ttsAutoVoice', 'ttsTier', 'ttsModelVariant', 'ttsBatterySaver'];
    const missing = required.filter((key) => !(key in base));
    const validEngine = base.ttsEngine === 'kokoro' || base.ttsEngine === 'windows';
    const validSpeed = typeof base.ttsSpeed === 'number' && base.ttsSpeed >= 0.7 && base.ttsSpeed <= 1.4;
    const validVolume = typeof base.ttsVolume === 'number' && base.ttsVolume >= 0 && base.ttsVolume <= 1;
    const validVariant = base.ttsModelVariant === 'quantized';
    const failures = [
      ...missing.map((k) => `missing default: ${k}`),
      ...(!validEngine ? ['ttsEngine must be kokoro or windows'] : []),
      ...(!validSpeed ? [`ttsSpeed out of range: ${base.ttsSpeed}`] : []),
      ...(!validVolume ? [`ttsVolume out of range: ${base.ttsVolume}`] : []),
      ...(!validVariant ? [`ttsModelVariant invalid: ${base.ttsModelVariant}`] : [])
    ];
    record(
      'TTS settings defaults',
      failures.length === 0,
      failures.length ? failures.join('; ') : `${required.length} TTS defaults present and valid.`
    );
  } catch (error) {
    record('TTS settings defaults', false, error.stack || error.message);
  }
}

function checkAsrSettings() {
  try {
    const { ASR_ENGINES, defaults } = require('./lib/constants.cjs');
    const { summarizeAsr } = require('./lib/asr-health.cjs');
    const base = defaults('TestUser');
    const required = ['asrEngine', 'asrDevice', 'asrComputeType', 'asrLanguage', 'asrWordTimestamps', 'asrVad', 'asrChunkSeconds'];
    const missing = required.filter((key) => !(key in base));
    const ids = ASR_ENGINES.map((engine) => engine.id);
    const failures = [
      ...missing.map((key) => `missing default: ${key}`),
      ...(Number(base.settingsVersion) < 8 ? [`settingsVersion is ${base.settingsVersion}, expected 8+`] : []),
      ...(base.asrEngine !== 'whisper' ? [`asrEngine default is ${base.asrEngine}, expected whisper`] : []),
      ...(base.asrLanguage !== 'en' ? [`asrLanguage default is ${base.asrLanguage || '(blank)'}, expected en`] : []),
      ...(new Set(ids).size !== ids.length ? ['ASR engine ids are not unique'] : []),
      ...(ids[0] !== 'whisper' ? ['Whisper is not the first ASR engine'] : []),
      ...(!ASR_ENGINES.find((engine) => engine.id === 'whisper')?.languageHint ? ['Whisper does not advertise a language hint'] : []),
      ...(!ASR_ENGINES.find((engine) => engine.id === 'qwen3-asr-1.7b')?.languageHint ? ['Qwen3-ASR does not advertise a language hint'] : []),
      ...(ASR_ENGINES.find((engine) => engine.id === 'parakeet-tdt-0.6b-v3')?.languageHint === true ? ['Parakeet must not advertise a language hint'] : []),
      ...(ASR_ENGINES.find((engine) => engine.id === 'granite-speech-5.0-470m-turboctc')?.languageHint === true ? ['Granite must not advertise a language hint'] : []),
      ...(!['auto', 'cpu', 'cuda'].includes(base.asrDevice) ? [`invalid asrDevice: ${base.asrDevice}`] : []),
      ...(!['auto', 'float32', 'float16', 'bfloat16'].includes(base.asrComputeType) ? [`invalid asrComputeType: ${base.asrComputeType}`] : []),
      ...(!Number.isFinite(base.asrChunkSeconds) || base.asrChunkSeconds < 1 || base.asrChunkSeconds > 120 ? [`asrChunkSeconds out of range: ${base.asrChunkSeconds}`] : []),
      ...(typeof base.asrWordTimestamps !== 'boolean' || typeof base.asrVad !== 'boolean' ? ['ASR toggles are not boolean'] : [])
    ];
    record(
      'ASR settings defaults',
      failures.length === 0,
      failures.length ? failures.join('; ') : `${required.length} ASR settings present; ${ASR_ENGINES.length} engines with a unique catalog.`
    );

    const summary = summarizeAsr({
      engineId: 'parakeet-tdt-0.6b-v3',
      running: true,
      status: {
        status: 'ready',
        active_model: 'parakeet-tdt-0.6b-v3',
        available: true,
        capabilities: { token_timestamps: true, word_timestamps: false }
      }
    });
    const healthOk = summary.status === 'ready'
      && summary.capabilities.token_timestamps === true
      && summary.capabilities.word_timestamps === false
      && !Object.hasOwn(summary, 'words')
      && !Object.hasOwn(summary, 'tokens')
      && !Object.hasOwn(summary, 'segments');
    record(
      'ASR health normalization',
      healthOk,
      healthOk
        ? 'Ready state preserves native token timing and never invents word or segment timestamps.'
        : `Unexpected ASR summary: ${JSON.stringify(summary).slice(0, 500)}`
    );
  } catch (error) {
    record('ASR settings defaults', false, error.stack || error.message);
    record('ASR health normalization', false, error.stack || error.message);
  }
}

function checkIslandDownload() {
  try {
    const {
      whisperIslandDownload,
      whisperStartingIslandDownload,
      kokoroIslandDownload,
      ollamaIslandDownload
    } = require('./lib/island-download.cjs');
    // Real payload shapes, as produced by each service.
    const whisperDownloading = whisperIslandDownload({
      ok: false, switching: true, status: 'downloading',
      targetModel: 'medium',
      progress: { model: 'medium', status: 'downloading', downloadedBytes: 615_089_400, totalBytes: 1_464_072_658, percent: 42, speedBps: 2_517_819, stalled: false, error: '' }
    });
    const whisperLoading = whisperIslandDownload({
      switching: true, status: 'loading', targetModel: 'small', progress: null
    });
    const whisperIdle = whisperIslandDownload({
      ok: true, switching: false, status: 'ready', model: 'small', progress: null
    });
    const whisperMismatch = whisperIslandDownload({
      ok: false, switching: false, status: 'mismatch', activeModel: 'tiny', selectedModel: 'medium'
    });
    const starting = whisperStartingIslandDownload('medium');
    const startingUnknown = whisperStartingIslandDownload('');
    const kokoroDownloading = kokoroIslandDownload({
      status: 'downloading', modelReady: false, hasConsent: true, variant: 'quantized',
      progress: { percent: 7, totalBytes: 86_840_000, downloadedBytes: 6_078_800 }
    });
    const kokoroReady = kokoroIslandDownload({ status: 'downloaded', modelReady: true, hasConsent: true, variant: 'quantized' });
    const ollamaPull = ollamaIslandDownload({ status: 'pulling', completed: 9_900_000, total: 10_000_000, percent: 99 }, 'qwen3:8b');
    const ollamaNoPercent = ollamaIslandDownload({ status: 'pulling sha256:abcd', completed: 0, total: 0, percent: null }, 'qwen3:8b');
    const ollamaSuccess = ollamaIslandDownload({ status: 'success', completed: 10, total: 10, percent: 100 }, 'qwen3:8b');
    const overOneHundred = kokoroIslandDownload({ status: 'downloading', variant: 'quantized', progress: { percent: 182 } });
    const longLabel = kokoroIslandDownload({ status: 'downloading', variant: 'pack'.repeat(60), progress: { percent: 1 } });
    // Pill layer: lib/overlay.cjs normalizes again on every state change; the
    // same null-percent rule and clamp must hold there (Number(null) trap).
    const pill = require('./lib/overlay.cjs').createOverlay({ log: null });
    const pillNullPercent = pill.setDownload({ phase: 'loading', label: 'Whisper · small', percent: null }).download;
    const pillClamped = pill.setDownload({ phase: 'downloading', label: 'Whisper · tiny', percent: 412 }).download;
    const pillCleared = pill.setDownload(null).download;
    const cases = [
      ['whisper downloading', whisperDownloading && whisperDownloading.phase === 'downloading' && whisperDownloading.percent === 42 && whisperDownloading.label === 'Whisper · medium'],
      ['whisper loading', whisperLoading && whisperLoading.phase === 'loading' && whisperLoading.percent === null && whisperLoading.label === 'Whisper · small'],
      ['whisper idle', whisperIdle === null],
      ['whisper mismatch', whisperMismatch === null],
      ['whisper starting', starting && starting.phase === 'starting' && starting.percent === null],
      ['whisper starting unknown model', startingUnknown === null],
      ['kokoro downloading', kokoroDownloading && kokoroDownloading.percent === 7 && kokoroDownloading.label === 'Voice · quantized'],
      ['kokoro ready', kokoroReady === null],
      ['ollama pulling percent', ollamaPull && ollamaPull.percent === 99 && ollamaPull.label === 'Ollama · qwen3:8b'],
      ['ollama no percent yet', ollamaNoPercent && ollamaNoPercent.percent === null],
      ['ollama success clears', ollamaSuccess === null],
      ['percent clamps at 100', overOneHundred && overOneHundred.percent === 100],
      ['label capped at 60 chars', longLabel && longLabel.label.length === 60],
      ['pill layer keeps null percent', pillNullPercent && pillNullPercent.percent === null],
      ['pill layer clamps percent', pillClamped && pillClamped.percent === 100],
      ['pill layer clears download', pillCleared === null]
    ];
    const failures = cases.filter(([name, ok]) => !ok).map(([name]) => name);
    record(
      'Island download mapping',
      failures.length === 0,
      failures.length ? `failed: ${failures.join('; ')}` : `${cases.length} real-payload mapping cases passed.`
    );
  } catch (error) {
    record('Island download mapping', false, error.stack || error.message);
  }
}

function checkIslandDwell() {
  try {
    const constants = require('./lib/constants.cjs');
    const store = require('./lib/store.cjs');
    const base = constants.defaults('TestUser');
    const current = { dictationHotkey: 'Ctrl+Q', agentHotkey: 'Alt+Q' };
    let failures = [];
    for (const [key, options] of Object.entries(constants.ISLAND_DWELL_OPTIONS)) {
      if (!options.includes(base[key])) failures.push(`${key} default ${base[key]} is not a whitelisted option`);
      const viaPatch = store.sanitizeSettingsPatch({ [key]: options[options.length - 1] }, current, () => true);
      if (viaPatch[key] !== options[options.length - 1]) failures.push(`${key} valid option ${options[options.length - 1]} was not kept`);
      let rejected = 0;
      const bad = [0, '8', options[options.length - 1] + 1, null];
      for (const candidate of bad) {
        try {
          store.sanitizeSettingsPatch({ [key]: candidate }, current, () => true);
        } catch {
          rejected += 1;
        }
      }
      if (rejected !== bad.length) failures.push(`${key} accepted a non-whitelisted value`);
    }
    // Use sites: the knobs must actually drive the pill dwells, not just persist.
    const main = require('node:fs').readFileSync(require('node:path').join(__dirname, 'main.cjs'), 'utf8');
    const wired = [
      ['feedToastSeconds', /scheduleOverlayHide\(settings\.feedToastSeconds \* 1000\)/],
      ['feedDwellSeconds', /scheduleOverlayHide\(settings\.feedDwellSeconds \* 1000\)/],
      ['mediaSnoozeMinutes', /mediaSnoozeUntil = Date\.now\(\) \+ settings\.mediaSnoozeMinutes \* 60000/]
    ];
    for (const [key, pattern] of wired) {
      if (!pattern.test(main)) failures.push(`${key} never reaches its use site in main.cjs`);
    }
    record(
      'Island dwell settings',
      failures.length === 0,
      failures.length ? failures.join('; ') : `${Object.keys(constants.ISLAND_DWELL_OPTIONS).length} dwell knobs validated end-to-end (defaults, whitelist save, use site).`
    );
  } catch (error) {
    record('Island dwell settings', false, error.stack || error.message);
  }
}

function run() {
  checkJavaScript();
  checkMarkup();
  checkContentSecurityPolicy();
  checkIpcPairs();
  checkPermissionPolicy();
  checkToolSchema();
  checkLogRedaction();
  checkTtsNormaliser();
  checkTtsSegmenter();
  checkIslandDownload();
  checkIslandDwell();
  checkTtsSettings();
  checkAsrSettings();
  if (process.argv.includes('--static-only')) {
    record('Runtime checks', true, 'Skipped because --static-only was requested.');
    formatReport('Voxa static self-test report');
    return;
  }
  runRuntime();
  formatReport('Voxa self-test report');
}

try {
  run();
} catch (error) {
  record('Self-test harness', false, error.stack || error.message);
  formatReport('Voxa self-test report');
}
