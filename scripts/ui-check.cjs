'use strict';

/*
 * Voxa UI QA tool — read-only visual + DOM audit.
 *
 * Run:  node scripts/ui-check.cjs [--only <state|page|leg>] [--quick]
 *                                       [--scales 100,125,150]
 *
 * Launches its OWN isolated Electron instance (fresh temp userData profile,
 * deleted at exit) and drives the REAL overlay (lib/overlay.cjs) and the REAL
 * dashboard (renderer/settings.html) through every island state and dashboard
 * page at Windows scale 100/125/150% while emulating prefers-reduced-motion
 * on ('reduce') and off (no-preference) via CDP.
 *
 * Isolation contract:
 *  - fresh temp userData + sessionData (never touches the real profile,
 *    settings.json or the models folder),
 *  - no ports opened (whisper:8000 / kokoro of the live Voxa are never started
 *    from this harness — services are not initialized here),
 *  - only processes started by THIS script get terminated (the electron child
 *    PID tracked from the bootstrap; tree-kill names no processes).
 *
 * Output: reference/ui-check/{REPORT.md,FIX-LIST.md,shots/*.png}
 * Exit code 1 when any rule fails.
 */

const IS_ELECTRON = Boolean(process.versions && process.versions.electron);

// ---------------------------------------------------------------------------
// Bootstrap: when launched with plain node, re-spawn inside Electron.
// The only PID we ever terminate is the electron child started right here.
// ---------------------------------------------------------------------------

function bootstrapDriver() {
  const fs = require('node:fs');
  const path = require('node:path');
  const { spawn, spawnSync } = require('node:child_process');
  let electronExe = null;
  try {
    electronExe = require(require.resolve('electron')); // package main = exe path
  } catch {
    electronExe = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  }
  if (!electronExe || !fs.existsSync(electronExe)) {
    console.error('ui-check: electron executable not found.');
    process.exit(2);
  }
  const child = spawn(electronExe, [__filename, ...process.argv.slice(2)], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, VOXA_UICHECK_CHILD: '1' }
  });
  let done = false;
  const finish = (code) => { done = true; process.exit(code); };
  child.on('exit', (code, signal) => finish(signal && code == null ? 1 : code == null ? 1 : code));
  child.on('error', (error) => {
    console.error(`ui-check: could not launch electron: ${error.message}`);
    finish(2);
  });
  // Hard timeout so a wedged run cannot sit forever. Kill by OUR pid only.
  const maxMinutes = 70;
  setTimeout(() => {
    if (done) return;
    console.error(`ui-check: run exceeded ${maxMinutes} min, terminating OUR electron (pid ${child.pid}).`);
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
    } catch { /* already gone */ }
    finish(1);
  }, maxMinutes * 60 * 1000).unref();
}

if (!IS_ELECTRON) {
  bootstrapDriver();
  return; // CJS top-level: inside Electron this line is never reached.
}

// ---- everything below runs INSIDE our own Electron main process ----

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow, ipcMain } = require('electron');

const REPO = path.join(__dirname, '..');
const OUT = path.join(REPO, 'reference', 'ui-check');
const SHOTS = path.join(OUT, 'shots');

// Isolated profile first thing (fresh temp folder; removed at exit).
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'voxa-ui-check-'));
app.setPath('userData', PROFILE);
app.setPath('sessionData', PROFILE);

const { createOverlay } = require(path.join(REPO, 'lib', 'overlay.cjs'));

fs.mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const ONLY = argOf('--only');
const QUICK = argv.includes('--quick');
const SCALES = (argOf('--scales') || '100,125,150').split(',').map((v) => Number(v.trim())).filter(Boolean);
const SETTLE_DEFAULT = QUICK ? 1500 : 2300;
const SETTLE_WIDE = QUICK ? 1800 : 2900;

const want = (name) => !ONLY || String(name).toLowerCase() === String(ONLY).toLowerCase();

// ---------------------------------------------------------------------------
// PNG helpers (decode only, no dependencies)
// ---------------------------------------------------------------------------

