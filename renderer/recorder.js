'use strict';

const api = window.voiceAgent;
let session = null;
let monitor = null;

function mediaError(error) {
  if (error?.name === 'NotAllowedError') return 'Microphone permission was denied. Check Windows Settings > Privacy > Microphone.';
  if (error?.name === 'NotFoundError') return 'No microphone was found. Connect an input device and refresh.';
  if (error?.name === 'NotReadableError') return 'The microphone is busy in another app. Close it and try again.';
  return error?.message || 'Microphone capture failed.';
}

function constraints(deviceId) {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1
    },
    video: false
  };
}

async function openStream(deviceId = '') {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints(deviceId));
  } catch (error) {
    if (deviceId && ['OverconstrainedError', 'NotFoundError'].includes(error.name)) {
      return navigator.mediaDevices.getUserMedia(constraints(''));
    }
    throw error;
  }
}

async function attachAnalyser(stream) {
  const context = new AudioContext();
  try {
    await context.resume();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    return { context, analyser };
  } catch (error) {
    context.close().catch(() => {});
    throw error;
  }
}

function readLevel(analyser) {
  if (!analyser) return { rms: 0, peak: 0 };
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  let peak = 0;
  for (const sample of samples) {
    sum += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  return { rms: Math.sqrt(sum / samples.length), peak };
}

// Phase C: 16 log-spaced FFT bands riding the existing level payloads. The
// island spectrum paints these real mic bins; the dashboard payload stays
// { peak } because main.cjs forwards only the peak there.
const BAND_COUNT = 16;
let freqData = null;
function readBands(analyser) {
  if (!analyser || typeof analyser.getByteFrequencyData !== 'function') return null;
  const count = analyser.frequencyBinCount;
  if (!count) return null;
  if (!freqData || freqData.length !== count) freqData = new Uint8Array(count);
  analyser.getByteFrequencyData(freqData);
  const bins = [];
  for (let band = 0; band < BAND_COUNT; band += 1) {
    let lo = Math.round(Math.pow(count, band / BAND_COUNT));
    let hi = Math.round(Math.pow(count, (band + 1) / BAND_COUNT));
    lo = Math.min(count - 1, Math.max(1, lo));
    hi = Math.min(count, Math.max(lo + 1, hi));
    let value = 0;
    for (let i = lo; i < hi; i += 1) value = Math.max(value, freqData[i]);
    bins.push(Math.min(1, value / 255));
  }
  return bins;
}

function cleanup(target) {
  if (!target) return;
  clearInterval(target.levelTimer);
  clearTimeout(target.stopTimer);
  target.levelTimer = null;
  target.stopTimer = null;
  try {
    target.stream?.getTracks().forEach((track) => track.stop());
  } catch {
    // Tracks may already be stopped by the browser.
  }
  target.stream = null;
  target.analyser = null;
  if (target.context) {
    target.context.close().catch(() => {});
    target.context = null;
  }
  if (session === target) session = null;
}

function stopMonitor() {
  if (!monitor) return;
  const target = monitor;
  monitor = null;
  cleanup(target);
}

async function startMonitor(deviceId) {
  stopMonitor();
  const stream = await openStream(deviceId);
  let analyserData;
  try {
    analyserData = await attachAnalyser(stream);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  const target = { stream, context: analyserData.context, analyser: analyserData.analyser, levelTimer: null };
  target.levelTimer = setInterval(() => {
    if (!target.analyser) return;
    api.recorder.level({ peak: readLevel(target.analyser).peak, at: Date.now(), bins: readBands(target.analyser) });
  }, 100);
  monitor = target;
  return true;
}

function blobToBytes(blob) {
  return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

async function playSample(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve();
    };
    const timer = setTimeout(finish, 8000);
    audio.onended = finish;
    audio.onerror = finish;
    audio.play().catch(finish);
  });
}

async function finishSession(target, cancelled) {
  if (target.finished) return;
  target.finished = true;
  const durationMs = target.startedAt ? Date.now() - target.startedAt : 0;
  const chunks = target.chunks.slice();
  const mime = target.mime || 'audio/webm';
  const rms = target.levelSamples ? target.rmsSum / target.levelSamples : 0;
  const peak = target.peakMax;
  cleanup(target);
  if (cancelled) return;
  const blob = new Blob(chunks, { type: mime });
  if (!blob.size) {
    if (target.kind === 'test') {
      api.recorder.respond(target.requestId, { ok: false, error: 'The microphone returned no audio.' });
    } else {
      api.recorder.error({ sessionId: target.id, message: 'The microphone returned no audio.' });
    }
    return;
  }
  if (target.kind === 'test') {
    api.recorder.progress('Playing back…');
    await playSample(blob);
    const audio = await blobToBytes(blob);
    api.recorder.respond(target.requestId, {
      ok: true,
      data: { audio, mime, durationMs, rms, peak, bytes: blob.size }
    });
    return;
  }
  const audio = await blobToBytes(blob);
  api.recorder.audio({
    sessionId: target.id,
    mime,
    durationMs,
    rms,
    peak,
    chunks: target.chunkCount,
    audio
  });
}

