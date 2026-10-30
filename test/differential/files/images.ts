// Generated test images for test/differential/files/serve.test.ts: the
// generator of the M0.7 spike (scripts/spikes/M0.7/images.ts) without its
// sharp-made files. Every image is computed from coordinates and a seeded
// PRNG, so a rerun writes the same pixels.

import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { encodeGif } from "@/files/gif-encode";
import { encodePng, type Raw } from "@/files/png-raw";

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function synthetic(width: number, height: number, seed: number, alpha = false): Raw {
  const rand = prng(seed);
  const pix = new Uint8Array(width * height * 4);
  const cx = width * (0.3 + rand() * 0.4);
  const cy = height * (0.3 + rand() * 0.4);
  const radius = Math.min(width, height) * 0.25;
  const phase = rand() * Math.PI * 2;
  for (let y = 0; y < height; y++) {
    const fy = y / height;
    for (let x = 0; x < width; x++) {
      const fx = x / width;
      const o = (y * width + x) * 4;
      let r = 90 + 80 * Math.sin(fx * 5 + phase) + 60 * fy;
      let g = 110 + 70 * Math.sin(fy * 4 + fx * 2);
      let b = 160 - 90 * fy + 40 * Math.cos(fx * 7);
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy < radius * radius) {
        r = 230;
        g = 180 - 60 * fy;
        b = 40;
      }
      // fine stripes in a band: aliasing shows when a resize skips pixels
      if (fy > 0.7 && fy < 0.8 && Math.floor(x / 2) % 2 === 0) {
        r *= 0.3;
        g *= 0.3;
        b *= 0.3;
      }
      // a sharp-edged block
      if (fx > 0.08 && fx < 0.22 && fy > 0.1 && fy < 0.35) {
        r = 20;
        g = 200;
        b = 90;
      }
      const n = (rand() - 0.5) * 24;
      pix[o] = Math.max(0, Math.min(255, Math.round(r + n)));
      pix[o + 1] = Math.max(0, Math.min(255, Math.round(g + n)));
      pix[o + 2] = Math.max(0, Math.min(255, Math.round(b + n)));
      pix[o + 3] = alpha
        ? Math.max(0, Math.min(255, Math.round(255 * (1 - fx) * (0.4 + 0.6 * fy))))
        : 255;
    }
  }
  return { width, height, pix };
}

// An APP1 Exif segment with one IFD0 entry: Orientation (0x0112) = value,
// little-endian ("II") or big-endian ("MM")
function exifSegment(value: number, bigEndian = false): Uint8Array {
  const u16 = (n: number): number[] => (bigEndian ? [n >> 8, n & 0xff] : [n & 0xff, n >> 8]);
  const tiff = [
    ...(bigEndian ? [0x4d, 0x4d] : [0x49, 0x49]),
    ...u16(42),
    ...(bigEndian ? [0, 0, 0, 8] : [8, 0, 0, 0]), // IFD0 at 8
    ...u16(1), // one entry
    ...u16(0x0112),
    ...u16(3), // SHORT
    ...(bigEndian ? [0, 0, 0, 1] : [1, 0, 0, 0]), // count 1
    ...u16(value),
    0,
    0, // the value's padding
    0,
    0,
    0,
    0, // no next IFD
  ];
  return segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]);
}

// An APP1 XMP segment, as editors and phones write it next to Exif
function xmpSegment(): Uint8Array {
  const text =
    "http://ns.adobe.com/xap/1.0/\0" +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>';
  return segment(0xe1, [...new TextEncoder().encode(text)]);
}

function segment(marker: number, payload: number[]): Uint8Array {
  const len = payload.length + 2;
  return new Uint8Array([0xff, marker, len >> 8, len & 0xff, ...payload]);
}