function decodePNG(buffer) {
  if (buffer.length < 16 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
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
  return { width, height, data: out };
}

function encodeRGBPNG(width, height, rgb) {
  const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 8;
      table[n] = c;
    }
    return table;
  })();
  const crc32 = (buffer) => {
    let c = -1;
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// Flatten onto a neutral desktop color so translucent shots are readable files.
function flattenPNG(file, bg) {
  const image = decodePNG(fs.readFileSync(file));
  const rgb = Buffer.alloc(image.width * image.height * 3);
  for (let index = 0; index < image.width * image.height; index += 1) {
    const a = image.data[index * 4 + 3] / 255;
    rgb[index * 3] = Math.round(image.data[index * 4] * a + bg[0] * (1 - a));
    rgb[index * 3 + 1] = Math.round(image.data[index * 4 + 1] * a + bg[1] * (1 - a));
    rgb[index * 3 + 2] = Math.round(image.data[index * 4 + 2] * a + bg[2] * (1 - a));
  }
  fs.writeFileSync(file, encodeRGBPNG(image.width, image.height, rgb));
}

// ---------------------------------------------------------------------------
// Sample content (statuses mirror scripts/island-capture.cjs shapes)
// ---------------------------------------------------------------------------

const SAMPLE_ANSWER = [
  'Here is the capture sample answer so we can judge the expanded card.',
  '',
  '- It has a short list item',
  '- And a second one',
  '',
  '`inline code` and **bold text** render, plus a sentence long enough to wrap around the card width twice without any trouble at all.'
].join('\n');

const FEED_SAMPLES = [
  { id: 'feed-a', title: 'Agent finished the task', body: 'Opened Notepad and typed the review notes. Everything went through the approval you allowed.', ts: Date.now(), kind: 'turn', tone: 'highlight' },
  { id: 'feed-b', title: 'Whisper model downloaded', body: 'Voice recognition model staged and ready to transcribe.', ts: Date.now() - 14 * 60000, kind: 'download', tone: 'neutral' },
  { id: 'feed-c', title: 'Media controls connected', body: 'Playback info and controls are wired to the island.', ts: Date.now() - 52 * 60000, kind: 'media', tone: 'neutral' }
];

const MEDIA_SAMPLE = { title: 'Sample track', artist: 'Sample artist', app: 'Sample player', playing: true, canToggle: true, canNext: true, canPrev: true };
const DOWNLOAD_SAMPLE = { phase: 'downloading', label: 'Whisper · medium', percent: 42 };
const WAVE = Array.from({ length: 16 }, (_, i) => (i % 2 ? 0.85 : 0.4));

// The requested island states in the brief's order. "activate" is the
// activation orb: resting compact pill + injected mic wave (lit band).
const STATES = [
  { name: 'compact', wait: SETTLE_DEFAULT, patch: { status: 'idle', message: '', notifications: [], download: null } },
  { name: 'medium', wait: SETTLE_DEFAULT, patch: { status: 'media', media: MEDIA_SAMPLE } },
  { name: 'home', wait: SETTLE_DEFAULT, patch: { status: 'idle', expand: 'pinned', message: '', notifications: [], download: null } },
  { name: 'assistant', wait: SETTLE_DEFAULT, patch: { status: 'answer', canCopy: true, speaking: false, approval: null, message: SAMPLE_ANSWER } },
  { name: 'notifications', wait: SETTLE_DEFAULT, patch: { status: 'feed', feedPreview: true, notifications: FEED_SAMPLES, message: '' } },
  { name: 'activate', wait: SETTLE_DEFAULT, wave: true, patch: { status: 'idle', message: '', notifications: [], download: null, companionEnabled: true } },
  { name: 'listening', wait: SETTLE_DEFAULT, wave: true, patch: { status: 'listening', message: 'Speak naturally. Release to send.' } },
  { name: 'thinking', wait: SETTLE_DEFAULT, patch: { status: 'thinking', message: 'Transcribing, one moment please…' } },
  { name: 'response', wait: SETTLE_WIDE, patch: { status: 'answer', canCopy: true, speaking: true, approval: null, message: SAMPLE_ANSWER } },
  { name: 'error', wait: SETTLE_DEFAULT, patch: { status: 'error', message: 'Something failed on purpose so we can inspect the error state.' } },
  { name: 'approval', wait: SETTLE_DEFAULT, patch: { status: 'approval', approval: { id: 'harness', title: 'Allow this sample action?', detail: 'Harness preview — nothing will run.', tool: 'type_text' } } },
  { name: 'toast', wait: SETTLE_DEFAULT, patch: { status: 'idle', notifications: FEED_SAMPLES, download: null, message: '' } },
  { name: 'download', wait: SETTLE_DEFAULT, patch: { status: 'idle', notifications: [], download: DOWNLOAD_SAMPLE, message: '' } },
  { name: 'empty-notifications', wait: SETTLE_DEFAULT, patch: { status: 'feed', feedPreview: false, notifications: [], message: '' } }
];

const DASH_PAGES = ['dashboard', 'insights', 'history', 'dictation', 'agent', 'apps', 'logs', 'settings'];
const LEGS = ['states', 'dashboard', 'leaks', 'perf', 'tokens'];

const doLeg = (leg) => {
  if (!ONLY) return true;
  const o = String(ONLY).toLowerCase();
  if (LEGS.includes(o)) return leg === o;
  if (leg === 'states') return STATES.some((s) => s.name === o) || o === 'island';
  if (leg === 'dashboard') return DASH_PAGES.includes(o);
  return false;
};

// ---------------------------------------------------------------------------
// Renderer probes
// ---------------------------------------------------------------------------

const INSTALL_PROBE = `(function(){
  try {
    if (window.__uic) return 'ok';
    window.__uic = { errors: [], rejections: 0 };
    window.addEventListener('error', function (e) {
      if (e && e.message) window.__uic.errors.push(String(e.message).slice(0, 300));
    });
    window.addEventListener('unhandledrejection', function (e) {
      window.__uic.rejections += 1;
      window.__uic.errors.push('unhandledrejection: ' + String(e && e.reason && ((e.reason.stack) || e.reason.message) || e.reason).slice(0, 300));
    });
    var m = { rafScheduled: 0, rafCompleted: 0, _inflight: 0, intervalLive: 0, listenersNet: 0 };
    var origRAF = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
    if (origRAF) window.requestAnimationFrame = function (cb) {
      m.rafScheduled += 1;
      m._inflight += 1;
      return origRAF(function (t) {
        m._inflight = Math.max(0, m._inflight - 1);
        m.rafCompleted += 1;
        if (typeof cb === 'function') return cb(t);
        return undefined;
      });
    };
    var origSI = window.setInterval.bind(window);
    window.setInterval = function () { m.intervalLive += 1; return origSI.apply(null, arguments); };
    var origCI = window.clearInterval.bind(window);
    window.clearInterval = function (id) { if (id != null) m.intervalLive -= 1; return origCI(id); };
    [window, document].forEach(function (target) {
      var origAdd = target.addEventListener.bind(target);
      target.addEventListener = function () { m.listenersNet += 1; return origAdd.apply(target, arguments); };
      var origRemove = target.removeEventListener.bind(target);
      target.removeEventListener = function () { m.listenersNet -= 1; return origRemove.apply(target, arguments); };
    });
    window.__uicLeaks = m;
    return 'ok';
  } catch (e) { return 'ERR ' + e.message; }
})()`;

const LEAKS_SNAPSHOT = `(function(){
  try {
    var m = window.__uicLeaks || {};
    return {
      rafScheduled: m.rafScheduled || 0, rafCompleted: m.rafCompleted || 0,
      rafInflight: m._inflight || 0, intervalLive: Math.max(0, m.intervalLive || 0),
      listenersNet: m.listenersNet || 0,
      errors: ((window.__uic && window.__uic.errors) || []).length,
      rejections: (window.__uic && window.__uic.rejections) || 0
    };
  } catch (e) { return null; }
})()`;

// Full DOM geometry snapshot for one visible state.
const DOM_PROBE = `(function(){
  try {
    function sig(node) {
      if (!node) return '';
      var cls = typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\\s+/)[0] : '';
      return (node.id ? '#' + node.id : node.tagName.toLowerCase() + cls);
    }
    function vis(el) {
      if (!el || el.nodeType !== 1) return false;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      var r = el.getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5) return false;
      if (el.closest('[hidden]')) return false;
      return true;
    }
    var DECOR = /(^|[\\s_])(pill-glow|glow|band-drift|tint|pool|band-iris|blob-band|blob-tint|blob-pool|blob-spec|word-ghost|card-ghost|pill-surface|meter-canvas|label-ghost|shadow)/;
    var scope = document.querySelector('.page.active') || document.body;
    var pimap = new Map();
    var els = [scope];
    var all = scope.querySelectorAll('*');
    for (var i = 0; i < all.length && els.length < 1800; i++) els.push(all[i]);
    for (i = 0; i < els.length; i++) {
      if (vis(els[i])) pimap.set(els[i], pimap.size);
    }
    function describe(node) {
      var pi = pimap.get(node);
      var r = node.getBoundingClientRect();
      var cs = getComputedStyle(node);
      var tag = node.tagName.toLowerCase();
      var role = node.getAttribute('role') || '';
      var interactive = tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea'
        || (node.hasAttribute('tabindex') && node.getAttribute('tabindex') !== '-1')
        || (role && /^(button|tab|option|checkbox|radio|switch|slider|menuitem|combobox)$/.test(role));
      var parentElement = node.parentElement;
      var ppi = parentElement && pimap.has(parentElement) ? pimap.get(parentElement) : -1;
      var ownText = [];
      node.childNodes.forEach(function (n) {
        if (n.nodeType === 3) {
          var t = (n.textContent || '').replace(/\\s+/g, ' ').trim();
          if (t) ownText.push(t);
        }
      });
      return {
        pi: pi,
        ppi: ppi,
        tag: tag,
        id: node.id || '',
        cls: (typeof node.className === 'string' ? node.className.trim() : '').slice(0, 80),
        role: role,
        ariaHidden: node.getAttribute('aria-hidden') || '',
        rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
        interactive: interactive,
        disabled: node.disabled === true,
        text: ownText.join(' ').slice(0, 90),
        scrollWidth: node.scrollWidth || 0,
        clientWidth: node.clientWidth || 0,
        scrollHeight: node.scrollHeight || 0,
        clientHeight: node.clientHeight || 0,
        opacity: cs.opacity,
        color: cs.color,
        bg: cs.backgroundColor,
        overflowX: cs.overflowX,
        overflowY: cs.overflowY,
        textOverflow: cs.textOverflow,
        whiteSpace: cs.whiteSpace,
        lineClamp: cs.webkitLineClamp == null ? '0' : String(cs.webkitLineClamp),
        deco: DECOR.test(typeof node.className === 'string' ? node.className : ''),
        boxShadow: cs.boxShadow.slice(0, 120),
        fontSize: cs.fontSize,
        fontWeight: String(cs.fontWeight)
      };
    }
    var nodes = [];
    for (i = 0; i < els.length; i++) {
      if (pimap.has(els[i])) nodes.push(describe(els[i]));
    }
    // text runs with their owner pi
    var texts = [];
    for (i = 0; i < els.length && texts.length < 700; i++) {
      var host = els[i];
      if (!pimap.has(host)) continue;
      var hostPi = pimap.get(host);
      Array.prototype.forEach.call(host.childNodes, function (n) {
        if (n.nodeType !== 3) return;
        var value = n.textContent || '';
        if (!value.trim()) return;
        var range = document.createRange();
        try { range.selectNodeContents(n); } catch (e) { return; }
        var rect = range.getBoundingClientRect();
        if (rect.width <= 0.5 || rect.height <= 0.5) return;
        var cs2 = getComputedStyle(host);
        texts.push({
          text: value.replace(/\\s+/g, ' ').trim().slice(0, 90),
          rect: { x: +rect.x.toFixed(1), y: +rect.y.toFixed(1), w: +rect.width.toFixed(1), h: +rect.height.toFixed(1) },
          owner: hostPi,
          ownerOpacity: Number(getComputedStyle(host).opacity),
          fontSize: cs2.fontSize,
          fontWeight: String(cs2.fontWeight)
        });
      });
    }
    // horizontal rows: visible parents with >=2 same-y, similar-height children
    var rows = [];
    // vertical stacks: >=2 children sharing the same left edge while stepping down
    var stacks = [];
    for (i = 0; i < els.length && (rows.length < 200 || stacks.length < 200); i++) {
      var parent = els[i];
      if (!pimap.has(parent)) continue;
      var kids = Array.prototype.filter.call(parent.children, vis);
      if (kids.length < 2) continue;
      var kidRects = kids.map(function (k) { return k.getBoundingClientRect(); });
      var centers = kidRects.map(function (r) { return r.y + r.height / 2; });
      var sameCy = centers.every(function (cy) { return Math.abs(cy - centers[0]) <= 2.5; });
      if (sameCy) {
        var widths = kidRects.map(function (r) { return r.width; });
        if (Math.max.apply(null, widths) - Math.min.apply(null, widths) > 120) continue; // flexible widths, not a centered row
        rows.push({
          parent: sig(parent),
          kids: kidRects.map(function (r, j) { return { sel: sig(kids[j]), x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; }),
          kidPads: kids.map(function (k) { var cs3 = getComputedStyle(k); return String(cs3.paddingLeft) + ' ' + String(cs3.paddingRight); })
        });
        continue;
      }
      // vertical stack: children share the left edge (within 0.6), ordered by y
      var xs = kidRects.map(function (r) { return r.x; });
      var leftoks = xs.every(function (x) { return Math.abs(x - xs[0]) <= 0.6; });
      var stacked = leftoks && kidRects.every(function (r, j) { return j === 0 || r.y >= kidRects[j - 1].y + kidRects[j - 1].height * 0.6; });
      if (stacked) {
        stacks.push({
          parent: sig(parent),
          kidSels: kids.map(sig),
          lefts: xs.map(function (x) { return +x.toFixed(1); }),
          leftSpread: +(Math.max.apply(null, xs) - Math.min.apply(null, xs)).toFixed(2),
          kidPads: kids.map(function (k) { var cs3 = getComputedStyle(k); return String(cs3.paddingLeft) + ' ' + String(cs3.paddingRight); })
        });
      }
    }
    var pillEl = document.getElementById('notch');
    var pillRect = pillEl ? pillEl.getBoundingClientRect() : null;
    var pillCS = pillEl ? getComputedStyle(pillEl) : null;
    var surface = document.querySelector('.pill-surface');
    function decorateRect(node) {
      if (!node) return null;
      var r = node.getBoundingClientRect();
      return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    }
    var blobNode = document.querySelector('.blob');
    var blob = (blobNode && vis(blobNode)) ? {
      blob: decorateRect(blobNode),
      slot: decorateRect(document.querySelector('.companion')),
      head: decorateRect(document.querySelector('.pill-head'))
    } : null;
    var fontList = [];
    try {
      document.fonts.forEach(function (f) {
        fontList.push({ family: f.family, status: f.status, style: f.style, weight: f.weight });
      });
    } catch (e) { /* older renderer */ }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dpr: window.devicePixelRatio,
      mode: pillEl ? 'island' : 'dashboard',
      label: pillarUpdate(),
      scrollViewport: {
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
        scrollH: document.documentElement.scrollHeight,
        clientH: document.documentElement.clientHeight
      },
      pill: pillRect ? { x: +pillRect.x.toFixed(1), y: +pillRect.y.toFixed(1), w: +pillRect.width.toFixed(1), h: +pillRect.height.toFixed(1), radius: pillCS.borderRadius, size: pillEl.dataset.size || '', state: pillEl.dataset.state || '', tab: pillEl.dataset.tab || '', padX: pillCS.getPropertyValue('--pad-x') } : null,
      surfaceShadow: surface ? getComputedStyle(surface).boxShadow : '',
      blob: blob,
      nodes: nodes,
      texts: texts,
      rows: rows,
      stacks: stacks,
      fonts: { status: (document.fonts && document.fonts.status) || 'unknown', faces: fontList },
      images: Array.prototype.slice.call(document.images, 0, 120).map(function (img) { return { src: String(img.currentSrc || img.src).slice(0, 120), naturalWidth: img.naturalWidth, rendered: img.width }; })
    };
    function pillarUpdate() {
      var label = document.getElementById('notchState');
      return label ? label.textContent : '';
    }
  } catch (e) { return { probeError: String(e && e.stack || e).slice(0, 600) }; }
})()`;

// Temporary 64-char unbreakable word probes (removed again before returning).
const PROBE_LONGWORD = `(function(){
  try {
    var word = 'u'.repeat(64);
    var scope = document.querySelector('.page.active') || document.body;
    var sels = ['.state-label', '.card-text', '.feed-title', '.card-title', '.card p', '.card-note', 'h2', 'h3'];
    var targets = [];
    var seen = new Set();
    for (var s of sels) {
      var list = Array.from(scope.querySelectorAll(s)).slice(0, 3);
      for (var n of list) {
        var cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        var key = s + '::' + n.tagName + '.' + String(n.className).split(' ')[0];
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({ el: n, sel: key });
        if (targets.length >= 8) break;
      }
      if (targets.length >= 8) break;
    }
    var added = [];
    for (var t of targets) {
      var span = document.createElement('span');
      span.textContent = word;
      span.setAttribute('data-uic-probe', '1');
      span.style.display = 'inline';
      span.style.font = 'inherit';
      span.style.margin = '0 2px';
      try { t.el.appendChild(span); added.push(t); } catch (e) { /* skip */ }
    }
    var results = [];
    for (var a of added) {
      var parent = a.el;
      var pp = parent.parentElement;
      results.push({
        sel: a.sel,
        elemScroll: { sw: parent.scrollWidth, cw: parent.clientWidth },
        parentOverflowX: getComputedStyle(parent).overflowX,
        parentoverflow: getComputedStyle(parent).overflowX,
        parentEllipsis: getComputedStyle(parent).textOverflow,
        parentClamp: (getComputedStyle(parent).webkitLineClamp == null ? '0' : String(getComputedStyle(parent).webkitLineClamp)),
        ppScroll: pp ? { sw: pp.scrollWidth, cw: pp.clientWidth } : null,
        ppOverflowX: pp ? getComputedStyle(pp).overflowX : ''
      });
    }
    document.querySelectorAll('[data-uic-probe]').forEach(function (n) { n.remove(); });
    return results;
  } catch (e) { return [{ error: String(e && e.message || e) }]; }
})()`;

const FOCUS_SEQ = `(function(){
  try {
    var scope = document.querySelector('.page.active') || document.body;
    var sel = 'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
    var list = Array.prototype.slice.call(scope.querySelectorAll(sel), 0, 90);
    return list.filter(function (el) {
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      return true;
    }).map(function (el, i) {
      var r = el.getBoundingClientRect();
      return { i: i, tag: el.tagName.toLowerCase(), id: el.id || '', cls: String(el.className || '').slice(0, 60), x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    });
  } catch (e) { return [{ error: String(e && e.message || e) }]; }
})()`;

const FOCUS_WINDOW = `(function(){
  try {
    var el = document.activeElement;
    if (!el || el === document.body) return null;
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(), id: el.id || '', cls: String(el.className || '').slice(0, 60),
      focusVisible: el.matches(':focus-visible'),
      outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor,
      boxShadow: cs.boxShadow.slice(0, 140),
      rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }
    };
  } catch (e) { return { error: String(e && e.message || e) }; }
})()`;

// ---------------------------------------------------------------------------
// Error collector (renderer console + failed loads + crashes)
// ---------------------------------------------------------------------------

function makeCollector(label) {
  return { label, errors: [], warnings: [], failLoads: [], crashes: [] };
}
const overlayCollector = makeCollector('overlay');
const dashCollector = makeCollector('dashboard');

function attachCollector(wc, collector) {
  wc.on('console-message', (event, level, message, line, sourceId) => {
    let ev = { level, message, lineNumber: line, sourceId };
    if (event && typeof event === 'object' && event.level) {
      ev = { level: event.level, message: event.message, lineNumber: event.lineNumber, sourceId: event.sourceId };
    }
    const text = String(ev.message || ev || '').slice(0, 300);
    if (ev.level === 'error') collector.errors.push({ text, src: ev.sourceId || '', line: ev.lineNumber || 0 });
    else if (ev.level === 'warning') collector.warnings.push({ text, src: ev.sourceId || '' });
  });
  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return;
    collector.failLoads.push({ url: String(validatedURL || '').slice(0, 200), code: errorCode, desc: errorDescription });
  });
  wc.on('render-process-gone', (_e, details) => collector.crashes.push(details.reason));
}

