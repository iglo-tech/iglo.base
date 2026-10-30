// Upstream: Go 1.27 image.DecodeConfig with the image/jpeg, image/png and
// image/gif decoders, golang.org/x/image v0.47.0 webp (DecodeConfig), as
// tools/filesystem/filesystem.go createThumb calls it; imaging v1.6.2
// io.go (readOrientation) and the transforms of transform.go it applies.
//
// Go and golang.org/x/image: BSD-3-Clause, Copyright (c) 2009 The Go
// Authors; imaging: MIT, Copyright (c) 2012 Grigory Dryapak (notices in
// LICENSE).
//
// decodeConfig reads only the header, with the errors that fail it:
// image/jpeg's marker walk to the first SOF0-2, image/png's IHDR (and, for
// a paletted image, the chunks up to tRNS or IDAT), image/gif's logical
// screen and x/image/webp's RIFF chunks up to VP8, VP8L or VP8X. Its size
// is the one upstream checks against PB_THUMBS_MAX_SOURCE_PIXELS.
// gifFirstFrame reads the frame image/gif decodes, whose size imaging
// resizes. checkJpegComplete repeats the one decode failure of Go's
// image/jpeg that libjpeg-turbo turns into a warning: the data ends before
// the EOI marker. readOrientation is imaging's (the first APP1 segment
// only); orientImage applies imaging's fixOrientation transforms with
// Bun.Image's rotate, flip and flop, which give the same pixels.

// image.DecodeConfig: the decoder is chosen by the leading bytes, as
// image.RegisterFormat's patterns do ("?" matches any byte). The source is
// read in order, as Go's decoders read their io.Reader: the segments and
// chunks the header walk skips are read in bounded pieces, never held
// whole, so the check costs little memory however large the file is.
export function decodeConfig(src: Uint8Array | ByteSource): Size {
  const r = src instanceof Uint8Array ? bytesSource(src) : src;
  const head = r.peek(15);
  const match = (pattern: string): boolean =>
    head.length >= pattern.length &&
    [...pattern].every((c, i) => c === "?" || head[i] === c.charCodeAt(0));
  if (match("\xff\xd8")) {
    return jpegConfig(r);
  }
  if (match("\x89PNG\r\n\x1a\n")) {
    return pngConfig(r);
  }
  if (match("GIF8?a")) {
    return gifConfig(r);
  }
  if (match("RIFF????WEBPVP8")) {
    return webpConfig(r);
  }
  // BMP and TIFF are registered too, but the API never thumbs them
  throw new Error("image: unknown format");
}

export interface Size {
  width: number;
  height: number;
}

// The bytes of an image, read in order. read fails as Go's io.ReadFull
// does; size is the whole image's length.
export interface ByteSource {
  readonly size: number;
  readonly offset: number;
  // up to n bytes ahead, not consumed
  peek(n: number): Uint8Array;
  read(n: number): Uint8Array;
  skip(n: number): void;
}

const unexpectedEOF = (): Error => new Error("unexpected EOF");

// a source over bytes in memory
function bytesSource(b: Uint8Array, start = 0): ByteSource {
  let o = start;
  return {
    size: b.length,
    get offset(): number {
      return o;
    },
    peek(n: number): Uint8Array {
      return b.subarray(o, o + n);
    },
    read(n: number): Uint8Array {
      if (o + n > b.length) {
        throw unexpectedEOF();
      }
      o += n;
      return b.subarray(o - n, o);
    },
    skip(n: number): void {
      this.read(n);
    },
  };
}

// the most a reader source buffers at once (larger skips are read in
// pieces of this size; the largest piece the header walk keeps is a JPEG
// segment, under 64 KiB)
const readerChunk = 64 * 1024;

