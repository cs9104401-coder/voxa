'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SAMPLES = 4;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  const innerLeft = left + radius;
  const innerRight = right - radius;
  const innerTop = top + radius;
  const innerBottom = bottom - radius;
  if (x >= innerLeft && x <= innerRight && y >= top && y <= bottom) return true;
  if (y >= innerTop && y <= innerBottom && x >= left && x <= right) return true;
  const corners = [
    [innerLeft, innerTop],
    [innerRight, innerTop],
    [innerLeft, innerBottom],
    [innerRight, innerBottom]
  ];
  for (const [cx, cy] of corners) {
    const dx = x - cx;
    const dy = y - cy;
    if (dx * dx + dy * dy <= radius * radius) return true;
  }
  return false;
}

function insideBar(x, y, left, right, top, bottom, radius) {
  return insideRoundedRect(x, y, left, top, right, bottom, radius);
}

function render(size) {
  const scale = size / 256;
  const padding = 16 * scale;
  const radius = 56 * scale;
  const barWidth = 18 * scale;
  const gap = 14 * scale;
  const heights = [42, 74, 110, 74, 42].map((value) => value * scale);
  const totalWidth = barWidth * heights.length + gap * (heights.length - 1);
  const startX = (size - totalWidth) / 2;
  const centerY = size / 2;
  const bars = heights.map((height, index) => {
    const left = startX + index * (barWidth + gap);
    return {
      left,
      right: left + barWidth,
      top: centerY - height / 2,
      bottom: centerY + height / 2
    };
  });
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    const gradient = clamp((y - padding) / Math.max(1, size - padding * 2), 0, 1);
    const background = [
      Math.round(36 + (72 - 36) * gradient),
      Math.round(54 + (123 - 54) * gradient),
      Math.round(76 + (180 - 76) * gradient)
    ];
    for (let x = 0; x < size; x += 1) {
      let backgroundHits = 0;
      let barHits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = x + (sx + 0.5) / SAMPLES;
          const py = y + (sy + 0.5) / SAMPLES;
          if (!insideRoundedRect(px, py, padding, padding, size - padding, size - padding, radius)) continue;
          backgroundHits += 1;
          for (const bar of bars) {
            if (insideBar(px, py, bar.left, bar.right, bar.top, bar.bottom, barWidth / 2)) {
              barHits += 1;
              break;
            }
          }
        }
      }
      const offset = (y * size + x) * 4;
      const total = SAMPLES * SAMPLES;
      if (!backgroundHits) continue;
      const coverage = backgroundHits / total;
      const barShare = barHits / backgroundHits;
      const red = background[0] * (1 - barShare) + 244 * barShare;
      const green = background[1] * (1 - barShare) + 248 * barShare;
      const blue = background[2] * (1 - barShare) + 255 * barShare;
      pixels[offset] = Math.round(red);
      pixels[offset + 1] = Math.round(green);
      pixels[offset + 2] = Math.round(blue);
      pixels[offset + 3] = Math.round(255 * coverage);
    }
  }
  return pixels;
}

function encodeBmpFrame(size) {
  const pixels = render(size);
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const maskBytes = maskRowBytes * size;
  const frame = Buffer.alloc(40 + size * size * 4 + maskBytes);
  frame.writeUInt32LE(40, 0);
  frame.writeInt32LE(size, 4);
  frame.writeInt32LE(size * 2, 8);
  frame.writeUInt16LE(1, 12);
  frame.writeUInt16LE(32, 14);
  frame.writeUInt32LE(0, 16);
  frame.writeUInt32LE(size * size * 4, 20);
  frame.writeInt32LE(0, 24);
  frame.writeInt32LE(0, 28);
  frame.writeUInt32LE(0, 32);
  frame.writeUInt32LE(0, 36);

  const pixelBase = 40;
  for (let y = 0; y < size; y += 1) {
    const sourceRow = size - 1 - y;
    for (let x = 0; x < size; x += 1) {
      const source = (sourceRow * size + x) * 4;
      const target = pixelBase + (y * size + x) * 4;
      frame[target] = pixels[source + 2];
      frame[target + 1] = pixels[source + 1];
      frame[target + 2] = pixels[source];
      frame[target + 3] = pixels[source + 3];
    }
  }
  return frame;
}

function buildIcon() {
  const frames = SIZES.map((size) => ({ size, data: encodeBmpFrame(size) }));
  const directorySize = 6 + frames.length * 16;
  const header = Buffer.alloc(directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = directorySize;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(frame.size === 256 ? 0 : frame.size, entry);
    header.writeUInt8(frame.size === 256 ? 0 : frame.size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.data.length;
  });
  return Buffer.concat([header, ...frames.map((frame) => frame.data)]);
}

const output = path.join(__dirname, '..', 'assets', 'icon.ico');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, buildIcon());
console.log(`Wrote ${output}`);
