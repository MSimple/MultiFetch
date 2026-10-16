#!/usr/bin/env node
'use strict';

// Generates the app's original icon assets (no external data, no deps):
//   app/renderer/assets/tray.png    16x16
//   app/renderer/assets/tray@2x.png 32x32
//   app/renderer/assets/icon.png    256x256
// Design: rounded blue square + white download arrow.
// Pure zlib + hand-rolled CRC32 -> valid PNG, no canvas needed.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// ---- CRC32 (PNG chunk checksums) ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // rest zero: deflate, no filter/interlace
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- glyph drawing ----
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const bg = [47, 111, 237, 255]; // accent blue
  const fg = [255, 255, 255, 255];
  const clear = [0, 0, 0, 0];

  const m = Math.max(1, Math.round(size * 0.06));
  const r = Math.max(2, Math.round(size * 0.22));

  function insideRounded(x, y) {
    const x0 = m;
    const y0 = m;
    const x1 = size - 1 - m;
    const y1 = size - 1 - m;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const inCornerX = x < x0 + r || x > x1 - r;
    const inCornerY = y < y0 + r || y > y1 - r;
    if (inCornerX && inCornerY) {
      const cx = x < x0 + r ? x0 + r : x1 - r;
      const cy = y < y0 + r ? y0 + r : y1 - r;
      const dx = x - cx;
      const dy = y - cy;
      return dx * dx + dy * dy <= r * r;
    }
    return true;
  }

  const cx = size / 2;
  const shaftW = Math.max(2, Math.round(size * 0.16));
  const top = Math.round(size * 0.22);
  const shaftBottom = Math.round(size * 0.58);
  const bottom = Math.round(size * 0.8);
  const headHalf = Math.max(shaftW, Math.round(size * 0.24));

  function isArrow(x, y) {
    const center = x + 0.5;
    if (y >= top && y <= shaftBottom && Math.abs(center - cx) <= shaftW / 2) return true;
    if (y > shaftBottom && y <= bottom) {
      const t = (y - shaftBottom) / (bottom - shaftBottom);
      return Math.abs(center - cx) <= (1 - t) * headHalf;
    }
    // baseline bar under the arrow (like a download tray)
    const barTop = Math.round(size * 0.84);
    const barBottom = Math.round(size * 0.9);
    if (y >= barTop && y <= barBottom && Math.abs(center - cx) <= headHalf) return true;
    return false;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const off = (y * size + x) * 4;
      let c = clear;
      if (insideRounded(x, y)) c = isArrow(x, y) ? fg : bg;
      px[off] = c[0];
      px[off + 1] = c[1];
      px[off + 2] = c[2];
      px[off + 3] = c[3];
    }
  }
  return px;
}

const outDir = path.join(__dirname, '..', 'app', 'renderer', 'assets');
fs.mkdirSync(outDir, { recursive: true });

const targets = [
  ['tray.png', 16],
  ['tray@2x.png', 32],
  ['icon.png', 256],
];

for (const [name, size] of targets) {
  const png = encodePng(size, size, drawIcon(size));
  fs.writeFileSync(path.join(outDir, name), png);
  console.log(`${name}  ${size}x${size}  ${png.length} bytes`);
}
console.log('icons written to ' + outDir);

// Browser-extension icons share the same original glyph.
const extDir = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(extDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, size, drawIcon(size));
  fs.writeFileSync(path.join(extDir, `icon${size}.png`), png);
  console.log(`extension/icons/icon${size}.png  ${png.length} bytes`);
}

// Windows .ico for rcedit (packaged exe icon): classic 32-bit DIB entries,
// which every Windows icon consumer accepts.
function encodeDib(rgba, size) {
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const xorSize = size * size * 4;
  const andSize = maskRowBytes * size;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // height is doubled (XOR + AND masks)
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(xorSize + andSize, 20);
  const xor = Buffer.alloc(xorSize);
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y; // DIB rows are bottom-up
    for (let x = 0; x < size; x++) {
      const s = (srcRow * size + x) * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }
  const and = Buffer.alloc(andSize); // zeroed: transparency handled by alpha
  return Buffer.concat([header, xor, and]);
}

function encodeIco(sizes) {
  const images = sizes.map((size) => ({ size, dib: encodeDib(drawIcon(size), size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = [];
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size === 256 ? 0 : img.size;
    e[1] = img.size === 256 ? 0 : img.size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.dib.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.dib.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.dib)]);
}

const ico = encodeIco([16, 32, 48, 256]);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
console.log(`icon.ico  (16/32/48/256 DIB)  ${ico.length} bytes`);