// the segments, right after SOI
function withSegments(jpeg: Uint8Array, ...segments: Uint8Array[]): Uint8Array {
  const parts = [jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function withExifOrientation(jpeg: Uint8Array, value: number): Uint8Array {
  return withSegments(jpeg, exifSegment(value));
}

// A GIF whose logical screen is larger than its first frame, which is
// placed at (left, top). Only the frame's pixels exist.
function gifWithScreen(
  frame: Raw,
  screenW: number,
  screenH: number,
  left: number,
  top: number,
): Uint8Array {
  const gif = encodeGif(frame.pix, frame.width, frame.height);
  const v = new DataView(gif.buffer, gif.byteOffset, gif.byteLength);
  v.setUint16(6, screenW, true);
  v.setUint16(8, screenH, true);
  // the image descriptor follows the 13-byte header and the 256-color table
  const desc = 13 + 3 * 256;
  if (gif[desc] !== 0x2c) {
    throw new Error("unexpected GIF layout");
  }
  v.setUint16(desc + 1, left, true);
  v.setUint16(desc + 3, top, true);
  return gif;
}

// 24-bit bottom-up BI_RGB
function encodeBmp(raw: Raw): Uint8Array {
  const rowLen = Math.ceil((raw.width * 3) / 4) * 4;
  const size = 54 + rowLen * raw.height;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  v.setUint32(2, size, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, raw.width, true);
  v.setInt32(22, raw.height, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(34, rowLen * raw.height, true);
  for (let y = 0; y < raw.height; y++) {
    const row = 54 + (raw.height - 1 - y) * rowLen;
    for (let x = 0; x < raw.width; x++) {
      const i = (y * raw.width + x) * 4;
      out[row + x * 3] = raw.pix[i + 2] as number;
      out[row + x * 3 + 1] = raw.pix[i + 1] as number;
      out[row + x * 3 + 2] = raw.pix[i] as number;
    }
  }
  return out;
}

export interface TestImage {
  name: string;
  contentType: string;
  // stored pixels, before any EXIF orientation
  width: number;
  height: number;
  note: string;
  // PB_THUMBS_MAX_SOURCE_PIXELS for this image, when not the default
  limit?: number;
  // the thumb sizes compared, when not all
  sizes?: string[];
}

// An uncompressed little-endian RGB TIFF (not thumbed by the API)
function encodeTiff(raw: Raw): Uint8Array {
  const n = raw.width * raw.height * 3;
  const entries: [number, number, number, number][] = [
    [256, 3, 1, raw.width], // ImageWidth
    [257, 3, 1, raw.height], // ImageLength
    [258, 3, 1, 8], // BitsPerSample (one value for all samples, kept simple)
    [259, 3, 1, 1], // Compression: none
    [262, 3, 1, 2], // PhotometricInterpretation: RGB
    [273, 4, 1, 0], // StripOffsets (patched below)
    [277, 3, 1, 3], // SamplesPerPixel
    [278, 3, 1, raw.height], // RowsPerStrip
    [279, 4, 1, n], // StripByteCounts
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const dataOffset = 8 + ifdSize;
  const out = new Uint8Array(dataOffset + n);
  const v = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]);
  v.setUint32(4, 8, true);
  v.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, count, value], i) => {
    const o = 10 + i * 12;
    v.setUint16(o, tag, true);
    v.setUint16(o + 2, type, true);
    v.setUint32(o + 4, count, true);
    const val = tag === 273 ? dataOffset : value;
    if (type === 3) {
      v.setUint16(o + 8, val, true);
    } else {
      v.setUint32(o + 8, val, true);
    }
  });
  for (let i = 0, j = dataOffset; i < raw.width * raw.height; i++, j += 3) {
    out[j] = raw.pix[i * 4] as number;
    out[j + 1] = raw.pix[i * 4 + 1] as number;
    out[j + 2] = raw.pix[i * 4 + 2] as number;
  }
  return out;
}

// One image per format the API stores, for the thumb size modes and the
// content type rules (the M0.7 quality set without its sharp-made files)
export async function writeBaseSet(dir: string): Promise<TestImage[]> {
  const images: TestImage[] = [];
  const put = (name: string, contentType: string, bytes: Uint8Array, note: string): void => {
    writeFileSync(join(dir, name), bytes);
    images.push({ name, contentType, width: 0, height: 0, note });
  };
  const photo = synthetic(640, 427, 1);
  const photoPng = encodePng(photo);
  put(
    "photo.jpg",
    "image/jpeg",
    await new Bun.Image(photoPng).jpeg({ quality: 90 }).bytes(),
    "baseline JPEG, q90",
  );
  put("photo.png", "image/png", encodePng(photo, 6), "RGBA PNG, opaque");
  const alpha = synthetic(300, 200, 3, true);
  put("alpha.png", "image/png", encodePng(alpha, 6), "RGBA PNG with an alpha gradient");
  const tiny = synthetic(60, 40, 4);
  put("tiny.png", "image/png", encodePng(tiny, 6), "60x40: Fill takes resizeAndCrop below 100 px");
  put(
    "photo.webp",
    "image/webp",
    await new Bun.Image(photoPng).webp({ quality: 85 }).bytes(),
    "lossy WebP",
  );
  put(
    "alpha.webp",
    "image/webp",
    await new Bun.Image(encodePng(alpha)).webp({ lossless: true }).bytes(),
    "lossless WebP with alpha",
  );
  put(
    "photo.gif",
    "image/gif",
    encodeGif(photo.pix, photo.width, photo.height),
    "GIF, Plan 9 palette",
  );
  put("photo.bmp", "image/bmp", encodeBmp(photo), "24-bit BMP (not thumbed by the API)");
  put("photo.tiff", "image/tiff", encodeTiff(tiny), "uncompressed TIFF (not thumbed by the API)");
  return images;
}

