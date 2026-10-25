'use strict';
// Stage 2b orb visual review: clones the live .companion node at 6x on a
// canvas-sized stage so the gradient layers can be inspected next to
// reference/siri-blob-ref.png (the real orb is only 40x30 on screen). Review
// tool only — the clone is outside the app layout and nothing is committed
// to the renderer sources.
const path = require('node:path');
const fs = require('node:fs');
const OUT = path.join(process.env.TEMP || 'C:/Users/Shoyo/AppData/Local/Temp/opencode', 'island-capture');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let overlay = null;

async function waitForRenderer(contents) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if (await contents.executeJavaScript('Boolean(window.voiceAgent)', true)) return; } catch { /* loading */ }
    await sleep(150);
  }
  throw new Error('renderer not ready');
}

async function emulateMotion(contents, on) {
  try {
    const dbg = contents.debugger;
    if (!dbg.isAttached()) await dbg.attach('1.3');
    await dbg.sendCommand('Emulation.setEmulatedMedia', on
      ? { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }
      : { features: [] });
  } catch { /* review only */ }
}

const STAGE = `(function(){
  var old = document.getElementById('orb-review-stage');
  if (old) old.remove();
  var stage = document.createElement('div');
  stage.id = 'orb-review-stage';
  stage.style.cssText = 'position:fixed;left:0;top:0;width:720px;height:340px;background:rgba(10,12,16,1);z-index:99999;overflow:hidden';
  var tag = document.createElement('div');
  tag.style.cssText = 'position:absolute;left:16px;top:10px;color:#9aa4b2;font:600 11px system-ui;letter-spacing:.08em';
  tag.textContent = 'ORB REVIEW';
  stage.appendChild(tag);
  document.body.appendChild(stage);
  return true;
})()`;

const PLANT = `(function(name, palette, lite, bandOnly){
  var stage = document.getElementById('orb-review-stage');
  if (!stage) return 'no stage';
  Array.from(stage.querySelectorAll('[id^="orb-review-"]')).forEach(function (n) { n.remove(); });
  var src = document.getElementById('companion');
  var clone = src.cloneNode(true);
  clone.removeAttribute('id');
  clone.classList.toggle('is-lite', Boolean(lite));
  clone.style.cssText += ';display:block;position:absolute;left:40px;top:60px;width:38px;height:42px;inset:auto;transform:scale(6);transform-origin:0 0;animation:none';
  // The orb tokens live on the .pill[data-companion=true] .companion rule; the
  // detached clone has no pill ancestor, so copy the live computed values.
  var live = getComputedStyle(src);
  ['--blob-glow','--glow-core','--glow-green','--glow-gold','--glow-orange','--glow-cyan','--glow-cobalt',
   '--glow-magenta','--glow-pool-cold','--glow-blue-deep','--glow-ember','--level','--act','--look-x','--look-y']
    .forEach(function (v) {
      var val = live.getPropertyValue(v).trim();
      if (val) clone.style.setProperty(v, val);
    });
  if (bandOnly) {
    // Isolation view: only the iris band stack + rim; everything else off so
    // gradient construction can be judged against the reference next to it.
    ['.blob-body','.blob-tint','.blob-glass','.blob-pool','.blob-dots','.blob-spec',
     '.blob-eyes','.blob-cheek','.blob-smile','.blob-mouth','.blob-variant']
      .forEach(function (sel) {
        clone.querySelectorAll(sel).forEach(function (el) { el.style.display = 'none'; });
      });
    // bandOnly may hold a single band name ('.band-core' etc) — when set, every
    // OTHER band hides too: four clones give one clean plate per layer.
    if (bandOnly !== true) {
      clone.querySelectorAll('.blob-band').forEach(function (el) {
        if (!el.matches(bandOnly)) el.style.display = 'none';
      });
    }
  }
  var wrap = document.createElement('div');
  wrap.id = 'orb-review-' + name;
  wrap.style.cssText = 'position:absolute;left:0;top:0;width:720px;height:340px;pointer-events:none';
  var label = document.createElement('div');
  label.style.cssText = 'position:absolute;left:' + (40 + 6 * 38 + 14) + 'px;top:64px;color:#dfe6ef;font:600 13px system-ui';
  label.textContent = name + ' | ' + (clone.dataset.expression || '?') + ' | ' + (lite ? 'lite' : (palette || 'rainbow')) + ' | level ' + (clone.style.getPropertyValue('--level') || '0') + (bandOnly ? ' | BANDS ONLY' : '');
  wrap.appendChild(label);
  wrap.appendChild(clone);
  stage.appendChild(wrap);
  return true;
})`;

async function shoot(contents, name) {
  const capture = await overlay.getWindow().webContents.capturePage({ x: 0, y: 0, width: 760, height: 360 });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, capture.toPNG());
  console.log(`saved ${file}`);
}

