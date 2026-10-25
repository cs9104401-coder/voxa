'use strict';

// Island visual + geometric verification harness (dev-only; never shipped:
// package.json excludes scripts/** from the build).
//  1. Offline pixel audit: decodes the dormant companion PNGs (unused by the
//     renderer since the CSS blob mascot, but still on disk) and proves no pixel
//     of that sprite can be clipped by the pill's rounded corners at any size.
//  2. Static sync check: the [data-size] band rules in island.css must mirror
//     ISLAND_SIZES in renderer/overlay.js.
//  3. Runtime check: drives the REAL overlay window through every state with the
//     real renderer, waits for the springs to settle, captures a screenshot and
//     measures the live DOM rects against expectations.
// Run: npx electron scripts/island-capture.cjs
// Output: PNGs + island-metrics.json under %TEMP%\opencode\island-capture\

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const REPO = path.join(__dirname, '..');
const OUT = path.join(process.env.TEMP || 'C:/Users/Shoyo/AppData/Local/Temp/opencode', 'island-capture');
fs.mkdirSync(OUT, { recursive: true });

const results = { audit: [], sync: [], runtime: [], screenshots: [] };
let failed = 0;
const fail = (label, text) => { failed += 1; results[label].push({ ok: false, text }); console.log(`FAIL ${text}`); };
const pass = (label, text) => { results[label].push({ ok: true, text }); console.log(`pass ${text}`); };

// ---------- PNG decode / encode (no dependencies) ----------

function decodePNG(file) {
  const buffer = fs.readFileSync(file);
  let offset = 8;
  const chunks = [];
  let width = 0;
  let height = 0;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    else if (type === 'IDAT') chunks.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const out = Buffer.alloc(height * stride);
  let position = 0;
  const paeth = (a, b, c) => { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y += 1) {
    const filter = raw[position++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const value = raw[position++];
      const left = x >= 4 ? row[x - 4] : 0;
      const up = previous[x];
      const upperLeft = x >= 4 ? previous[x - 4] : 0;
      let decoded;
      if (filter === 0) decoded = value;
      else if (filter === 1) decoded = value + left;
      else if (filter === 2) decoded = value + up;
      else if (filter === 3) decoded = value + ((left + up) >> 1);
      else decoded = value + paeth(left, up, upperLeft);
      row[x] = decoded & 255;
    }
  }
  return { width, height, data: out, stride };
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let index = 0; index < buffer.length; index += 1) c = CRC_TABLE[(c ^ buffer[index]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function flattenPNG(file, out, color) {
  const image = decodePNG(file);
  const rgb = Buffer.alloc(image.width * image.height * 3);
  for (let index = 0; index < image.width * image.height; index += 1) {
    const alpha = image.data[index * 4 + 3] / 255;
    rgb[index * 3] = Math.round(image.data[index * 4] * alpha + color[0] * (1 - alpha));
    rgb[index * 3 + 1] = Math.round(image.data[index * 4 + 1] * alpha + color[1] * (1 - alpha));
    rgb[index * 3 + 2] = Math.round(image.data[index * 4 + 2] * alpha + color[2] * (1 - alpha));
  }
  const raw = Buffer.alloc((image.width * 3 + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (image.width * 3 + 1)] = 0;
    rgb.copy(raw, y * (image.width * 3 + 1) + 1, y * image.width * 3, (y + 1) * image.width * 3);
  }
  fs.writeFileSync(out, encodePNGOpaque(image.width, image.height, raw));
}

function encodePNGOpaque(width, height, rgbRows) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rgbRows, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- 1. Offline corner-clip audit ----------

// Geometry constants of the dormant PNG sprite from its last shipped CSS layout
// (island.css before the blob avatar grid): height H, width H*538/685, body 27.59%.
// Only auditClip() consumes these; the runtime grid checks use PAD_X below.
const SIZES = {
  compact: { W: 208, H: 88, R: 44, padL: 18, lead: 66, charH: 84 },
  medium: { W: 340, H: 104, R: 24, padL: 16, lead: 72, charH: 88 },
  expanded: { W: 520, H: 128, R: 26, padL: 16, lead: 94, charH: 116 },
  notchCompact: { W: 544, H: 88, R: 22, padL: 18, lead: 66, charH: 84 }
};

// Shared horizontal padding of the header/text/footer grid per size (island.css --pad-x).
const PAD_X = { compact: 18, medium: 16, expanded: 16 };

function leftInset(y, R, H) {
  if (y >= R && y <= H - R) return 0;
  const dy = y < R ? R - y : y - (H - R);
  return R - Math.sqrt(R * R - dy * dy);
}

function auditClip() {
  const head = decodePNG(path.join(REPO, 'assets', 'companion', 'companion-head.png'));
  const body = decodePNG(path.join(REPO, 'assets', 'companion', 'companion-body.png'));
  if (head.width !== 538 || head.height !== 506 || body.width !== 538 || body.height !== 189) {
    fail('audit', `companion PNG dimensions changed: head ${head.width}x${head.height}, body ${body.width}x${body.height}`);
    return;
  }
  for (const [name, size] of Object.entries(SIZES)) {
    const scale = size.charH / 685;
    const charW = size.charH * 538 / 685;
    const x0 = size.padL + (size.lead - charW) / 2;
    const charY = size.H - size.charH;
    const headTop = charY;
    const bodyTop = size.H - size.charH * 2759 / 10000;
    let worst = Infinity;
    let worstAt = '';
    const scan = (image, baseY) => {
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          if (image.data[y * image.stride + x * 4 + 3] <= 24) continue;
          const px = x0 + x * scale;
          const py = baseY + y * scale;
          if (px < 0 || px >= size.W) { // outside the pill horizontally
            continue;
          }
          const inset = leftInset(py, size.R, size.H);
          const marginFromLeft = px - inset;
          const marginFromRight = size.W - inset - px;
          const margin = Math.min(marginFromLeft, marginFromRight);
          if (margin < worst) { worst = margin; worstAt = `px(${x},${y}) page(${px.toFixed(1)},${py.toFixed(1)})`; }
        }
      }
    };
    scan(head, headTop);
    scan(body, bodyTop);
    if (worst >= 1.5) pass('audit', `${name}: corner clip margin ${worst.toFixed(1)}px (worst ${worstAt})`);
    else fail('audit', `${name}: corner clip margin ${worst.toFixed(1)}px at ${worstAt}`);
  }
}