// ---------------------------------------------------------------------------
// Rule engine state
// ---------------------------------------------------------------------------

const RULE_LABEL = {
  layout: 'Nothing visible crosses its pill/panel/window bounds',
  shadow: 'No clipped glow/shadow at window edges',
  align: 'Rows share left edge + centers aligned + blob margins',
  overlap: 'No unintended element overlap',
  overflow: 'No unclamped text overflow / horizontal scroll',
  holdword: '64-char unbroken string does not break layout',
  stray: 'No stray sub-3px lines crossing content',
  hit: 'Interactive targets >= 32x32',
  contrast: 'Text contrast vs real background pixels (WCAG AA)',
  assets: 'Fonts loaded, images ok',
  errors: 'No console errors/warnings/failed loads',
  keyboard: 'Tab reachability with visible focus ring',
  tokens: 'No off-token hard-coded values',
  perf: 'CPU budget',
  leaks: 'rAF/timer/listener drift across 30 state cycles'
};

const FIX_HINTS = {
  layout: 'Constrain the element inside its container (padding/max-width/max-height/overflow), or move the absolutely-positioned layer under a clipping surface (e.g. .pill-surface has overflow:hidden).',
  shadow: 'Trim the box-shadow offsets/blur (tokens.css --island-depth / --island-notch-depth) so the glow stays inside the transparent window padding, or increase the window padding budget in lib/overlay.cjs boundsFor().',
  align: 'Give the row one shared layout (flex with align-items:center and one padding rule per cell) or align the stack cells on a single left edge; drop per-cell margins/offsets so all left edges match within 1px.',
  overlap: 'Add gap/margin between the two elements or shrink the decorative layer; if layering is intended, mark the decoration pointer-events:none + aria-hidden and document it in the exclusion list.',
  overflow: 'Apply the clamp pattern (overflow:hidden; min-width:0; text-overflow:ellipsis; white-space:nowrap) or allow wrapping (overflow-wrap:anywhere) / shrink-to-fit on the listed selector.',
  holdword: 'Same as overflow, for the 64-char unbroken probe: add the clamp or overflow-wrap:anywhere on the listed container.',
  stray: 'Remove the sub-3px element or give it an intentional divider/track/progress class and a token; real hairlines belong to the token file, not ad-hoc CSS.',
  hit: 'Grow the interactive box to at least 32x32 CSS px (see .tab-button at 36px for the pattern): padding + clip-path visibility, or wrap the glyph in a padded button.',
  contrast: 'Raise the text color contrast vs the actual backdrop: adjust the token (--island-text-dim etc.) or add a scrim/gradient behind the text zone.',
  assets: 'Repair the resource path / file (missing font or icon) or preload it; verify the family name in tokens.css matches the file.',
  errors: 'Fix the reported console error/warning/failed load (see evidence).',
  keyboard: 'Keep the :focus-visible outline token (--vx-outline) on every control, avoid display:none of focusable nodes during states, and do not leave disabled elements in tab order.',
  tokens: 'Move the hard-coded value into renderer/tokens.css and reference it via var(...). The island band heights deliberately pinned by scripts/island-capture.cjs are documented exceptions (geometry, not colors).',
  perf: 'Idle CPU must be near zero while the island is collapsed: audit rAF/setInterval loops running while visible-idle (renderer) and 30Hz cursor poll cadence (main).',
  leaks: 'Balance lifecycle: every setInterval/rAF/listener added during a state must be cleared when the state ends (check hide paths + feed/media teardown).'
};

const rows = [];
const fails = [];
let exitFailed = true && false; // set on first failRow
let doneScreenshots = 0;
const midEdit = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pass(area, scale, motion, rule, evidence, shot) {
  rows.push({ area, scale, motion, rule, result: 'PASS', evidence, shot: shot || '' });
}
function failRow(area, scale, motion, rule, evidence, selector, shot) {
  exitFailed = true;
  rows.push({ area, scale, motion, rule, result: 'FAIL', evidence, shot: shot || '' });
  fails.push({
    rule, area, scale, motion, selector: selector || '', evidence,
    fix: FIX_HINTS[rule] || 'Inspect the element and the tokens it binds to.',
    shot: shot || ''
  });
}
function infoRow(area, scale, motion, rule, evidence, shot) {
  rows.push({ area, scale, motion, rule, result: 'INFO', evidence, shot: shot || '' });
}

function shotName(prefix, scale, motion) {
  return `${prefix}-${scale}s-${motion === 1 ? 'motion' : 'reduce'}.png`;
}

// ---------------------------------------------------------------------------
// Color contrast on real pixels
// ---------------------------------------------------------------------------

function relLum(r, g, b) {
  const f = (c) => {
    c /= 255;
    if (c <= 0.04045) return c / 12.92;
    return Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastRatio(l1, l2) {
  const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (a + 0.05) / (b + 0.05);
}
function quant5(c) { return c >> 3; }

const pngCache = new Map(); // file -> decoded
function decodeCached(buffer) {
  const key = buffer.length + ':' + buffer[buffer.length >> 1];
  if (pngCache.has(key)) return pngCache.get(key);
  const img = decodePNG(buffer);
  pngCache.set(key, img);
  if (pngCache.size > 6) pngCache.delete(pngCache.keys().next().value);
  return img;
}

// png = raw RGBA buffer from capture; sf = device px per CSS px
function sampleColors(png, rectCss, sf) {
  const img = decodeCached(png);
  const x0 = Math.max(0, Math.round(rectCss.x * sf));
  const y0 = Math.max(0, Math.round(rectCss.y * sf));
  const x1 = Math.min(img.width, Math.max(x0 + 2, Math.round((rectCss.x + rectCss.w) * sf)));
  const y1 = Math.min(img.height, Math.max(y0 + 2, Math.round((rectCss.y + rectCss.h) * sf)));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const total = (x1 - x0) * (y1 - y0);
  const hist = new Map();
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * img.width + x) * 4;
      if (png[i + 3] < 24) continue;
      const key = (quant5(png[i]) << 10) | (quant5(png[i + 1]) << 5) | quant5(png[i + 2]);
      hist.set(key, (hist.get(key) || 0) + 1);
    }
  }
  if (!hist.size) return null;
  let dominant = null;
  let domCount = 0;
  for (const [key, n] of hist) {
    if (n > domCount) { domCount = n; dominant = key; }
  }
  if (!dominant || domCount / total < 0.08) return null; // glyphs cover their own background
  const dR = (((dominant >> 10) & 31) << 3) + 4;
  const dG = (((dominant >> 5) & 31) << 3) + 4;
  const dB = ((dominant & 31) << 3) + 4;
  const bgLum = relLum(dR, dG, dB);
  let best = 0;
  let fg = null;
  for (const [key, n] of hist) {
    if (n / total < 0.02) continue; // ignore specks
    const r2 = (((key >> 10) & 31) << 3) + 4;
    const g2 = (((key >> 5) & 31) << 3) + 4;
    const b2 = ((key & 31) << 3) + 4;
    const ratio = contrastRatio(bgLum, relLum(r2, g2, b2));
    if (ratio > best) { best = ratio; fg = [r2, g2, b2]; }
  }
  if (!fg) return null;
  return { bg: [dR, dG, dB], fg, ratio: +best.toFixed(2), bgShare: +(domCount / total).toFixed(2) };
}

