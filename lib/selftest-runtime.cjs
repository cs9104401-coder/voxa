'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const { LIMITS, TOOL_DEFINITIONS, APPROVABLE_TOOLS } = require('./constants.cjs');
const { parseHotkey } = require('./hotkeys.cjs');
const { createApprovalGate } = require('./approval.cjs');
const { runAgentLoop } = require('./agent-loop.cjs');
const desktop = require('./desktop.cjs');
const { normalizeProviderUrl, sanitizeSettingsPatch } = require('./store.cjs');

const RESULTS = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitsFor(promise, timeout = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Approval did not settle.')), timeout);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function errorText(error) {
  return String(error?.message || error || 'Unknown error').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

function record(name, ok, detail = '') {
  RESULTS.push({ name, ok: Boolean(ok), detail: String(detail).replace(/\r?\n/g, ' ').slice(0, 2000) });
}

async function waitForRenderer(window, expression, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    if (!window || window.isDestroyed()) throw new Error('The window closed before it finished loading.');
    try {
      const value = await window.webContents.executeJavaScript(expression, true);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(120);
  }
  throw new Error(lastError ? errorText(lastError) : 'The renderer did not become ready in time.');
}

function consoleDetails(args) {
  if (args[0] && typeof args[0] === 'object' && ('level' in args[0] || 'message' in args[0])) {
    return { level: args[0].level, message: args[0].message };
  }
  return { level: args[0], message: args[1] };
}

function attachConsoleErrors(window, errors) {
  const handler = (_event, ...args) => {
    const { level, message } = consoleDetails(args);
    const numeric = typeof level === 'number'
      ? level
      : ({ verbose: 0, info: 1, warning: 2, error: 3 }[level] ?? 0);
    if (numeric >= 3) errors.push(String(message || 'Renderer console error'));
  };
  window.webContents.on('console-message', handler);
  return () => {
    if (!window.isDestroyed()) window.webContents.removeListener('console-message', handler);
  };
}

function powershellPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function createSpeechSample(app) {
  const directory = fs.mkdtempSync(path.join(app.getPath('temp'), 'voxa-selftest-'));
  const wav = path.join(directory, 'sample.wav');
  const escaped = wav.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Speech',
    '$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$voice.SetOutputToWaveFile('" + escaped + "')",
    "$voice.Speak('Voxa self test, one two three.')",
    '$voice.Dispose()'
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    await execFileAsync(powershellPath(), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded
    ], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const audio = fs.readFileSync(wav);
    if (audio.length < 1000) throw new Error('The generated speech sample was empty.');
    return { audio, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function checkMicrophones(queueRecorderOperation, recorderRequest) {
  try {
    const microphones = await queueRecorderOperation(() => recorderRequest('enumerate', {}, 20000));
    if (!Array.isArray(microphones)) throw new Error('The recorder returned an invalid device list.');
    record(
      'Microphone enumeration',
      microphones.length > 0,
      microphones.length ? microphones.map((item) => item.label || item.id).join(', ') : 'No audio input devices were found.'
    );
    return microphones;
  } catch (error) {
    record('Microphone enumeration', false, errorText(error));
    return [];
  }
}

async function checkNotch({ overlay, screen }) {
  try {
    const window = overlay.getWindow();
    if (!window || window.isDestroyed()) throw new Error('The notch window was not created.');
    overlay.show({
      status: 'listening',
      mode: 'agent',
      message: 'Voxa self-test notch',
      approval: null,
      canCopy: false
    });
    const rendered = await waitForRenderer(window, `(() => {
      const notch = document.querySelector('#notch');
      if (!notch) return null;
      return {
        visible: notch.dataset.visible === 'true',
        state: notch.dataset.state,
        text: document.querySelector('#cardText')?.innerText || ''
      };
    })()`, 10000);
    await sleep(250);
    const measured = await window.webContents.executeJavaScript(`(() => {
      const notch = document.querySelector('#notch');
      const rect = notch.getBoundingClientRect();
      return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
    })()`, true);
    const bounds = window.getBounds();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const expectedX = display.workArea.x + (display.workArea.width - bounds.width) / 2;
    const centered = Math.abs(bounds.x - expectedX) <= 2;
    const fits = bounds.width >= 320 && bounds.width <= 720 && bounds.height >= 96 && bounds.height <= 560;
    record(
      'Notch renderer',
      rendered.visible && rendered.state === 'listening' && /self-test/i.test(rendered.text),
      `state=${rendered.state}; text=${rendered.text.slice(0, 120)}`
    );
    record(
      'Notch bounds',
      fits && centered && measured.width > 0,
      `window=${bounds.width}x${bounds.height} at (${bounds.x},${bounds.y}); content=${measured.width}x${measured.height}; display=${display.workArea.width}x${display.workArea.height}`
    );
    const focusable = typeof window.isFocusable === 'function' ? window.isFocusable() : null;
    record(
      'Notch window behavior',
      window.isAlwaysOnTop() && focusable === false,
      `alwaysOnTop=${window.isAlwaysOnTop()}; focusable=${focusable}`
    );
    overlay.hideNow();
    await sleep(180);
    record('Notch hide', !overlay.getWindow()?.isVisible(), 'The notch window is hidden again.');
  } catch (error) {
    record('Notch renderer', false, errorText(error));
  }
}

async function checkDashboard({ getDashboard }) {
  const dashboard = getDashboard();
  if (!dashboard || dashboard.isDestroyed()) {
    record('Dashboard renderer', false, 'The dashboard window was not created.');
    return;
  }
  const consoleErrors = [];
  const detach = attachConsoleErrors(dashboard, consoleErrors);
  try {
    await waitForRenderer(dashboard, `Boolean(
      window.voiceAgent
      && typeof window.voiceAgent.getState === 'function'
      && document.querySelectorAll('.nav-item[data-page]').length >= 7
      && document.querySelector('#page-dashboard')?.innerHTML.length > 0
    )`, 25000);
    const state = await dashboard.webContents.executeJavaScript('window.voiceAgent.getState()', true);
    record(
      'Dashboard preload bridge',
      Boolean(state?.settings && Array.isArray(state.turns) && state.keyStatus),
      `app=${state?.appName || 'unknown'}; provider=${state?.settings?.chatProvider || 'unknown'}; hotkey=${state?.hotkey?.mode || 'unknown'}`
    );
    await dashboard.webContents.executeJavaScript(`(() => {
      window.__voxaSelftestErrors = [];
      window.addEventListener('error', (event) => {
        window.__voxaSelftestErrors.push(String(event.message || 'window error'));
      });
      window.addEventListener('unhandledrejection', (event) => {
        window.__voxaSelftestErrors.push(String(event.reason?.message || event.reason || 'unhandled rejection'));
      });
      return true;
    })()`, true);
    consoleErrors.length = 0;
    const pages = ['dashboard', 'insights', 'history', 'dictation', 'agent', 'apps', 'logs', 'settings', 'about'];
    for (const page of pages) {
      try {
        await dashboard.webContents.executeJavaScript(`(() => {
          if (typeof nav === 'function') nav(${JSON.stringify(page)}, true);
          else {
            const button = document.querySelector('[data-page="' + ${JSON.stringify(page)} + '"]');
            if (button) button.click();
            else {
              const menu = document.querySelector('[data-menu="' + ${JSON.stringify(page)} + '"]');
              if (menu) menu.click();
            }
          }
          return true;
        })()`, true);
        await sleep(page === 'dictation' ? 600 : 160);
        const result = await dashboard.webContents.executeJavaScript(`(() => {
          const active = document.querySelector('.page.active');
          return { id: active?.id || '', text: active?.innerText || '' };
        })()`, true);
        record(
          `Dashboard page: ${page}`,
          result.id === `page-${page}` && result.text.trim().length > 0,
          `active=${result.id || 'none'}; textLength=${result.text.trim().length}`
        );
      } catch (error) {
        record(`Dashboard page: ${page}`, false, errorText(error));
      }
    }
    const filterState = await dashboard.webContents.executeJavaScript(`(async () => {
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      nav('history', true);
      await pause(220);
      const historySearch = document.querySelector('#historySearch');
      if (!historySearch) return { error: 'history search missing' };
      historySearch.focus();
      historySearch.value = 'zzzz-no-matching-turn';
      historySearch.dispatchEvent(new Event('input', { bubbles: true }));
      await pause(260);
      const history = {
        active: document.querySelector('.page.active')?.id,
        focused: document.activeElement === historySearch,
        value: historySearch.value,
        text: document.querySelector('#historyResults')?.innerText || ''
      };
      historySearch.value = '';
      historySearch.dispatchEvent(new Event('input', { bubbles: true }));

      nav('logs', true);
      await pause(220);
      const logFilter = document.querySelector('#logFilter');
      if (!logFilter) return { error: 'log filter missing' };
      logFilter.focus();
      logFilter.value = 'zzzz-no-matching-log';
      logFilter.dispatchEvent(new Event('input', { bubbles: true }));
      await pause(160);
      const logs = {
        active: document.querySelector('.page.active')?.id,
        focused: document.activeElement === logFilter,
        value: logFilter.value,
        text: document.querySelector('#logsPage')?.textContent || ''
      };
      logFilter.value = '';
      logFilter.dispatchEvent(new Event('input', { bubbles: true }));
      return { history, logs };
    })()`, true);
    record(
      'Live filters keep focus',
      !filterState.error && filterState.history.active === 'page-history' && filterState.history.focused
        && filterState.history.value === 'zzzz-no-matching-turn' && !filterState.logs.text.trim()
        && filterState.logs.active === 'page-logs' && filterState.logs.focused
        && filterState.logs.value === 'zzzz-no-matching-log',
      filterState.error || `history=${filterState.history.active}/${filterState.history.focused}; logs=${filterState.logs.active}/${filterState.logs.focused}; logText=${filterState.logs.text.length}`
    );

    await dashboard.webContents.executeJavaScript(`(() => {
      if (typeof nav === 'function') nav('agent', true);
      return true;
    })()`, true);
    await sleep(180);
    const permissionUi = await dashboard.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('#permissionMode');
      return {
        select: Boolean(select),
        options: select ? select.options.length : 0,
        custom: document.querySelectorAll('[data-permission]').length,
        reset: Boolean(document.querySelector('[data-action="reset-permissions"]'))
      };
    })()`, true);
    record(
      'Permission mode UI',
      permissionUi.select && permissionUi.options === 3 && permissionUi.custom >= 6 && permissionUi.reset,
      `select=${permissionUi.select}; options=${permissionUi.options}; customSwitches=${permissionUi.custom}; reset=${permissionUi.reset}`
    );
    await dashboard.webContents.executeJavaScript('typeof nav === "function" ? nav("dashboard", true) : true', true);
    await sleep(250);
    const pageErrors = await dashboard.webContents.executeJavaScript('window.__voxaSelftestErrors || []', true);
    const problems = [...consoleErrors, ...pageErrors].map((item) => String(item).slice(0, 300));
    record(
      'Dashboard console',
      problems.length === 0,
      problems.length ? problems.join(' | ') : 'No console errors or unhandled rejections while opening all pages.'
    );
  } catch (error) {
    record('Dashboard renderer', false, errorText(error));
  } finally {
    detach();
  }
}

async function runRuntimeSelfTest(context) {
  const {
    app, logger, settings, services, overlay, screen, getDashboard,
    queueRecorderOperation, recorderRequest, healthChecks, ensureWhisper, WHISPER_PORT, hotkeys
  } = context;
  const output = process.env.VOXA_SELFTEST_OUTPUT;

  try {
    record(
      'Settings and shortcuts',
      Boolean(settings?.providers?.local && settings?.dictationHotkey && settings?.agentHotkey),
      `mode=${settings?.mode}; localModel=${settings?.providers?.local?.model}; dictation=${settings?.dictationHotkey}; agent=${settings?.agentHotkey}`
    );
    let parserOk = false;
    try {
      const values = ['Ctrl+Space', 'Alt+Q', 'F9', 'Shift+F12'].map((value) => parseHotkey(value).display);
      parserOk = values.every(Boolean) && (() => {
        try {
          parseHotkey('Alt+Ctrl');
          return false;
        } catch {
          return true;
        }
      })();
    } catch {
      parserOk = false;
    }
    record('Hotkey parser', parserOk, parserOk ? 'Modifier, digit, letter, function, and invalid-input cases passed.' : 'One or more shortcut parsing cases failed.');

    try {
      const gate = createApprovalGate();
      const allowedDecision = gate.request('allow-1', 'turn-1');
      const allowedHandled = gate.respond('allow-1', true);
      const allowed = await waitsFor(allowedDecision);
      const deniedDecision = gate.request('deny-1', 'turn-1');
      const deniedHandled = gate.respond('deny-1', false);
      const denied = await waitsFor(deniedDecision);
      const staleDecision = gate.request('live-1', 'turn-1');
      const staleHandled = gate.respond('stale-1', true);
      const liveHandled = gate.respond('live-1', true);
      const live = await waitsFor(staleDecision);
      record(
        'Approval gate decisions',
        allowedHandled && allowed === true && deniedHandled && denied === false
          && !staleHandled && liveHandled && live === true,
        `allow=${allowed}; deny=${denied}; staleRespond=${staleHandled}; liveRespond=${liveHandled}; live=${live}`
      );

      const supersededDecision = gate.request('superseded-1', 'turn-1');
      const currentDecision = gate.request('current-1', 'turn-1');
      const superseded = await waitsFor(supersededDecision);
      const currentHandled = gate.respond('current-1', true);
      const current = await waitsFor(currentDecision);
      const cancelledDecision = gate.request('cancel-1', 'turn-2');
      const cancelHandled = gate.cancelTurn('turn-2');
      const cancelled = await waitsFor(cancelledDecision);
      record(
        'Approval gate lifecycle',
        superseded === false && currentHandled && current === true && cancelHandled && cancelled === false,
        `superseded=${superseded}; current=${current}; cancel=${cancelled}`
      );
    } catch (error) {
      record('Approval gate decisions', false, errorText(error));
      record('Approval gate lifecycle', false, errorText(error));
    }

    try {
      const timedGate = createApprovalGate({ timeoutMs: 40 });
      const timedDecision = timedGate.request('timeout-1', 'turn-timeout');
      const timed = await waitsFor(timedDecision);
      record(
        'Approval timeout',
        timed === false && !timedGate.current(),
        `timedOutResponse=${timed}; pending=${Boolean(timedGate.current())}`
      );
    } catch (error) {
      record('Approval timeout', false, errorText(error));
    }

    try {
      let round = 0;
      const executed = [];
      const messages = [{ role: 'user', content: 'Open the site.' }];
      const normal = await runAgentLoop({
        messages,
        maxRounds: 3,
        maxToolCalls: 4,
        maxConsecutiveFailures: 2,
        timeoutMs: 3000,
        messageToText: (message) => message?.content || '',
        callModel: async () => {
          round += 1;
          if (round === 1) {
            return {
              content: '',
              tool_calls: [{
                id: 'call-selftest',
                function: { name: 'open_url', arguments: '{"url":"https://example.com"}' }
              }]
            };
          }
          return { content: 'Finished.', tool_calls: [] };
        },
        executeTool: async (call) => {
          executed.push(call.function.name);
          return { ok: true, message: 'Opened.' };
        }
      });
      record(
        'Agent loop rounds',
        normal.content === 'Finished.' && normal.toolCalls === 1 && executed.length === 1
          && messages.some((message) => message.role === 'tool'),
        `content=${normal.content}; rounds=${normal.rounds}; toolCalls=${normal.toolCalls}; executed=${executed.join(',')}`
      );

      let failures = 0;
      let failureStopped = false;
      try {
        await runAgentLoop({
          messages: [{ role: 'user', content: 'Loop forever.' }],
          maxRounds: 4,
          maxToolCalls: 6,
          maxConsecutiveFailures: 2,
          timeoutMs: 3000,
          messageToText: (message) => message?.content || '',
          callModel: async () => ({
            content: '',
            tool_calls: [{ id: `fail-${failures}`, function: { name: 'open_url', arguments: '{}' } }]
          }),
          executeTool: async () => {
            failures += 1;
            return { ok: false, error: 'Simulated failure.' };
          }
        });
      } catch (error) {
        failureStopped = /failed/i.test(error.message);
      }
      record(
        'Agent loop failure cap',
        failures === 2 && failureStopped,
        `failures=${failures}; stopped=${failureStopped}`
      );

      let timeoutCalled = 0;
      let timeoutCaught = false;
      try {
        await runAgentLoop({
          messages: [{ role: 'user', content: 'Wait forever.' }],
          maxRounds: 1,
          timeoutMs: 40,
          onTimeout: () => { timeoutCalled += 1; },
          messageToText: (message) => message?.content || '',
          callModel: () => new Promise((resolve) => setTimeout(() => resolve({ content: 'Late.', tool_calls: [] }), 250)),
          executeTool: async () => ({ ok: true })
        });
      } catch (error) {
        timeoutCaught = error.timeout === true;
      }
      record(
        'Agent loop timeout',
        timeoutCalled === 1 && timeoutCaught,
        `onTimeout=${timeoutCalled}; rejected=${timeoutCaught}`
      );
    } catch (error) {
      record('Agent loop rounds', false, errorText(error));
      record('Agent loop failure cap', false, errorText(error));
      record('Agent loop timeout', false, errorText(error));
    }

    try {
      let httpRejected = false;
      try {
        desktop.validUrl('http://example.com');
      } catch {
        httpRejected = true;
      }
      const https = desktop.validUrl('https://example.com/path?q=1');
      const utf16 = desktop.decodeTextBuffer(Buffer.from('Hello Voxa', 'utf16le'));
      const utf8 = desktop.decodeTextBuffer(Buffer.from('Hello Voxa', 'utf8'));
      record(
        'File and URL safety',
        httpRejected && https.startsWith('https://example.com/path') && utf16.text === 'Hello Voxa' && utf8.text === 'Hello Voxa',
        `httpRejected=${httpRejected}; utf16=${utf16.encoding}; utf8=${utf8.encoding}`
      );
    } catch (error) {
      record('File and URL safety', false, errorText(error));
    }

    try {
      const throws = (callback) => {
        try {
          callback();
          return false;
        } catch {
          return true;
        }
      };
      const isValidHotkey = () => true;
      const localFallbackRejected = throws(() => sanitizeSettingsPatch({ fallbackProvider: 'local' }, settings, isValidHotkey));
      const localSttRejected = throws(() => sanitizeSettingsPatch({ sttCloudProvider: 'local' }, settings, isValidHotkey));
      const unknownCategoryRejected = throws(() => sanitizeSettingsPatch({ permissionCustom: { open_nothing: true } }, settings, isValidHotkey));
      const httpCloudRejected = normalizeProviderUrl('openai', 'http://example.com') === null;
      const httpLocalProviderRejected = normalizeProviderUrl('local', 'http://example.com') === null;
      const httpsCloudAccepted = normalizeProviderUrl('openai', 'https://example.com/v1') === 'https://example.com/v1';
      const localhostHttpAccepted = normalizeProviderUrl('custom', 'http://localhost:31415/v1') === 'http://localhost:31415/v1';
      const loopbackHttpAccepted = normalizeProviderUrl('custom', 'http://127.0.0.1:31415/v1') === 'http://127.0.0.1:31415/v1';
      const ipv6LoopbackHttpAccepted = normalizeProviderUrl('custom', 'http://[::1]:31415/v1') === 'http://[::1]:31415/v1';
      const spoofedLoopbackRejected = normalizeProviderUrl('custom', 'http://127.0.0.1.evil.com/v1') === null;
      const localHttpAccepted = normalizeProviderUrl('local', 'http://127.0.0.1:11434') === 'http://127.0.0.1:11434';
      const customLocalPatch = sanitizeSettingsPatch({ providers: { custom: { url: 'http://127.0.0.1:31415/v1' } } }, settings, isValidHotkey);
      const customLocalSaved = customLocalPatch.providers?.custom?.url === 'http://127.0.0.1:31415/v1';
      const customSpoofRejected = throws(() => sanitizeSettingsPatch({ providers: { custom: { url: 'http://127.0.0.1.evil.com/v1' } } }, settings, isValidHotkey));
      record(
        'Settings security policy',
        localFallbackRejected && localSttRejected && unknownCategoryRejected
          && httpCloudRejected && httpLocalProviderRejected && httpsCloudAccepted
          && localhostHttpAccepted && loopbackHttpAccepted && ipv6LoopbackHttpAccepted
          && spoofedLoopbackRejected && localHttpAccepted && customLocalSaved && customSpoofRejected,
        `localFallback=${localFallbackRejected}; localStt=${localSttRejected}; unknownCategory=${unknownCategoryRejected}; httpCloudRejected=${httpCloudRejected}; httpLocalProviderRejected=${httpLocalProviderRejected}; httpsCloud=${httpsCloudAccepted}; localhostHttp=${localhostHttpAccepted}; loopbackHttp=${loopbackHttpAccepted}; ipv6LoopbackHttp=${ipv6LoopbackHttpAccepted}; spoofedLoopbackRejected=${spoofedLoopbackRejected}; localHttp=${localHttpAccepted}; customLocalSaved=${customLocalSaved}; customSpoofRejected=${customSpoofRejected}`
      );
    } catch (error) {
      record('Settings security policy', false, errorText(error));
    }

    const hook = hotkeys?.status?.() || {};
    record(
      'Native hotkey hook',
      Boolean(hook.active),
      hook.active ? `Listening for ${hook.bindings?.dictation?.display || 'dictation'} and ${hook.bindings?.agent?.display || 'agent'}.` : (hook.error || 'The native hook is not active.')
    );

    const toolNames = TOOL_DEFINITIONS.map((tool) => tool.name);
    const approvalsValid = APPROVABLE_TOOLS.length === toolNames.length - 1
      && APPROVABLE_TOOLS.every((name) => toolNames.includes(name))
      && !APPROVABLE_TOOLS.includes('refresh_apps');
    record(
      'Tool definitions',
      toolNames.length >= 8 && approvalsValid && LIMITS.MIN_HOLD_MS === 250 && LIMITS.TAIL_MS === 300,
      `${toolNames.length} tools; ${APPROVABLE_TOOLS.length} require approval; hold=${LIMITS.MIN_HOLD_MS}ms tail=${LIMITS.TAIL_MS}ms.`
    );

    await checkMicrophones(queueRecorderOperation, recorderRequest);

    try {
      const health = await healthChecks();
      record(
        'Ollama configured model',
        Boolean(health.ollama?.ok && health.ollama?.modelAvailable !== false),
        health.ollama?.message || health.ollama?.error || 'No Ollama detail returned.'
      );
      const selected = health.chat;
      record(
        'Agent provider health',
        Boolean(selected && selected.provider === settings.chatProvider && selected.model === settings.providers[settings.chatProvider]?.model),
        selected ? `provider=${selected.provider}; model=${selected.model}; ok=${selected.ok}; ${selected.message || ''}` : 'No selected-provider health detail returned.'
      );
    } catch (error) {
      record('Ollama configured model', false, errorText(error));
      record('Agent provider health', false, errorText(error));
    }

    const wasRunning = services.whisperStatus().running;
    let sample = null;
    try {
      sample = await createSpeechSample(app);
      const service = await ensureWhisper();
      record(
        'Whisper service',
        Boolean(service?.ok) && (!service.model || service.model === settings.whisperModel),
        service?.ok ? `model=${service.model || settings.whisperModel}; device=${service.device || settings.whisperDevice}` : (service?.error || 'Whisper did not become healthy.')
      );
      if (sample) {
        const result = await services.transcribe(
          `http://127.0.0.1:${WHISPER_PORT}`,
          sample.audio,
          'audio/wav',
          settings.whisperModel
        );
        record(
          'Whisper transcription',
          Boolean(result.text),
          result.text ? result.text.slice(0, 200) : 'The generated speech sample produced no transcript.'
        );
      }
    } catch (error) {
      record('Whisper service', false, errorText(error));
    } finally {
      sample?.cleanup();
      if (!wasRunning) services.stopWhisper();
    }

    await checkNotch({ overlay, screen });
    await checkDashboard({ getDashboard });

    try {
      await queueRecorderOperation(() => recorderRequest('monitor-stop', {}, 10000));
    } catch {
      // Stale monitor cleanup is best-effort; the recorder window closes on quit.
    }
  } catch (error) {
    record('Self-test runtime', false, errorText(error));
    logger?.error('selftest', errorText(error));
  } finally {
    hotkeys?.stop?.();
    overlay?.hideNow?.();
    if (output) {
      try {
        fs.writeFileSync(output, `${JSON.stringify(RESULTS, null, 2)}\n`, 'utf8');
      } catch (error) {
        console.error(`[voxa] Could not write the self-test report: ${error.message}`);
      }
    }
    const failed = RESULTS.filter((result) => !result.ok).length;
    logger?.info('selftest', `${RESULTS.length - failed} passed, ${failed} failed`);
    setTimeout(() => app.exit(failed ? 1 : 0), 150);
  }
}

module.exports = { runRuntimeSelfTest };