// ---------- 2. Static sync check (CSS bands <-> JS ISLAND_SIZES) ----------

function syncCheck() {
  const css = fs.readFileSync(path.join(REPO, 'renderer', 'island.css'), 'utf8');
  const js = fs.readFileSync(path.join(REPO, 'renderer', 'overlay.js'), 'utf8');
  const band = {};
  for (const size of ['compact', 'medium', 'expanded']) {
    const match = css.match(new RegExp(`\\.pill\\[data-size=${size}\\] \\.pill-head\\{height:(\\d+)px`));
    band[size] = match ? Number(match[1]) : null;
  }
  const padX = {};
  padX.compact = Number((css.match(/\.pill\{[^}]*--pad-x:(\d+)px/) || [])[1]);
  for (const size of ['medium', 'expanded']) {
    const match = css.match(new RegExp(`\\.pill\\[data-size=${size}\\]\\{[^}]*--pad-x:(\\d+)px`));
    padX[size] = match ? Number(match[1]) : null;
  }
  const jsSizes = js.match(/const ISLAND_SIZES = \{[\s\S]*?\};/);
  if (!jsSizes) { fail('sync', 'ISLAND_SIZES not found in overlay.js'); return; }
  const block = jsSizes[0];
  const jsCompact = block.match(/compact:\s*\{\s*width:\s*(\d+),\s*height:\s*(\d+)/);
  const jsMedium = block.match(/medium:\s*\{\s*(?:width:\s*\d+,\s*)?height:\s*(\d+)/);
  const jsExpandedWidth = block.match(/expanded:\s*\{\s*width:\s*(\d+)/);
  const jsRail = parseInt((block.match(/rail:\s*(\d+)/) || [])[1], 10);
  const jsNotch = parseInt((js.match(/const NOTCH_WIDTH = (\d+)/) || [])[1], 10);
  const checks = [
    ['compact band css/js', band.compact, Number(jsCompact[2])],
    ['medium band css/js', band.medium, Number(jsMedium[1])],
    ['expanded rail css/js', band.expanded, jsRail],
    ['compact pad css/harness', padX.compact, PAD_X.compact],
    ['medium pad css/harness', padX.medium, PAD_X.medium],
    ['expanded pad css/harness', padX.expanded, PAD_X.expanded]
  ];
  for (const [label, a, b] of checks) {
    if (a === b) pass('sync', `${label} = ${b}`);
    else fail('sync', `${label}: css ${a} vs js/harness ${b}`);
  }
  if (jsNotch >= Number(jsExpandedWidth[1]) + 20) pass('sync', `notch width ${jsNotch} >= expanded ${jsExpandedWidth[1]} + 20`);
  else fail('sync', `notch width ${jsNotch} vs expanded ${jsExpandedWidth[1]}`);
}

// ---------- 3. Runtime scenarios ----------

const SAMPLE_ANSWER = [
  'Here is the capture sample answer so we can judge the expanded card.',
  '',
  '- It has a short list item',
  '- And a second one',
  '',
  '`inline code` and **bold text** render, plus a sentence long enough to wrap around the card width twice without any trouble at all.'
].join('\n');

const scenarios = [
  { name: 'compact-idle', style: 'island', wait: 2300, patch: { status: 'idle' } },
  { name: 'compact-listening', style: 'island', wait: 2300, patch: { status: 'listening', message: 'Speak naturally. Release to send.' } },
  { name: 'medium-thinking', style: 'island', wait: 3000, patch: { status: 'thinking', message: 'Transcribing, one moment please…' } },
  { name: 'medium-done', style: 'island', wait: 2300, patch: { status: 'done' } },
  { name: 'expanded-answer', style: 'island', wait: 3200, patch: { status: 'answer', canCopy: true, speaking: true, approval: null, message: SAMPLE_ANSWER } },
  { name: 'expanded-approval', style: 'island', wait: 3000, patch: { status: 'approval', approval: { id: 'harness', title: 'Allow this sample action?', detail: 'Harness preview — nothing will run.', tool: 'type_text' } } },
  { name: 'expanded-error', style: 'island', wait: 2600, patch: { status: 'error', message: 'Something failed on purpose so we can inspect the error state.' } },
  { name: 'expanded-chat', style: 'island', wait: 3200, patch: { status: 'chat', chatOpen: true, chatPreview: true } },
  { name: 'back-compact', style: 'island', wait: 2600, patch: { status: 'idle' } },
  { name: 'notch-compact-idle', style: 'notch', wait: 2400, patch: { status: 'idle' } },
  { name: 'notch-compact-listening', style: 'notch', wait: 2400, patch: { status: 'listening', message: 'Speak naturally. Release to send.' } },
  { name: 'notch-medium', style: 'notch', wait: 2600, patch: { status: 'thinking', message: 'Transcribing…' } },
  { name: 'notch-expanded-answer', style: 'notch', wait: 3000, patch: { status: 'answer', canCopy: true, approval: null, message: SAMPLE_ANSWER } },
  { name: 'notch-chat', style: 'notch', wait: 3200, patch: { status: 'chat', chatOpen: true, chatPreview: true } },
  { name: 'compact-idle-nochar', style: 'island', wait: 2400, patch: { status: 'idle', companionEnabled: false } },
  { name: 'slow-mid-transition', style: 'island', wait: 950, slow: true, noAssert: true, patch: { status: 'answer', canCopy: true, approval: null, message: SAMPLE_ANSWER } }
];

const MEASURE = `(() => {
  const rect = (el) => el ? (({ x, y, width, height }) => ({ x: +x.toFixed(1), y: +y.toFixed(1), width: +width.toFixed(1), height: +height.toFixed(1) }))(el.getBoundingClientRect()) : null;
  const pillEl = document.getElementById('notch');
  const charEl = document.querySelector('.companion');
  return {
    pill: rect(pillEl),
    head: rect(document.querySelector('.pill-head')),
    char: rect(charEl),
    charVisible: charEl ? getComputedStyle(charEl).display !== 'none' : false,
    expression: charEl ? charEl.dataset.expression : null,
    blob: rect(document.querySelector('.blob')),
    blobEyes: rect(document.querySelector('.blob-eyes')),
    label: rect(document.querySelector('.state-label')),
    actions: rect(document.querySelector('.head-actions')),
    cardActions: rect(document.querySelector('.card-actions')),
    text: rect(document.querySelector('.card-text')),
    zone: rect(document.querySelector('.head-center')),
    radius: getComputedStyle(pillEl).borderRadius,
    radiusBL: getComputedStyle(pillEl).borderBottomLeftRadius,
    inline: { width: pillEl.style.width, height: pillEl.style.height, radius: pillEl.style.borderRadius, transform: pillEl.style.transform, filter: pillEl.style.filter, opacity: pillEl.style.opacity },
    dpr: window.devicePixelRatio,
    charH: charEl ? getComputedStyle(charEl).height : null,
    size: pillEl.dataset.size,
    status: pillEl.dataset.state
  };
})()`;
let overlay = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRenderer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const ready = await overlay.getWindow().webContents.executeJavaScript('Boolean(window.voiceAgent)', true);
      if (ready) return;
    } catch { /* not loaded yet */ }
    await sleep(150);
  }
  throw new Error('overlay renderer never signalled readiness');
}

