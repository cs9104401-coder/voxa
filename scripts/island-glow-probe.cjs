'use strict';

// CPU probe for the Stage 2b activation orb (dev-only; scripts/** never ships).
// Phase A: pill collapsed and hidden — every orb loop is paused by the island
//          idle/hidden rules, so this measures resting renderer load.
// Phase B: pill shown in listening, full animated orb (CDP media emulation
//          neutralizes this box's OS prefers-reduced-motion and is-lite is
//          dropped first) with synthetic mic levels driving the iris band
//          every 500ms — measures the orb's active animation cost.
// Phase C: the same listening pill with is-lite re-added — the auto-selected
//          low-power fallback, for comparison.
// Sampling uses app.getAppMetrics(); Electron 45 exposes per-PID rows with a
// top-level cumulative CPU-usage field, so this probe derives each 500ms
// window's % of one core from cumulative deltas (see samplePhase) and reports
// the phase average. Electrically identical semantics to the old
// percentProcessorUsage flow, version-proof across schema changes.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO = path.join(__dirname, '..');
const OUT = path.join(process.env.TEMP || 'C:/Users/Shoyo/AppData/Local/Temp/opencode', 'island-capture');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let overlay = null;

// Harness-only media emulation (same approach as island-capture): flip
// prefers-reduced-motion to "no-preference" so the animated orb runs on a11y
// machines. Phase C forces the class instead, so it also needs emulation off
// afterwards — Phase A/C idle states end with the OS truth restored.
async function emulateMotion(contents, on) {
  try {
    const dbg = contents.debugger;
    if (!dbg.isAttached()) await dbg.attach('1.3');
    await dbg.sendCommand('Emulation.setEmulatedMedia', on
      ? { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }
      : { features: [] });
  } catch (error) {
    console.log(`motion emulation ${on ? 'on' : 'off'} failed: ${error && (error.message || error)}`);
  }
}

async function setLite(contents, on) {
  await contents.executeJavaScript(`(()=>{const c=document.querySelector(".companion");if(c)c.classList.${on ? 'add' : 'remove'}("is-lite");return Boolean(c)})()`, true);
}

async function waitForRenderer(contents) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (await contents.executeJavaScript('Boolean(window.voiceAgent)', true)) return;
    } catch { /* not loaded yet */ }
    await sleep(150);
  }
  throw new Error('overlay renderer never signalled readiness');
}

// Sampling: app.getAppMetrics() — Electron 45 exposes per-PID rows with a
// top-level row.cpu = { cumulativeCPUUsage, percentCPUUsage, ... }. The legacy
// metrics.cpu nesting and percentProcessorUsage name are gone, and
// percentCPUUsage reports 0 on the first sample, so per-core load is computed
// from cumulativeCPUUsage deltas over the fixed 500ms windows: CPU-seconds
// consumed / 0.5s wall × 100 = % of one core. Rows are keyed per PID so
// multi-process types (Utility, Renderer) never share one delta baseline; the
// phase average sums the per-window deltas per process type.
async function samplePhase({ app, contents, seconds, drive }) {
  const rows = [];
  const prev = new Map();
  let deadline = Date.now() + seconds * 1000;
  let window = null;
  while (Date.now() < deadline) {
    await sleep(500);
    window = (window ?? 0) + 1;
    if (drive) {
      const wave = Array.from({ length: 16 }, (_, i) => (i % 2 ? 0.85 : 0.4));
      try { await contents.executeJavaScript(`applyAudioLevel(0.55, ${JSON.stringify(wave)})`, true); } catch { /* renderer busy */ }
    }
    for (const metric of app.getAppMetrics()) {
      const cpu = metric.cpu;
      if (!cpu || typeof cpu.cumulativeCPUUsage !== 'number') continue;
      const pidKey = `${metric.type}:${metric.pid}`;
      const baseline = prev.get(pidKey);
      prev.set(pidKey, cpu.cumulativeCPUUsage);
      if (baseline === undefined) continue;
      rows.push({ type: metric.type, window, delta: Math.max(0, cpu.cumulativeCPUUsage - baseline) });
    }
  }
  // Console output contract: percentCpuPerProcessType is the phase-average
  // TOTAL % of one core for that process type — per-window deltas are summed
  // over the type's live processes, then averaged over completed windows.
  const windows = window ?? 0;
  const buckets = {};
  for (const row of rows) {
    const key = `${row.type}:${row.window}`;
    buckets[key] = (buckets[key] || 0) + row.delta;
  }
  const byType = {};
  for (const [key, delta] of Object.entries(buckets)) {
    const type = key.split(':')[0];
    byType[type] = (byType[type] || 0) + delta;
  }
  const average = {};
  for (const [type, totalDelta] of Object.entries(byType)) {
    average[type] = +(totalDelta / windows / 0.5 * 100).toFixed(2);
  }
  return {
    windowSamples: windows,
    percentCpuPerProcessType: average
  };
}