// A source over a sequential reader (a stored file's blob.Reader) of size
// bytes. It holds at most one buffered piece.
export function readerSource(r: { read(p: Uint8Array): number }, size: number): ByteSource {
  let buf = new Uint8Array(0);
  let pos = 0;
  let o = 0;
  let scratch: Uint8Array | undefined;
  let store = new Uint8Array(0);
  // buffers at least n bytes ahead, or what is left
  const fill = (n: number): void => {
    if (buf.length - pos >= n) {
      return;
    }
    // the backing store is reused while it is large enough
    const need = Math.max(n, readerChunk);
    const next = store.length >= need ? store : new Uint8Array(need);
    let have = buf.length - pos;
    next.set(buf.subarray(pos));
    store = next;
    while (have < n) {
      const k = r.read(next.subarray(have));
      if (k === 0) {
        break;
      }
      have += k;
    }
    buf = next.subarray(0, have);
    pos = 0;
  };
  return {
    size,
    get offset(): number {
      return o;
    },
    peek(n: number): Uint8Array {
      fill(n);
      return buf.subarray(pos, pos + n);
    },
    read(n: number): Uint8Array {
      fill(n);
      if (buf.length - pos < n) {
        throw unexpectedEOF();
      }
      const out = buf.slice(pos, pos + n);
      pos += n;
      o += n;
      return out;
    },
    skip(n: number): void {
      // the buffered bytes first, then the rest read into one scratch
      // buffer, so a large skip allocates nothing per piece
      const buffered = Math.min(n, buf.length - pos);
      pos += buffered;
      o += buffered;
      let left = n - buffered;
      if (left === 0) {
        return;
      }
      scratch ??= new Uint8Array(readerChunk);
      while (left > 0) {
        const k = r.read(scratch.subarray(0, Math.min(left, readerChunk)));
        if (k === 0) {
          throw unexpectedEOF();
        }
        left -= k;
        o += k;
      }
    },
  };
}

// image/jpeg decode(r, configOnly=true) and DecodeConfig (Go 1.27.2)
function jpegConfig(r: ByteSource): Size {
  r.read(2);
  let jfif = false;
  let sof: Size | undefined;
  const ignore = (n: number): void => r.skip(n);
  for (;;) {
    const tmp = [...r.read(2)] as [number, number];
    while (tmp[0] !== 0xff) {
      // extraneous data is ignored
      tmp[0] = tmp[1];
      tmp[1] = r.read(1)[0] as number;
    }
    let marker = tmp[1];
    if (marker === 0) {
      continue;
    }
    while (marker === 0xff) {
      marker = r.read(1)[0] as number;
    }
    if (marker === 0xd9) {
      break;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      continue;
    }
    const len = r.read(2);
    const n = ((len[0] as number) << 8) + (len[1] as number) - 2;
    if (n < 0) {
      throw new Error("invalid JPEG format: short segment length");
    }
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (sof) {
        throw new Error("invalid JPEG format: multiple SOF markers");
      }
      sof = processSOF(r.read(n));
      if (jfif) {
        return sof;
      }
    } else if (marker === 0xda) {
      break;
    } else if (marker === 0xe0 && n >= 5) {
      const t = r.read(5);
      jfif = String.fromCharCode(...t) === "JFIF\0";
      ignore(n - 5);
    } else if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe || marker === 0xc4) {
      // APPn, COM; DHT, DQT and DRI are skipped in configOnly mode
      ignore(n);
    } else if (marker === 0xdb || marker === 0xdd) {
      ignore(n);
    } else if (marker < 0xc0) {
      throw new Error("invalid JPEG format: unknown marker");
    } else {
      // SOF3, SOF5-7, SOF9-15 (lossless, hierarchical, arithmetic), DAC, DNL...
      throw new Error("unsupported JPEG feature: unknown marker");
    }
  }
  if (!sof) {
    throw new Error("invalid JPEG format: missing SOF marker");
  }
  return sof;
}