async function runtimeCheck() {
  const { app, ipcMain } = require('electron');
  const { createOverlay } = require(path.join(REPO, 'lib', 'overlay.cjs'));
  // The real main.cjs answers this once; the harness stubs it so labels show the
  // actual app name instead of the no-listener fallback.
  ipcMain.removeAllListeners('brand:name');
  ipcMain.on('brand:name', (event) => { event.returnValue = 'Voxa'; });
  overlay = createOverlay({ log: { info: () => {}, warn: (tag, text) => console.log(`[warn:${tag}] ${text}`), error: (tag, text) => console.log(`[error:${tag}] ${text}`) } });
  await app.whenReady();
  overlay.create();
  await waitForRenderer();
  const contents = overlay.getWindow().webContents;

  const saveResults = () => fs.writeFileSync(path.join(OUT, 'island-metrics.json'), JSON.stringify(results, null, 2));
  for (const scenario of scenarios) {
    try {
      overlay.setStyle(scenario.style);
      if (scenario.slow) overlay.setPreviewOptions({ slowMotion: true });
      overlay.hideNow();
      await sleep(420);
      overlay.show(scenario.patch);
      await sleep(scenario.wait);
      let metrics = null;
      try {
        metrics = JSON.parse(JSON.stringify(await contents.executeJavaScript(MEASURE, true)));
      } catch (error) {
        fail('runtime', `${scenario.name}: measure failed: ${error.message}`);
        continue;
      }
      const capture = await overlay.getWindow().webContents.capturePage();
      const pngPath = path.join(OUT, `${scenario.name}.png`);
      fs.writeFileSync(pngPath, capture.toPNG());
      flattenPNG(pngPath, pngPath, [35, 38, 43]);
      results.screenshots.push(pngPath);
      console.log(`saved ${pngPath}`);
      if (!scenario.noAssert) assertScenario(scenario, metrics);
      if (scenario.slow) overlay.setPreviewOptions({ slowMotion: false });
      results.runtime.push({ name: scenario.name, metrics });
    } catch (error) {
      fail('runtime', `${scenario.name}: scenario crashed: ${error && error.stack || error}`);
    }
    saveResults();
  }

  overlay.hideNow();
  await sleep(400);
  overlay.destroy();
  await sleep(120);
  app.quit();
}

