// One-off asset prep for the island companion.
// Run: npx electron scripts/prepare-companion/main.cjs
// v2: background matte + trim + face patches + head/body split + color sampling
//     + debug exports. Adjust the constants below when the source artwork changes.
const fs = require('fs');

const SRC = 'C:/Users/Shoyo/Downloads/WhatsApp Image 2026-10-25 at 5.37.51 AM.jpeg';
const OUT = 'C:/Users/Shoyo/AppData/Local/Temp/voxa-companion';
const ASSETS = 'C:/project-v2/chatgpt project/my-voice-app/assets/companion';
const STAGE = 2;

// --- geometry constants measured on the trimmed sprite (538 x 685) ---
// [x, y, width, height] skin patches (feathered) covering baked eyes/mouth
const PATCHES = [
  { x: 106, y: 284, w: 98, h: 104 },  // left eye + under-brow area
  { x: 234, y: 282, w: 102, h: 104 }, // right eye + under-brow area
  { x: 196, y: 394, w: 158, h: 98 },  // mouth (shout keeps chin outline below)
  { x: 136, y: 408, w: 60, h: 72 }    // poking tongue, clear of the jaw outline
];
// sampled from the source face (see SAMPLES below) so patches are invisible
const SKIN = 'rgb(244,229,205)';
const CUT_Y = 506;       // head layer keeps everything above this line
const BODY_OVERLAP = 10; // body layer starts CUT_Y - BODY_OVERLAP so rotation never opens a seam
const SEAM_TEST_DEG = 3.5;