// image/jpeg processSOF: the checks that fail DecodeConfig
function processSOF(t: Uint8Array): Size {
  const nComp = { 9: 1, 15: 3, 18: 4 }[t.length];
  if (!nComp) {
    throw new Error("unsupported JPEG feature: number of components");
  }
  if (t[0] !== 8) {
    throw new Error("unsupported JPEG feature: precision");
  }
  if (t[5] !== nComp) {
    throw new Error("invalid JPEG format: SOF has wrong length");
  }
  const subsampling = "unsupported JPEG feature: luma/chroma subsampling ratio";
  const ids: number[] = [];
  const hvs: { h: number; v: number }[] = [];
  for (let i = 0; i < nComp; i++) {
    const c = t[6 + 3 * i] as number;
    if (ids.includes(c)) {
      throw new Error("invalid JPEG format: repeated component identifier");
    }
    ids.push(c);
    if ((t[8 + 3 * i] as number) > 3) {
      throw new Error("invalid JPEG format: bad Tq value");
    }
    const hv = t[7 + 3 * i] as number;
    let h = hv >> 4;
    let v = hv & 0x0f;
    if (h < 1 || h > 4 || v < 1 || v > 4) {
      throw new Error("invalid JPEG format: luma/chroma subsampling ratio");
    }
    if (h === 3 || v === 3) {
      throw new Error(subsampling);
    }
    if (nComp === 1) {
      h = 1;
      v = 1;
    } else if (nComp === 4) {
      const first = hvs[0];
      if (
        (i === 0 && hv !== 0x11 && hv !== 0x22) ||
        ((i === 1 || i === 2) && hv !== 0x11) ||
        (i === 3 && first && (first.h !== h || first.v !== v))
      ) {
        throw new Error(subsampling);
      }
    }
    hvs.push({ h, v });
  }
  if (nComp === 3) {
    const maxH = Math.max(...hvs.map((c) => c.h));
    const maxV = Math.max(...hvs.map((c) => c.v));
    if (hvs.some((c) => maxH % c.h !== 0 || maxV % c.v !== 0)) {
      throw new Error(subsampling);
    }
  }
  return {
    height: ((t[1] as number) << 8) + (t[2] as number),
    width: ((t[3] as number) << 8) + (t[4] as number),
  };
}

// image/png DecodeConfig: the IHDR, and for a paletted image the chunks up
// to tRNS or IDAT, each with its CRC and in the order the decoder accepts
function pngConfig(r: ByteSource): Size {
  r.read(8);
  // stages: 0 start, 1 IHDR, 2 PLTE, 3 tRNS, 4 IDAT
  let stage = 0;
  let paletted = false;
  let depth = 0;
  let size: Size = { width: 0, height: 0 };
  for (;;) {
    const head = r.read(8);
    const length = view(head).getUint32(0);
    const type = String.fromCharCode(...head.subarray(4, 8));
    // the CRC of the type and the data
    let crc = Bun.hash.crc32(head.subarray(4, 8));
    const data = (n: number): Uint8Array => {
      const t = r.read(n);
      crc = Bun.hash.crc32(t, crc);
      return t;
    };
    const order = new Error("invalid PNG format: chunk out of order");
    if (type === "IHDR") {
      if (stage !== 0) {
        throw order;
      }
      stage = 1;
      if (length !== 13) {
        throw new Error("invalid PNG format: bad IHDR length");
      }
      const t = data(13);
      if (t[10] !== 0) {
        throw new Error("unsupported PNG feature: compression method");
      }
      if (t[11] !== 0) {
        throw new Error("unsupported PNG feature: filter method");
      }
      if (t[12] !== 0 && t[12] !== 1) {
        throw new Error("invalid PNG format: invalid interlace method");
      }
      const w = view(t).getInt32(0);
      const h = view(t).getInt32(4);
      if (w <= 0 || h <= 0) {
        throw new Error("invalid PNG format: non-positive dimension");
      }
      depth = t[8] as number;
      const colorType = t[9] as number;
      const valid: Record<number, number[]> = {
        1: [0, 3],
        2: [0, 3],
        4: [0, 3],
        8: [0, 2, 3, 4, 6],
        16: [0, 2, 4, 6],
      };
      if (!valid[depth]?.includes(colorType)) {
        throw new Error(`unsupported PNG feature: bit depth ${depth}, color type ${colorType}`);
      }
      paletted = colorType === 3;
      size = { width: w, height: h };
    } else if (type === "PLTE") {
      if (stage !== 1) {
        throw order;
      }
      stage = 2;
      // only a paletted image gets here before IDAT
      const np = Math.floor(length / 3);
      if (length % 3 !== 0 || np <= 0 || np > 256 || np > 1 << depth) {
        throw new Error("invalid PNG format: bad PLTE length");
      }
      data(3 * np);
    } else if (type === "tRNS") {
      if (stage !== 2) {
        throw order;
      }
      stage = 3;
      if (length > 256) {
        throw new Error("invalid PNG format: bad tRNS length");
      }
      data(length);
    } else if (type === "IDAT") {
      if (stage < 1 || (stage === 1 && paletted)) {
        throw order;
      }
      return size;
    } else if (type === "IEND") {
      throw order;
    } else {
      if (length > 0x7fffffff) {
        throw new Error(`invalid PNG format: Bad chunk length: ${length}`);
      }
      for (let left = length; left > 0;) {
        const k = Math.min(left, readerChunk);
        data(k);
        left -= k;
      }
    }
    if (view(r.read(4)).getUint32(0) !== crc >>> 0) {
      throw new Error("invalid PNG format: invalid checksum");
    }
    if (stage >= (paletted ? 3 : 1)) {
      return size;
    }
  }
}

