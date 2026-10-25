/* Phase H: derivations for the island download live activity.

   Three real producers feed the pill — whisper model switches (health polled
   every WHISPER_PROGRESS_POLL_MS), kokoro voice-pack downloads (progress per
   percent line), and ollama model pulls (progress per stream line). Main calls
   these on every event; each returns either null (no download to show) or a
   fixed-shape summary { phase, label, percent } the pill can honestly display.

   These are pure: the selftest covers them with real payload shapes, so the
   mapping stays verified without ever triggering a download. */

function islandDownload({ phase, label, percent } = {}) {
  const cleanPhase = phase === 'starting' || phase === 'downloading' || phase === 'loading' ? phase : null;
  const cleanLabel = String(label || '').trim();
  if (!cleanPhase || !cleanLabel) return null;
  // Number(null) is 0 — treat "no percent" exactly as null, never as fake 0%
  // progress. Only a genuinely reported, finite number is clamped and kept.
  const value = percent == null ? null : Number(percent);
  return {
    phase: cleanPhase,
    label: cleanLabel.slice(0, 60),
    percent: value == null || !Number.isFinite(value) ? null
      : Math.max(0, Math.min(100, Math.round(value)))
  };
}

/* Whisper: the server owns the real bytes; the summary already carries a
   rounded percent and the target model. Mismatch/unreachable states are not a
   download — never show a fake ring for them. */
function whisperIslandDownload(summary) {
  if (!summary || !summary.switching) return null;
  const status = String(summary.status || '');
  if (status !== 'downloading' && status !== 'loading') return null;
  return islandDownload({
    phase: status,
    label: `Whisper · ${summary.targetModel || summary.model || 'model'}`,
    percent: summary.progress ? summary.progress.percent : null
  });
}

/* Whisper startup: the process is launching but the server cannot yet report
   download progress (status unreachable). That is still a real long activity —
   show the starting phase so the pill matches the watch that is actually
   polling. An empty or unknown model means there is nothing to name. */
function whisperStartingIslandDownload(model) {
  const name = String(model || '').trim();
  if (!name) return null;
  return islandDownload({ phase: 'starting', label: `Whisper · ${name}`, percent: null });
}

/* Kokoro: consent downloads publish a percent per log line; every other
   status (consented, ready, error, cancelled) is not an active download. */
function kokoroIslandDownload(status) {
  if (!status || status.status !== 'downloading') return null;
  const variant = String(status.variant || 'pack').trim();
  return islandDownload({
    phase: 'downloading',
    label: `Voice · ${variant}`,
    percent: status.progress ? status.progress.percent : null
  });
}

/* Ollama: the pull stream emits { status, completed, total, percent } rows;
   'success' rows end the pull, so they clear the pill rather than showing a
   stuck 100%. Rows without a computable percent still count as active — the
   label says the pull is running, never invents progress. */
function ollamaIslandDownload(progress, model) {
  if (!progress || progress.status === 'success') return null;
  const name = String(model || '').trim();
  if (!name) return null;
  return islandDownload({
    phase: 'downloading',
    label: `Ollama · ${name}`,
    percent: progress.percent
  });
}

module.exports = {
  islandDownload,
  whisperIslandDownload,
  whisperStartingIslandDownload,
  kokoroIslandDownload,
  ollamaIslandDownload
};
