'use strict';

// Pure normalization for the optional ASR service. Keeping this out of main.cjs
// makes the dashboard-facing shape deterministic and testable without Electron
// or Python. It never invents availability, progress, language, or timestamps:
// unknown values stay null and missing timestamps stay absent.

const { ASR_ENGINES } = require('./constants.cjs');

const ENGINES = new Map(ASR_ENGINES.map((engine) => [engine.id, engine]));
const BUSY_STATES = new Set(['preparing', 'downloading', 'loading']);

function formatBytes(value, empty = 'Unknown size') {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return empty;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function engineInfo(engineId) {
  return ENGINES.get(String(engineId || '')) || ENGINES.get('whisper');
}

function optionalEngine(engineId) {
  const engine = ENGINES.get(String(engineId || ''));
  return engine && engine.id !== 'whisper' ? engine : null;
}

function normalizeProgress(source) {
  if (!source || typeof source !== 'object') return null;
  const downloaded = Number(source.downloaded_bytes ?? source.downloadedBytes);
  const total = Number(source.total_bytes ?? source.totalBytes);
  const rawPercent = source.percent == null ? NaN : Number(source.percent);
  const speed = Number(source.speed_bps ?? source.speedBps);
  return {
    model: typeof source.model === 'string' ? source.model : '',
    status: typeof source.status === 'string' ? source.status : '',
    downloadedBytes: Number.isFinite(downloaded) ? Math.max(0, downloaded) : 0,
    totalBytes: Number.isFinite(total) ? Math.max(0, total) : 0,
    percent: Number.isFinite(rawPercent) ? Math.max(0, Math.min(100, Math.round(rawPercent))) : null,
    speedBps: Number.isFinite(speed) ? Math.max(0, speed) : 0,
    currentFile: typeof source.current_file === 'string' ? source.current_file : '',
    stalled: Boolean(source.stalled),
    error: typeof source.error === 'string' ? source.error : ''
  };
}

function normalizeCapabilities(source) {
  if (!source || typeof source !== 'object') return {};
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}

function normalizeAsrModels(payload, engineId = '') {
  const rows = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : [];
  return rows.map((item) => ({
    id: String(item?.id || ''),
    label: String(item?.label || item?.id || ''),
    backend: String(item?.backend || ''),
    approxSizeBytes: Number(item?.approx_size_bytes ?? item?.approxSizeBytes) || 0,
    downloaded: typeof item?.downloaded === 'boolean' ? item.downloaded : null,
    available: typeof item?.available === 'boolean' ? item.available : null,
    active: Boolean(item?.active),
    selected: Boolean(item?.selected || item?.id === engineId),
    missing: Array.isArray(item?.missing) ? item.missing.map(String) : [],
    outdated: Array.isArray(item?.outdated) ? item.outdated.map(String) : [],
    reason: String(item?.availability_reason || item?.reason || ''),
    languages: Array.isArray(item?.languages) ? item.languages.map(String) : [],
    capabilities: normalizeCapabilities(item?.capabilities),
    notes: String(item?.notes || ''),
    longForm: Boolean(item?.long_form ?? item?.longForm)
  })).filter((item) => item.id);
}

function progressMessage(label, state, progress) {
  if (state === 'downloading') {
    if (progress?.percent != null) {
      return `Downloading ${label} — ${progress.percent}% (${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)}).`;
    }
    return `Preparing the ${label} download.`;
  }
  if (state === 'loading') return `Loading ${label}…`;
  if (state === 'preparing') return `Preparing ${label}…`;
  return '';
}

function summarizeAsr({
  status = null,
  engineId = 'whisper',
  running = false,
  error = '',
  serviceError = '',
  models = null
} = {}) {
  const engine = engineInfo(engineId);
  const selectedId = engine.id;
  const isWhisper = selectedId === 'whisper';
  const progress = normalizeProgress(status?.progress);
  const rawStatus = String(status?.status || '').trim().toLowerCase();
  const activeModel = String(status?.active_model || status?.activeModel || '');
  const targetModel = String(status?.target_model || status?.targetModel || status?.selected_model || status?.selectedModel || selectedId);
  const busy = Boolean(status?.download_active) || BUSY_STATES.has(rawStatus);
  const ready = running && rawStatus === 'ready' && activeModel === selectedId;
  const modelMatches = !activeModel || activeModel === selectedId;
  const available = status && typeof status.available === 'boolean' ? status.available : null;
  const downloaded = status && typeof status.downloaded === 'boolean' ? status.downloaded : null;
  const device = String(status?.device || '');
  const computeType = String(status?.compute_type || status?.computeType || '');
  const requestedDevice = String(status?.requested_device || status?.requestedDevice || '');
  const warnings = Array.isArray(status?.warnings) ? status.warnings.map(String).filter(Boolean) : [];
  const statusError = String(status?.error || error || serviceError || '').trim();
  const cuda = status?.cuda && typeof status.cuda === 'object' ? status.cuda : null;
  const cudaAvailable = typeof cuda?.available === 'boolean'
    ? cuda.available
    : typeof cuda?.cuda_available === 'boolean' ? cuda.cuda_available : null;
  const cudaReason = typeof cuda?.reason === 'string' ? cuda.reason : '';
  const missing = Array.isArray(status?.missing) ? status.missing.map(String) : [];
  const outdated = Array.isArray(status?.outdated) ? status.outdated.map(String) : [];

  let state;
  if (isWhisper) state = 'bundled';
  else if (!running) state = statusError ? 'error' : 'stopped';
  else if (rawStatus === 'error') state = 'error';
  else if (rawStatus === 'canceled') state = 'canceled';
  else if (statusError && rawStatus !== 'ready') state = 'error';
  else if (busy) state = rawStatus === 'downloading' ? 'downloading' : 'loading';
  else if (rawStatus === 'ready' && !modelMatches) state = 'mismatch';
  else if (ready) state = 'ready';
  else if (rawStatus) state = rawStatus;
  else if (running) state = 'idle';
  else state = 'stopped';

  let message;
  if (isWhisper) {
    message = 'The bundled Whisper server handles local dictation. Optional engines are not started.';
  } else if (state === 'downloading' || state === 'loading') {
    message = progressMessage(engine.label, state, progress);
  } else if (state === 'ready') {
    const where = [device, computeType].filter(Boolean).join(' · ');
    message = `${engine.label} is ready${where ? ` on ${where}` : ''}.`;
  } else if (state === 'error') {
    message = statusError || `${engine.label} could not be loaded.`;
  } else if (state === 'mismatch') {
    message = `The service loaded ${activeModel || 'another model'}, not ${engine.label}.`;
  } else if (state === 'canceled') {
    message = statusError || `The ${engine.label} load was canceled.`;
  } else if (state === 'idle') {
    message = `${engine.label} is selected but not loaded.`;
  } else if (state === 'stopped') {
    message = 'The optional speech service is stopped. Load a model or check status.';
  } else {
    message = statusError || `${engine.label} status is ${state}.`;
  }
  if (available === false && !statusError) {
    const reason = String(status?.availability_reason || '').trim();
    const files = [...missing, ...outdated].filter(Boolean);
    message = `${engine.label} is unavailable in this Python environment${reason ? `: ${reason}` : files.length ? `: ${files.join(', ')}` : '.'}`;
  }
  if (progress?.stalled && state === 'downloading') {
    message += ' The download has not made progress recently.';
  }
  if (requestedDevice === 'cuda' && cudaAvailable === false && state !== 'error') {
    message += ` CUDA is unavailable${cudaReason ? `: ${cudaReason}` : '.'}`;
  }

  const model = (models || []).find((item) => item.id === selectedId) || null;
  return {
    ok: Boolean(isWhisper || (ready && available !== false)),
    mode: isWhisper ? 'bundled' : 'optional',
    engine: selectedId,
    label: engine.label,
    backend: String(status?.backend || engine.backend || ''),
    serviceRunning: Boolean(running),
    status: state,
    message,
    error: statusError,
    activeModel,
    targetModel,
    selectedModel: selectedId,
    modelMatches,
    ready,
    busy,
    available,
    downloaded: downloaded == null ? model?.downloaded ?? null : downloaded,
    approxSizeBytes: Number(model?.approxSizeBytes ?? engine.sizeBytes) || 0,
    missing,
    outdated,
    device,
    computeType,
    requestedDevice,
    cudaAvailable,
    cudaReason,
    capabilities: normalizeCapabilities(status?.capabilities),
    languages: Array.isArray(status?.languages) ? status.languages.map(String) : [],
    warnings,
    progress,
    cacheDir: String(status?.cache_dir || ''),
    chunked: Boolean(status?.chunked),
    chunkSeconds: Number(status?.chunk_seconds) || null,
    canLoad: !isWhisper && !busy && available !== false,
    canDownload: !isWhisper && !busy && downloaded !== true,
    canCancel: !isWhisper && busy,
    canUnload: !isWhisper && Boolean(activeModel) && !busy,
    checkedAt: new Date().toISOString()
  };
}

module.exports = {
  BUSY_STATES,
  engineInfo,
  optionalEngine,
  normalizeProgress,
  normalizeAsrModels,
  summarizeAsr
};
