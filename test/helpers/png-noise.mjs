/**
 * Deterministic noisy PNG encoder used to manufacture screenshot-like images
 * without adding a dependency. The raster is random RGB noise, which defeats
 * PNG deflate and therefore keeps the *stored* attachment large enough that
 * the pi-ai adapter must re-encode it into a request version.
 *
 * Hand-built on purpose: `sharp` is only reachable transitively through
 * `@deepseek-ai/dsh-attachment-local`, and the integration test must not rely
 * on module-resolution tricks or new dependencies.
 */
import { deflateSync } from 'node:zlib';

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
  for (let index = 0; index < buffer.length; index += 1) {
    c = CRC_TABLE[(c ^ buffer[index]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const tagged = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tagged));
  return Buffer.concat([length, tagged, crc]);
}

/**
 * Encode one 8-bit RGB PNG whose pixels are deterministic pseudo-random noise.
 *
 * @param {{ width: number, height: number, seed: number }} input - raster shape and PRNG seed.
 * @returns {Buffer} PNG bytes.
 */
export function encodeNoisePng({ width, height, seed }) {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new TypeError('encodeNoisePng requires positive integer width/height');
  }
  let state = seed >>> 0;
  const nextByte = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) & 0xff;
  };

  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; // PNG filter type 0 (None): noise stays incompressible.
    for (let x = 0; x < width * 3; x += 1) raw[row + 1 + x] = nextByte();
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour (RGB)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