// image/gif DecodeConfig: the logical screen, not the first frame
function gifConfig(r: ByteSource): Size {
  const t = r.read(13);
  return {
    width: (t[6] as number) | ((t[7] as number) << 8),
    height: (t[8] as number) | ((t[9] as number) << 8),
  };
}

// The first frame, which image/gif's Decode returns and imaging resizes:
// its own size, not the logical screen's, and an error when it does not
// fit in the logical screen (newImageFromDescriptor). Extensions are
// skipped by their sub-blocks; the frame's pixel data is not checked here.
export function gifFirstFrame(b: Uint8Array): Size {
  const r = bytesSource(b);
  const screen = gifConfig(r);
  const fields = b[10] as number;
  if (fields & 0x80) {
    r.read(3 << (1 + (fields & 7)));
  }
  for (;;) {
    const c = r.read(1)[0];
    if (c === 0x21) {
      r.read(1);
      for (let n = r.read(1)[0] as number; n !== 0; n = r.read(1)[0] as number) {
        r.read(n);
      }
    } else if (c === 0x2c) {
      const d = r.read(9);
      const left = (d[0] as number) | ((d[1] as number) << 8);
      const top = (d[2] as number) | ((d[3] as number) << 8);
      const width = (d[4] as number) | ((d[5] as number) << 8);
      const height = (d[6] as number) | ((d[7] as number) << 8);
      if (left + width > screen.width || top + height > screen.height) {
        throw new Error("gif: frame bounds larger than image bounds");
      }
      return { width, height };
    } else if (c === 0x3b) {
      throw new Error("gif: missing image data");
    } else {
      throw new Error(`gif: unknown block type: 0x${(c as number).toString(16)}`);
    }
  }
}

// The length of a GIF up to the end of its first frame's image data, the
// part image/gif's Decode reads (it returns after the first frame). The
// thumb reads only these bytes and ends them with a trailer, so an animated
// original is not read whole. Blocks are walked by their sub-blocks; a cut
// or unknown block fails as the decode would.
export function gifFirstFrameLength(r: ByteSource): number {
  const t = r.read(13);
  const fields = t[10] as number;
  if (fields & 0x80) {
    r.skip(3 << (1 + (fields & 7)));
  }
  const skipSubBlocks = (): void => {
    for (let n = r.read(1)[0] as number; n !== 0; n = r.read(1)[0] as number) {
      r.skip(n);
    }
  };
  for (;;) {
    const c = r.read(1)[0];
    if (c === 0x21) {
      r.read(1);
      skipSubBlocks();
    } else if (c === 0x2c) {
      const d = r.read(9);
      const local = d[8] as number;
      if (local & 0x80) {
        r.skip(3 << (1 + (local & 7)));
      }
      // the LZW minimum code size, then the image data
      r.read(1);
      skipSubBlocks();
      return r.offset;
    } else if (c === 0x3b) {
      throw new Error("gif: missing image data");
    } else {
      throw new Error(`gif: unknown block type: 0x${(c as number).toString(16)}`);
    }
  }
}

// x/image/webp decode(r, configOnly=false) walks the RIFF chunks to the
// first VP8 or VP8L chunk and fails when there is none: an animated WebP
// keeps its frames in ANMF chunks, so upstream cannot decode it and serves
// the original. The thumb walks the same top-level chunks through the
// bounded reader first, so such an original fails before it is read whole.
export function webpCheckImageChunk(r: ByteSource): void {
  const invalid = new Error("webp: invalid format");
  const riffLen = view(r.read(12)).getUint32(4, true);
  if (riffLen < 4) {
    throw new Error("riff: short chunk data");
  }
  let total = riffLen - 4;
  for (;;) {
    if (total < 8 || r.offset + 8 > r.size) {
      throw invalid;
    }
    total -= 8;
    const head = r.read(8);
    const id = String.fromCharCode(...head.subarray(0, 4));
    if (id === "VP8 " || id === "VP8L") {
      return;
    }
    const len = view(head).getUint32(4, true);
    if (len > total || r.offset + len > r.size) {
      throw invalid;
    }
    r.skip(len);
    total -= len;
    if (len & 1) {
      if (total === 0) {
        throw invalid;
      }
      total--;
      r.skip(1);
    }
  }
}