// The cases of the PR #37 review: imaging's EXIF orientation (all values,
// both byte orders, an XMP APP1 segment before or after the Exif one), a
// GIF whose first frame is smaller than its logical screen, and originals
// at PB_THUMBS_MAX_SOURCE_PIXELS = 1,000,000 in each format the API thumbs,
// where the header Go reads decides
export async function writeCompatSet(dir: string): Promise<TestImage[]> {
  const images: TestImage[] = [];
  const put = (
    name: string,
    contentType: string,
    bytes: Uint8Array,
    note: string,
    extra: Partial<TestImage> = {},
  ): void => {
    writeFileSync(join(dir, name), bytes);
    images.push({ name, contentType, width: 0, height: 0, note, ...extra });
  };
  const wide = synthetic(320, 180, 8);
  const jpeg = await new Bun.Image(encodePng(wide)).jpeg({ quality: 90 }).bytes();
  for (let o = 1; o <= 8; o++) {
    put(`exif${o}-320x180.jpg`, "image/jpeg", withExifOrientation(jpeg, o), `Orientation ${o}`);
  }
  put(
    "exif8-mm.jpg",
    "image/jpeg",
    withSegments(jpeg, exifSegment(8, true)),
    "Orientation 8, big-endian Exif",
  );
  put(
    "xmp-then-exif6.jpg",
    "image/jpeg",
    withSegments(jpeg, xmpSegment(), exifSegment(6)),
    "XMP APP1 before the Exif APP1 (Orientation 6): imaging ignores the orientation",
  );
  put(
    "exif6-then-xmp.jpg",
    "image/jpeg",
    withSegments(jpeg, exifSegment(6), xmpSegment()),
    "Exif APP1 (Orientation 6) before an XMP APP1",
  );
  const frame = synthetic(600, 400, 9);
  put(
    "gif-subframe.gif",
    "image/gif",
    gifWithScreen(frame, 900, 700, 100, 150),
    "GIF: 900x700 logical screen, first frame 600x400 at (100, 150)",
  );
  const limit = 1_000_000;
  const few = ["100x100", "70x50f", "0x50"];
  put(
    "limit-gif-screen-over.gif",
    "image/gif",
    gifWithScreen(frame, 1200, 1000, 0, 0),
    "logical screen 1200x1000 (over the limit), first frame 600x400",
    { limit, sizes: few },
  );
  put(
    "limit-gif-screen-at.gif",
    "image/gif",
    gifWithScreen(frame, 1000, 1000, 0, 0),
    "logical screen 1000x1000 (at the limit), first frame 600x400",
    { limit, sizes: few },
  );
  const at = synthetic(1000, 1000, 10);
  const over = synthetic(1000, 1001, 10);
  put("limit-at.png", "image/png", encodePng(at, 6), "1000x1000 PNG (at the limit)", {
    limit,
    sizes: few,
  });
  put("limit-over.png", "image/png", encodePng(over, 6), "1000x1001 PNG", { limit, sizes: few });
  put(
    "limit-at.jpg",
    "image/jpeg",
    await new Bun.Image(encodePng(at)).jpeg({ quality: 90 }).bytes(),
    "1000x1000 JPEG (at the limit)",
    { limit, sizes: few },
  );
  put(
    "limit-over-exif6.jpg",
    "image/jpeg",
    withExifOrientation(await new Bun.Image(encodePng(over)).jpeg({ quality: 90 }).bytes(), 6),
    "1000x1001 JPEG, Orientation 6",
    { limit, sizes: few },
  );
  put(
    "limit-over.webp",
    "image/webp",
    await new Bun.Image(encodePng(over)).webp({ quality: 85 }).bytes(),
    "1000x1001 lossy WebP (VP8)",
    { limit, sizes: few },
  );
  const overAlpha = synthetic(1000, 1001, 10, true);
  put(
    "limit-over-alpha.webp",
    "image/webp",
    await new Bun.Image(encodePng(overAlpha)).webp({ quality: 85 }).bytes(),
    "1000x1001 lossy WebP with alpha (VP8X)",
    { limit, sizes: few },
  );
  put(
    "limit-over-lossless.webp",
    "image/webp",
    await new Bun.Image(encodePng(overAlpha)).webp({ lossless: true }).bytes(),
    "1000x1001 lossless WebP (VP8L)",
    { limit, sizes: few },
  );
  return images;
}