async function main() {
  const { app, ipcMain } = require('electron');
  const { createOverlay } = require(path.join(__dirname, '..', 'lib', 'overlay.cjs'));
  ipcMain.removeAllListeners('brand:name');
  ipcMain.on('brand:name', (event) => { event.returnValue = 'Voxa'; });
  app.on('window-all-closed', () => {});
  overlay = createOverlay({ log: { info: () => {}, warn: () => {}, error: () => {} } });
  await app.whenReady();
  overlay.create();
  const contents = overlay.getWindow().webContents;
  await waitForRenderer(contents);
  await sleep(2400);
  await emulateMotion(contents, true);
  await contents.executeJavaScript(STAGE, true);
  await contents.executeJavaScript('document.getElementById("orb-review-stage").style.opacity', true);

  // Rainbow listening, level 1 (mirror the harness wave payload).
  overlay.show({ status: 'listening', companionEnabled: true, message: 'Speak naturally. Release to send.' });
  await sleep(2200);
  const probe = await contents.executeJavaScript(`(function(){
    applyAudioLevel(0.55, Array.from({length:16},function(_,i){return i%2?0.85:0.4;}));
    var c = document.getElementById('companion');
    return { applied: true, inlineIsLevel: c.style.getPropertyValue('--level'),
      computedLevel: getComputedStyle(c).getPropertyValue('--level'),
      compDisplay: getComputedStyle(c).display,
      pillCompanion: document.getElementById('notch').dataset.companion };
  })()`, true);
  console.log('wave probe:', JSON.stringify(probe));
  await sleep(700);
  const plantResult = await contents.executeJavaScript(`${PLANT}("rainbow-listen", null, false)`, true);
  console.log('plant result:', JSON.stringify(plantResult));
  const cloneProbe = await contents.executeJavaScript(`(function(){
    var clone = document.getElementById('orb-review-rainbow-listen').querySelector('.companion');
    var band = clone.querySelector('.band-core');
    var st = getComputedStyle(band);
    var rectOf = function (sel) { var el = clone.querySelector(sel); if (!el) return 'missing'; var r = el.getBoundingClientRect(); return sel + ':' + r.x.toFixed(0) + ',' + r.y.toFixed(0) + ' ' + r.width.toFixed(0) + 'x' + r.height.toFixed(0); };
    return { cloneLevel: getComputedStyle(clone).getPropertyValue('--level'),
      bandOpacity: st.opacity, bandFilter: st.filter,
      cloneAnim: st.animationName,
      rects: [rectOf('.blob'), rectOf('.blob-shape'), rectOf('.blob-body'),
        rectOf('.band-core'), rectOf('.band-iris-left'), rectOf('.band-iris-cyan'), rectOf('.band-iris-right'),
        rectOf('.blob-glass'), rectOf('.pool-l'), rectOf('.pool-r'), rectOf('.blob-dots'),
        rectOf('.spec-top'), rectOf('.spec-arc'), rectOf('.tint-cold'), rectOf('.tint-ember')] };
  })()`, true);
  console.log('clone probe:', JSON.stringify(cloneProbe, null, 1));
  await sleep(350);
  await shoot(contents, 'orb-review-rainbow-listening.png');

  // Isolation plates: one band per screenshot, so each gradient can be judged
  // cleanly.
  for (const band of ['.band-core', '.band-iris-left', '.band-iris-cyan', '.band-iris-right']) {
    const id = band.replace(/[.]/g, '-');
    await contents.executeJavaScript(`${PLANT}("plate", null, false, ${JSON.stringify(band)})`, true);
    await sleep(300);
    await shoot(contents, `orb-band-plate${id}.png`);
  }

  // Voxa palette (the dataset attr drives the override).
  await contents.executeJavaScript('document.getElementById("notch").dataset.glowPalette = "voxa"', true);
  await sleep(500);
  await contents.executeJavaScript(`${PLANT}("voxa-listen", "voxa", false)`, true);
  await sleep(350);
  await shoot(contents, 'orb-review-voxa-listening.png');
  await contents.executeJavaScript('document.getElementById("notch").removeAttribute("data-glow-palette")', true);
  await sleep(400);

  // Thinking (mood act 1.05, lower band energy)
  await contents.executeJavaScript('applyAudioLevel(0.18, Array.from({length:16},(_,i)=>i%2?0.3:0.12))', true);
  overlay.show({ status: 'thinking', companionEnabled: true, message: 'Transcribing, one moment please…' });
  await sleep(2200);
  await contents.executeJavaScript(`${PLANT}("thinking", null, false)`, true);
  await sleep(250);
  await shoot(contents, 'orb-review-thinking.png');

  // Lite fallback at the same level.
  await contents.executeJavaScript('applyAudioLevel(0.55, Array.from({length:16},(_,i)=>i%2?0.85:0.4))', true);
  overlay.show({ status: 'listening', companionEnabled: true, message: 'Speak naturally. Release to send.' });
  await sleep(2200);
  await contents.executeJavaScript(`${PLANT}("lite", null, true)`, true);
  await sleep(250);
  await shoot(contents, 'orb-review-lite.png');

  await emulateMotion(contents, false);
  setTimeout(() => app.quit(), 200);
  setTimeout(() => process.exit(0), 1400);
}

main().catch((error) => { console.error(error); process.exit(1); });
