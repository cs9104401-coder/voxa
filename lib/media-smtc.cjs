'use strict';

const { spawn } = require('node:child_process');

/* Phase F media controls — metadata and transport only, straight from Windows
   SystemMediaTransportControls (SMTC). No audio taps, no synthetic levels.
   Dependencies: powershell.exe (ships with Windows) and the WinRT projection
   it exposes — nothing else. One long-lived watcher process polls the session
   manager and writes a single JSON line whenever anything changes; transport
   commands spawn a short-lived process, pick the same preferred session
   (Playing first, else the first session) and issue its Try*Async call. */

const PS_EXE = 'powershell.exe';
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const MANAGER_TYPE = '[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]';
const SESSION_LIST_TYPE = '[System.Collections.Generic.IReadOnlyList[Windows.Media.Control.GlobalSystemMediaTransportControlsSession]]';
const MEDIA_PROPS_TYPE = '[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]';
const POLL_MS = 1200;
const COMMAND_TIMEOUT_MS = 8000;

const HEAD = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  // Type tokens must be real Type objects (not bracketed strings) for the
  // reflection helpers below; the literal projects the WinRT namespace.
  `$managerType = ${MANAGER_TYPE}`,
  `$listType = ${SESSION_LIST_TYPE}`,
  `$propsType = ${MEDIA_PROPS_TYPE}`,
  // PS 5.1 needs System.WindowsRuntimeSystemExtensions.AsTask to await WinRT
  // IAsyncOperation. Reflection keeps the generic lookup quoting-safe: inside a
  // PS single-quoted string the backtick ('System.IAsyncOperation`1') is literal.
  'function AwaitWinRt($WinRtTask, $ResultType) {',
  '  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {',
  "    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and",
  "    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'",
  '  })[0].MakeGenericMethod($ResultType)',
  '  $netTask = $asTask.Invoke($null, @($WinRtTask))',
  '  $netTask.Wait(-1) | Out-Null',
  '  $netTask.Result',
  '}',
  'function AwaitWinRtAction($WinRtAction) {',
  '  $asAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {',
  "    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and",
  "    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'",
  '  })[0]',
  '  $netTask = $asAction.Invoke($null, @($WinRtAction))',
  '  $netTask.Wait(-1) | Out-Null',
  '}',
  '$manager = AwaitWinRt $managerType::RequestAsync() $managerType',
  'function Pick-Session($sessions) {',
  '  foreach ($candidate in $sessions) {',
  "    if ($candidate.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing') { return $candidate }",
  '  }',
  '  return $sessions[0]',
  '}'
].join('\n');

const WATCHER_SCRIPT = [
  HEAD,
  '$seen = $null',
  'while ($true) {',
  '  $emit = $null',
  '  try {',
  '    $sessions = $manager.Sessions',
  '    if ($sessions.Count -eq 0) {',
  '      $emit = @{ active = $false }',
  '    } else {',
  '      $session = Pick-Session $sessions',
  '      $info = $session.GetPlaybackInfo()',
  '      $controls = $info.Controls',
  `      $props = AwaitWinRt ($session.TryGetMediaPropertiesAsync()) $propsType`,
  '      $emit = @{',
  '        active = $true',
  '        title = [string]$props.Title',
  '        artist = [string]$props.Artist',
  '        app = [string]$session.SourceAppUserModelId',
  '        status = $info.PlaybackStatus.ToString()',
  '        canPlay = [bool]$controls.IsPlayEnabled',
  '        canPause = [bool]$controls.IsPauseEnabled',
  '        canNext = [bool]$controls.IsNextEnabled',
  '        canPrev = [bool]$controls.IsPreviousEnabled',
  '        sessionId = [string]$session.SessionId',
  '      }',
  '    }',
  '  } catch {',
  '    $emit = @{ active = $false; error = [string]$_.Exception.Message }',
  '  }',
  "  $signature = if ($emit.error) { 'err|' + $emit.error } elseif ($emit.active) { $emit.sessionId + '|' + $emit.status + '|' + $emit.title + '|' + $emit.artist } else { 'none' }",
  '  if ($signature -ne $seen) {',
  '    $seen = $signature',
  '    [Console]::Out.WriteLine(($emit | ConvertTo-Json -Compress))',
  '    [Console]::Out.Flush()',
  '  }',
  `  Start-Sleep -Milliseconds ${POLL_MS}`,
  '}'
].join('\n');

const COMMAND_OPS = {
  toggle: 'TryTogglePlayPauseAsync',
  next: 'TrySkipNextAsync',
  previous: 'TrySkipPreviousAsync'
};

