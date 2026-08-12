import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'icons');
mkdirSync(out, { recursive: true });

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(size, px) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const i = y * stride + 1 + x * 4;
      const p = px(x, y);
      raw[i] = p[0]; raw[i + 1] = p[1]; raw[i + 2] = p[2]; raw[i + 3] = p[3];
    }
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function icon(size) {
  const bg = [19, 19, 19, 255];
  const line = [217, 217, 217, 255];
  const hole = [10, 10, 10, 255];
  const f = size * 0.19;
  const t = Math.max(1, Math.round(size * 0.055));
  return png(size, (x, y) => {
    const inFrame = x >= f && x < size - f && y >= f && y < size - f;
    if (!inFrame) return bg;
    const edge = x < f + t || x >= size - f - t || y < f + t || y >= size - f - t;
    return edge ? line : hole;
  });
}

for (const s of [16, 48, 128]) {
  writeFileSync(resolve(out, `icon${s}.png`), icon(s));
}

/* svg favicon — same language as the PNGs (dark square, thin light frame,
   hollow counter) with a capital G; used as the page favicon via a <link>
   in newtab.html (manifest icons must stay raster) */
writeFileSync(resolve(out, 'icon.svg'), `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" fill="#131313"/>
  <rect x="24" y="24" width="80" height="80" fill="none" stroke="#d9d9d9" stroke-width="7"/>
  <g transform="translate(64,64) scale(0.86) translate(-64,-64)">
    <path fill="#d9d9d9" fill-rule="nonzero"
          d="M 88.28 54 L 106 54 A 10 10 0 0 1 106 74 L 88.28 74 A 30 30 0 1 1 88.28 54 Z
             M 60 47 A 17 17 0 1 0 60 81 A 17 17 0 1 0 60 47 Z"/>
  </g>
</svg>
`);

console.log('icons written to ' + out);