async function main() {
  const { app, ipcMain } = require('electron');
  const { createOverlay } = require(path.join(REPO, 'lib', 'overlay.cjs'));
  // Same stub as island-capture so labels resolve; no other main-process code
  // runs in the probe.
  ipcMain.removeAllListeners('brand:name');
  ipcMain.on('brand:name', (event) => { event.returnValue = 'Voxa'; });
  app.on('window-all-closed', () => {});
  overlay = createOverlay({ log: { info: () => {}, warn: (tag, text) => console.log(`[warn:${tag}] ${text}`), error: (tag, text) => console.log(`[error:${tag}] ${text}`) } });
  await app.whenReady();
  overlay.create();
  const contents = overlay.getWindow().webContents;
  await waitForRenderer(contents);

  // Let startup costs (fonts, springs, first paint) drain out of phase A.
  await sleep(3000);
  await contents.executeJavaScript('getComputedStyle(document.body).opacity', true).catch(() => {});

  const idle = await samplePhase({ app, contents, seconds: 8, drive: false });
  const idleCheck = await contents.executeJavaScript(`(() => {
    const pill = document.getElementById('notch');
    const shape = document.querySelector('.blob-shape');
    return {
      pillVisible: pill ? pill.dataset.visible : null,
      shapeAnim: shape ? getComputedStyle(shape).animationName : null
    };
  })()`, true);

  // Phase B: the designed animated orb — force-off auto-lite (this box has OS
  // reduce on, so the bootstrap would otherwise static it) and emulate
  // no-preference so the island.css media block unstatics too.
  await setLite(contents, false);
  await emulateMotion(contents, true);
  overlay.show({ status: 'listening', message: 'Glow probe — speak naturally.', companionEnabled: true });
  await sleep(2200);
  const active = await samplePhase({ app, contents, seconds: 10, drive: true });
  const activeCheck = await contents.executeJavaScript(`(() => {
    const pill = document.getElementById('notch');
    const comp = document.querySelector('.companion');
    const band = document.querySelector('.band-core');
    const shape = document.querySelector('.blob-shape');
    return {
      state: pill ? pill.dataset.state : null,
      expression: comp ? comp.dataset.expression : null,
      lite: comp ? comp.classList.contains('is-lite') : null,
      bandOpacity: band ? getComputedStyle(band).opacity : null,
      bandAnim: band ? getComputedStyle(band).animationName : null,
      shapeAnim: shape ? getComputedStyle(shape).animationName : null,
      level: comp ? getComputedStyle(comp).getPropertyValue('--level') : null
    };
  })()`, true);

  // Phase C: the auto-selected Lite fallback for comparison.
  await setLite(contents, true);
  await sleep(700);
  const litePhase = await samplePhase({ app, contents, seconds: 6, drive: true });
  const liteCheck = await contents.executeJavaScript(`(() => {
    const comp = document.querySelector('.companion');
    const band = document.querySelector('.band-core');
    return {
      lite: comp ? comp.classList.contains('is-lite') : null,
      bandAnim: band ? getComputedStyle(band).animationName : null,
      bandFilter: band ? getComputedStyle(band).filter : null
    };
  })()`, true);
  await emulateMotion(contents, false);

  const report = {
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    cpuThreads: os.cpus().length,
    idleCollapsed: { ...idleCheck, ...idle },
    glowActiveListening: { ...activeCheck, ...active },
    glowLiteListening: { ...liteCheck, ...litePhase }
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'island-cpu.json'), JSON.stringify(report, null, 2));

  console.log('--- Section 2b CPU report (Electron 45 cumulative-CPU deltas, phase-average % of one core) ---');
// Electron 45 labels the overlay renderer process `Tab` (pre-Electron `Window`).
  const windowPct = (phase) => phase.percentCpuPerProcessType.Tab ?? phase.percentCpuPerProcessType.Window ?? phase.percentCpuPerProcessType.window ?? 'n/a';
  const gpuPct = (phase) => phase.percentCpuPerProcessType.GPU ?? phase.percentCpuPerProcessType.gpu ?? 'n/a';
  console.log(`idle / collapsed   (${idle.windowSamples} windows): window=${windowPct(idle)} gpu=${gpuPct(idle)} all=${Object.entries(idle.percentCpuPerProcessType).map(([type, cpu]) => `${type}:${cpu}`).join(' ')}`);
  console.log(`glow active        (${active.windowSamples} windows): window=${windowPct(active)} gpu=${gpuPct(active)} all=${Object.entries(active.percentCpuPerProcessType).map(([type, cpu]) => `${type}:${cpu}`).join(' ')}`);
  console.log(`glow active check: ${JSON.stringify(activeCheck)}`);
  console.log(`glow lite          (${litePhase.windowSamples} windows): window=${windowPct(litePhase)} gpu=${gpuPct(litePhase)}`);
  console.log(`glow lite check: ${JSON.stringify(liteCheck)}`);
  console.log(`idle check: ${JSON.stringify(idleCheck)}`);

  setTimeout(() => app.quit(), 200);
  setTimeout(() => process.exit(0), 1600);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
