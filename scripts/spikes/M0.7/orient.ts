// M0.7 spike: what upstream reads before and around the decode, for the
// backends that do not read it themselves. Not shipped.
//
// headerSize is the image.DecodeConfig step of createThumb
// (tools/filesystem/filesystem.go) for the formats the API thumbs: the PNG
// IHDR, the GIF logical screen, the JPEG SOFn and the WebP VP8/VP8L/VP8X
// headers. It is a spike reader, not a port of Go's decoders' error rules.
// checkJpegComplete repeats the one decode failure of Go's image/jpeg that
// libjpeg-turbo turns into a warning: the data ends before the EOI marker.
// readOrientation and fixOrientation port imaging v1.6.2 io.go and the
// transforms of transform.go that they call (imaging: MIT, Copyright (c)
// 2012 Grigory Dryapak).

import type { Raw } from "@/../scripts/spikes/M0.7/png";

export function headerSize(b: Uint8Array): { width: number; height: number } {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ascii = (o: number, n: number): string => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") {
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (b.length >= 10 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
  }
  if (b.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
    }
    if (kind === "VP8L" && b[20] === 0x2f) {
      const bits = v.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X") {
      const w = (b[24] as number) | ((b[25] as number) << 8) | ((b[26] as number) << 16);
      const h = (b[27] as number) | ((b[28] as number) << 8) | ((b[29] as number) << 16);
      return { width: w + 1, height: h + 1 };
    }
    throw new Error("webp: invalid format");
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 4 <= b.length) {
      if (b[o] !== 0xff) {
        throw new Error("invalid JPEG format: missing 0xff marker start");
      }
      const marker = b[o + 1] as number;
      if (marker === 0xff) {
        o++;
        continue;
      }
      const len = v.getUint16(o + 2);
      // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc)
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        if (o + 9 > b.length) {
          break;
        }
        return { width: v.getUint16(o + 7), height: v.getUint16(o + 5) };
      }
      o += 2 + len;
    }
    throw new Error("unexpected EOF");
  }
  throw new Error("image: unknown format");
}

export function readOrientation(b: Uint8Array): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  const ok = (n: number): boolean => o + n <= b.length;
  if (!ok(2) || v.getUint16(0) !== 0xffd8) {
    return 0;
  }
  o = 2;
  for (;;) {
    if (!ok(4)) {
      return 0;
    }
    const marker = v.getUint16(o);
    const size = v.getUint16(o + 2);
    o += 4;
    if (marker >> 8 !== 0xff) {
      return 0;
    }
    if (marker === 0xffe1) {
      break;
    }
    if (size < 2) {
      return 0;
    }
    o += size - 2;
  }
  if (!ok(6) || v.getUint32(o) !== 0x45786966) {
    return 0;
  }
  o += 6;
  if (!ok(2)) {
    return 0;
  }
  const tag = v.getUint16(o);
  const le = tag === 0x4949;
  if (!le && tag !== 0x4d4d) {
    return 0;
  }
  o += 4;
  if (!ok(4)) {
    return 0;
  }
  const offset = v.getUint32(o, le);
  o += 4;
  if (offset < 8) {
    return 0;
  }
  o += offset - 8;
  if (!ok(2)) {
    return 0;
  }
  const numTags = v.getUint16(o, le);
  o += 2;
  for (let i = 0; i < numTags; i++) {
    if (!ok(2)) {
      return 0;
    }
    const t = v.getUint16(o, le);
    o += 2;
    if (t !== 0x0112) {
      o += 10;
      continue;
    }
    o += 6;
    if (!ok(2)) {
      return 0;
    }
    const val = v.getUint16(o, le);
    return val < 1 || val > 8 ? 0 : val;
  }
  return 0;
}

// dst(x, y) = src(map(x, y)) for a destination of dw x dh
function transform(
  img: Raw,
  dw: number,
  dh: number,
  map: (x: number, y: number) => [number, number],
): Raw {
  const pix = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const [sx, sy] = map(x, y);
      const s = (sy * img.width + sx) * 4;
      pix.set(img.pix.subarray(s, s + 4), (y * dw + x) * 4);
    }
  }
  return { width: dw, height: dh, pix };
}

export function fixOrientation(img: Raw, orientation: number): Raw {
  const w = img.width;
  const h = img.height;
  switch (orientation) {
    case 2: // FlipH
      return transform(img, w, h, (x, y) => [w - 1 - x, y]);
    case 3: // Rotate180
      return transform(img, w, h, (x, y) => [w - 1 - x, h - 1 - y]);
    case 4: // FlipV
      return transform(img, w, h, (x, y) => [x, h - 1 - y]);
    case 5: // Transpose
      return transform(img, h, w, (x, y) => [y, x]);
    case 6: // Rotate270 (counter-clockwise)
      return transform(img, h, w, (x, y) => [y, h - 1 - x]);
    case 7: // Transverse
      return transform(img, h, w, (x, y) => [w - 1 - y, h - 1 - x]);
    case 8: // Rotate90 (counter-clockwise)
      return transform(img, h, w, (x, y) => [w - 1 - y, x]);
    default:
      return img;
  }
}

// Go's image/jpeg reads marker after marker until EOI and fails with
// "unexpected EOF" when the data ends first, also inside a scan. This walks
// the same markers: segments by their length, entropy-coded data after SOS
// up to the next marker that is not a stuffed 0xFF00, a fill 0xFF or RSTn.
export function checkJpegComplete(b: Uint8Array): void {
  if (b[0] !== 0xff || b[1] !== 0xd8) {
    return;
  }
  let o = 2;
  for (;;) {
    while (o < b.length && b[o] !== 0xff) {
      o++;
    }
    while (o < b.length && b[o] === 0xff) {
      o++;
    }
    if (o >= b.length) {
      throw new Error("unexpected EOF");
    }
    const marker = b[o++] as number;
    if (marker === 0xd9) {
      return;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      continue;
    }
    if (o + 2 > b.length) {
      throw new Error("unexpected EOF");
    }
    const len = ((b[o] as number) << 8) | (b[o + 1] as number);
    o += len;
    if (o > b.length) {
      throw new Error("unexpected EOF");
    }
    if (marker === 0xda) {
      // entropy-coded data: 0xFF00 is a stuffed 0xFF, RSTn stays in the scan
      for (;;) {
        if (o + 1 >= b.length) {
          throw new Error("unexpected EOF");
        }
        if (b[o] === 0xff) {
          const next = b[o + 1] as number;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
            o += next === 0xff ? 1 : 2;
            continue;
          }
          break;
        }
        o++;
      }
    }
  }
}
