// M0.7 spike: a minimal PNG writer and reader for raw RGBA pixels. Not shipped.
//
// The writer wraps 8-bit RGBA rows (filter 0) in a zlib stream. Bun.Image has
// no raw pixel input or output, so the spike moves pixels in and out of it as
// PNG: an uncompressed one (level 0) costs little more than a copy. The reader
// handles non-interlaced 8- and 16-bit PNGs of every color type, which covers
// Bun.Image's, the codecs' and upstream's PNG output.

import { deflateSync, inflateSync } from "node:zlib";

export interface Raw {
  width: number;
  height: number;
  // NRGBA: non-premultiplied RGBA, 8 bits per channel, no row padding
  pix: Uint8Array;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)) >>> 0);
  return out;
}

const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export function encodePng(raw: Raw, level = 0): Uint8Array {
  const { width, height, pix } = raw;
  const rowLen = width * 4 + 1;
  const rows = new Uint8Array(rowLen * height);
  for (let y = 0; y < height; y++) {
    rows.set(pix.subarray(y * width * 4, (y + 1) * width * 4), y * rowLen + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const idat = deflateSync(rows, { level });
  const parts = [
    signature,
    chunk("IHDR", header),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function decodePng(bytes: Uint8Array): Raw {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== signature[i]) {
      throw new Error("not a PNG");
    }
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let plte: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(off + 8);
      height = view.getUint32(off + 12);
      depth = data[8] as number;
      colorType = data[9] as number;
      if (data[12] !== 0) {
        throw new Error("interlaced PNG");
      }
    } else if (type === "PLTE") {
      plte = data;
    } else if (type === "tRNS") {
      trns = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (channels === undefined) {
    throw new Error(`PNG color type ${colorType}`);
  }
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let j = 0;
  for (const d of idat) {
    joined.set(d, j);
    j += d.length;
  }
  const data = inflateSync(joined);
  // 8-bit RGBA rows are the output already: unfilter straight into it
  const direct = colorType === 6 && depth === 8;
  const pix = new Uint8Array(width * height * 4);
  const lines = direct ? pix : new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)] as number;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const raw = data[src + x] as number;
      const a = x >= bpp ? (lines[dst + x - bpp] as number) : 0;
      const b = y > 0 ? (lines[dst - stride + x] as number) : 0;
      const c = x >= bpp && y > 0 ? (lines[dst - stride + x - bpp] as number) : 0;
      const pred =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? (a + b) >> 1
                : paeth(a, b, c);
      lines[dst + x] = (raw + pred) & 0xff;
    }
  }
  if (direct) {
    return { width, height, pix };
  }
  const sample = (y: number, i: number): number => {
    if (depth === 16) {
      return lines[y * stride + i * 2] as number;
    }
    if (depth === 8) {
      return lines[y * stride + i] as number;
    }
    const byte = lines[y * stride + ((i * depth) >> 3)] as number;
    const shift = 8 - depth - ((i * depth) & 7);
    const v = (byte >> shift) & ((1 << depth) - 1);
    return colorType === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  const trnsGray = trns && trns.length >= 2 ? ((trns[0] as number) << 8) | (trns[1] as number) : -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const idx = sample(y, x);
        pix[o] = plte?.[idx * 3] ?? 0;
        pix[o + 1] = plte?.[idx * 3 + 1] ?? 0;
        pix[o + 2] = plte?.[idx * 3 + 2] ?? 0;
        pix[o + 3] = trns?.[idx] ?? 255;
      } else if (colorType === 0 || colorType === 4) {
        const g = sample(y, x * (channels as number));
        pix[o] = g;
        pix[o + 1] = g;
        pix[o + 2] = g;
        pix[o + 3] =
          colorType === 4
            ? sample(y, x * 2 + 1)
            : trnsGray >= 0 && depth === 8 && g === trnsGray
              ? 0
              : 255;
      } else {
        for (let c = 0; c < channels; c++) {
          pix[o + c] = sample(y, x * channels + c);
        }
        if (channels === 3) {
          pix[o + 3] = 255;
        }
      }
    }
  }
  return { width, height, pix };
}