function runContrastRules(area, scale, motion, probe, shot, sf) {
  const candidates = probe.texts
    .filter((t) => (t.ownerOpacity === undefined ? true : t.ownerOpacity >= 0.6))
    .filter((t) => t.rect.w >= 6 && t.rect.h >= 7)
    .sort((a, b) => (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h))
    .slice(0, 10);
  if (!candidates.length) {
    infoRow(area, scale, motion, 'contrast', 'no visible text runs to sample', shot.name);
    return;
  }
  const checked = [];
  const bad = [];
  for (const t of candidates) {
    const sample = sampleColors(shot.pngRaw, t.rect, sf);
    if (!sample) continue; // transparent/covered region — no verdict possible
    const bigText = parseFloat(t.fontSize) >= 18.66 || (parseFloat(t.fontSize) >= 14 && parseFloat(t.fontWeight) >= 700);
    const min = bigText ? 3.0 : 4.5;
    checked.push({ text: t.text.slice(0, 30), ratio: sample.ratio, min });
    if (sample.ratio < min) bad.push({ t, sample, min });
  }
  if (!checked.length) {
    infoRow(area, scale, motion, 'contrast', 'background could not be established under sampled text (transparent or fully glyph-covered areas)', shot.name);
    return;
  }
  if (bad.length) {
    for (const b of bad.slice(0, 5)) {
      failRow(area, scale, motion, 'contrast',
        `"${b.t.text.slice(0, 28)}" (${b.t.fontSize}) on rgb(${b.sample.bg.join(',')}) measures ${b.sample.ratio}:1 < ${b.min}:1 (fg rgb(${b.sample.fg.join(',')}), bg share ${(b.sample.bgShare * 100).toFixed(0)}%)`,
        `text "${b.t.text.slice(0, 20)}"`, shot.name);
    }
  } else {
    const lowest = checked.reduce((a, b) => (a.ratio <= b.ratio ? a : b));
    pass(area, scale, motion, 'contrast', `${checked.length} sampled text run(s) pass AA (lowest "${lowest.text}" ${lowest.ratio}:1 ≥ ${lowest.min}:1)`, shot.name);
  }
}

// ---------------------------------------------------------------------------
// Geometry rules
// ---------------------------------------------------------------------------

function selOf(node) {
  const cls = node.cls && typeof node.cls === 'string' && node.cls ? '.' + String(node.cls).split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
  return `${node.tag}${node.id ? '#' + node.id : ''}${cls}`;
}

let probeIndex = [];

function isInside(a, b) {
  let cur = a;
  let hops = 0;
  while (cur && cur.ppi >= 0 && hops < 12) {
    const parent = probeIndex[cur.ppi];
    if (!parent) break;
    if (parent === b) return true;
    cur = parent;
    hops += 1;
  }
  return false;
}

function parseShadowExtent(shadow) {
  if (!shadow || shadow === 'none') return null;
  let y = 0;
  let x = 0;
  for (const part of String(shadow).replace(/,(?![^(]*\))/g, '\u0001').split('\u0001')) {
    const values = [...part.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => parseFloat(m[1]));
    if (values.length >= 3) {
      const [ox, oy, blur, spread] = values;
      x = Math.max(x, Math.abs(ox) + Math.max(0, spread || 0) + blur * 0.5);
      y = Math.max(y, Math.abs(oy) + Math.max(0, spread || 0) + blur * 0.5);
    }
  }
  return { x: +x.toFixed(0), y: +y.toFixed(0) };
}

function runLayoutRules(area, scale, motion, probe, shot) {
  probeIndex = probe.nodes;
  const vp = probe.viewport;
  const shotNameStr = shot ? shot.name : '';
  for (const node of probe.nodes) {
    const r = node.rect;
    if (r.w <= 1 && r.h <= 1) continue;
    if (node.tag === 'html' || node.tag === 'body') continue;
    // 1) window-level containment — catches window-edge clipped glow too
    if (r.x < -0.7 || r.x + r.w > vp.w + 0.7 || r.y < -0.7 || r.y + r.h > vp.h + 0.7) {
      failRow(area, scale, motion, 'layout',
        `${selOf(node)} extends past the window edge (window ${vp.w}x${vp.h}): x ${r.x}, right ${r.x + r.w}, y ${r.y}, bottom ${r.y + r.h}`,
        selOf(node), shotNameStr);
      continue;
    }
    // 2) island: content containment inside the pill (decor layers excluded — they may sit in the transparent margin)
    if (probe.pill && !node.deco) {
      const pill = probe.pill;
      const out = [];
      if (r.x < pill.x - 0.9) out.push(`left ${(pill.x - r.x).toFixed(1)}px`);
      if (r.x + r.w > pill.x + pill.w + 0.9) out.push(`right ${(r.x + r.w - pill.x - pill.w).toFixed(1)}px`);
      if (r.y < pill.y - 0.9) out.push(`top ${(pill.y - r.y).toFixed(1)}px`);
      if (r.y + r.h > pill.y + pill.h + 0.9) out.push(`bottom ${(r.y + r.h - pill.y - pill.h).toFixed(1)}px`);
      if (out.length) {
        failRow(area, scale, motion, 'layout',
          `${selOf(node)} crosses the pill bounds: ${out.join(', ')} (pill ${pill.w}x${pill.h} at ${pill.x},${pill.y})`,
          selOf(node), shotNameStr);
      }
    }
  }
  // pill shadow must fit the transparent window padding
  if (probe.pill && probe.surfaceShadow && probe.surfaceShadow !== 'none') {
    const ext = parseShadowExtent(probe.surfaceShadow);
    if (ext) {
      const roomBelow = vp.h - (probe.pill.y + probe.pill.h);
      const roomAbove = probe.pill.y;
      const roomSide = Math.min(probe.pill.x, vp.w - (probe.pill.x + probe.pill.w));
      if (roomBelow < ext.y - 20 || roomAbove < ext.y - 8 || roomSide < ext.x - 6) {
        failRow(area, scale, motion, 'shadow',
          `pill shadow (extent y ${ext.y}px, x ${ext.x}px) exceeds the window room (below ${roomBelow}px, above ${roomAbove}px, side ${roomSide}px): ${probe.surfaceShadow}`,
          '.pill-surface', shotNameStr);
      } else {
        pass(area, scale, motion, 'shadow', `shadow fits the transparent window padding (extent y ${ext.y}px, x ${ext.x}px vs room below ${roomBelow}px / side ${roomSide}px)`, shotNameStr);
      }
    } else {
      infoRow(area, scale, motion, 'shadow', `shadow not parseable numeric: ${String(probe.surfaceShadow).slice(0, 80)}`, shotNameStr);
    }
  }
}

function runAlignRules(area, scale, motion, probe, shot) {
  const shotNameStr = shot ? shot.name : '';
  let checked = 0;
  for (const row of probe.rows || []) {
    checked += 1;
    const centers = row.kids.map((k) => k.y + k.h / 2);
    const centerSpread = +(Math.max(...centers) - Math.min(...centers)).toFixed(1);
    if (centerSpread > 1.5) {
      failRow(area, scale, motion, 'align',
        `row "${row.parent}" header cells not vertically centered: centers spread ${centerSpread}px > 1.5px (${row.kids.map((k) => `${k.sel}@${(k.y + k.h / 2).toFixed(1)}px`).join(' + ')})`,
        row.parent, shotNameStr);
      continue;
    }
    pass(area, scale, motion, 'align', `row "${row.parent}" vertically centered (spread ${centerSpread}px, ${row.kids.length} cells)`, shotNameStr);
  }
  for (const stack of probe.stacks || []) {
    checked += 1;
    if (stack.leftSpread > 1) {
      failRow(area, scale, motion, 'align',
        `stack "${stack.parent}" left edges spread ${stack.leftSpread}px > 1px: ${stack.kidSels.slice(0, 4).join(', ')}${stack.kidSels.length > 4 ? ` +${stack.kidSels.length - 4} more` : ''} (lefts ${stack.lefts.slice(0, 5).join(', ')})`,
        stack.parent, shotNameStr);
    } else {
      pass(area, scale, motion, 'align', `stack "${stack.parent}" left edges aligned (spread ${stack.leftSpread}px, ${stack.kidSels.length} cells)`, shotNameStr);
    }
  }
  if (probe.blob && probe.blob.slot && probe.blob.blob) {
    const { blob, slot } = probe.blob;
    const margins = {
      left: +(blob.x - slot.x).toFixed(1),
      right: +((slot.x + slot.w) - (blob.x + blob.w)).toFixed(1),
      top: +(blob.y - slot.y).toFixed(1),
      bottom: +((slot.y + slot.h) - (blob.y + blob.h)).toFixed(1)
    };
    const worst = Math.max(...Object.values(margins));
    if (worst > 2.5) {
      failRow(area, scale, motion, 'align',
        `blob not centered inside its slot (.companion): margins l${margins.left} r${margins.right} t${margins.top} b${margins.bottom} (max ${worst} > 2.5px)`,
        '.companion', shotNameStr);
    } else {
      pass(area, scale, motion, 'align', `blob inside slot with equal margins ≤${worst}px (l${margins.left} r${margins.right} t${margins.top} b${margins.bottom})`, shotNameStr);
    }
  }
  if (!checked) infoRow(area, scale, motion, 'align', 'no rows/stacks discovered in this state', shotNameStr);
}

