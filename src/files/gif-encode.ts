// Upstream: Go 1.27 image/gif writer.go (the single-frame path of Encode
// with imaging's options: NumColors 256, no Quantizer, so palette.Plan9
// and the draw.FloydSteinberg drawer), drawPaletted from
// image/draw/draw.go and the LSB writer of compress/lzw/writer.go, as
// imaging.Encode(w, img, imaging.GIF) calls them.
//
// Go: BSD-3-Clause, Copyright (c) 2009 The Go Authors (notice in LICENSE).
// The pixels are an NRGBA buffer (non-premultiplied RGBA, 8 bits per
// channel), as imaging hands them over.

// image/color/palette/palette.go: Plan9, 256 opaque colors, RRGGBB
const plan9Hex =
  "0000000000440000880000cc0044000044440044880044cc0088000088440088880088cc00cc0000cc4400cc8800cccc" +
  "00dddd1111110000550000990000dd005500005555004c990049dd00990000994c0099990093dd00dd0000dd4900dd93" +
  "00ee9e00eeee2222220000660000aa0000ee0066000066660055aa004fee00aa0000aa5500aaaa009eee00ee0000ee4f" +
  "00ff5500ffaa00ffff3333330000770000bb0000ff007700007777005dbb0055ff00bb0000bb5d00bbbb00aaff00ff00" +
  "4400444400884400cc4444004444444444884444cc4488004488444488884488cc44cc0044cc4444cc8844cccc440000" +
  "5500005500554c00994900dd5555005555554c4c994949dd4c99004c994c4c99994993dd49dd0049dd4949dd9349dddd" +
  "4feeee6600006600665500aa4f00ee6666006666665555aa4f4fee55aa0055aa5555aaaa4f9eee4fee004fee4f4fee9e" +
  "55ffaa55ffff7700007700775d00bb5500ff7777007777775d5dbb5555ff5dbb005dbb5d5dbbbb55aaff55ff0055ff55" +
  "8800888800cc8844008844448844888844cc8888008888448888888888cc88cc0088cc4488cc8888cccc880000880044" +
  "99004c9900999300dd994c00994c4c994c999349dd99990099994c9999999393dd93dd0093dd4993dd9393dddd990000" +
  "aa0000aa0055aa00aa9e00eeaa5500aa5555aa55aa9e4feeaaaa00aaaa55aaaaaa9e9eee9eee009eee4f9eee9e9eeeee" +
  "aaffffbb0000bb005dbb00bbaa00ffbb5d00bb5d5dbb5dbbaa55ffbbbb00bbbb5dbbbbbbaaaaffaaff00aaff55aaffaa" +
  "cc00cccc4400cc4444cc4488cc44cccc8800cc8844cc8888cc88cccccc00cccc44cccc88cccccccc0000cc0044cc0088" +
  "dd0093dd00dddd4900dd4949dd4993dd49dddd9300dd9349dd9393dd93dddddd00dddd49dddd93dddddddd0000dd0049" +
  "ee004fee009eee00eeee4f00ee4f4fee4f9eee4feeee9e00ee9e4fee9e9eee9eeeeeee00eeee4feeee9eeeeeeeee0000" +
  "ff0000ff0055ff00aaff00ffff5500ff5555ff55aaff55ffffaa00ffaa55ffaaaaffaaffffff00ffff55ffffaaffffff";
const plan9 = Uint8Array.from(plan9Hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));

// color.RGBA{r, g, b, 0xff}.RGBA() for each palette entry
const palette16 = (() => {
  const out = new Int32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    for (let c = 0; c < 3; c++) {
      const v = plan9[i * 3 + c] as number;
      out[i * 4 + c] = v | (v << 8);
    }
    out[i * 4 + 3] = 0xffff;
  }
  return out;
})();

const clamp16 = (i: number): number => (i < 0 ? 0 : i > 0xffff ? 0xffff : i);

// uint32 (d*d) >> 2 with d = x - y in [-0xffff, 0xffff]
const sqDiff = (x: number, y: number): number => {
  const d = x - y;
  return Math.floor((d * d) / 4);
};

// draw.FloydSteinberg.Draw(pm, b, m, b.Min) onto the Plan 9 palette
export function quantizePlan9(pix: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  let curr = new Int32Array((width + 2) * 4);
  let next = new Int32Array((width + 2) * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      // color.NRGBA.RGBA(): 16-bit premultiplied
      const a8 = pix[o + 3] as number;
      const a = a8 | (a8 << 8);
      const pm = (v: number): number => Math.floor(((v | (v << 8)) * a8) / 0xff);
      let er = pm(pix[o] as number);
      let eg = pm(pix[o + 1] as number);
      let eb = pm(pix[o + 2] as number);
      let ea = a;
      const q = (x + 1) * 4;
      er = clamp16(er + Math.trunc((curr[q] as number) / 16));
      eg = clamp16(eg + Math.trunc((curr[q + 1] as number) / 16));
      eb = clamp16(eb + Math.trunc((curr[q + 2] as number) / 16));
      ea = clamp16(ea + Math.trunc((curr[q + 3] as number) / 16));

      let best = 0;
      let bestSum = 0xffffffff;
      for (let i = 0; i < 256; i++) {
        const p = i * 4;
        const sum =
          sqDiff(er, palette16[p] as number) +
          sqDiff(eg, palette16[p + 1] as number) +
          sqDiff(eb, palette16[p + 2] as number) +
          sqDiff(ea, palette16[p + 3] as number);
        if (sum < bestSum) {
          best = i;
          bestSum = sum;
          if (sum === 0) {
            break;
          }
        }
      }
      out[y * width + x] = best;
      const p = best * 4;
      er -= palette16[p] as number;
      eg -= palette16[p + 1] as number;
      eb -= palette16[p + 2] as number;
      ea -= palette16[p + 3] as number;

      const n0 = x * 4;
      const n1 = n0 + 4;
      const n2 = n0 + 8;
      const errs = [er, eg, eb, ea];
      for (let c = 0; c < 4; c++) {
        const e = errs[c] as number;
        next[n0 + c] = (next[n0 + c] as number) + e * 3;
        next[n1 + c] = (next[n1 + c] as number) + e * 5;
        next[n2 + c] = (next[n2 + c] as number) + e;
        curr[n2 + c] = (curr[n2 + c] as number) + e * 7;
      }
    }
    [curr, next] = [next, curr];
    next.fill(0);
  }
  return out;
}