// sample points read from the source pixels (pre-patch) and printed for the runtime CSS
const SAMPLES = [
  ['skinMid', 215, 388], ['skinLow', 300, 390], ['skinMid2', 150, 388],
  ['hair', 280, 50], ['eyeWhite', 150, 330], ['pupilArea', 146, 352],
  ['outline', 66, 470]
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(ASSETS, { recursive: true });

  const bytes = fs.readFileSync(SRC);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = 'data:image/jpeg;base64,' + bytes.toString('base64');
  });
  const w = img.naturalWidth;
  const h = img.naturalHeight;

  const base = document.createElement('canvas');
  base.width = w;
  base.height = h;
  const baseCtx = base.getContext('2d', { willReadFrequently: true });
  baseCtx.drawImage(img, 0, 0);

  // 1. flood-remove connected background from the borders
  const data = baseCtx.getImageData(0, 0, w, h);
  const px = data.data;
  const backgroundish = (r, g, b) => {
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    return lo >= 236 || (lo >= 196 && hi <= 252 && hi - lo <= 15);
  };
  const n = w * h;
  const bg = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  const push = (p) => { if (!bg[p]) { bg[p] = 1; queue[qt++] = p; } };
  for (let x = 0; x < w; x += 1) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y += 1) {
    push(y * w);
    push(y * w + (w - 1));
  }
  while (qh < qt) {
    const p = queue[qh];
    qh += 1;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0 && !bg[p - 1] && backgroundish(px[(p - 1) * 4], px[(p - 1) * 4 + 1], px[(p - 1) * 4 + 2])) push(p - 1);
    if (x < w - 1 && !bg[p + 1] && backgroundish(px[(p + 1) * 4], px[(p + 1) * 4 + 1], px[(p + 1) * 4 + 2])) push(p + 1);
    if (y > 0 && !bg[p - w] && backgroundish(px[(p - w) * 4], px[(p - w) * 4 + 1], px[(p - w) * 4 + 2])) push(p - w);
    if (y < h - 1 && !bg[p + w] && backgroundish(px[(p + w) * 4], px[(p + w) * 4 + 1], px[(p + w) * 4 + 2])) push(p + w);
  }

  // 2. alpha + light halo trim
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      if (bg[p]) { px[p * 4 + 3] = 0; continue; }
      let adjacent = 0;
      for (let dy = -1; dy <= 1 && adjacent < 8; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) { adjacent += 1; continue; }
          if (bg[ny * w + nx]) adjacent += 1;
        }
      }
      if (adjacent > 0) {
        const o = p * 4;
        const r = px[o];
        const g = px[o + 1];
        const b = px[o + 2];
        const hi = Math.max(r, g, b);
        const lo = Math.min(r, g, b);
        if (lo >= 215 && hi - lo <= 28) px[p * 4 + 3] = 150;
      }
    }
  }

  // 3. content bbox + crop
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (px[(y * w + x) * 4 + 3] > 12) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  console.log(`content bbox x=${minX} y=${minY} w=${cw} h=${ch}`);

  const sprite = document.createElement('canvas');
  sprite.width = cw;
  sprite.height = ch;
  const sctx = sprite.getContext('2d');
  sctx.putImageData(data, -minX, -minY);

  // 4. sample colors for the runtime vector face, before patching alters them
  const spriteData = sctx.getImageData(0, 0, cw, ch);
  const sdata = spriteData.data;
  for (const [name, sx, sy] of SAMPLES) {
    const o = (sy * cw + sx) * 4;
    console.log(`color ${name}: rgb(${sdata[o]},${sdata[o + 1]},${sdata[o + 2]})`);
  }

  // 5. skin patches with feathered edges
  sctx.putImageData(spriteData, 0, 0);
  const skin = SKIN;
  for (const patch of PATCHES) {
    const blur = 5;
    const tile = document.createElement('canvas');
    tile.width = patch.w + blur * 2;
    tile.height = patch.h + blur * 2;
    const tc = tile.getContext('2d');
    tc.filter = `blur(${blur}px)`;
    tc.fillStyle = skin;
    tc.beginPath();
    tc.roundRect(blur, blur, patch.w, patch.h, 14);
    tc.fill();
    sctx.drawImage(tile, patch.x - blur, patch.y - blur);
  }

  // 6. split into head (<= CUT_Y, overlapping) and body (>= CUT_Y - BODY_OVERLAP)
  const head = document.createElement('canvas');
  head.width = cw;
  head.height = CUT_Y;
  head.getContext('2d').drawImage(sprite, 0, 0);

  const body = document.createElement('canvas');
  body.width = cw;
  body.height = ch - CUT_Y + BODY_OVERLAP;
  body.getContext('2d').drawImage(sprite, 0, -(CUT_Y - BODY_OVERLAP));

  const savePng = (canvas, file) => {
    fs.writeFileSync(file, Buffer.from(canvas.toDataURL('image/png').split(',')[1], 'base64'));
    console.log(`saved ${file}`);
  };

  savePng(head, `${ASSETS}/companion-head.png`);
  savePng(body, `${ASSETS}/companion-body.png`);

  // 7. head grid debug (face svg coordinates are measured here, source units)
  const grid = document.createElement('canvas');
  grid.width = cw;
  grid.height = CUT_Y;
  gctx = grid.getContext('2d');
  var gctx;
  gctx.drawImage(seamlessPatchedSprite(sprite, PATCHES, skin), 0, 0);
  gctx.font = '11px monospace';
  for (let x = 0; x <= cw; x += 20) {
    gctx.strokeStyle = x % 100 === 0 ? 'rgba(0,120,255,.5)' : 'rgba(0,200,255,.2)';
    gctx.beginPath();
    gctx.moveTo(x + 0.5, 0);
    gctx.lineTo(x + 0.5, CUT_Y);
    gctx.stroke();
  }
  for (let y = 0; y <= CUT_Y; y += 20) {
    gctx.strokeStyle = y % 100 === 0 ? 'rgba(0,120,255,.5)' : 'rgba(0,200,255,.2)';
    gctx.beginPath();
    gctx.moveTo(0, y + 0.5);
    gctx.lineTo(cw, y + 0.5);
    gctx.stroke();
  }
  gctx.fillStyle = '#0034c8';
  for (let x = 0; x <= cw; x += 100) gctx.fillText(String(x), x + 2, 12);
  for (let y = 20; y <= CUT_Y; y += 100) gctx.fillText(String(y), 2, y + 12);
  savePng(grid, `${OUT}/voxa-companion-debug-head-grid.png`);

  // 8. seam test: head tilted ±SEAM_TEST_DEG over static body
  const seam = document.createElement('canvas');
  seam.width = cw;
  seam.height = ch;
  const mctx = seam.getContext('2d');
  mctx.fillStyle = '#888888';
  mctx.fillRect(0, 0, cw, ch);
  mctx.drawImage(body, 0, CUT_Y - BODY_OVERLAP);
  for (const deg of [SEAM_TEST_DEG, -SEAM_TEST_DEG]) {
    mctx.save();
    mctx.translate(cw / 2, CUT_Y);
    mctx.rotate(deg * Math.PI / 180);
    // draw only the head region of the patched sprite (9-arg source rect)
    mctx.drawImage(seamlessPatchedSprite(sprite, PATCHES, skin), 0, 0, cw, CUT_Y, -cw / 2, -CUT_Y, cw, CUT_Y);
    mctx.restore();
    console.log(`seam test rotated ${deg}deg` + (deg > 0 ? ' (+)' : ' (-)'));
  }
  savePng(seam, `${OUT}/voxa-companion-debug-seam.png`);

  // 9. final full composite check (what the page will show at rest)
  const composite = document.createElement('canvas');
  composite.width = cw;
  composite.height = ch;
  composite.getContext('2d').drawImage(seamlessPatchedSprite(sprite, PATCHES, skin), 0, 0);
  savePng(composite, `${OUT}/voxa-companion-debug-rest.png`);

  console.log(`stage ${STAGE} done; sprite ${cw}x${ch}; head ${cw}x${CUT_Y}; body ${cw}x${ch - CUT_Y + BODY_OVERLAP}`);
  await wait(150);
  window.close();
}

// helper used by grid/seam debug: re-derive the patched head from the raw sprite
function seamlessPatchedSprite(sprite, patches, skinColor) {
  const out = document.createElement('canvas');
  out.width = sprite.width;
  out.height = sprite.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(sprite, 0, 0);
  for (const patch of patches) {
    const blur = 5;
    const tile = document.createElement('canvas');
    tile.width = patch.w + blur * 2;
    tile.height = patch.h + blur * 2;
    const tc = tile.getContext('2d');
    tc.filter = `blur(${blur}px)`;
    tc.fillStyle = skinColor;
    tc.beginPath();
    tc.roundRect(blur, blur, patch.w, patch.h, 14);
    tc.fill();
    ctx.drawImage(tile, patch.x - blur, patch.y - blur);
  }
  return out;
}

main().catch((error) => {
  console.error('prep failed', error);
  setTimeout(() => window.close(), 200);
});