// x/image/webp decode(r, configOnly=true) (v0.47.0): the RIFF chunks up to
// the first VP8, VP8L or VP8X chunk, which gives the size
function webpConfig(r: ByteSource): Size {
  const invalid = new Error("webp: invalid format");
  const riffLen = view(r.read(12)).getUint32(4, true);
  if (riffLen < 4) {
    throw new Error("riff: short chunk data");
  }
  let total = riffLen - 4;
  let wantAlpha = false;
  for (;;) {
    if (total === 0) {
      throw invalid;
    }
    if (total < 8 || r.offset + 8 > r.size) {
      throw new Error("riff: short chunk header");
    }
    total -= 8;
    const head = r.read(8);
    const id = String.fromCharCode(...head.subarray(0, 4));
    const len = view(head).getUint32(4, true);
    if (len > total) {
      throw new Error("riff: list subchunk too long");
    }
    if (r.offset + len > r.size) {
      throw unexpectedEOF();
    }
    if (id === "ALPH") {
      if (!wantAlpha) {
        throw invalid;
      }
      wantAlpha = false;
    } else if (id === "VP8 ") {
      if (wantAlpha || len > 0x7fffffff) {
        throw invalid;
      }
      if (len < 3) {
        throw unexpectedEOF();
      }
      const d = r.read(Math.min(len, 10));
      // a frame that is not a key frame has no size: Go reports 0x0
      if ((d[0] as number) & 1) {
        return { width: 0, height: 0 };
      }
      if (len < 10) {
        throw unexpectedEOF();
      }
      if (d[3] !== 0x9d || d[4] !== 0x01 || d[5] !== 0x2a) {
        throw new Error("vp8: invalid format");
      }
      return {
        width: (((d[7] as number) & 0x3f) << 8) | (d[6] as number),
        height: (((d[9] as number) & 0x3f) << 8) | (d[8] as number),
      };
    } else if (id === "VP8L") {
      if (len < 5) {
        throw unexpectedEOF();
      }
      const d = r.read(5);
      if (d[0] !== 0x2f) {
        throw new Error("vp8l: invalid header");
      }
      const bits = view(d).getUint32(1, true);
      if (bits >>> 29 !== 0) {
        throw new Error("vp8l: invalid version");
      }
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (id === "VP8X") {
      if (len !== 10) {
        throw invalid;
      }
      const d = r.read(10);
      wantAlpha = ((d[0] as number) & 0x10) !== 0;
      const w = ((d[4] as number) | ((d[5] as number) << 8) | ((d[6] as number) << 16)) + 1;
      const h = ((d[7] as number) | ((d[8] as number) << 8) | ((d[9] as number) << 16)) + 1;
      if (w * h > 2 ** 31 - 1) {
        throw invalid;
      }
      return { width: w, height: h };
    }
    // the next chunk (ALPH or another), after an odd chunk's padding byte
    r.skip(len);
    total -= len;
    if (len & 1) {
      if (total === 0) {
        throw new Error("riff: list subchunk too long");
      }
      total--;
      r.skip(1);
    }
  }
}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
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

// imaging's fixOrientation with Bun.Image's own transforms, for a pipeline made with
// { autoOrient: false }. Bun.Image runs rotate (clockwise), then flip
// (vertical) and flop (horizontal), then resize, whatever the call order.
export function orientImage(img: Bun.Image, orientation: number): Bun.Image {
  switch (orientation) {
    case 2: // FlipH
      return img.flop();
    case 3: // Rotate180
      return img.rotate(180);
    case 4: // FlipV
      return img.flip();
    case 5: // Transpose
      return img.rotate(90).flop();
    case 6: // Rotate270 (counter-clockwise)
      return img.rotate(90);
    case 7: // Transverse
      return img.rotate(270).flop();
    case 8: // Rotate90 (counter-clockwise)
      return img.rotate(270);
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