function runOverlapRules(area, scale, motion, probe, shot) {
  probeIndex = probe.nodes;
  const shotNameStr = shot ? shot.name : '';
  const nodes = probe.nodes.filter((x) => x.interactive || (x.text && x.text.length));
  const ignoredPairs = [];
  const offenders = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      if (isInside(a, b) || isInside(b, a)) continue;
      const ra = a.rect;
      const rb = b.rect;
      const ix = Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x);
      const iy = Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y);
      if (ix <= 0.5 || iy <= 0.5) continue;
      const smaller = Math.min(ra.w * ra.h || 1, rb.w * rb.h || 1);
      const ratio = (ix * iy) / smaller;
      if (ratio < 0.3) continue;
      if (a.ariaHidden === 'true' || b.ariaHidden === 'true') {
        ignoredPairs.push({ pair: `${sel(a)} × ${sel(b)}`, reason: 'aria-hidden decoration' });
        continue;
      }
      if (a.deco || b.deco) {
        ignoredPairs.push({ pair: `${sel(a)} × ${sel(b)}`, reason: 'decorative layer (glow/mask/ghost/tint)' });
        continue;
      }
      if (parseFloat(a.opacity) < 0.25 || parseFloat(b.opacity) < 0.25) {
        ignoredPairs.push({ pair: `${sel(a)} × ${sel(b)}`, reason: 'opacity < .25 layer' });
        continue;
      }
      if (/badge|halo|ghost|avatar|tint|glass|shade|backdrop|scrollbar/i.test(a.cls) || /badge|halo|ghost|avatar|tint|glass|shade|backdrop|scrollbar/i.test(b.cls)) {
        ignoredPairs.push({ pair: `${sel(a)} × ${sel(b)}`, reason: 'intended badge/backdrop on its card' });
        continue;
      }
      offenders.push({ a: sel(a), b: sel(b), ratio: +ratio.toFixed(2) });
      continue;
      function sel(node) {
        return selOf(node);
      }
    }
  }
  if (offenders.length) {
    for (const o of offenders.slice(0, 8)) {
      failRow(area, scale, motion, 'overlap',
        `${o.a} overlaps ${o.b} (fills ${Math.round(o.ratio * 100)}% of the smaller box)`,
        `${o.a} ∧ ${o.b}`, shotNameStr);
    }
  } else {
    pass(area, scale, motion, 'overlap', `no overlap across ${nodes.length} interactive/text elements`, shotNameStr);
  }
  if (ignoredPairs.length) {
    infoRow(area, scale, motion, 'overlap', `ignored intended layering: ${ignoredPairs.slice(0, 5).map((x) => `${x.pair} (${x.reason})`).join('; ')}${ignoredPairs.length > 5 ? `; +${ignoredPairs.length - 5} more` : ''}`, shotNameStr);
  }
}

const CLAMP_CLASS = /ellipsis|truncate|clamp|scroller|marquee|nowrap|ticker|fade|scroll|log-box/i;
function runOverflowRules(area, scale, motion, probe, shot) {
  const shotNameStr = shot ? shot.name : '';
  const bad = [];
  let clampedCount = 0;
  for (const node of probe.nodes) {
    if (!node.text && node.tag !== 'pre' && !node.interactive) continue;
    const sw = node.scrollWidth;
    const cw = node.clientWidth;
    if (!(sw > cw + 1)) continue;
    const intended = CLAMP_CLASS.test(String(node.cls)) || node.textOverflow === 'ellipsis'
      || (parseFloat(node.lineClamp || '0') > 0)
      || node.overflowX === 'auto' || node.overflowX === 'scroll'
      || node.overflowY === 'auto' || node.overflowY === 'scroll'
      || node.deco;
    if (intended) {
      clampedCount += 1;
      infoRow(area, scale, motion, 'overflow', `${selOf(node)} clamps/scrolls intentionally (scrollW ${sw} > clientW ${cw}, overflow ${node.overflowX}, textOverflow ${node.textOverflow}, class ${String(node.cls).slice(0, 40)})`, shotNameStr);
      continue;
    }
    bad.push({ node, sw, cw });
  }
  if (bad.length) {
    for (const b of bad.slice(0, 6)) {
      failRow(area, scale, motion, 'overflow',
        `${selOf(b.node)} scrollWidth ${b.sw} > clientWidth ${b.cw} with unclamped text (overflow ${b.node.overflowX}, whiteSpace ${b.node.whiteSpace})`,
        selOf(b.node), shotNameStr);
    }
  } else {
    pass(area, scale, motion, 'overflow', `no unclamped overflow across ${probe.nodes.length} elements${clampedCount ? ` (${clampedCount} clamped intentional)` : ''}`, shotNameStr);
  }
  const sv = probe.scrollViewport;
  if (sv.scrollW > sv.clientW + 1) {
    failRow(area, scale, motion, 'overflow', `document horizontal scrollbar: scrollWidth ${sv.scrollW} > clientWidth ${sv.clientW}`, 'document', shotNameStr);
  } else {
    pass(area, scale, motion, 'overflow', `document scrollWidth ${sv.scrollW} ≤ clientWidth ${sv.clientW} (no horizontal scrollbar)`, shotNameStr);
  }
}

const STRAY_WHITELIST = /(progress|track|divider|line|rule|rim|bezel|hairline|underline|focus|meter|caret|cursor|scroll|thumb|scale|frame|band|blob|ghost|arrow)/i;
function runStrayRules(area, scale, motion, probe, shot) {
  const shotNameStr = shot ? shot.name : '';
  const strays = [];
  for (const node of probe.nodes) {
    const w = node.rect.w;
    const h = node.rect.h;
    const thinH = h <= 3 && w >= 12;
    const thinV = w <= 3 && h >= 12;
    if (!thinH && !thinV) continue;
    const decorated = (node.bg && node.bg !== 'rgba(0, 0, 0, 0)' && node.bg !== 'transparent') || (node.boxShadow && node.boxShadow !== 'none');
    if (!decorated) continue;
    if (STRAY_WHITELIST.test(String(node.cls)) || node.deco || node.interactive) continue;
    strays.push(node);
  }
  if (strays.length) {
    for (const s of strays.slice(0, 5)) {
      failRow(area, scale, motion, 'stray',
        `${selOf(s)} is ${s.rect.w}×${s.rect.h}px with bg ${s.bg} (not whitelisted as divider/progress/rim, crosses content)`,
        selOf(s), shotNameStr);
    }
  } else {
    pass(area, scale, motion, 'stray', `no stray thin lines across ${probe.nodes.length} elements`, shotNameStr);
  }
}

const HIT_MIN = 32;
function runHitRules(area, scale, motion, probe, shot) {
  const shotNameStr = shot ? shot.name : '';
  const all = probe.nodes.filter((n) => n.interactive);
  const small = all.filter((n) => n.rect.w < HIT_MIN || n.rect.h < HIT_MIN);
  if (small.length) {
    for (const s of small.slice(0, 8)) {
      failRow(area, scale, motion, 'hit',
        `${selOf(s)} measures ${s.rect.w}×${s.rect.h} px < ${HIT_MIN}×${HIT_MIN} minimum`,
        selOf(s), shotNameStr);
    }
  } else {
    pass(area, scale, motion, 'hit', `all ${all.length} interactive elements ≥ ${HIT_MIN}px`, shotNameStr);
  }
}

function runAssetRules(area, scale, motion, probe, shot) {
  const shotNameStr = shot ? shot.name : '';
  const bad = [];
  if (probe.fonts.status !== 'loaded') bad.push(`document.fonts.status = ${probe.fonts.status}`);
  for (const face of probe.fonts.faces) {
    if (face.status !== 'loaded') bad.push(`font "${face.family}" ${face.style} ${face.weight} → ${face.status}`);
  }
  const broken = (probe.images || []).filter((i) => i.naturalWidth === 0 && i.src);
  for (const item of bad.slice(0, 6)) failRow(area, scale, motion, 'assets', item, '@font-face', shotNameStr);
  for (const img of broken.slice(0, 5)) failRow(area, scale, motion, 'assets', `image naturalWidth 0: ${img.src}`, 'img', shotNameStr);
  if (!bad.length && !broken.length) {
    pass(area, scale, motion, 'assets', `${probe.fonts.faces.length} font face(s) + ${probe.images.length} image(s) all loaded`, shotNameStr);
  }
}

function runErrorRules(area, scale, motion, shotNameStr, delta, collector) {
  let any = false;
  if (delta.errors > 0) {
    const samples = collector.errors.slice(-2).map((e) => `"${e.text}"`).join(' | ');
    failRow(area, scale, motion, 'errors', `${delta.errors} new console error(s): ${samples}`, 'renderer console', shotNameStr);
    any = true;
  }
  if (delta.failLoads > 0) {
    const samples = collector.failLoads.slice(-2).map((f) => `"${f.desc}" ${f.url}`).join(' | ');
    failRow(area, scale, motion, 'errors', `${delta.failLoads} failed resource load(s): ${samples}`, 'resource loader', shotNameStr);
    any = true;
  }
  if (delta.warnings > 0) {
    const samples = collector.warnings.slice(-2).map((w) => `"${w.text}"`).join(' | ');
    failRow(area, scale, motion, 'errors', `${delta.warnings} new console warning(s): ${samples}`, 'renderer console', shotNameStr);
    any = true;
  }
  if (!any) pass(area, scale, motion, 'errors', 'no new console errors/warnings/failed loads in this state', shotNameStr);
}

async function probeLongWord(area, scale, motion, wc, shot) {
  const result = await wc.executeJavaScript(PROBE_LONGWORD, true);
  if (!Array.isArray(result) || !result.length) {
    infoRow(area, scale, motion, 'holdword', 'no text containers found for the 64-char probe', shot.name);
    return;
  }
  const offenders = result.filter((r) => {
    if (r.error) return true;
    if (r.parentEllipsis === 'ellipsis' || parseFloat(r.parentClamp || '0') > 0) return false;
    const clipped = r.elemScroll && r.elemScroll.sw > r.elemScroll.cw + 1;
    const containerClipped = r.ppScroll && r.ppScroll.sw > r.ppScroll.cw + 1 && !['auto', 'scroll', 'hidden'].includes(r.ppOverflowX);
    return clipped || containerClipped;
  });
  if (offenders.length) {
    for (const b of offenders.slice(0, 6)) {
      if (b.error) {
        failRow(area, scale, motion, 'holdword', `probe crashed: ${b.error}`, 'probe', shot.name);
        continue;
      }
      failRow(area, scale, motion, 'holdword',
        `${b.sel} breaks with a 64-char unbroken word: scrollW ${b.elemScroll.sw} > clientW ${b.elemScroll.cw} (overflow ${b.parentoverflow})`,
        b.sel, shot.name);
    }
  } else {
    pass(area, scale, motion, 'holdword', `64-char unbroken word contained in ${result.length} probed containers`, shot.name);
  }
}

// ---------------------------------------------------------------------------
// Keyboard leg (real Tab key events -> :focus-visible ring)
// ---------------------------------------------------------------------------