async function startSession(options) {
  if (session) {
    if (options.kind === 'test') {
      api.recorder.respond(options.requestId, { ok: false, error: 'The microphone is already in use.' });
    } else {
      api.recorder.error({ sessionId: options.id, message: 'The microphone is already in use.' });
    }
    return;
  }
  stopMonitor();
  const target = {
    id: options.id,
    kind: options.kind || 'recording',
    requestId: options.requestId || null,
    deviceId: options.deviceId || '',
    cancelled: false,
    stopRequested: false,
    starting: true,
    startedAt: 0,
    chunks: [],
    chunkCount: 0,
    levelSamples: 0,
    rmsSum: 0,
    peakMax: 0,
    stream: null,
    context: null,
    analyser: null,
    recorder: null,
    levelTimer: null,
    stopTimer: null,
    mime: 'audio/webm'
  };
  session = target;
  try {
    const stream = await openStream(target.deviceId);
    if (target.cancelled) {
      stream.getTracks().forEach((track) => track.stop());
      if (session === target) session = null;
      return;
    }
    target.stream = stream;
    const { context, analyser } = await attachAnalyser(stream);
    target.context = context;
    target.analyser = analyser;
    if (target.cancelled) {
      cleanup(target);
      return;
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    target.mime = mime;
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    target.recorder = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data?.size) {
        target.chunks.push(event.data);
        target.chunkCount += 1;
      }
    };
    recorder.onerror = (event) => {
      target.failed = true;
      target.finished = true;
      const message = event.error?.message || event.message || 'MediaRecorder failed.';
      if (target.kind === 'test') api.recorder.respond(target.requestId, { ok: false, error: message });
      else api.recorder.error({ sessionId: target.id, message });
      cleanup(target);
    };
    recorder.onstop = () => {
      if (target.failed) return;
      void finishSession(target, target.cancelled);
    };
    target.startedAt = Date.now();
    target.starting = false;
    target.levelTimer = setInterval(() => {
      if (!target.analyser) return;
      const level = readLevel(target.analyser);
      target.levelSamples += 1;
      target.rmsSum += level.rms;
      target.peakMax = Math.max(target.peakMax, level.peak);
      api.recorder.level({ peak: level.peak, at: Date.now(), bins: readBands(target.analyser) });
    }, 100);
    recorder.start(250);
    if (target.kind === 'test') {
      api.recorder.progress('Recording 3 seconds…');
      target.stopTimer = setTimeout(() => stopSession(target.id), Number(options.durationMs) || 3000);
    }
    if (target.stopRequested) stopSession(target.id);
  } catch (error) {
    const message = mediaError(error);
    if (target.kind === 'test') api.recorder.respond(target.requestId, { ok: false, error: message });
    else api.recorder.error({ sessionId: target.id, message });
    cleanup(target);
  }
}

function stopSession(id) {
  if (!session || session.id !== id) return;
  const target = session;
  target.stopRequested = true;
  if (target.starting) return;
  if (target.recorder && target.recorder.state !== 'inactive') {
    target.recorder.stop();
  } else if (target.recorder) {
    void finishSession(target, target.cancelled);
  }
}

function cancelSession(id) {
  if (!session || session.id !== id) return;
  const target = session;
  target.cancelled = true;
  if (target.recorder && target.recorder.state !== 'inactive') {
    target.recorder.stop();
  } else {
    cleanup(target);
  }
}

async function enumerateMicrophones() {
  await navigator.mediaDevices.enumerateDevices();
  let devices = await navigator.mediaDevices.enumerateDevices();
  let inputs = devices.filter((device) => device.kind === 'audioinput');
  if (!inputs.length || inputs.every((device) => !device.label)) {
    const stream = await openStream('');
    stream.getTracks().forEach((track) => track.stop());
    devices = await navigator.mediaDevices.enumerateDevices();
    inputs = devices.filter((device) => device.kind === 'audioinput');
  }
  return inputs.map((device, index) => ({
    id: device.deviceId,
    label: device.label || `Microphone ${index + 1}`
  }));
}

async function handleRequest(request) {
  if (!request || typeof request.id !== 'number') return;
  const respond = (payload) => api.recorder.respond(request.id, payload);
  try {
    if (request.type === 'enumerate') {
      if (session) throw new Error('Finish recording before enumerating microphones.');
      respond({ ok: true, data: await enumerateMicrophones() });
      return;
    }
    if (request.type === 'monitor-start') {
      if (session) throw new Error('The microphone is busy recording.');
      await startMonitor(request.deviceId || '');
      respond({ ok: true, data: { monitoring: true } });
      return;
    }
    if (request.type === 'monitor-stop') {
      stopMonitor();
      respond({ ok: true, data: { monitoring: false } });
      return;
    }
    if (request.type === 'test') {
      if (session) throw new Error('The microphone is already in use.');
      void startSession({
        kind: 'test',
        requestId: request.id,
        deviceId: request.deviceId || '',
        durationMs: Number(request.durationMs) || 3000
      });
      return;
    }
    throw new Error(`Unknown microphone request: ${request.type}`);
  } catch (error) {
    respond({ ok: false, error: mediaError(error) });
  }
}

api.recorder.onStart(({ sessionId, deviceId }) => {
  void startSession({ kind: 'recording', id: sessionId, deviceId });
});

api.recorder.onStop(({ sessionId }) => {
  stopSession(sessionId);
});

api.recorder.onCancel(({ sessionId }) => {
  cancelSession(sessionId);
});

api.recorder.onRequest((request) => {
  void handleRequest(request);
});

api.recorder.ready();

api.on?.('tts:play-audio', (buffer) => { console.log('player got play'); window.ttsPlayer?.play(new Uint8Array(buffer)); });
api.on?.('tts:stop-audio', () => { console.log('player got stop'); window.ttsPlayer?.stop(); });