// The edge cases: none of them may make a thumb. photoJpeg and photoPng may
// be Buffers, whose slice() is a view: each changed file is a copy.
export async function writeEdgeSet(
  dir: string,
  photoJpeg: Uint8Array,
  photoPng: Uint8Array,
): Promise<TestImage[]> {
  const out: TestImage[] = [];
  const put = (name: string, contentType: string, bytes: Uint8Array, note: string): void => {
    writeFileSync(join(dir, name), bytes);
    out.push({ name, contentType, width: 0, height: 0, note });
  };
  put(
    "truncated.jpg",
    "image/jpeg",
    photoJpeg.subarray(0, Math.floor(photoJpeg.length / 2)),
    "JPEG cut at half its scan data",
  );
  put(
    "no-eoi.jpg",
    "image/jpeg",
    photoJpeg.subarray(0, photoJpeg.length - 2),
    "JPEG without its final EOI marker",
  );
  const flipped = new Uint8Array(photoJpeg);
  for (let i = Math.floor(flipped.length * 0.4); i < flipped.length * 0.6; i += 97) {
    flipped[i] = 0xff;
  }
  put("garbled.jpg", "image/jpeg", flipped, "JPEG with 0xFF bytes written into its scan data");
  put(
    "truncated.png",
    "image/png",
    photoPng.subarray(0, Math.floor(photoPng.length / 2)),
    "PNG cut in its IDAT",
  );
  const badCrc = new Uint8Array(photoPng);
  badCrc[61] = (badCrc[61] as number) ^ 0x55;
  put("badcrc.png", "image/png", badCrc, "PNG with a corrupted IDAT byte (CRC mismatch)");
  // a valid PNG header claiming 11000x10000 = 110,000,000 px > 104,857,600
  const bomb = encodePng({ width: 1, height: 1, pix: new Uint8Array([0, 0, 0, 255]) });
  const view = new DataView(bomb.buffer);
  view.setUint32(16, 11000);
  view.setUint32(20, 10000);
  view.setUint32(29, Bun.hash.crc32(bomb.subarray(12, 29)) >>> 0);
  put("bomb.png", "image/png", bomb, "PNG header claiming 11000x10000 (110 MP) with 1 px of data");
  // Go's image/jpeg decodes SOF0-2 only; libjpeg-turbo also has arithmetic
  // coding (SOF9). The marker is rewritten, so the scan data is not valid
  // arithmetic-coded data: only the header decision is compared.
  const sof9 = new Uint8Array(photoJpeg);
  sof9[jpegMarker(sof9, 0xc0) + 1] = 0xc9;
  put("sof9.jpg", "image/jpeg", sof9, "JPEG with an SOF9 (arithmetic coding) marker");
  const frame = synthetic(60, 40, 13);
  put(
    "gif-frame-outside.gif",
    "image/gif",
    gifWithScreen(frame, 30, 40, 0, 0),
    "GIF whose first frame (60x40) is larger than its logical screen (30x40)",
  );
  put(
    "anim.webp",
    "image/webp",
    await animatedWebp(),
    "animated WebP (VP8X, ANIM, one ANMF frame)",
  );
  // D26 backlog probes from the PR #37 review: damaged files that keep
  // their end marker
  const scan = jpegMarker(photoJpeg, 0xda);
  const cut = photoJpeg.subarray(0, Math.floor((scan + photoJpeg.length) / 2));
  put(
    "cut-scan-eoi.jpg",
    "image/jpeg",
    new Uint8Array([...cut, 0xff, 0xd9]),
    "JPEG cut halfway through its scan data, followed by EOI",
  );
  put(
    "no-iend.png",
    "image/png",
    photoPng.subarray(0, photoPng.length - 12),
    "PNG without its IEND chunk",
  );
  return out;
}

const u24 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
function riffChunk(id: string, data: number[]): number[] {
  const len = data.length;
  return [
    ...new TextEncoder().encode(id),
    len & 0xff,
    (len >> 8) & 0xff,
    (len >> 16) & 0xff,
    len >>> 24,
    ...data,
    ...(len & 1 ? [0] : []),
  ];
}