class ByteSink {
  private buf = new Uint8Array(4096);
  length = 0;
  push(b: number): void {
    if (this.length === this.buf.length) {
      const grown = new Uint8Array(this.buf.length * 2);
      grown.set(this.buf);
      this.buf = grown;
    }
    this.buf[this.length++] = b;
  }
  pushAll(bytes: ArrayLike<number>): void {
    for (let i = 0; i < bytes.length; i++) {
      this.push(bytes[i] as number);
    }
  }
  u16(v: number): void {
    this.push(v & 0xff);
    this.push((v >> 8) & 0xff);
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

// compress/lzw writer.go, LSB order, into GIF data sub-blocks of 255 bytes
function lzwBlocks(out: ByteSink, data: Uint8Array, litWidth: number): void {
  const maxCode = (1 << 12) - 1;
  const tableSize = 4 * (1 << 12);
  const tableMask = tableSize - 1;
  const table = new Uint32Array(tableSize);
  const block = new Uint8Array(256);
  const blockByte = (c: number): void => {
    block[0] = (block[0] as number) + 1;
    block[block[0] as number] = c;
    if ((block[0] as number) === 255) {
      out.pushAll(block);
      block[0] = 0;
    }
  };
  let bits = 0;
  let nBits = 0;
  let width = litWidth + 1;
  let hi = (1 << litWidth) + 1;
  let overflow = 1 << (litWidth + 1);
  const write = (c: number): void => {
    bits |= c << nBits;
    nBits += width;
    while (nBits >= 8) {
      blockByte(bits & 0xff);
      bits >>>= 8;
      nBits -= 8;
    }
  };
  const clear = 1 << litWidth;
  // returns false when out of codes
  const incHi = (): boolean => {
    hi++;
    if (hi === overflow) {
      width++;
      overflow <<= 1;
    }
    if (hi === maxCode) {
      write(clear);
      width = litWidth + 1;
      hi = clear + 1;
      overflow = clear << 1;
      table.fill(0);
      return false;
    }
    return true;
  };
  if (data.length > 0) {
    write(clear);
    let code = data[0] as number;
    loop: for (let i = 1; i < data.length; i++) {
      const literal = data[i] as number;
      const key = ((code << 8) | literal) >>> 0;
      let hash = ((key >>> 12) ^ key) & tableMask;
      for (let h = hash, t = table[hash] as number; t !== 0;) {
        if (key === t >>> 12) {
          code = t & maxCode;
          continue loop;
        }
        h = (h + 1) & tableMask;
        t = table[h] as number;
      }
      write(code);
      code = literal;
      if (!incHi()) {
        continue;
      }
      for (;;) {
        if (table[hash] === 0) {
          table[hash] = ((key << 12) | hi) >>> 0;
          break;
        }
        hash = (hash + 1) & tableMask;
      }
    }
    write(code);
    incHi();
  } else {
    write(clear);
  }
  write(clear + 1);
  if (nBits > 0) {
    blockByte(bits & 0xff);
  }
  // blockWriter.close()
  if (block[0] === 0) {
    out.push(0);
  } else {
    const n = block[0] as number;
    out.pushAll(block.subarray(0, n + 1));
    out.push(0);
  }
}

// gif.Encode(w, nrgba, &gif.Options{NumColors: 256}) as imaging.Encode calls it
export function encodeGif(pix: Uint8Array, width: number, height: number): Uint8Array {
  if (width >= 1 << 16 || height >= 1 << 16) {
    throw new Error("gif: image is too large to encode");
  }
  const indexes = quantizePlan9(pix, width, height);
  const out = new ByteSink();
  out.pushAll(new TextEncoder().encode("GIF89a"));
  out.u16(width);
  out.u16(height);
  // global color table of 2^(1+7) entries, background 0, aspect 0
  out.push(0x80 | 7);
  out.push(0);
  out.push(0);
  out.pushAll(plan9);
  // image descriptor, no local color table (the palette is the global one)
  out.push(0x2c);
  out.u16(0);
  out.u16(0);
  out.u16(width);
  out.u16(height);
  out.push(0);
  out.push(8);
  lzwBlocks(out, indexes, 8);
  out.push(0x3b);
  return out.bytes();
}
