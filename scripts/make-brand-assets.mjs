/**
 * Generates public/brand/vecna-avatar.png without any image dependency:
 * a dark radial crimson core, an eight-blade crown and a slit pupil — the
 * Mind Flayer sigil that rides inside every Vecna mail and in Settings.
 *
 * Run with `node scripts/make-brand-assets.mjs`.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256;
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/brand/vecna-avatar.png');

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (t) => {
  const x = clamp(t);
  return x * x * (3 - 2 * x);
};

/** RGBA for one point in a 0..1 coordinate space centred at (0.5, 0.5). */
function shade(x, y) {
  const dx = x - 0.5;
  const dy = y - 0.47;
  const r = Math.hypot(dx, dy);
  let color = [5, 3, 8];
  const alpha = 255;

  // crimson halo bleeding into the dark
  const halo = 1 - smooth((r - 0.04) / 0.46);
  color = [
    mix(color[0], 150, halo ** 1.6 * 0.75),
    mix(color[1], 6, halo ** 1.6 * 0.75),
    mix(color[2], 34, halo ** 1.6 * 0.75),
  ];

  // crown of eight blades radiating from the core
  const angle = Math.atan2(dy, dx);
  const sector = Math.PI / 4;
  const offset = Math.abs((((angle + Math.PI / 2) % sector) + sector) % sector - sector / 2) / (sector / 2);
  const r0 = 0.26;
  const r1 = 0.49;
  const t = (r - r0) / (r1 - r0);
  if (t > 0 && t < 1 && offset < 0.62 * (1 - t)) {
    color = [mix(168, 255, t), mix(14, 122, t), mix(46, 92, t)];
  }

  // crimson core with a bright centre
  const coreR = 0.285;
  if (r < coreR) {
    const c = smooth(r / coreR);
    color = [mix(255, 122, c), mix(48, 4, c), mix(72, 26, c)];
  }

  // slit pupil
  const px = Math.abs(dx);
  const py = Math.abs(dy - 0.004);
  if ((px / 0.058) ** 2 + (py / 0.145) ** 2 <= 1) color = [255, 238, 240];
  if ((px / 0.02) ** 2 + (py / 0.115) ** 2 <= 1) color = [16, 0, 5];

  // menacing vignette only outside the core, so the sigil stays bright
  const vig = 1 - smooth((r - 0.36) / 0.14) * 0.92;
  color = color.map((c) => c * vig);

  return [Math.round(color[0]), Math.round(color[1]), Math.round(color[2]), alpha];
}

/* ---- minimal PNG encoder (truecolour + alpha, filter 0) ---- */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
const SS = 3; // supersampling grid for soft edges
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [pr, pg, pb, pa] = shade((x + (sx + 0.5) / SS) / SIZE, (y + (sy + 0.5) / SS) / SIZE);
        r += pr * pa;
        g += pg * pa;
        b += pb * pa;
        a += pa;
      }
    }
    const n = SS * SS;
    const idx = rowStart + 1 + x * 4;
    raw[idx] = Math.round(a ? r / a : 0);
    raw[idx + 1] = Math.round(a ? g / a : 0);
    raw[idx + 2] = Math.round(a ? b / a : 0);
    raw[idx + 3] = Math.round(a / n);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${png.length} bytes)`);