function within(actual, expected, tolerance, label, scenario) {
  if (actual == null) { fail('runtime', `${scenario.name}: ${label} missing`); return; }
  if (Math.abs(actual - expected) <= tolerance) pass('runtime', `${scenario.name}: ${label} ${actual} ≈ ${expected} (±${tolerance})`);
  else fail('runtime', `${scenario.name}: ${label} ${actual} vs expected ${expected} (±${tolerance})`);
}

function relaxedAtLeast(actual, minimum, label, scenario) {
  if (actual == null) { fail('runtime', `${scenario.name}: ${label} missing`); return; }
  if (actual >= minimum) pass('runtime', `${scenario.name}: ${label} ${actual} >= ${minimum}`);
  else fail('runtime', `${scenario.name}: ${label} ${actual} < minimum ${minimum}`);
}

function assertScenario(scenario, m) {
  const notch = scenario.name.includes('notch');
  const size = m.size;
  if (!m.pill) { fail('runtime', `${scenario.name}: no pill rect`); return; }
  const radiusPx = parseFloat(notch ? m.radiusBL : m.radius);
  const padX = PAD_X[size] ?? PAD_X.compact;
  if (size === 'compact') {
    within(m.pill.width, notch ? 544 : 208, 1.5, 'pill width', scenario);
    within(m.pill.height, 88, 1.5, 'pill height', scenario);
    within(radiusPx, notch ? 22 : 44, 1, 'pill radius', scenario);
  } else if (size === 'medium') {
    within(m.pill.width, notch ? 544 : 340, 1.5, 'pill width', scenario);
    within(m.pill.height, 104, 1.5, 'pill height', scenario);
    within(radiusPx, notch ? 22 : 24, 1, 'pill radius', scenario);
  } else {
    within(m.pill.width, notch ? 544 : 520, 1.5, 'pill width', scenario);
    within(radiusPx, notch ? 22 : 26, 1, 'pill radius', scenario);
    relaxedAtLeast(m.pill.height, 214, 'expanded height includes card', scenario);
    if (m.head) within(m.head.height, 128, 1.5, 'expanded rail height', scenario);
  }
  // Shared grid: card text sits on --pad-x; when the blob is up, it shares that edge.
  // Display-hidden elements report 0x0 rects, so guard on real widths (chat state).
  const hasText = m.text && m.text.width > 0;
  const hasBlob = m.blob && m.blob.width > 0;
  if (hasText) {
    within(m.text.x, m.pill.x + padX, 1.5, 'card text left edge on shared pad', scenario);
    if (hasBlob) {
      within(m.blob.x, m.pill.x + padX, 3.5, 'blob left edge on shared pad', scenario);
      within(m.blob.x, m.text.x, 3.5, 'blob left == text left (shared grid)', scenario);
    }
  } else if (m.status !== 'chat') {
    fail('runtime', `${scenario.name}: card-text rect missing`);
  }
  if (m.actions) within(m.actions.x + m.actions.width, m.pill.x + m.pill.width - padX, 2, 'header buttons right on shared pad', scenario);
  if (size === 'expanded') {
    if (m.cardActions && m.cardActions.width > 0) within(m.cardActions.x + m.cardActions.width, m.pill.x + m.pill.width - padX, 2, 'footer actions right on shared pad', scenario);
    if (m.label) {
      within(m.label.y + m.label.height / 2, m.head.y + m.head.height / 2, 3.5, 'label centered on head band', scenario);
      if (hasBlob) within(m.label.x - (m.blob.x + m.blob.width), 10, 4, 'label gap after blob', scenario);
    }
  }
  // Blob slot geometry: avatar box, centered on the head band, strictly inside the pill.
  if (m.charVisible) {
    within(m.char.width, 38, 1.5, 'blob slot width', scenario);
    within(m.char.height, 42, 1.5, 'blob slot height', scenario);
    if (m.head && hasBlob) within(m.blob.y + m.blob.height / 2, m.head.y + m.head.height / 2, 4, 'blob centered on head band', scenario);
    if (hasBlob) {
      const insidePill = m.blob.x >= m.pill.x + 2
        && m.blob.x + m.blob.width <= m.pill.x + m.pill.width - 2
        && m.blob.y >= m.pill.y + 2
        && m.blob.y + m.blob.height <= m.pill.y + m.pill.height - 2;
      if (insidePill) pass('runtime', `${scenario.name}: blob fully inside pill bounds`);
      else fail('runtime', `${scenario.name}: blob exceeds pill bounds`);
    }
  } else if (!scenario.name.includes('nochar')) {
    fail('runtime', `${scenario.name}: companion not visible`);
  }
  if (m.head) within(m.head.y, m.pill.y, 1, 'head band top', scenario);
  if (m.zone) {
    relaxedAtLeast(m.zone.width, 20, 'center zone width', scenario);
    if (m.pill) {
      if (m.zone.x >= m.pill.x + 4 && m.zone.x + m.zone.width <= m.pill.x + m.pill.width - 4) {
        pass('runtime', `${scenario.name}: center zone inside pill`);
      } else fail('runtime', `${scenario.name}: center zone exceeds pill bounds`);
    }
  }
}

// ---------- run ----------

auditClip();
syncCheck();
process.on('uncaughtException', (error) => {
  console.error('harness uncaught:', error && error.stack || error);
  try { fs.writeFileSync(path.join(OUT, 'island-metrics.json'), JSON.stringify(results, null, 2)); } catch { /* best effort */ }
  setTimeout(() => process.exit(1), 200);
});
process.on('unhandledRejection', (error) => {
  console.error('harness unhandled rejection:', error && (error.stack || error.message) || error);
});
runtimeCheck().then(() => {
  fs.writeFileSync(path.join(OUT, 'island-metrics.json'), JSON.stringify(results, null, 2));
  console.log(failed === 0 ? `\nALL CHECKS PASSED — output in ${OUT}` : `\n${failed} check(s) FAILED — output in ${OUT}`);
  setTimeout(() => process.exit(failed === 0 ? 0 : 1), 1200);
}).catch((error) => {
  console.error('harness crashed:', error);
  fs.writeFileSync(path.join(OUT, 'island-metrics.json'), JSON.stringify(results, null, 2));
  try { overlay?.destroy(); } catch { /* already gone */ }
  setTimeout(() => process.exit(1), 300);
});