async function keyboardLeg(area, scale, motion, wc, shot) {
  const seq = await wc.executeJavaScript(FOCUS_SEQ, true);
  if (!Array.isArray(seq) || !seq.length) {
    infoRow(area, scale, motion, 'keyboard', 'no focusable elements in scope', shot.name);
    return;
  }
  const maxTabs = Math.min(seq.length + 2, 60);
  const hitMap = new Map();
  for (let k = 0; k < maxTabs; k += 1) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await sleep(28);
    const f = await wc.executeJavaScript(FOCUS_WINDOW, true);
    if (!f || f.error) continue;
    let bestI = -1;
    let bestDist = 6;
    for (const el of seq) {
      if (el.tag !== f.tag) continue;
      const dist = Math.abs(el.x - f.rect.x) + Math.abs(el.y - f.rect.y) + Math.abs(el.w - f.rect.w);
      if (dist < bestDist) { bestDist = dist; bestI = el.i; }
    }
    if (bestI >= 0 && !hitMap.has(bestI)) hitMap.set(bestI, f);
  }
  const ringMissing = [];
  for (const [i, f] of hitMap) {
    const outlineRing = f.outlineStyle !== 'none' && parseFloat(f.outlineWidth) > 0 && f.outlineColor !== 'transparent';
    if (outlineRing) continue;
    ringMissing.push(`#${seq[i].id || String(seq[i].cls).slice(0, 24)} (${f.tag}) outline=${f.outlineStyle} ${f.outlineWidth} ${f.outlineColor} focus-visible=${f.focusVisible}`);
  }
  const missed = seq.filter((el) => !hitMap.has(el.i));
  if (ringMissing.length) {
    failRow(area, scale, motion, 'keyboard',
      `${ringMissing.length}/${hitMap.size} tab stop(s) without a visible focus ring; e.g. ${ringMissing[0]}`,
      'focus ring', shot.name);
  } else if (missed.length) {
    failRow(area, scale, motion, 'keyboard',
      `${missed.length}/${seq.length} focusable element(s) never received Tab focus: ${missed.slice(0, 4).map((m) => `${m.tag}${m.id ? '#' + m.id : ''}.${String(m.cls).slice(0, 14)}`).join(', ')}`,
      missed[0] ? `${missed[0].tag}${missed[0].id ? '#' + missed[0].id : ''}` : 'tab order', shot.name);
  } else {
    pass(area, scale, motion, 'keyboard', `all ${hitMap.size} tab stop(s) reached; focused elements show their ring`, shot.name);
  }
}

// ---------------------------------------------------------------------------
// Static token scan
// ---------------------------------------------------------------------------

function tokenScan() {
  const tokens = fs.readFileSync(path.join(REPO, 'renderer', 'tokens.css'), 'utf8');
  const allowed = new Set(['transparent']);
  for (const match of tokens.matchAll(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8}|[0-9a-fA-F]{3})\b/g)) allowed.add(match[0].toLowerCase());
  for (const match of tokens.matchAll(/rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)/gi)) allowed.add(match[0].toLowerCase());
  const scan = [];
  for (const file of ['island.css', 'dashboard.css']) {
    let css = '';
    try { css = fs.readFileSync(path.join(REPO, 'renderer', file), 'utf8'); } catch { continue; }
    const occurrences = [];
    for (const match of css.matchAll(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8}|[0-9a-fA-F]{3})\b|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)/gi)) {
      const literal = match[0].toLowerCase();
      if (allowed.has(literal)) continue;
      const line = css.slice(0, match.index).split('\n').length;
      occurrences.push({ literal, line });
    }
    scan.push({ file, occurrences });
  }
  for (const file of scan) {
    if (!file.occurrences.length) {
      infoRow('static', '—', '—', 'tokens', `${file.file}: every color literal maps to tokens.css (or the file carries none)`, '');
      continue;
    }
    const unique = [...new Set(file.occurrences.map((o) => o.literal))].slice(0, 5).join(', ');
    failRow('static', '—', '—', 'tokens',
      `${file.file}: ${file.occurrences.length} color literal(s) outside tokens.css, e.g. ${unique}${file.occurrences.length > 5 ? ` +${file.occurrences.length - 5} more` : ''}`,
      'css color literals', '');
  }
  return scan;
}

// ---------------------------------------------------------------------------
// Screen emulation
// ---------------------------------------------------------------------------

async function ensureDebugger(wc) {
  const dbg = wc.debugger;
  if (!dbg.isAttached()) await dbg.attach('1.3');
  return dbg;
}

async function setReducedMotion(wc, preferNormal) {
  const dbg = await ensureDebugger(wc);
  await dbg.sendCommand('Emulation.setEmulatedMedia', preferNormal
    ? { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }
    : { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
}

async function setScale(wc, scale, viewport) {
  const dsf = scale / 100;
  let note = '';
  try {
    wc.enableDeviceEmulation({ screenPosition: 'desktop', deviceScaleFactor: dsf, scale: 1 });
    await sleep(80);
    const dpr = await wc.executeJavaScript('window.devicePixelRatio', true);
    if (Math.abs(dpr - dsf) < 0.02) {
      return { method: `enableDeviceEmulation (dpr ${dpr})`, dpr };
    }
    note = `enableDeviceEmulation no dpr effect (dpr stayed ${dpr}) → `;
  } catch (error) {
    note = `enableDeviceEmulation errored (${String(error.message).slice(0, 60)}) → `;
  }
  try {
    const dbg = await ensureDebugger(wc);
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: Math.round(viewport.w),
      height: Math.round(viewport.h),
      deviceScaleFactor: dsf,
      mobile: false,
      screenWidth: Math.round(viewport.w),
      screenHeight: Math.round(viewport.h),
      scale: 1
    });
    await sleep(140);
    const dpr = await wc.executeJavaScript('window.devicePixelRatio', true);
    return { method: `${note}Emulation.setDeviceMetricsOverride (dpr ${dpr})`, dpr };
  } catch (error) {
    return { method: `${note}CDP override failed: ${String(error.message).slice(0, 60)}`, dpr: null };
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function captureShot(prefix, wc, scale, motion) {
  const image = await wc.capturePage();
  const pngRaw = image.toPNG();
  const name = shotName(prefix, scale, motion);
  const file = path.join(SHOTS, name);
  fs.writeFileSync(file, pngRaw);
  flattenPNG(file, [28, 29, 33]);
  doneScreenshots += 1;
  return { file, name, size: image.getSize(), pngRaw };
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

let overlay = null;
let dashboardWin = null;
let overlayCounts = { errors: 0, warnings: 0, failLoads: 0 };
let dashCounts = { errors: 0, warnings: 0, failLoads: 0 };

function snapCounts(c) { return { errors: c.errors.length, warnings: c.warnings.length, failLoads: c.failLoads.length }; }
function diffCounts(before, c) {
  return {
    errors: c.errors.length - before.errors,
    warnings: c.warnings.length - before.warnings,
    failLoads: c.failLoads.length - before.failLoads
  };
}

async function waitForRenderer(wc) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      if (await wc.executeJavaScript('Boolean(window.voiceAgent)', true)) return true;
    } catch { /* still loading */ }
    await sleep(120);
  }
  return false;
}

async function probeOrThrow(wc) {
  const probe = await wc.executeJavaScript(DOM_PROBE, true);
  if (!probe || probe.probeError) {
    throw new Error(`DOM probe crashed (possible mid-edit): ${(probe && probe.probeError) || JSON.stringify(probe).slice(0, 200)}`);
  }
  return probe;
}

function sfFor(probe, shotSize) {
  const w = probe && probe.viewport ? probe.viewport.w : 0;
  return w > 0 && shotSize.width > 0 ? shotSize.width / w : 1;
}

function runAllGeometryRules(area, scale, motion, probe, shot) {
  runLayoutRules(area, scale, motion, probe, shot);
  runAlignRules(area, scale, motion, probe, shot);
  runOverlapRules(area, scale, motion, probe, shot);
  runOverflowRules(area, scale, motion, probe, shot);
  runStrayRules(area, scale, motion, probe, shot);
  runHitRules(area, scale, motion, probe, shot);
  runContrastRules(area, scale, motion, probe, shot, sfFor(probe, shot.size));
  runAssetRules(area, scale, motion, probe, shot);
}

async function runOneState(scenario, scale, motion) {
  const area = `island · ${scenario.name}`;
  const wc = overlay.getWindow().webContents;
  overlay.hideNow();
  await sleep(170);
  overlay.show(scenario.patch);
  if (scenario.wave) {
    try {
      await wc.executeJavaScript(`(function(){ try { applyAudioLevel(0.55, ${JSON.stringify(WAVE)}); return 'ok'; } catch (e) { return 'ERR ' + e.message; } })()`, true);
    } catch { /* best-effort */ }
  }
  await sleep(scenario.wait);
  const probe = await probeOrThrow(wc);
  const before = snapCounts(overlayCollector);
  const shot = await captureShot(`island-${scenario.name}`, wc, scale, motion);
  runAllGeometryRules(area, scale, motion, probe, shot);
  runErrorRules(area, scale, motion, shot.name, diffCounts(before, overlayCollector), overlayCollector);
  overlayCounts = snapCounts(overlayCollector);
  if (!QUICK) await probeLongWord(area, scale, motion, wc, shot);
  await keyboardLeg(area, scale, motion, wc, shot);
}

async function runStatesFor(scale, motion) {
  let first = true;
  for (const scenario of STATES) {
    if (!want(scenario.name)) continue;
    let attempt = 0;
    let ok = false;
    while (attempt < 2 && !ok) {
      attempt += 1;
      try {
        await runOneState(first ? scenario : { ...scenario, wait: Math.max(scenario.wait, 1200) }, scale, motion);
        first = false;
        ok = true;
      } catch (error) {
        const message = String(error && error.stack || error);
        if (attempt < 2) {
          console.log(`possible mid-edit on island/${scenario.name}: attempt ${attempt} failed (${message.slice(0, 180)}) — re-running in 20 s`);
          await sleep(20000);
        } else {
          failRow(`island · ${scenario.name}`, scale, motion === 1 ? 'motion' : 'reduce', 'errors',
            `harness could not drive this state twice, even after a 20 s re-run (possible mid-edit): ${message.slice(0, 280)}`,
            'harness/possible mid-edit', '');
          midEdit.add(scenario.name);
        }
      }
    }
  }
}

async function runOnePage(page, scale, motion) {
  const area = `dashboard · ${page}`;
  const wc = dashboardWin.webContents;
  const clicked = await wc.executeJavaScript(`(function(){
    try {
      var btn = document.querySelector('[data-page="${page}"]');
      if (!btn) return 'NO-BUTTON';
      btn.click();
      return 'ok';
    } catch (e) { return 'ERR ' + e.message; }
  })()`, true);
  if (clicked !== 'ok') throw new Error(`nav "${page}": ${clicked}`);
  await sleep(QUICK ? 640 : 1050);
  const probe = await probeOrThrow(wc);
  const before = snapCounts(dashCollector);
  const shot = await captureShot(`dashboard-${page}`, wc, scale, motion);
  runAllGeometryRules(area, scale, motion, probe, shot);
  runErrorRules(area, scale, motion, shot.name, diffCounts(before, dashCollector), dashCollector);
  dashCounts = snapCounts(dashCollector);
  if (!QUICK) await probeLongWord(area, scale, motion, wc, shot);
  await keyboardLeg(area, scale, motion, wc, shot);
}

