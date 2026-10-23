'use strict';

const path = require('node:path');

let hookModule = null;

function loadHook() {
  if (hookModule) return hookModule;
  const candidates = ['uiohook-napi'];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'uiohook-napi'));
  }
  const failures = [];
  for (const candidate of candidates) {
    try {
      hookModule = require(candidate);
      return hookModule;
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`);
    }
  }
  const wrapped = new Error(`Global shortcut hook failed to load: ${failures.join(' | ')}`);
  wrapped.cause = new Error(failures.join('\n'));
  throw wrapped;
}

const KEY_TABLE = {
  space: 57,
  tab: 15,
  enter: 28,
  return: 28,
  esc: 1,
  escape: 1,
  backspace: 14,
  delete: 3667,
  del: 3667,
  insert: 3666,
  home: 3655,
  end: 3663,
  pageup: 3657,
  pagedown: 3665,
  up: 57416,
  down: 57424,
  left: 57419,
  right: 57421,
  a: 30,
  b: 48,
  c: 46,
  d: 32,
  e: 18,
  f: 33,
  g: 34,
  h: 35,
  i: 23,
  j: 36,
  k: 37,
  l: 38,
  m: 50,
  n: 49,
  o: 24,
  p: 25,
  q: 16,
  r: 19,
  s: 31,
  t: 20,
  u: 22,
  v: 47,
  w: 17,
  x: 45,
  y: 21,
  z: 44,
  0: 11,
  1: 2,
  2: 3,
  3: 4,
  4: 5,
  5: 6,
  6: 7,
  7: 8,
  8: 9,
  9: 10,
  f1: 59,
  f2: 60,
  f3: 61,
  f4: 62,
  f5: 63,
  f6: 64,
  f7: 65,
  f8: 66,
  f9: 67,
  f10: 68,
  f11: 87,
  f12: 88,
  f13: 91,
  f14: 92,
  f15: 93,
  f16: 99,
  f17: 100,
  f18: 101,
  f19: 102,
  f20: 103,
  f21: 104,
  f22: 105,
  f23: 106,
  f24: 107
};

const MODIFIER_KEYCODES = {
  ctrl: [29, 3613],
  alt: [56, 3640],
  shift: [42, 54],
  meta: [3675, 3676]
};

function keyTable() {
  return KEY_TABLE;
}

function parseHotkey(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 60) throw new Error('Shortcut is empty or too long.');
  const parts = text.split('+').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Shortcut is empty.');
  const modifiers = { ctrl: false, alt: false, shift: false, meta: false };
  let keyName = '';
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (['ctrl', 'control'].includes(lower)) modifiers.ctrl = true;
    else if (lower === 'alt') modifiers.alt = true;
    else if (lower === 'shift') modifiers.shift = true;
    else if (['meta', 'win', 'super', 'cmd'].includes(lower)) modifiers.meta = true;
    else if (keyName) throw new Error('Use exactly one non-modifier key in a shortcut.');
    else keyName = lower;
  }
  if (!keyName) throw new Error('Shortcut needs a key.');
  const table = keyTable();
  if (!Object.hasOwn(table, keyName)) throw new Error(`Unsupported shortcut key: ${keyName}`);
  if (!modifiers.ctrl && !modifiers.alt && !modifiers.shift && !modifiers.meta && !/^f([1-9]|1[0-9]|2[0-4])$/.test(keyName)) {
    throw new Error('Add Ctrl, Alt, Shift, or the Windows key to a letter or number shortcut.');
  }
  const label = [
    modifiers.ctrl ? 'Ctrl' : '',
    modifiers.alt ? 'Alt' : '',
    modifiers.shift ? 'Shift' : '',
    modifiers.meta ? 'Win' : ''
  ].filter(Boolean).join('+');
  return {
    ...modifiers,
    keycode: table[keyName],
    keyName,
    display: `${label}${label ? '+' : ''}${keyName.length === 1 ? keyName.toUpperCase() : keyName[0].toUpperCase() + keyName.slice(1)}`
  };
}

function isValidHotkey(value) {
  try {
    parseHotkey(value);
    return true;
  } catch {
    return false;
  }
}

function createHotkeys({ log, onDictation, onAgent, onDictationEnd, onAgentEnd }) {
  let active = false;
  let bindings = { dictation: null, agent: null };
  let pressed = { dictation: false, agent: false };
  let hook = null;
  let lastError = '';
  let startedAt = 0;

  function match(event, binding) {
    return Boolean(binding
      && event.keycode === binding.keycode
      && Boolean(event.ctrlKey) === binding.ctrl
      && Boolean(event.altKey) === binding.alt
      && Boolean(event.shiftKey) === binding.shift
      && Boolean(event.metaKey) === binding.meta);
  }

  function keydown(event) {
    if (!active) return;
    if (match(event, bindings.dictation)) {
      if (pressed.dictation) return;
      pressed.dictation = true;
      try {
        onDictation?.();
      } catch (error) {
        log?.error('hotkey', `Dictation handler failed: ${error.message}`);
      }
      return;
    }
    if (match(event, bindings.agent)) {
      if (pressed.agent) return;
      pressed.agent = true;
      try {
        onAgent?.();
      } catch (error) {
        log?.error('hotkey', `Agent handler failed: ${error.message}`);
      }
    }
  }

  function released(event, binding) {
    if (!binding) return false;
    if (event.keycode === binding.keycode) return true;
    return Object.entries(MODIFIER_KEYCODES).some(([modifier, codes]) => binding[modifier] && codes.includes(event.keycode));
  }

  function keyup(event) {
    if (!active) return;
    const dictationKey = Boolean(pressed.dictation && released(event, bindings.dictation));
    const agentKey = Boolean(pressed.agent && released(event, bindings.agent));
    if (dictationKey) {
      pressed.dictation = false;
      try {
        onDictationEnd?.();
      } catch (error) {
        log?.error('hotkey', `Dictation release handler failed: ${error.message}`);
      }
    }
    if (agentKey) {
      pressed.agent = false;
      try {
        onAgentEnd?.();
      } catch (error) {
        log?.error('hotkey', `Agent release handler failed: ${error.message}`);
      }
    }
    if (Date.now() - startedAt < 500) pressed = { dictation: false, agent: false };
  }

  function configure(next = {}) {
    const dictation = parseHotkey(next.dictationHotkey);
    const agent = parseHotkey(next.agentHotkey);
    if (dictation.display === agent.display) throw new Error('Dictation and Agent must use different shortcuts.');
    if (pressed.dictation) onDictationEnd?.();
    if (pressed.agent) onAgentEnd?.();
    bindings = { dictation, agent };
    pressed = { dictation: false, agent: false };
    if (dictation.alt || agent.alt) {
      log?.warn('hotkeys', 'Alt-based shortcuts are detected but cannot be suppressed; Windows may also react to them.');
    }
    log?.info('hotkeys', `Watching ${dictation.display} (dictation) and ${agent.display} (agent)`);
    return { dictation: dictation.display, agent: agent.display };
  }

  function start() {
    if (hook) return { ok: true };
    try {
      const { uIOhook } = loadHook();
      hook = uIOhook;
      hook.on('keydown', keydown);
      hook.on('keyup', keyup);
      hook.start();
      active = true;
      startedAt = Date.now();
      lastError = '';
      log?.info('hotkeys', 'Global shortcut listener started');
      return { ok: true };
    } catch (error) {
      lastError = error.message;
      try {
        hook?.removeListener('keydown', keydown);
        hook?.removeListener('keyup', keyup);
      } catch {
        // Keep the original load/start error.
      }
      hook = null;
      log?.error('hotkeys', lastError);
      return { ok: false, error: lastError };
    }
  }

  function stop() {
    active = false;
    if (!hook) return;
    try {
      hook.stop();
    } catch (error) {
      log?.warn('hotkeys', `Could not stop hook cleanly: ${error.message}`);
    }
    hook.removeListener('keydown', keydown);
    hook.removeListener('keyup', keyup);
    hook = null;
    pressed = { dictation: false, agent: false };
  }

  return {
    configure,
    start,
    stop,
    status: () => ({ active, bindings, error: lastError })
  };
}

module.exports = {
  createHotkeys,
  parseHotkey,
  isValidHotkey,
  loadHook
};
