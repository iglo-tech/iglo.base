// M0.7 spike: generated test images. Not shipped.
//
// Every image is computed from coordinates and a seeded PRNG, so a rerun
// writes the same pixels: smooth color fields like a photo's sky, hard
// edges, fine stripes that alias when resized badly, noise, and for the
// alpha cases a transparency gradient. Formats Bun.Image cannot write are
// written by sharp (the generator only; sharp is not a choice, D10) or by
// the small writers here.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { encodeGif } from "@/../scripts/spikes/M0.7/gif";
import { encodePng, type Raw } from "@/../scripts/spikes/M0.7/png";

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

// An APP1 Exif segment with one IFD0 entry: Orientation (0x0112) = value
function withExifOrientation(jpeg: Uint8Array, value: number): Uint8Array {
  const tiff = [
    0x49,
    0x49,
    0x2a,
    0x00,
    0x08,
    0x00,
    0x00,
    0x00, // II, 42, IFD0 at 8
    0x01,
    0x00, // one entry
    0x12,
    0x01,
    0x03,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    value,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00, // no next IFD
  ];
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const len = payload.length + 2;
  const seg = new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, ...payload]);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, 2));
  out.set(seg, 2);
  out.set(jpeg.subarray(2), 2 + seg.length);
  return out;
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

// sharp, loaded from the spike's own node_modules (generator only)
interface SharpLike {
  (input: Uint8Array, options?: Record<string, unknown>): SharpPipeline;
}
interface SharpPipeline {
  jpeg(o?: Record<string, unknown>): SharpPipeline;
  png(o?: Record<string, unknown>): SharpPipeline;
  gif(o?: Record<string, unknown>): SharpPipeline;
  tiff(o?: Record<string, unknown>): SharpPipeline;
  greyscale(): SharpPipeline;
  toColourspace(c: string): SharpPipeline;
  toBuffer(): Promise<Uint8Array>;
}

export interface TestImage {
  name: string;
  contentType: string;
  // stored pixels, before any EXIF orientation
  width: number;
  height: number;
  note: string;
}

export async function writeQualitySet(dir: string, sharpPath: string): Promise<TestImage[]> {
  const sharp = ((await import(sharpPath)) as { default: SharpLike }).default;
  const images: TestImage[] = [];
  const put = (
    name: string,
    contentType: string,
    raw: Raw,
    bytes: Uint8Array,
    note: string,
  ): void => {
    writeFileSync(join(dir, name), bytes);
    images.push({ name, contentType, width: raw.width, height: raw.height, note });
  };
  const photo = synthetic(640, 427, 1);
  const photoPng = encodePng(photo);
  put(
    "photo.jpg",
    "image/jpeg",
    photo,
    await new Bun.Image(photoPng).jpeg({ quality: 90 }).bytes(),
    "baseline JPEG, q90, 4:2:0",
  );
  put(
    "photo-progressive.jpg",
    "image/jpeg",
    photo,
    await sharp(photoPng).jpeg({ quality: 90, progressive: true }).toBuffer(),
    "progressive JPEG",
  );
  put(
    "photo-444.jpg",
    "image/jpeg",
    photo,
    await sharp(photoPng).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer(),
    "JPEG without chroma subsampling",
  );
  put(
    "gray.jpg",
    "image/jpeg",
    photo,
    await sharp(photoPng).greyscale().jpeg({ quality: 90 }).toBuffer(),
    "grayscale JPEG",
  );
  put(
    "cmyk.jpg",
    "image/jpeg",
    photo,
    await sharp(photoPng).toColourspace("cmyk").jpeg({ quality: 90 }).toBuffer(),
    "CMYK JPEG (Adobe)",
  );
  const turned = synthetic(640, 427, 2);
  put(
    "exif6.jpg",
    "image/jpeg",
    turned,
    withExifOrientation(await new Bun.Image(encodePng(turned)).jpeg({ quality: 90 }).bytes(), 6),
    "EXIF Orientation 6: shown 427x640",
  );
  put("photo.png", "image/png", photo, encodePng(photo, 6), "RGBA PNG, opaque");
  const alpha = synthetic(300, 200, 3, true);
  put("alpha.png", "image/png", alpha, encodePng(alpha, 6), "RGBA PNG with an alpha gradient");
  put(
    "palette.png",
    "image/png",
    alpha,
    await sharp(encodePng(alpha)).png({ palette: true, colours: 64 }).toBuffer(),
    "indexed PNG with tRNS",
  );
  put(
    "gray16.png",
    "image/png",
    photo,
    await sharp(photoPng).greyscale().png().toColourspace("grey16").toBuffer(),
    "16-bit gray PNG",
  );
  const tiny = synthetic(60, 40, 4);
  put(
    "tiny.png",
    "image/png",
    tiny,
    encodePng(tiny, 6),
    "60x40: Fill takes resizeAndCrop below 100 px",
  );
  put(
    "photo.webp",
    "image/webp",
    photo,
    await new Bun.Image(photoPng).webp({ quality: 85 }).bytes(),
    "lossy WebP",
  );
  put(
    "alpha.webp",
    "image/webp",
    alpha,
    await new Bun.Image(encodePng(alpha)).webp({ lossless: true }).bytes(),
    "lossless WebP with alpha",
  );
  put(
    "photo.gif",
    "image/gif",
    photo,
    encodeGif(photo.pix, photo.width, photo.height),
    "GIF, Plan 9 palette",
  );
  put(
    "alpha.gif",
    "image/gif",
    alpha,
    await sharp(encodePng(alpha)).gif({ colours: 128 }).toBuffer(),
    "GIF with a transparent index",
  );
  put("photo.bmp", "image/bmp", photo, encodeBmp(photo), "24-bit BMP (not thumbed by the API)");
  put(
    "photo.tiff",
    "image/tiff",
    photo,
    await sharp(photoPng).tiff({ compression: "lzw" }).toBuffer(),
    "LZW TIFF (not thumbed by the API)",
  );
  return images;
}

// The edge cases: none of them may make a thumb
export function writeEdgeSet(
  dir: string,
  photoJpeg: Uint8Array,
  photoPng: Uint8Array,
): TestImage[] {
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
  const flipped = photoJpeg.slice();
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
  const badCrc = photoPng.slice();
  badCrc[61] = (badCrc[61] as number) ^ 0x55;
  put("badcrc.png", "image/png", badCrc, "PNG with a corrupted IDAT byte (CRC mismatch)");
  // a valid PNG header claiming 11000x10000 = 110,000,000 px > 104,857,600
  const bomb = encodePng({ width: 1, height: 1, pix: new Uint8Array([0, 0, 0, 255]) });
  const view = new DataView(bomb.buffer);
  view.setUint32(16, 11000);
  view.setUint32(20, 10000);
  view.setUint32(29, Bun.hash.crc32(bomb.subarray(12, 29)) >>> 0);
  put("bomb.png", "image/png", bomb, "PNG header claiming 11000x10000 (110 MP) with 1 px of data");
  return out;
}