// a one-frame animated WebP: VP8X with the animation flag, ANIM, and an
// ANMF chunk holding a lossless 40x30 frame. x/image/webp finds no VP8 or
// VP8L chunk at the top level and fails.
async function animatedWebp(): Promise<Uint8Array> {
  const frame = synthetic(40, 30, 14);
  // the VP8L chunk, header included, of a lossless WebP Bun.Image writes
  const vp8l = [
    ...(await new Bun.Image(encodePng(frame)).webp({ lossless: true }).bytes()).subarray(12),
  ];
  const body = [
    ...new TextEncoder().encode("WEBP"),
    ...riffChunk("VP8X", [0x02 | 0x10, 0, 0, 0, ...u24(39), ...u24(29)]),
    ...riffChunk("ANIM", [0, 0, 0, 0, 0, 0]),
    ...riffChunk("ANMF", [...u24(0), ...u24(0), ...u24(39), ...u24(29), ...u24(100), 0, ...vp8l]),
  ];
  const len = body.length;
  return new Uint8Array([
    ...new TextEncoder().encode("RIFF"),
    len & 0xff,
    (len >> 8) & 0xff,
    (len >> 16) & 0xff,
    len >>> 24,
    ...body,
  ]);
}

// the offset of the first segment with this marker, walking the segments
// by their lengths up to the scan
function jpegMarker(jpeg: Uint8Array, marker: number): number {
  let o = 2;
  while (o + 4 <= jpeg.length && jpeg[o] === 0xff) {
    if (jpeg[o + 1] === marker) {
      return o;
    }
    if (jpeg[o + 1] === 0xda) {
      break;
    }
    o += 2 + (((jpeg[o + 2] as number) << 8) | (jpeg[o + 3] as number));
  }
  throw new Error(`no 0x${marker.toString(16)} segment`);
}

// A large valid PNG (8-bit RGB, seeded noise, one stored deflate block and
// one IDAT chunk per row), written row by row so that the test process
// never holds the whole file: about width * height * 3 bytes on disk.
export function writeLargePng(path: string, width: number, height: number, seed: number): void {
  const rand = prng(seed);
  const fd = openSync(path, "w");
  try {
    const chunk = (type: string, data: Uint8Array): void => {
      const out = new Uint8Array(12 + data.length);
      const view = new DataView(out.buffer);
      view.setUint32(0, data.length);
      out.set(new TextEncoder().encode(type), 4);
      out.set(data, 8);
      view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)) >>> 0);
      writeSync(fd, out);
    };
    writeSync(fd, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const ihdr = new Uint8Array(13);
    new DataView(ihdr.buffer).setUint32(0, width);
    new DataView(ihdr.buffer).setUint32(4, height);
    ihdr.set([8, 2, 0, 0, 0], 8);
    chunk("IHDR", ihdr);
    const rowLen = 1 + width * 3; // the filter byte (none) and the pixels
    if (rowLen > 0xffff) {
      throw new Error("a row must fit in one stored deflate block");
    }
    let a = 1;
    let b = 0;
    for (let y = 0; y < height; y++) {
      const head = y === 0 ? 2 : 0; // the zlib header before the first block
      const tail = y === height - 1 ? 4 : 0; // the Adler-32 after the last
      const data = new Uint8Array(head + 5 + rowLen + tail);
      if (head) {
        data.set([0x78, 0x01]);
      }
      const view = new DataView(data.buffer);
      data[head] = y === height - 1 ? 1 : 0; // BFINAL, BTYPE stored
      view.setUint16(head + 1, rowLen, true);
      view.setUint16(head + 3, ~rowLen & 0xffff, true);
      const row = data.subarray(head + 5, head + 5 + rowLen);
      for (let i = 1; i < rowLen; i += 4) {
        const v = (rand() * 4294967296) >>> 0;
        row[i] = v;
        row[i + 1] = v >>> 8;
        row[i + 2] = v >>> 16;
        row[i + 3] = v >>> 24;
      }
      for (const byte of row) {
        a = (a + byte) % 65521;
        b = (b + a) % 65521;
      }
      if (tail) {
        view.setUint32(data.length - 4, ((b << 16) | a) >>> 0);
      }
      chunk("IDAT", data);
    }
    chunk("IEND", new Uint8Array(0));
  } finally {
    closeSync(fd);
  }
}

// size bytes of seeded noise, written in pieces
export function writeNoise(path: string, size: number, seed: number): void {
  const rand = prng(seed);
  const fd = openSync(path, "w");
  try {
    const piece = new Uint8Array(1 << 20);
    for (let left = size; left > 0;) {
      const n = Math.min(left, piece.length);
      for (let i = 0; i < n; i += 4) {
        const v = (rand() * 4294967296) >>> 0;
        piece[i] = v;
        piece[i + 1] = v >>> 8;
        piece[i + 2] = v >>> 16;
        piece[i + 3] = v >>> 24;
      }
      writeSync(fd, piece.subarray(0, n));
      left -= n;
    }
  } finally {
    closeSync(fd);
  }
}
