'use strict';

const { LIMITS } = require('./constants.cjs');

function createRecorderManager({ getWindow, log }) {
  let session = null;
  let nextId = 1;

  function send(channel, payload) {
    const window = getWindow?.();
    if (!window || window.isDestroyed()) return false;
    try {
      window.webContents.send(channel, payload);
      return true;
    } catch (error) {
      log?.warn('recorder', `Could not send ${channel}: ${error.message}`);
      return false;
    }
  }

  function start({ deviceId = '', origin = 'hotkey' } = {}) {
    if (session) {
      log?.warn('recorder', 'A recording is already active; duplicate start ignored.');
      return null;
    }
    session = {
      id: nextId++,
      deviceId: String(deviceId || ''),
      origin,
      startedAt: Date.now(),
      stopped: false
    };
    log?.info('recording', `Started session ${session.id} from ${origin}`);
    if (!send('recorder:start', { sessionId: session.id, deviceId: session.deviceId, minHoldMs: LIMITS.MIN_HOLD_MS })) {
      session = null;
      log?.warn('recorder', 'Could not start a recording because the microphone window is unavailable.');
      return null;
    }
    return { ...session };
  }

  function owns(sessionId) {
    return Boolean(session && session.id === sessionId && !session.stopped);
  }

  function cancel(sessionId, reason = 'cancelled') {
    if (!owns(sessionId)) return false;
    const current = session;
    current.stopped = true;
    session = null;
    log?.info('recording', `Session ${current.id} ${reason}`);
    send('recorder:cancel', { sessionId: current.id, reason });
    return true;
  }

  function stop(sessionId) {
    if (!owns(sessionId)) {
      log?.warn('recording', `Ignored stale stop for session ${sessionId}`);
      return false;
    }
    const current = session;
    const elapsed = Date.now() - current.startedAt;
    current.stopped = true;
    session = null;
    log?.info('recording', `Stopping session ${current.id} after ${elapsed} ms`);
    if (!send('recorder:stop', {
      sessionId: current.id,
      origin: current.origin,
      durationMs: elapsed,
      minAudioMs: LIMITS.MIN_AUDIO_MS
    })) {
      log?.warn('recorder', `Could not stop session ${current.id} because the microphone window is unavailable.`);
      return false;
    }
    return true;
  }

  function cancelAll() {
    if (!session) return false;
    return cancel(session.id, 'cancelled');
  }

  function active() {
    return session ? { ...session } : null;
  }

  return { start, stop, cancel, cancelAll, active, owns };
}

module.exports = { createRecorderManager };