function commandScript(action) {
  const op = COMMAND_OPS[action];
  if (!op) throw new Error(`Unsupported media action: ${action}`);
  return [
    HEAD,
    'try {',
    '  $sessions = $manager.Sessions',
    '  if ($sessions.Count -eq 0) {',
    "    [Console]::Out.WriteLine('NOSESSION')",
    '    exit 1',
    '  }',
    '  $session = Pick-Session $sessions',
    `  AwaitWinRtAction ($session.${op}())`,
    "  [Console]::Out.WriteLine('OK')",
    '} catch {',
    "  [Console]::Out.WriteLine(('ERR ' + [string]$_.Exception.Message))",
    '  exit 1',
    '}'
  ].join('\n');
}

function runMediaCommand(action, { log } = {}) {
  return new Promise((resolve) => {
    let script;
    try {
      script = commandScript(action);
    } catch (error) {
      log?.warn('media', error.message);
      resolve({ ok: false, reason: 'unsupported' });
      return;
    }
    const child = spawn(PS_EXE, [...PS_ARGS, '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const timer = setTimeout(() => {
      output += 'TIMEOUT executing the SMTC command.';
      try { child.kill(); } catch { /* already gone */ }
    }, COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = output.trim();
      if (code === 0 && text.includes('OK')) { resolve({ ok: true }); return; }
      if (text.includes('NOSESSION')) { resolve({ ok: false, reason: 'no-session' }); return; }
      const last = text.split(/\r?\n/).filter(Boolean).pop() || 'failed';
      resolve({ ok: false, reason: String(last).slice(0, 200) });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: String(error && error.message || error) });
    });
  });
}

function startMediaWatcher({ log, onUpdate } = {}) {
  let child = null;
  let disposed = false;
  let buffer = '';
  let stderrTail = '';
  let restartDelay = 2500;
  let bornAt = 0;
  let restartTimer = null;

  const scheduleRestart = (delay) => {
    if (disposed || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawnWatcher();
    }, delay);
  };

  const spawnWatcher = () => {
    if (disposed) return;
    buffer = '';
    stderrTail = '';
    bornAt = Date.now();
    const proc = spawn(PS_EXE, [...PS_ARGS, '-Command', WATCHER_SCRIPT], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child = proc;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          log?.warn('media', `Could not parse watcher line: ${line.slice(0, 120)}`);
          continue;
        }
        try {
          onUpdate(parsed);
        } catch (error) {
          log?.warn('media', `Watcher update handler failed: ${error && error.message || error}`);
        }
      }
    });
    proc.stderr.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-400);
    });
    proc.on('close', (code) => {
      if (child !== proc) return;
      child = null;
      if (disposed) return;
      log?.warn('media', `SMTC watcher exited (code ${code}).${stderrTail ? ` Last diagnostics: ${stderrTail.trim().slice(0, 200)}` : ''}`);
      if (Date.now() - bornAt > 20000) restartDelay = 2500;
      const delay = restartDelay;
      restartDelay = Math.min(restartDelay * 2, 30000);
      scheduleRestart(delay);
    });
    proc.on('error', (error) => {
      if (child !== proc) return;
      child = null;
      if (disposed) return;
      log?.error('media', `Could not start the SMTC watcher: ${error.message}`);
      scheduleRestart(restartDelay);
      restartDelay = Math.min(restartDelay * 2, 30000);
    });
  };

  spawnWatcher();
  return {
    stop: () => {
      disposed = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (child) {
        try { child.kill(); } catch { /* already gone */ }
        child = null;
      }
    },
    runCommand: (action) => runMediaCommand(action, { log })
  };
}

function describeApp(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const tail = value.split(/[!\\/]/).pop() || value;
  const cleaned = tail.replace(/\.exe$/i, '').replace(/_+/g, ' ').trim().slice(0, 60);
  return cleaned || value.slice(0, 60);
}

/* Watcher line -> the island's media state object. Returns null when nothing
   is playing-metadatable; returns { error } when the WinRT layer complained
   (main logs instead of touching the UI). */
function normalizeMedia(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.error) return { error: String(raw.error).slice(0, 200) };
  if (raw.active === false) return null;
  const title = String(raw.title || '').trim().slice(0, 120);
  const artist = String(raw.artist || '').trim().slice(0, 120);
  if (!title && !artist) return null;
  return {
    title: title || 'Unknown title',
    artist,
    app: describeApp(raw.app),
    playing: String(raw.status || '').trim() === 'Playing',
    canToggle: Boolean(raw.canPlay || raw.canPause),
    canNext: Boolean(raw.canNext),
    canPrev: Boolean(raw.canPrev)
  };
}

module.exports = { startMediaWatcher, runMediaCommand, normalizeMedia, POLL_MS };
