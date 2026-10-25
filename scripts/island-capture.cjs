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

// Geometry constants of the dormant PNG sprite from its legacy CSS layout.
// Only auditClip() consumes these; the runtime grid checks use PAD_X below.
// Stage-2 expanded models the blob inside the 640x190 pill with the 34px
// bottom radius; the sprite band there is drawn lower than the real strip, so
// a pass proves the real (higher) placement clears the corners with room.
const SIZES = {
  compact: { W: 208, H: 88, R: 44, padL: 18, lead: 66, charH: 84 },
  medium: { W: 340, H: 104, R: 24, padL: 16, lead: 72, charH: 88 },
  expanded: { W: 640, H: 190, R: 34, padL: 16, lead: 94, charH: 116 },
  notchCompact: { W: 660, H: 88, R: 22, padL: 18, lead: 66, charH: 84 }
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
  for (const size of ['compact', 'medium']) {
    const match = css.match(new RegExp(`\\.pill\\[data-size=${size}\\] \\.pill-head\\{height:(\\d+)px`));
    band[size] = match ? Number(match[1]) : null;
  }
  // Expanded split stack: the tab rail (.pill-tabs) always shows, the assistant
  // strip (.pill-head, 56px) only on Assistant states.
  const strip = Number((css.match(/\.pill\[data-size=expanded\] \.pill-head\{height:(\d+)px/) || [])[1]);
  const tabRail = Number((css.match(/\.pill\[data-size=expanded\] \.pill-tabs\{height:(\d+)px/) || [])[1]);
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
  const jsStrip = parseInt((block.match(/strip:\s*(\d+)/) || [])[1], 10);
  const jsHome = parseInt((block.match(/home:\s*(\d+)/) || [])[1], 10);
  const jsNotch = parseInt((js.match(/const NOTCH_WIDTH = (\d+)/) || [])[1], 10);
  // Token rules the layout depends on (tokens.css, scoped to .notch-body).
  const tokens = fs.readFileSync(path.join(REPO, 'renderer', 'tokens.css'), 'utf8');
  const tokenBlock = tokens.match(/\.notch-body\s*\{[\s\S]*?\n\}/);
  if (!tokenBlock) { fail('sync', '.notch-body island token block missing in tokens.css'); return; }
  const tokenSource = tokenBlock[0];
  const cardH = parseInt((tokenSource.match(/--island-card-h:\s*(\d+)px/) || [])[1], 10);
  const homePad = parseInt((css.match(/\.island-home\{[^}]*padding:0 var\(--pad-x\) (\d+)px/) || [])[1], 10);
  const checks = [
    ['compact band css/js', band.compact, Number(jsCompact[2])],
    ['medium band css/js', band.medium, Number(jsMedium[1])],
    ['expanded tab rail css/js', tabRail, jsRail],
    ['expanded assistant strip css/js', strip, jsStrip],
    ['expanded home stack css/js', tabRail + cardH + homePad + 2, jsHome],
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
  const tokenChecks = [
    ['island surface pure black', /--island-surface:\s*#000\b/, tokenBlock[0]],
    ['no hairline token', /--island-hairline:\s*transparent/, tokenBlock[0]],
    ['expanded radius 34', /--island-radius-expanded:\s*34px/, tokenBlock[0]],
    ['tab size 36', /--island-tab:\s*36px/, tokenBlock[0]],
    ['island ease', /--island-ease:\s*cubic-bezier\(0\.32,\s*0\.72,\s*0,\s*1\)/, tokenBlock[0]],
    ['island duration 300ms', /--island-dur:\s*300ms/, tokenBlock[0]],
    ['time gradients', /--time-grad-day:[\s\S]*?;[\s\S]*?--time-grad-evening:[\s\S]*?;[\s\S]*?--time-grad-night:/, tokenBlock[0]]
  ];
  for (const [label, pattern, source] of tokenChecks) {
    if (pattern.test(source)) pass('sync', label);
    else fail('sync', `${label} missing/mismatched in tokens.css`);
  }
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

// Notification feed samples (Phase B): same shape main.cjs galleryNotifications() sends.
const FEED_SAMPLES = [
  { id: 'feed-a', title: 'Agent finished the task', body: 'Opened Notepad and typed the review notes. Everything went through the approval you allowed.', ts: Date.now(), kind: 'turn', tone: 'highlight' },
  { id: 'feed-b', title: 'Whisper model downloaded', body: 'Voice recognition model staged and ready to transcribe.', ts: Date.now() - 14 * 60000, kind: 'download', tone: 'neutral' },
  { id: 'feed-c', title: 'Media controls connected', body: 'Playback info and controls are wired to the island.', ts: Date.now() - 52 * 60000, kind: 'media', tone: 'neutral' }
];

// Media pill samples (Phase F): same shape mediaSmtc.normalizeMedia() sends.
// Harness metadata only — real SMTC sessions are verified live.
const MEDIA_SAMPLE = {
  title: 'Sample track', artist: 'Sample artist', app: 'Sample player',
  playing: true, canToggle: true, canNext: true, canPrev: true
};
const MEDIA_PAUSED_SAMPLE = { ...MEDIA_SAMPLE, playing: false };

// Live-feed samples (Phase G): NEW ids so the cards count as unseen events —
// reopening the same ids must NOT replay the cascade (Phase D contract).
const LIVE_FEED_SAMPLES = FEED_SAMPLES.map((item, index) => ({
  ...item,
  id: `live-${['a', 'b', 'c'][index]}`,
  ts: Date.now() - index * 60000
}));

// Download live-activity sample (Phase H): same shape
// lib/island-download.cjs produces from real producer payloads — label names
// the model, percent comes from the server, never invented here.
const DOWNLOAD_SAMPLE = { phase: 'downloading', label: 'Whisper · medium', percent: 42 };
const DOWNLOAD_DONE_SAMPLE = { phase: 'loading', label: 'Whisper · medium', percent: null };

const scenarios = [
  { name: 'compact-idle', style: 'island', wait: 2300, patch: { status: 'idle' } },
  { name: 'compact-listening', style: 'island', wait: 2300, patch: { status: 'listening', message: 'Speak naturally. Release to send.' } },
  { name: 'medium-thinking', style: 'island', wait: 3000, patch: { status: 'thinking', message: 'Transcribing, one moment please…' } },
  { name: 'medium-done', style: 'island', wait: 2300, patch: { status: 'done' } },
  { name: 'medium-media', style: 'island', wait: 2600, patch: { status: 'media', media: MEDIA_SAMPLE } },
  { name: 'medium-media-paused', style: 'island', wait: 2600, patch: { status: 'media', media: MEDIA_PAUSED_SAMPLE } },
  { name: 'expanded-answer', style: 'island', wait: 3200, patch: { status: 'answer', canCopy: true, speaking: true, approval: null, message: SAMPLE_ANSWER } },
  { name: 'expanded-approval', style: 'island', wait: 3000, patch: { status: 'approval', approval: { id: 'harness', title: 'Allow this sample action?', detail: 'Harness preview — nothing will run.', tool: 'type_text' } } },
  { name: 'expanded-error', style: 'island', wait: 2600, patch: { status: 'error', message: 'Something failed on purpose so we can inspect the error state.' } },
  { name: 'expanded-feed', style: 'island', wait: 2800, noBlob: true, patch: { status: 'feed', feedPreview: true, notifications: FEED_SAMPLES } },
  // Stage 2 Home tab: pinned expansion on an idle pill lands on the tab rail +
  // preview media card + local time card. The blob stays with the Assistant
  // strip, so the companion is expected hidden here (noBlob).
  { name: 'expanded-home', style: 'island', wait: 2600, noBlob: true, patch: { status: 'idle', expand: 'pinned', message: '', notifications: [], download: null } },
  // Phase G: the LIVE stack (opened by a real click, not the gallery) — same
  // layout rules, but no PREVIEW ONLY badge: it holds real Voxa events.
  { name: 'live-feed', style: 'island', wait: 2800, feedPreview: false, noBlob: true, patch: { status: 'feed', feedPreview: false, notifications: LIVE_FEED_SAMPLES, message: '' } },
  // G/H legibility fix: content on a resting pill renders on the medium band,
  // because compact hides the state label (opacity 0). This scenario pins the
  // unread toast — the click affordance — to a readable label.
  { name: 'live-alert-toast', style: 'island', wait: 2800, feedPreview: false, wantLabel: 'Alerts · 3', patch: { status: 'idle', notifications: LIVE_FEED_SAMPLES, download: null, message: '' } },
  // Phase H: the download live activity on a resting pill — label names the
  // model and shows the server-reported percent; on completion it disappears
  // without an ornament.
  { name: 'live-download', style: 'island', wait: 2800, feedPreview: false, wantLabel: 'Whisper · medium · 42%', patch: { status: 'idle', notifications: [], download: DOWNLOAD_SAMPLE, message: '' } },
  { name: 'live-download-loading', style: 'island', wait: 2800, feedPreview: false, wantLabel: 'Whisper · medium · loading', patch: { status: 'idle', notifications: [], download: DOWNLOAD_DONE_SAMPLE, message: '' } },
  { name: 'live-download-done', style: 'island', wait: 2600, wantLabel: 'Idle', patch: { status: 'idle', notifications: [], download: null, message: '' } },
  { name: 'expanded-chat', style: 'island', wait: 3200, patch: { status: 'chat', chatOpen: true, chatPreview: true } },
  { name: 'back-compact', style: 'island', wait: 2600, patch: { status: 'idle' } },
  { name: 'notch-compact-idle', style: 'notch', wait: 2400, patch: { status: 'idle' } },
  { name: 'notch-compact-listening', style: 'notch', wait: 2400, patch: { status: 'listening', message: 'Speak naturally. Release to send.' } },
  { name: 'notch-medium', style: 'notch', wait: 2600, patch: { status: 'thinking', message: 'Transcribing…' } },
  { name: 'notch-expanded-answer', style: 'notch', wait: 3000, patch: { status: 'answer', canCopy: true, approval: null, message: SAMPLE_ANSWER } },
  { name: 'notch-chat', style: 'notch', wait: 3200, patch: { status: 'chat', chatOpen: true, chatPreview: true } },
  { name: 'compact-idle-nochar', style: 'island', wait: 2400, patch: { status: 'idle', companionEnabled: false } },
  // Phase D: interrupt the compact→medium spring mid-flight with a new target
  // (listening → thinking). Visual only: proves retargeting, not snapping.
  { name: 'retarget-mid-flight', style: 'island', wait: 620, noAssert: true, patch: { status: 'listening', message: 'Speak naturally. Release to send.' }, then: { after: 340, patch: { status: 'thinking', message: 'Retargeting mid-flight…' } } },
  { name: 'slow-mid-transition', style: 'island', wait: 950, slow: true, noAssert: true, patch: { status: 'answer', canCopy: true, approval: null, message: SAMPLE_ANSWER } },
  // --- Stage 2b activation orb: states x desktop backgrounds, palettes, Lite,
  // glow knob. bg is the composited desktop color for the screenshot; wave
  // injects synthetic mic levels so the iris band shows its lit shape;
  // palette/lite/glow are applied through the real DOM hooks (dataset attr,
  // is-lite class, setGlowLevel). Every patch re-pins companionEnabled:true —
  // the no-char scenario earlier in the list leaks its companionEnabled:false
  // through the persisted renderer state, which would hide the orb here.
  { name: 'glow-listening-light', style: 'island', wait: 2600, bg: [228, 229, 232], wave: true, patch: { status: 'listening', companionEnabled: true, message: 'Speak naturally. Release to send.' } },
  { name: 'glow-listening-color', style: 'island', wait: 2600, bg: [47, 110, 255], wave: true, patch: { status: 'listening', companionEnabled: true, message: 'Speak naturally. Release to send.' } },
  { name: 'glow-thinking-light', style: 'island', wait: 3000, bg: [228, 229, 232], patch: { status: 'thinking', companionEnabled: true, message: 'Transcribing, one moment please…' } },
  { name: 'glow-thinking-color', style: 'island', wait: 3000, bg: [124, 60, 196], patch: { status: 'thinking', companionEnabled: true, message: 'Transcribing, one moment please…' } },
  { name: 'glow-response-dark', style: 'island', wait: 3200, bg: [24, 26, 31], patch: { status: 'answer', companionEnabled: true, canCopy: true, speaking: false, approval: null, message: SAMPLE_ANSWER } },
  { name: 'glow-response-light', style: 'island', wait: 3200, bg: [228, 229, 232], patch: { status: 'answer', companionEnabled: true, canCopy: true, speaking: false, approval: null, message: SAMPLE_ANSWER } },
  { name: 'glow-error-light', style: 'island', wait: 2800, bg: [228, 229, 232], patch: { status: 'error', companionEnabled: true, approval: null, message: 'Something failed on purpose so we can inspect the error state.' } },
  { name: 'glow-error-color', style: 'island', wait: 2800, bg: [52, 54, 255], patch: { status: 'error', companionEnabled: true, approval: null, message: 'Something failed on purpose so we can inspect the error state.' } },
  { name: 'glow-palette-voxa', style: 'island', wait: 2600, bg: [47, 110, 255], palette: 'voxa', wave: true, patch: { status: 'listening', companionEnabled: true, message: 'Speak naturally. Release to send.' } },
  { name: 'glow-palette-voxa-answer', style: 'island', wait: 3000, bg: [35, 38, 43], palette: 'voxa', patch: { status: 'answer', companionEnabled: true, canCopy: true, approval: null, message: SAMPLE_ANSWER } },
  { name: 'glow-lite', style: 'island', wait: 2600, bg: [35, 38, 43], lite: true, wave: true, patch: { status: 'listening', companionEnabled: true, message: 'Speak naturally. Release to send.' } },
  { name: 'glow-full', style: 'island', wait: 2600, bg: [35, 38, 43], glow: 1.25, wave: true, patch: { status: 'listening', companionEnabled: true, message: 'Speak naturally. Release to send.' } },
  { name: 'glow-soft', style: 'island', wait: 2600, bg: [35, 38, 43], glow: 0.55, wave: true, patch: { status: 'listening', companionEnabled: true, message: 'Speak naturally. Release to send.' } }
];

const MEASURE = `(() => {
  const rect = (el) => el ? (({ x, y, width, height }) => ({ x: +x.toFixed(1), y: +y.toFixed(1), width: +width.toFixed(1), height: +height.toFixed(1) }))(el.getBoundingClientRect()) : null;
  const pillEl = document.getElementById('notch');
  const charEl = document.querySelector('.companion');
  return {
    pill: rect(pillEl),
    head: rect(document.querySelector('.pill-head')),
    tabs: rect(document.querySelector('.pill-tabs')),
    bodyOpacity: (() => {
      const el = document.querySelector('.pill-body');
      return el ? Number(getComputedStyle(el).opacity) : null;
    })(),
    tabActive: (() => {
      const node = document.querySelector('.tab-button.is-active');
      return node ? node.dataset.tab : null;
    })(),
    tab: (() => {
      const node = document.getElementById('notch');
      return node ? node.dataset.tab : null;
    })(),
    headVisible: (() => {
      const node = document.querySelector('.pill-head');
      return node ? getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().width > 0 : false;
    })(),
    mediaCard: (() => {
      const node = document.querySelector('.media-card');
      if (!node) return null;
      const badge = node.querySelector('.card-preview-badge');
      return {
        card: rect(node),
        art: rect(document.querySelector('.media-art')),
        title: document.getElementById('homeMediaTitle')?.textContent ?? null,
        progress: rect(document.querySelector('.media-progress')),
        transport: rect(document.querySelector('.media-card-controls')),
        badge: badge ? !badge.hidden && getComputedStyle(badge).display !== 'none' && badge.getBoundingClientRect().width > 0 : false
      };
    })(),
    timeCard: (() => {
      const node = document.getElementById('timeCard');
      if (!node) return null;
      return {
        card: rect(node),
        phase: node.dataset.phase ?? null,
        title: document.getElementById('timeTitle')?.textContent ?? null,
        temp: document.getElementById('timeTemp')?.textContent ?? null,
        dot: rect(document.getElementById('timeDot'))
      };
    })(),
    char: rect(charEl),
    charVisible: charEl ? getComputedStyle(charEl).display !== 'none' && charEl.getBoundingClientRect().width > 0 : false,
    expression: charEl ? charEl.dataset.expression : null,
    glow: (() => {
      const shape = document.querySelector('.blob-shape');
      const band = document.querySelector('.band-core');
      return {
        orb: rect(shape),
        bandOpacity: band ? Number(getComputedStyle(band).opacity) : null,
        bandAnim: band ? getComputedStyle(band).animationName : null,
        shapeAnim: shape ? getComputedStyle(shape).animationName : null,
        bandFilter: band ? getComputedStyle(band).filter : null,
        palette: pillEl.dataset.glowPalette || 'rainbow',
        lite: document.querySelector('.companion')?.classList.contains('is-lite') ?? null,
        level: charEl ? getComputedStyle(charEl).getPropertyValue('--level') : null
      };
    })(),
    blob: rect(document.querySelector('.blob')),
    blobEyes: rect(document.querySelector('.blob-eyes')),
    label: rect(document.querySelector('.state-label')),
    actions: rect(document.querySelector('.head-actions')),
    cardActions: rect(document.querySelector('.card-actions')),
    text: rect(document.querySelector('.card-text')),
    zone: rect(document.querySelector('.head-center')),
    meter: rect(document.querySelector('.meter-canvas')),
    meterInfo: (() => {
      const c = document.querySelector('.meter-canvas');
      if (!c || !c.getContext) return null;
      try {
        const zone = document.querySelector('.head-center')?.getBoundingClientRect() || null;
        const r = c.getBoundingClientRect();
        const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let painted = 0;
        for (let i = 3; i < data.length; i += 4) { if (data[i] > 8) painted += 1; }
        return {
          painted,
          inZone: zone ? r.x >= zone.x - 1 && r.x + r.width <= zone.x + zone.width + 1 : null,
          visible: getComputedStyle(c).display !== 'none'
        };
      } catch {
        return null;
      }
    })(),
    feed: rect(document.getElementById('feedPanel')),
    feedItem: rect(document.querySelector('.feed-item')),
    feedThumb: rect(document.querySelector('.feed-thumb')),
    feedPreviewVisible: (() => {
      const node = document.getElementById('feedPreviewLabel');
      return node ? !node.hidden : null;
    })(),
    // Phase H: the exact resting label text — download summaries, alert
    // counts, and plain status all surface here.
    stateText: (() => {
      const node = document.getElementById('notchState');
      return node ? node.textContent : null;
    })(),
    feedData: (() => {
      const items = document.querySelectorAll('.feed-item').length;
      const sections = [...document.querySelectorAll('.feed-section')].map((node) => node.textContent.toLowerCase());
      return { items, sections };
    })(),
    labelOpacity: (() => {
      const el = document.querySelector('.state-label');
      return el ? Number(getComputedStyle(el).opacity) : null;
    })(),
    feedEnter: (() => {
      const nodes = [...document.querySelectorAll('.feed-item.feed-enter')];
      return { entering: nodes.length, staggered: nodes.some((node) => (parseFloat(node.style.animationDelay) || 0) > 0) };
    })(),
    mediaInfo: (() => {
      const panel = document.getElementById('mediaPanel');
      const controls = document.getElementById('mediaControls');
      const playBtn = document.getElementById('mediaPlay');
      const buttons = controls ? [...controls.querySelectorAll('.media-btn')] : [];
      const glyphDisplay = (cls) => {
        if (!playBtn) return null;
        const node = playBtn.querySelector(cls);
        return node ? getComputedStyle(node).display : null;
      };
      return {
        visible: panel ? !panel.hidden : false,
        title: document.getElementById('mediaTitle')?.textContent ?? null,
        artist: document.getElementById('mediaArtist')?.textContent ?? null,
        panel: rect(panel),
        controls: rect(controls),
        buttons: buttons.length,
        disabled: buttons.filter((node) => node.disabled).length,
        playing: pillEl ? pillEl.dataset.mediaPlaying : null,
        playGlyph: glyphDisplay('.glyph-media-play'),
        pauseGlyph: glyphDisplay('.glyph-media-pause'),
        kicker: rect(document.querySelector('.state-label'))
      };
    })(),
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

// Stage 2b measuring fixtures: the legacy shared-grid asserts are calibrated
// against the resting orb, which a reduce-motion box always renders. On a
// normal machine three resting values differ from the reduced truth:
// 1. the listening mood runs the DESIGNED act=1.13 pulse (--act inline pin),
// 2. the chip may be playing its entrance (text-enter class off),
// 3. .pill-body carries its resting translateY(-4px) scale(.97) — overridden
//    to none only on expanded or by the reduced-motion media block — which
//    skews the clipped .card-text rect +2.6px/+4.6px off the shared pad even
//    though nothing is visible there (compact/medium clip the body band).
// The rest measure therefore pins all three briefly and the lit state below
// releases them. No renderer source changes — inline style/class only,
// momentary; the shipped expand choreography is untouched.
const GLOW_REST_FIXTURE = `(function(){try{var c=document.querySelector(".companion");if(c)c.style.setProperty("--act","1");var chip=document.querySelector(".card-text");if(chip)chip.classList.remove("text-enter");var b=document.querySelector(".pill-body");if(b)b.style.setProperty("transform","none");return "ok"}catch(err){return "ERR " + (err && err.message)}})()`;
const GLOW_LIT_RELEASE = `(function(){try{var c=document.querySelector(".companion");if(c)c.style.removeProperty("--act");var b=document.querySelector(".pill-body");if(b)b.style.removeProperty("transform");return "ok"}catch(err){return "ERR " + (err && err.message)}})()`;
// Lit-state orb metrics: taken AFTER the wave pump so opacity/anim readings
// reflect the live band; geometry asserts above still use the rest metrics.
const GLOW_ONLY = `(function(){try{
  var shape=document.querySelector(".blob-shape");
  var band=document.querySelector(".band-core");
  var comp=document.querySelector(".companion");
  var pill=document.getElementById("notch");
  var rect=function(el){if(!el)return null;var r=el.getBoundingClientRect();return {x:+r.x.toFixed(1),y:+r.y.toFixed(1),width:+r.width.toFixed(1),height:+r.height.toFixed(1)};};
  return {
    orb: rect(shape),
    bandOpacity: band ? Number(getComputedStyle(band).opacity) : null,
    bandAnim: band ? getComputedStyle(band).animationName : null,
    shapeAnim: shape ? getComputedStyle(shape).animationName : null,
    bandFilter: band ? getComputedStyle(band).filter : null,
    palette: pill && pill.dataset.glowPalette ? pill.dataset.glowPalette : "rainbow",
    lite: comp ? comp.classList.contains("is-lite") : null,
    level: comp ? getComputedStyle(comp).getPropertyValue("--level") : null
  };
}catch(err){return {error:String(err && err.message || err)}}})()`;

// Stage 2b scenario extras, applied through the real DOM hooks after show():
// palette pins data-glow-palette, lite toggles .is-lite, glow dials the real
// setGlowLevel() knob. Everything resets first so scenarios stay independent.
// Both scripts trap their own renderer exceptions and surface the real stack —
// the bare electron rejection ("Script failed to execute…") hides it.
//
// Harness-only media emulation: this gallery box (and any a11y-tuned machine)
// reports prefers-reduced-motion: reduce, which statics the orb both through
// the island.css media block and the auto-lite bootstrap. The lit scenarios
// emulate "no-preference" via CDP so the designed animated orb can be captured;
// glow-lite keeps the OS truth to validate the real auto-selected Lite path.
// No renderer code path changes.
const CDP_MOTION_ON = { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] };
const CDP_MOTION_OFF = { features: [] };

async function emulateMotion(contents, on) {
  try {
    const dbg = contents.debugger;
    if (!dbg.isAttached()) await dbg.attach('1.3');
    await dbg.sendCommand('Emulation.setEmulatedMedia', on ? CDP_MOTION_ON : CDP_MOTION_OFF);
  } catch (error) {
    console.log(`motion emulation ${on ? 'on' : 'off'} failed: ${error && (error.message || error)}`);
  }
}

async function applyGlowScenario(contents, scenario) {
  await emulateMotion(contents, scenario.name !== 'glow-lite');
  const parts = [
    'const pill = document.getElementById("notch");',
    'const comp = document.querySelector(".companion");',
    'if (comp) comp.classList.remove("is-lite");',
    'if (comp) comp.style.removeProperty("--blob-glow");',
    'if (pill && pill.dataset.glowPalette !== undefined) delete pill.dataset.glowPalette;'
  ];
  if (scenario.palette) parts.push(`if (pill) pill.dataset.glowPalette = ${JSON.stringify(scenario.palette)};`);
  if (scenario.lite) parts.push('if (comp) comp.classList.add("is-lite");');
  if (scenario.glow !== undefined) parts.push(`if (window.setGlowLevel) setGlowLevel(${scenario.glow});`);
  const body = parts.join(' ');
  let result = null;
  try {
    result = await contents.executeJavaScript(`(function(){try{${body}}catch(err){return "GLOW_ERR " + (err && (err.stack || err.message) || String(err));}})()`, true);
  } catch (error) {
    console.log(`${scenario.name}: glow patch rejected at electron level: ${error && (error.message || error)}`);
    return;
  }
  if (typeof result === 'string' && result.startsWith('GLOW_ERR')) {
    console.log(`${scenario.name}: glow patch renderer error: ${result.slice(9)}`);
  }
}

// Synthetic mic payload for the iris band (the same applyAudioLevel parser the
// spectrum test uses). Test data only; real audio is verified live.
async function injectGlowWave(contents, scenarioName) {
  const wave = Array.from({ length: 16 }, (_, i) => (i % 2 ? 0.85 : 0.4));
  try {
    await contents.executeJavaScript(`(function(){try{applyAudioLevel(0.55, ${JSON.stringify(wave)})}catch(err){return "WAVE_ERR " + (err && (err.stack || err.message) || String(err));}})()`, true);
  } catch (error) {
    console.log(`glow wave rejected at electron level (${scenarioName || 'unknown'}): ${error && (error.message || error)}`);
  }
}

// Zeroes any mic level leaked from an earlier scenario: without a new payload
// the smoothing loop keeps writing the last value forever, which would light
// the band (and pulse the face) during the REST geometry measure.
async function silenceMic(contents) {
  try {
    await contents.executeJavaScript('(function(){try{applyAudioLevel(0, []);return "ok"}catch(err){return "ERR " + (err && err.message)}})()', true);
  } catch (error) {
    console.log(`silence mic rejected: ${error && (error.message || error)}`);
  }
}

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
  // Without this, destroying the overlay window quits via the default
  // window-all-closed path and drops the pending async chain before the tally.
  app.on('window-all-closed', () => {});
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
      let metrics = null;
      if (scenario.name.startsWith('glow-')) {
        // Stage 2b flow: overrides → settle → REST measure under fixtures (the
        // slot/naval asserts are rest-state rules) → release → pump the band →
        // lit orb metrics → screenshot. Only glow scenarios pay the extra
        // measure; every other scenario keeps its original single-pass flow.
        await applyGlowScenario(contents, scenario);
        await silenceMic(contents);
        await sleep(scenario.wait);
        try {
          const fixture = await contents.executeJavaScript(GLOW_REST_FIXTURE, true);
          if (typeof fixture === 'string' && fixture.startsWith('ERR')) console.log(`${scenario.name}: rest fixture error: ${fixture}`);
        } catch (error) {
          console.log(`${scenario.name}: rest fixture rejected: ${error && (error.message || error)}`);
        }
        await sleep(350);
        try {
          metrics = JSON.parse(JSON.stringify(await contents.executeJavaScript(MEASURE, true)));
        } catch (error) {
          fail('runtime', `${scenario.name}: measure failed: ${error.message}`);
          continue;
        }
        try {
          await contents.executeJavaScript(GLOW_LIT_RELEASE, true);
        } catch { /* fixtures are best-effort */ }
        await injectGlowWave(contents, scenario.name);
        await sleep(1200);
        try {
          const glowOnly = await contents.executeJavaScript(GLOW_ONLY, true);
          if (glowOnly && !glowOnly.error) metrics.glow = glowOnly;
          else fail('runtime', `${scenario.name}: glow measure error: ${glowOnly && glowOnly.error}`);
        } catch (error) {
          fail('runtime', `${scenario.name}: glow measure failed: ${error.message}`);
          continue;
        }
      } else {
        if (scenario.wave) await injectGlowWave(contents, scenario.name);
        if (scenario.then) {
          await sleep(scenario.then.after);
          overlay.show(scenario.then.patch);
        }
        await sleep(scenario.wait);
        try {
          metrics = JSON.parse(JSON.stringify(await contents.executeJavaScript(MEASURE, true)));
        } catch (error) {
          fail('runtime', `${scenario.name}: measure failed: ${error.message}`);
          continue;
        }
      }
      const capture = await overlay.getWindow().webContents.capturePage();
      const pngPath = path.join(OUT, `${scenario.name}.png`);
      fs.writeFileSync(pngPath, capture.toPNG());
      flattenPNG(pngPath, pngPath, scenario.bg || [35, 38, 43]);
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

  // Stage 2b restore: lit scenarios leave the CDP motion emulation on — switch
  // it back off so the legacy spectrum leg runs under the same OS conditions
  // the Phase C asserts were tuned for.
  await emulateMotion(contents, false);

  // Spectrum painting pipeline (Phase C): injects labelled synthetic band data
  // through the real applyAudioLevel parser so the canvas painting path is
  // exercised end-to-end. The input is test data — real audio is verified live.
  try {
    overlay.hideNow();
    await sleep(420);
    overlay.show({ status: 'listening', message: 'Speak naturally. Release to send.', companionEnabled: true });
    await sleep(1400);
    const wave = Array.from({ length: 16 }, (_, i) => (i % 2 ? 0.9 : 0.35));
    await contents.executeJavaScript(`applyAudioLevel(0.5, ${JSON.stringify(wave)})`, true);
    await sleep(650);
    const spectrumMetrics = JSON.parse(JSON.stringify(await contents.executeJavaScript(MEASURE, true)));
    const shotPath = path.join(OUT, 'spectrum-inject.png');
    const capture = await overlay.getWindow().webContents.capturePage();
    fs.writeFileSync(shotPath, capture.toPNG());
    flattenPNG(shotPath, shotPath, [35, 38, 43]);
    results.screenshots.push(shotPath);
    results.runtime.push({ name: 'spectrum-inject', metrics: spectrumMetrics });
    console.log(`saved ${shotPath}`);
    assertScenario({ name: 'spectrum-inject' }, spectrumMetrics);
    const painted = spectrumMetrics.meterInfo ? spectrumMetrics.meterInfo.painted : 0;
    if (painted > 120) pass('runtime', `spectrum-inject: canvas painted (${painted} px)`);
    else fail('runtime', `spectrum-inject: canvas not painted (${painted} px)`);
  } catch (error) {
    fail('runtime', `spectrum-inject: crashed: ${error && error.stack || error}`);
  }
  saveResults();

  overlay.hideNow();
  await sleep(400);
  overlay.destroy();
  await sleep(120);
  // Print the tally before app.quit(): Electron can tear the loop down before
  // the outer promise continuation runs, which would silence the report. The
  // brief wait also lets stdout flush everything captured by the driver.
  console.log(failed === 0 ? `\nALL CHECKS PASSED — output in ${OUT}` : `\n${failed} check(s) FAILED — output in ${OUT}`);
  await sleep(350);
  app.exit(failed === 0 ? 0 : 1);
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
    within(m.pill.width, notch ? 660 : 208, 1.5, 'pill width', scenario);
    within(m.pill.height, 88, 1.5, 'pill height', scenario);
    within(radiusPx, notch ? 22 : 44, 1, 'pill radius', scenario);
  } else if (size === 'medium') {
    within(m.pill.width, notch ? 660 : 340, 1.5, 'pill width', scenario);
    within(m.pill.height, 104, 1.5, 'pill height', scenario);
    within(radiusPx, notch ? 22 : 24, 1, 'pill radius', scenario);
  } else {
    within(m.pill.width, notch ? 660 : 640, 1.5, 'pill width', scenario);
    within(radiusPx, notch ? 22 : 34, 1, 'pill radius', scenario);
    // Expanded height: the Home tab stack is pinned at exactly 190 (rail +
    // home cards); every other tab measures its own body but must reach the
    // rail + smallest-legal-card floor (a 1-line error card lands ~175).
    if (scenario.name === 'expanded-home') {
      within(m.pill.height, 190, 1.5, 'expanded home pinned height', scenario);
    } else {
      relaxedAtLeast(m.pill.height, 168, 'expanded height includes body', scenario);
    }
  }
  // Stage 2 tab rail: present on every expanded state; top row must sit at the
  // pill's top edge and keep its 52px height. The active tab follows the state
  // mapping (feed -> notifications, voice states -> assistant, rest -> home).
  if (size === 'expanded') {
    if (m.tabs) {
      within(m.tabs.height, 52, 1.5, 'tab rail height', scenario);
      within(m.tabs.y, m.pill.y, 1.5, 'tab rail top', scenario);
    } else fail('runtime', `${scenario.name}: tab rail missing`);
    const wantTab = scenario.name === 'expanded-home'
      ? 'home'
      : m.status === 'feed' ? 'notifications' : 'assistant';
    if (m.tab === wantTab) pass('runtime', `${scenario.name}: active tab ${m.tab}`);
    else fail('runtime', `${scenario.name}: tab ${JSON.stringify(m.tab)} vs expected ${wantTab}`);
  }
  // Shared grid: card text sits on --pad-x; when the blob is up, it shares that
  // edge. Display-hidden elements report 0x0 rects, so guard on real widths
  // (chat state renders text later; Home tab hides the card entirely).
  const hasText = m.text && m.text.width > 0;
  const hasBlob = m.blob && m.blob.width > 0;
  if (hasText) {
    // Stage 2b: when .pill-body is at its designed rest-hidden transform
    // (opacity 0 on compact/medium, translateY(-4px) scale(.97)), the chip's
    // BCR does not line up on the shared pad — reduce mode had frozen that
    // transform to identity, which is what the legacy asserts were calibrated
    // against. Glow scenarios skip the three pad asserts for the hidden body
    // (the blob-pad one still holds at rest and stays enforced).
    const bodyHiddenRest = m.bodyOpacity != null && m.bodyOpacity < 0.5 && scenario.name.startsWith('glow-');
    if (bodyHiddenRest) {
      if (hasBlob) within(m.blob.x, m.pill.x + padX, 3.5, 'blob left edge on shared pad', scenario);
      pass(`runtime`, `${scenario.name}: chip pad asserts skipped — pill-body at designed rest transform (opacity ${m.bodyOpacity})`);
    } else {
      within(m.text.x, m.pill.x + padX, 1.5, 'card text left edge on shared pad', scenario);
      if (hasBlob) {
        within(m.blob.x, m.pill.x + padX, 3.5, 'blob left edge on shared pad', scenario);
        within(m.blob.x, m.text.x, 3.5, 'blob left == text left (shared grid)', scenario);
      }
    }
  } else if (m.status !== 'chat' && m.status !== 'feed' && m.tab !== 'home') {
    fail('runtime', `${scenario.name}: card-text rect missing`);
  }
  if (m.actions && m.actions.width > 0) within(m.actions.x + m.actions.width, m.pill.x + m.pill.width - padX, 2, 'header buttons right on shared pad', scenario);
  // Phase D widget priority matrix: the state label is medium/expanded only,
  // the spectrum slot exists in compact listening only.
  if (m.labelOpacity != null) {
    const want = size === 'compact' ? 0 : 1;
    if (Math.abs(m.labelOpacity - want) < 0.05) pass('runtime', `${scenario.name}: label opacity matches widget matrix`);
    else fail('runtime', `${scenario.name}: label opacity ${m.labelOpacity} vs matrix ${want}`);
  }
  // Feed specifics: stacked cards on the shared grid, 44px thumbnail, NEW/OLD
  // section labels, Clear all wired.
  if (m.status === 'feed') {
    if (m.feedItem && m.feedItem.width > 0) {
      within(m.feedItem.x, m.pill.x + padX, 2, 'feed card left on shared pad', scenario);
      within(m.feedItem.x + m.feedItem.width, m.pill.x + m.pill.width - padX, 2, 'feed card right on shared pad', scenario);
      if (m.feed) relaxedAtLeast(m.feedItem.y + m.feedItem.height, m.feed.y + 4, 'feed card inside panel', scenario);
    } else {
      fail('runtime', `${scenario.name}: no visible feed card`);
    }
    if (m.feedThumb) within(m.feedThumb.width, 44, 1.5, 'feed thumb 44px', scenario);
    if (m.feedPreviewVisible !== null) {
      const wantPreview = scenario.feedPreview === false ? false : true;
      if (m.feedPreviewVisible === wantPreview) {
        pass('runtime', `${scenario.name}: PREVIEW badge ${wantPreview ? 'shown' : 'absent'} as scenario expects`);
      } else fail('runtime', `${scenario.name}: PREVIEW badge visibility ${m.feedPreviewVisible} vs expected ${wantPreview}`);
    }
    if (m.feedData) {
      if (m.feedData.items === FEED_SAMPLES.length) pass('runtime', `${scenario.name}: all feed cards rendered`);
      else fail('runtime', `${scenario.name}: feed card count ${m.feedData.items} vs ${FEED_SAMPLES.length}`);
      const wanted = ['new', 'old'];
      if (wanted.every((label) => m.feedData.sections.includes(label))) pass('runtime', `${scenario.name}: NEW/OLD sections present`);
      else fail('runtime', `${scenario.name}: sections ${JSON.stringify(m.feedData.sections)} missing NEW/OLD`);
    }
    if (m.feedEnter) {
      if (m.feedEnter.entering === FEED_SAMPLES.length) pass('runtime', `${scenario.name}: all feed cards cascade in`);
      else fail('runtime', `${scenario.name}: feed cascade ${m.feedEnter.entering} vs ${FEED_SAMPLES.length}`);
      if (m.feedEnter.staggered) pass('runtime', `${scenario.name}: feed cascade staggered`);
      else fail('runtime', `${scenario.name}: feed cascade not staggered`);
    }
  }
  // Phase H label rule: the resting pill shows exactly the download summary —
  // model · percent while downloading, · loading while the model loads, and
  // the plain status once the download clears.
  if (scenario.wantLabel !== undefined) {
    if (m.stateText === scenario.wantLabel) {
      pass('runtime', `${scenario.name}: resting label ${JSON.stringify(m.stateText)}`);
    } else {
      fail('runtime', `${scenario.name}: resting label ${JSON.stringify(m.stateText)} vs ${JSON.stringify(scenario.wantLabel)}`);
    }
  }
  // Phase F media pill: sample metadata on the medium band, transport right on
  // the shared pad, kicker clear of the title block. Outside media status the
  // panel must be hidden in every scenario (stale media state never leaks).
  if (m.status === 'media') {
    const info = m.mediaInfo;
    if (!info || !info.visible) {
      fail('runtime', `${scenario.name}: media panel not visible`);
    } else {
      if (info.title === 'Sample track') pass('runtime', `${scenario.name}: media title rendered`);
      else fail('runtime', `${scenario.name}: media title ${JSON.stringify(info.title)}`);
      if (info.buttons === 3 && info.disabled === 0) pass('runtime', `${scenario.name}: 3 enabled transport buttons`);
      else fail('runtime', `${scenario.name}: transport buttons ${info.buttons}, disabled ${info.disabled}`);
      const wantPlaying = scenario.name.includes('paused') ? 'false' : 'true';
      if (info.playing === wantPlaying) pass('runtime', `${scenario.name}: mediaPlaying flag ${info.playing}`);
      else fail('runtime', `${scenario.name}: mediaPlaying ${JSON.stringify(info.playing)} vs ${wantPlaying}`);
      const wantPlayGlyph = wantPlaying === 'true' ? 'none' : 'block';
      const wantPauseGlyph = wantPlaying === 'true' ? 'block' : 'none';
      if (info.playGlyph === wantPlayGlyph && info.pauseGlyph === wantPauseGlyph) pass('runtime', `${scenario.name}: play/pause glyph swap follows playback state`);
      else fail('runtime', `${scenario.name}: glyph swap play=${info.playGlyph} pause=${info.pauseGlyph}`);
      if (info.controls && info.controls.width > 0) {
        within(info.controls.x + info.controls.width, m.pill.x + m.pill.width - padX, 2, 'transport right on shared pad', scenario);
      } else fail('runtime', `${scenario.name}: transport row not laid out`);
      if (info.kicker && info.panel && info.kicker.y + info.kicker.height <= info.panel.y + 1) {
        pass('runtime', `${scenario.name}: NOW PLAYING kicker clear of the title block`);
      } else fail('runtime', `${scenario.name}: kicker overlaps title block (kicker ${JSON.stringify(info.kicker)}, panel ${JSON.stringify(info.panel)})`);
      if (m.meter && m.meter.height > 0.5) {
        fail('runtime', `${scenario.name}: media pill laid out a meter slot`);
      } else pass('runtime', `${scenario.name}: meter slot stays out of the media band`);
    }
  } else if (m.mediaInfo && m.mediaInfo.visible) {
    fail('runtime', `${scenario.name}: media panel visible outside media status`);
  }
  if (size === 'expanded') {
    if (m.cardActions && m.cardActions.width > 0) within(m.cardActions.x + m.cardActions.width, m.pill.x + m.pill.width - padX, 2, 'footer actions right on shared pad', scenario);
    // Assistant flow on expanded — the blob strip carries the label under the
    // tabs (Home/Notifications hide the head entirely).
    if (m.headVisible) {
      if (m.head) {
        within(m.head.height, 56, 1.5, 'assistant strip height', scenario);
        within(m.head.y, m.pill.y + 52, 2, 'assistant strip below tabs', scenario);
        const stripR = m.head.y + m.head.height;
        if (stripR <= m.pill.y + m.pill.height + 0.5) pass('runtime', `${scenario.name}: strip inside pill`);
        else fail('runtime', `${scenario.name}: strip exceeds pill bottom`);
      }
      if (m.label) {
        within(m.label.y + m.label.height / 2, m.head.y + m.head.height / 2, 3.5, 'label centered on head band', scenario);
        if (hasBlob) within(m.label.x - (m.blob.x + m.blob.width), 10, 4, 'label gap after blob', scenario);
      }
    } else if (m.tab === 'home') {
      // Home tab: media card + time card fill the body grid on the shared pads.
      const cards = m.mediaCard, time = m.timeCard;
      if (!cards || !cards.card || cards.card.width <= 0) fail('runtime', `${scenario.name}: media card missing`);
      else {
        if (cards.art) within(cards.art.width, 88, 1.5, 'album art 88px', scenario);
        else fail('runtime', `${scenario.name}: album art missing`);
        if (cards.badge) pass('runtime', `${scenario.name}: Preview badge visible on media card`);
        else fail('runtime', `${scenario.name}: Preview badge missing on media card`);
        if (cards.title === 'Preview track') pass('runtime', `${scenario.name}: preview media title rendered`);
        else fail('runtime', `${scenario.name}: preview media title ${JSON.stringify(cards.title)}`);
        if (cards.transport && cards.transport.width > 0) {
          within(cards.transport.x + cards.transport.width, cards.card.x + cards.card.width - 14, 3, 'home transport right inside card', scenario);
        } else fail('runtime', `${scenario.name}: home transport row not laid out`);
      }
      if (!time || !time.card || time.card.width <= 0) fail('runtime', `${scenario.name}: time card missing`);
      else {
        if (['day', 'evening', 'night'].includes(time.phase)) pass('runtime', `${scenario.name}: time phase ${time.phase}`);
        else fail('runtime', `${scenario.name}: time phase ${JSON.stringify(time.phase)}`);
        if (time.title === 'Day' || time.title === 'Evening' || time.title === 'Night') pass('runtime', `${scenario.name}: time title ${time.title}`);
        else fail('runtime', `${scenario.name}: time title ${JSON.stringify(time.title)}`);
        if (time.temp === '--') pass('runtime', `${scenario.name}: temperature renders -- until weather data exists`);
        else fail('runtime', `${scenario.name}: temperature ${JSON.stringify(time.temp)} vs --`);
        const insidePill = time.dot && time.dot.x >= m.pill.x + 2
          && time.dot.x + time.dot.width <= m.pill.x + m.pill.width - 2
          && time.dot.y >= m.pill.y + 2
          && time.dot.y + time.dot.height <= m.pill.y + m.pill.height - 2;
        if (insidePill) pass('runtime', `${scenario.name}: arc dot inside pill bounds`);
        else fail('runtime', `${scenario.name}: arc dot exceeds pill bounds`);
      }
      if (m.mediaCard && m.timeCard && m.mediaCard.card && m.timeCard.card) {
        const gridLeft = m.pill.x + padX;
        within(Math.min(m.mediaCard.card.x, m.timeCard.card.x), gridLeft, 2, 'home grid on shared pad', scenario);
        within(Math.max(m.mediaCard.card.x + m.mediaCard.card.width, m.timeCard.card.x + m.timeCard.card.width), m.pill.x + m.pill.width - padX, 2, 'home grid right on shared pad', scenario);
        const overlap = m.mediaCard.card.x + m.mediaCard.card.width > m.timeCard.card.x + 0.5 && m.timeCard.card.x + m.timeCard.card.width > m.mediaCard.card.x + 0.5;
        if (overlap) fail('runtime', `${scenario.name}: home cards overlap`);
        else pass('runtime', `${scenario.name}: home cards do not overlap`);
      }
    } else if (m.tab === 'assistant') {
      fail('runtime', `${scenario.name}: assistant strip expected but head band is hidden`);
    }
  }
  // Blob slot geometry: avatar box, centered on the head band, strictly inside
  // the pill. Home/Notifications tabs park the companion with the hidden strip
  // (noBlob); the nochar scenario disables it explicitly.
  if (scenario.noBlob || scenario.name.includes('nochar')) {
    if (!m.charVisible) pass('runtime', `${scenario.name}: companion parked as expected`);
    else fail('runtime', `${scenario.name}: companion should be hidden`);
  } else if (m.charVisible) {
    within(m.char.width, 38, 1.5, 'blob slot width', scenario);
    within(m.char.height, 42, 1.5, 'blob slot height', scenario);
    if (m.head && m.head.width > 0 && hasBlob) within(m.blob.y + m.blob.height / 2, m.head.y + m.head.height / 2, 4, 'blob centered on head band', scenario);
    if (hasBlob) {
      const insidePill = m.blob.x >= m.pill.x + 2
        && m.blob.x + m.blob.width <= m.pill.x + m.pill.width - 2
        && m.blob.y >= m.pill.y + 2
        && m.blob.y + m.blob.height <= m.pill.y + m.pill.height - 2;
      if (insidePill) pass('runtime', `${scenario.name}: blob fully inside pill bounds`);
      else fail('runtime', `${scenario.name}: blob exceeds pill bounds`);
    }
  } else fail('runtime', `${scenario.name}: companion not visible`);
  // Stage 2b orb behavior: the Lite scenario pins the static fallback (no
  // morph, no band drift, no blur filters); lit scenarios — motion-emulated
  // through CDP — must run both loops, honor the palette pin and make the
  // band opacity track level × glow knob.
  if (scenario.name.startsWith('glow-') && m.glow) {
    const glow = m.glow;
    if (scenario.lite) {
      if (glow.lite && glow.shapeAnim === 'none' && glow.bandAnim === 'none' && glow.bandFilter === 'none') pass('runtime', `${scenario.name}: lite orb static (no morph, no drift, filters off)`);
      else fail('runtime', `${scenario.name}: lite orb not static — ${JSON.stringify(glow)}`);
    } else {
      if (glow.lite !== true) pass('runtime', `${scenario.name}: lit orb active (is-lite off under motion emulation)`);
      else fail('runtime', `${scenario.name}: is-lite class leaked into lit scenario`);
      if (glow.shapeAnim === 'blob-morph' && glow.bandAnim === 'band-drift' && String(glow.bandFilter).includes('blur')) pass('runtime', `${scenario.name}: orb loops running (morph + band drift, blurred band)`);
      else fail('runtime', `${scenario.name}: orb loops not running — ${JSON.stringify({ shape: glow.shapeAnim, band: glow.bandAnim, filter: glow.bandFilter })}`);
      if (scenario.palette) {
        if (glow.palette === scenario.palette) pass('runtime', `${scenario.name}: palette pinned to ${glow.palette}`);
        else fail('runtime', `${scenario.name}: palette ${glow.palette} vs expected ${scenario.palette}`);
      }
      const knob = scenario.glow === undefined ? 1 : Math.max(0, Math.min(1.3, scenario.glow));
      const lvl = Math.min(1, Number(glow.level) || 0);
      within(Number(glow.bandOpacity), Math.min(1, 0.3 + 0.7 * knob * lvl), 0.07, 'band opacity tracks level x glow knob', scenario);
    }
  }
  // Spectrum slot (Phase C): the canvas parks inside the center zone in compact
  // listening only. Pixel assertions rely on real payloads; without any, the
  // canvas must stay clear. Phase D extends the else side: no slot layout and
  // no paint may appear in any other state, and label opacity follows the
  // widget priority matrix.
  if (size === 'compact' && m.status === 'listening') {
    if (m.meter) {
      within(m.meter.height, 30, 2, 'spectrum canvas height', scenario);
      within(m.meter.width, 88, 3, 'spectrum canvas width', scenario);
      if (m.meterInfo && m.meterInfo.inZone !== null) {
        if (m.meterInfo.inZone) pass('runtime', `${scenario.name}: spectrum canvas inside center zone`);
        else fail('runtime', `${scenario.name}: spectrum canvas spills out of center zone`);
      }
      if (m.meterInfo && m.meterInfo.visible !== null) {
        if (m.meterInfo.visible) pass('runtime', `${scenario.name}: spectrum canvas visible in listening`);
        else fail('runtime', `${scenario.name}: spectrum canvas hidden in listening`);
      }
    } else fail('runtime', `${scenario.name}: spectrum canvas missing`);
  } else {
    if (m.meterInfo && m.meterInfo.painted > 0) {
      fail('runtime', `${scenario.name}: spectrum painted outside listening (${m.meterInfo.painted} px)`);
    }
    if (m.meter && m.meter.height > 0.5) {
      fail('runtime', `${scenario.name}: meter slot laid out outside listening (h=${m.meter.height})`);
    }
  }
  if (m.headVisible && m.head) within(m.head.y, m.pill.y + (size === 'expanded' ? 52 : 0), 2, 'head band top', scenario);
  if (m.zone && m.headVisible) {
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