async function runDashFor(scale, motion) {
  for (const page of DASH_PAGES) {
    if (!want(page)) continue;
    let attempt = 0;
    let ok = false;
    while (attempt < 2 && !ok) {
      attempt += 1;
      try {
        await runOnePage(page, scale, motion);
        ok = true;
      } catch (error) {
        const message = String(error && error.stack || error);
        if (attempt < 2) {
          console.log(`possible mid-edit on dashboard/${page}: attempt ${attempt} failed (${message.slice(0, 180)}) — re-running in 20 s`);
          await sleep(20000);
        } else {
          failRow(`dashboard · ${page}`, scale, motion === 1 ? 'motion' : 'reduce', 'errors',
            `harness could not drive this page twice, even after a 20 s re-run (possible mid-edit): ${message.slice(0, 280)}`,
            'harness/possible mid-edit', '');
          midEdit.add(`dashboard/${page}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Leaks leg: 30 cycles through core states
// ---------------------------------------------------------------------------

const LEAK_CYCLE_STATES = ['compact', 'medium', 'listening', 'response', 'notifications', 'toast', 'download', 'empty-notifications'];

async function runLeaksLeg() {
  const area = 'island · leak-cycle';
  const wc = overlay.getWindow().webContents;
  overlay.setStyle('island');
  const base = await wc.executeJavaScript(LEAKS_SNAPSHOT, true);
  if (!base) {
    failRow(area, '100', '—', 'leaks', 'leak counters missing in the renderer', 'window.__uicLeaks', '');
    return;
  }
  const baseline = { intervalLive: base.intervalLive, listenersNet: base.listenersNet };
  const subset = STATES.filter((s) => LEAK_CYCLE_STATES.includes(s.name));
  const checkpoints = [];
  const t0 = Date.now();
  for (let cycle = 1; cycle <= 30; cycle += 1) {
    for (const scenario of subset) {
      overlay.show(scenario.patch);
      await sleep(QUICK ? 230 : 380);
    }
    if (cycle === 1 || cycle === 10 || cycle === 20 || cycle === 30) {
      const snap = await wc.executeJavaScript(LEAKS_SNAPSHOT, true);
      if (snap) checkpoints.push({ cycle, snap });
    }
  }
  const minutes = ((Date.now() - t0) / 60000).toFixed(1);
  const last = checkpoints[checkpoints.length - 1];
  if (!last) {
    failRow(area, '100', '—', 'leaks', 'no leak checkpoints were recorded', 'window.__uicLeaks', '');
    return;
  }
  const final = last.snap;
  const intervalDrift = final.intervalLive - baseline.intervalLive;
  const listenerDrift = final.listenersNet - baseline.listenersNet;
  const pendingRaf = final.rafScheduled - final.rafCompleted;
  const schedPerInterval = [];
  for (let i = 1; i < checkpoints.length; i += 1) schedPerInterval.push(checkpoints[i].snap.rafScheduled - checkpoints[i - 1].snap.rafScheduled);
  const growth = schedPerInterval.length >= 2 ? schedPerInterval[schedPerInterval.length - 1] / Math.max(1, schedPerInterval[0]) : 1;
  const reasons = [];
  if (intervalDrift > 2) reasons.push(`live setInterval count ${baseline.intervalLive} → ${final.intervalLive} (+${intervalDrift}); new interval per state cycle leaks`);
  if (listenerDrift > 3) reasons.push(`window/document listener pool grew by ${listenerDrift} over the run (adds without removes)`);
  if (pendingRaf > 16) reasons.push(`${pendingRaf} rAF callbacks scheduled but never completed (stuck loop callbacks)`);
  if (growth > 2.2) reasons.push(`rAF scheduling rate per checkpoint grew ×${growth.toFixed(2)} — an extra loop appears during the cycle`);
  const note = `30 cycles × ${subset.length} states in ${minutes} min | intervals ${baseline.intervalLive}→${final.intervalLive} | listeners ${baseline.listenersNet}→${final.listenersNet} | rAF pending ${pendingRaf} | rAF/checkpoint growth ×${growth.toFixed(2)}`;
  if (reasons.length) failRow(area, '100', '—', 'leaks', `${note} → GROWTH: ${reasons.join('; ')}`, 'renderer loops/timers/listeners', '');
  else pass(area, '100', '—', 'leaks', `${note} → no growth`, '');
}

// ---------------------------------------------------------------------------
// Perf leg
// ---------------------------------------------------------------------------

function appMetricsSnapshot(rendererPid) {
  const metrics = app.getAppMetrics();
  let total = 0;
  let renderer = null;
  for (const item of metrics) {
    const cpu = item.cpuUsage && item.cpuUsage.cpu;
    total += cpu || 0;
    if (item.pid === rendererPid) renderer = cpu || 0;
  }
  return { total: +total.toFixed(1), renderer: renderer == null ? null : +renderer.toFixed(1), processes: metrics.length };
}

async function measureCpu(wc, ms) {
  const rendererPid = wc ? wc.getProcessId() : null;
  const start = appMetricsSnapshot(rendererPid);
  await sleep(ms);
  const end = appMetricsSnapshot(rendererPid);
  return { avg: +((start.total + end.total) / 2).toFixed(1), start: start.total, end: end.total, renderer: end.renderer, processes: end.processes };
}

async function runPerfLeg() {
  const area = 'island · perf';
  const wc = overlay.getWindow().webContents;
  if (dashboardWin && !dashboardWin.isDestroyed()) dashboardWin.hide();
  overlay.show({ status: 'idle', message: '', notifications: [], download: null });
  await sleep(1800);
  const idle = await measureCpu(wc, 5000);
  const idleNote = `idle-CPU (collapsed pill visible): avg ${idle.avg}% app CPU over 5 s (samples ${idle.start}% → ${idle.end}%; overlay renderer ${idle.renderer}%; ${idle.processes} processes incl. GPU)`;
  if (idle.avg <= 8) pass(area, '100', 'motion', 'perf', `${idleNote} → within the near-zero budget`, '');
  else failRow(area, '100', 'motion', 'perf', `${idleNote} → above the 8% idle budget for one collapsed pill`, 'renderer/main aggregate', '');
  overlay.show({ status: 'listening', message: 'Speak naturally. Release to send.', companionEnabled: true });
  try {
    await wc.executeJavaScript(`(function(){ try { applyAudioLevel(0.55, ${JSON.stringify(WAVE)}); return 'ok'; } catch (e) { return 'ERR'; } })()`, true);
  } catch { }
  await sleep(1700);
  const glow = await measureCpu(wc, 5000);
  const glowNote = `glow-animation CPU: avg ${glow.avg}% app CPU over 5 s (samples ${glow.start}% → ${glow.end}%; overlay renderer ${glow.renderer}%)`;
  if (glow.avg <= 40) pass(area, '100', 'motion', 'perf', `${glowNote} → within budget`, '');
  else failRow(area, '100', 'motion', 'perf', `${glowNote} → above the 40% budget while the glow animation is active`, 'renderer/main aggregate', '');
  if (dashboardWin && !dashboardWin.isDestroyed()) dashboardWin.showInactive();
}

// ---------------------------------------------------------------------------
// IPC stubs (isolated profile — dashboard renders deterministically, no main.cjs)
// ---------------------------------------------------------------------------

function registerIpcStubs() {
  ipcMain.on('brand:name', (event) => { event.returnValue = 'Voxa'; });
  const state = () => ({
    appName: 'Voxa',
    appVersion: '1.2.0 (ui-check isolated profile)',
    userName: 'ui-check',
    gallery: true,
    settings: {
      mode: 'agent', chatProvider: 'local', activeMode: 'agent', lastCloudProvider: 'ollama',
      sttProvider: 'local', sttCloudProvider: 'openai', ttsEngine: 'kokoro', ttsVoice: 'af_heart',
      whisperPreset: 'fast', whisperModel: 'base', whisperLanguage: 'auto',
      overlayStyle: 'island', companionEnabled: true, dictationHotkey: 'F2', agentHotkey: 'F3',
      fallbackEnabled: false, autostart: false, monitorMic: false, permissionMode: 'routine',
      customPermissions: {}, providers: {}
    },
    turns: [
      { time: new Date().toISOString(), said: 'Summarize my meeting notes', did: 'A concise summary is ready.' },
      { time: new Date(Date.now() - 3600000).toISOString(), said: 'Write a short follow-up', did: 'Draft prepared for review.' },
      { time: new Date(Date.now() - 86400000).toISOString(), said: 'Open my documents', did: 'Opened Documents.' }
    ],
    memory: ['Prefers concise replies', 'Workday starts at 9:00'],
    health: { ollama: { ok: true, message: 'Ready' }, whisper: { ok: true, message: 'Ready' }, kokoro: { status: 'unknown' } },
    activationLogs: [{ time: new Date().toISOString(), level: 'info', step: 'app', detail: 'ui-check isolated profile' }],
    hotkey: { mode: 'uiohook', error: '', dictation: 'F2', agent: 'F3' },
    apps: ['Calendar', 'Mail', 'Notes', 'Browser'],
    keyStatus: {}
  });
  const onHandle = (channel, fn) => { try { ipcMain.handle(channel, fn); } catch { /* already handled */ } };
  onHandle('app:state', () => state());
  onHandle('logs:read', () => ['2026-01-01T00:00:00.000Z [info] [app] ui-check isolated profile log']);
  onHandle('health:check', () => state().health);
  onHandle('tts:health', () => state().health.kokoro);
  onHandle('whisper:models', () => ({ ok: true, models: [] }));
  onHandle('provider:models', () => []);
  onHandle('microphone:list', () => []);
  onHandle('updater:get-status', () => ({ status: 'idle', version: '1.2.0', canUpdate: false }));
  for (const channel of ['settings:save', 'provider:save-key', 'provider:test', 'provider:detect', 'ollama:pull', 'ollama:open-download', 'whisper:load', 'whisper:cancel', 'microphone:test', 'microphone:monitor', 'assistant:toggle', 'assistant:stop', 'assistant:set-mode', 'history:clear', 'apps:refresh', 'overlay:preview', 'overlay:test', 'overlay:gallery-options', 'voice:test', 'tts:download', 'tts:cancel-download', 'tts:speak', 'window:action', 'updater:check', 'updater:download', 'updater:install']) {
    onHandle(channel, () => ({}));
  }
  for (const channel of ['approval:respond', 'overlay:resize', 'overlay:stop', 'overlay:copy', 'overlay:interactive', 'overlay:hidden', 'overlay:expand', 'overlay:dismiss-pause', 'overlay:dismiss-resume', 'overlay:notification-dismiss', 'overlay:media-control', 'overlay:feed-toggle', 'overlay:open-settings', 'chat:send', 'chat:cancel', 'chat:open', 'chat:close', 'chat:request-history', 'recorder:audio', 'recorder:error', 'recorder:audio-level', 'recorder:speech-level', 'recorder:test-progress', 'recorder:response', 'recorder:ready']) {
    try { ipcMain.on(channel, () => { }); } catch { }
  }
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function gitInfo() {
  const run = (args) => {
    try {
      const result = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', timeout: 15000 });
      return result.status === 0 ? String(result.stdout || '').trim() : '';
    } catch { return ''; }
  };
  const commit = run(['rev-parse', 'HEAD']);
  const dirtyRaw = run(['status', '--short']);
  return { commit: commit || 'unknown (git unavailable)', dirtyRaw, dirty: dirtyRaw ? dirtyRaw.split('\n').filter(Boolean) : [] };
}

function buildReport(tokenScanResult, startedStamp, git, minutes) {
  const out = [];
  out.push('# Voxa UI QA check — REPORT');
  out.push('');
  out.push(`- started ${new Date(startedStamp).toISOString()} · finished ${new Date().toISOString()} · duration ${minutes} min`);
  out.push(`- git commit: \`${git.commit}\``);
  out.push(`- working tree: ${git.dirty.length ? `**DIRTY** — another session is editing (${git.dirty.length} entries; first: \`${git.dirty[0]}\`)` : 'clean'}`);
  out.push(`- mode: ${QUICK ? 'quick' : 'full'} · scales: ${SCALES.join('%, ')}% · motion values: \`reduce\` (prefers-reduced-motion ON) vs \`motion\` (OFF = no-preference)`);
  out.push(`- isolation: own Electron instance spawned by this script; fresh temp profile ${path.basename(PROFILE)} under %TEMP% (deleted at exit); no ports opened — the whisper:8000/kokoro rails of a live Voxa are never started by this harness; only PIDs owned by this script were used.`);
  out.push('- selftest: NOT run — `npm run selftest` always targets the real profile; skipped per harness contract.');
  out.push(`- screenshots: ${doneScreenshots} flattened PNGs in shots/`);
  out.push('');
  out.push('Scale note: deviceScaleFactor emulates Windows scale (dpr re-checked in the renderer and logged in the run output); element rects are CSS px, contrast samples use device pixels at sf = shot.width / viewport.width.');
  out.push('');
  out.push('## Rule legend');
  out.push('');
  out.push('| rule | meaning |');
  out.push('|---|---|');
  for (const [code, label] of Object.entries(RULE_LABEL)) out.push(`| ${code} | ${label} |`);
  out.push('');
  out.push('## Results');
  out.push('');
  out.push('| state/page | scale | motion | rule | result | evidence | shot |');
  out.push('|---|---|---|---|---|---|---|');
  for (const row of rows) {
    const evidence = String(row.evidence).replace(/\|/g, '/').slice(0, 420);
    out.push(`| ${row.area} | ${row.scale} | ${row.motion} | ${row.rule} | ${row.result} | ${evidence} | ${row.shot ? `[${row.shot}](shots/${row.shot})` : ''} |`);
  }
  out.push('');
  out.push('## Token static scan (colors outside tokens.css; style.css exempt — legacy shared shell)');
  out.push('');
  out.push('| file | unique off-token literals (examples) | occurrences |');
  out.push('|---|---|---|');
  for (const file of tokenScanResult) {
    const unique = [...new Set(file.occurrences.map((o) => o.literal))].slice(0, 8).join(', ');
    out.push(`| ${file.file} | ${unique ? `${unique}${unique.endsWith(',') ? '' : ''}` : '—'} | ${file.occurrences.length} |`);
  }
  out.push('');
  out.push('## Possible mid-edit re-runs (state re-run once after 20 s before reporting)');
  out.push('');
  out.push(midEdit.size ? [...midEdit].map((m) => `- ${m}`).join('\n') : 'none');
  out.push('');
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), out.join('\n') + '\n');
}

function buildFixList() {
  const groups = new Map();
  for (const fail of fails) {
    const base = fail.area.split('·')[0].trim();
    const key = `${fail.rule}::${fail.selector}::${base}`;
    if (!groups.has(key)) {
      groups.set(key, { rule: fail.rule, selector: fail.selector, base, evidence: fail.evidence, fix: fail.fix, hits: [] });
    }
    groups.get(key).hits.push(`${fail.area} · ${fail.scale}% · ${fail.motion}`);
  }
  const rank = { layout: 0, overlap: 1, overflow: 2, holdword: 3, shadow: 4, stray: 5, hit: 6, contrast: 7, keyboard: 8, align: 9, errors: 10, assets: 11, leaks: 12, perf: 13, tokens: 14 };
  const items = [...groups.values()].sort((a, b) => (rank[a.rule] ?? 99) - (rank[b.rule] ?? 99));
  const out = ['# Voxa UI QA check — FIX-LIST', '', 'One item per real defect; the same bug seen at several scales/states is grouped ONCE. Items are paste-ready tasks for the editing session.', ''];
  items.forEach((item, index) => {
    out.push(`## ${index + 1}. [${item.rule}] ${item.selector || item.base}`);
    out.push('');
    out.push(`- affects: ${[...new Set(item.hits)].slice(0, 10).join(', ')}${item.hits.length > 10 ? ` (+${item.hits.length - 10} more combos)` : ''}`);
    out.push(`- measured: ${item.evidence}`);
    out.push(`- suggested fix: ${item.fix}`);
    out.push(`- file hint: ${item.rule === 'tokens' ? 'renderer/tokens.css + renderer/island.css | renderer/dashboard.css' : 'renderer/island.css | renderer/overlay.js | renderer/dashboard.css — evidence above pins the exact selector'}`);
    out.push('');
  });
  fs.writeFileSync(path.join(OUT, 'FIX-LIST.md'), out.join('\n') + '\n');
}

function cleanupProfile() {
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    try { spawnSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', PROFILE], { stdio: 'ignore', timeout: 8000 }); } catch { }
    if (fs.existsSync(PROFILE)) console.warn(`ui-check: could not delete temp profile ${PROFILE} (best effort; %TEMP% cleanup will collect it)`);
  }
}

function exitRun(code) {
  console.log(`\nui-check finished: ${fails.length} failing task(s), ${rows.filter((r) => r.result === 'PASS').length} passes, ${rows.filter((r) => r.result === 'INFO').length} infos, ${doneScreenshots} shots → ${OUT}`);
  console.log(code === 0 ? 'ui-check: ALL GREEN' : 'ui-check: FAILURES PRESENT (exit 1)');
  cleanupProfile();
  process.exitCode = code;
  app.exit(code);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startedStamp = Date.now();
  registerIpcStubs();
  app.on('window-all-closed', () => { /* the driver owns its windows */ });

  await app.whenReady();
  const git = gitInfo();
  console.log(`ui-check: isolated profile ${PROFILE}`);
  console.log(`ui-check: commit ${git.commit}; working tree ${git.dirty.length ? `DIRTY (${git.dirty.length} entries)` : 'clean'}`);

  // ---- overlay: the real window from lib/overlay.cjs ----
  overlay = createOverlay({ log: { info: () => { }, warn: (tag, text) => console.log(`[warn:${tag}] ${text}`), error: (tag, text) => console.log(`[error:${tag}] ${text}`) } });
  overlay.create();
  if (!await waitForRenderer(overlay.getWindow().webContents)) {
    throw new Error('overlay renderer never reported ready (possible mid-edit)');
  }
  attachCollector(overlay.getWindow().webContents, overlayCollector);
  await overlay.getWindow().webContents.executeJavaScript(INSTALL_PROBE, true);
  overlayCounts = snapCounts(overlayCollector);
  overlay.hideNow();
  await sleep(220);

  // ---- dashboard: real settings.html window with stubbed IPC ----
  dashboardWin = new BrowserWindow({
    width: 1080,
    height: 710,
    show: false,
    title: 'Voxa · ui-check',
    backgroundColor: '#0e0d0b',
    webPreferences: {
      preload: path.join(REPO, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  dashboardWin.setMenuBarVisibility(false);
  attachCollector(dashboardWin.webContents, dashCollector);
  await dashboardWin.loadFile(path.join(REPO, 'renderer', 'settings.html'));
  await waitForRenderer(dashboardWin.webContents);
  await dashboardWin.webContents.executeJavaScript(INSTALL_PROBE, true);
  dashCounts = snapCounts(dashCollector);
  await sleep(600);

  // ---- static token scan ----
  const scan = tokenScan();

  // ---- sweeps ----
  const OVERLAY_VIEW = { w: 720, h: 640 };
  const DASH_VIEW = { w: 1080, h: 710 };
  for (const scale of SCALES) {
    const motions = (QUICK && SCALES.length > 1) ? [1] : [1, 0];
    for (const motion of motions) {
      const ovScale = await setScale(overlay.getWindow().webContents, scale, OVERLAY_VIEW);
      const dashScale = await setScale(dashboardWin.webContents, scale, DASH_VIEW);
      console.log(`scale ${scale}% — overlay dpr ${ovScale.dpr} (${ovScale.method}) | dashboard dpr ${dashScale.dpr} (${dashScale.method})`);
      await setReducedMotion(overlay.getWindow().webContents, motion === 1);
      await setReducedMotion(dashboardWin.webContents, motion === 1);
      if (doLeg('states')) await runStatesFor(scale, motion);
      if (doLeg('dashboard')) await runDashFor(scale, motion);
    }
  }

  // ---- legs ----
  if (doLeg('leaks')) {
    console.log('leg: leaks — 30 state cycles…');
    await runLeaksLeg();
  }
  if (doLeg('perf')) {
    console.log('leg: perf — idle + glow CPU…');
    await runPerfLeg();
  }

  // ---- report ----
  const minutes = ((Date.now() - startedStamp) / 60000).toFixed(1);
  buildReport(scan, startedStamp, git, minutes);
  buildFixList();
  exitRun(fails.length ? 1 : 0);
}

// ---- crash guards ----
process.on('uncaughtException', (error) => {
  console.error('ui-check uncaught:', error && error.stack || error);
  try {
    fs.writeFileSync(path.join(OUT, 'REPORT-error.json'), JSON.stringify({ lastRows: rows.slice(-40), error: String(error && error.stack || error) }, null, 2));
  } catch { }
  setTimeout(() => app.exit(1), 300);
});
process.on('unhandledRejection', (error) => {
  console.error('ui-check unhandled rejection:', error && (error.stack || error.message || error));
});

main().catch((error) => {
  console.error('ui-check crashed:', error && error.stack || error);
  try {
    fs.writeFileSync(path.join(OUT, 'REPORT-error.json'), JSON.stringify({ error: String(error && error.stack || error), lastRows: rows.slice(-40) }, null, 2));
  } catch { }
  exitRun(2);
});
