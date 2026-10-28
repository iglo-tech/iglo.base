// Upstream: Go 1.27 encoding/base64 (Encoding.EncodeToString and
// DecodeString with decodeQuantum), for base64.StdEncoding (Encrypt and
// Decrypt) and base64.RawURLEncoding and URLEncoding (JWT segments and
// S256Challenge).
//
// The decoder accepts exactly what Go's non-strict decoder accepts: '\r' and
// '\n' anywhere are skipped, non-zero trailing bits are allowed, padding is
// required by the padded encodings and rejected by the raw ones.

const stdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export class CorruptInputError extends Error {
  constructor(readonly offset: number) {
    super(`illegal base64 data at input byte ${offset}`);
    this.name = "CorruptInputError";
  }
}

export class Encoding {
  private readonly decodeMap: Int16Array;

  constructor(
    private readonly alphabet: string,
    private readonly padded: boolean,
  ) {
    this.decodeMap = new Int16Array(256).fill(-1);
    for (let i = 0; i < alphabet.length; i++) {
      this.decodeMap[alphabet.charCodeAt(i)] = i;
    }
  }

  encodeToString(src: Uint8Array): string {
    let out = "";
    let i = 0;
    for (; i + 3 <= src.length; i += 3) {
      const v = ((src[i] as number) << 16) | ((src[i + 1] as number) << 8) | (src[i + 2] as number);
      out += this.char(v >> 18) + this.char(v >> 12) + this.char(v >> 6) + this.char(v);
    }
    const rem = src.length - i;
    if (rem > 0) {
      let v = (src[i] as number) << 16;
      if (rem === 2) {
        v |= (src[i + 1] as number) << 8;
      }
      out += this.char(v >> 18) + this.char(v >> 12);
      if (rem === 2) {
        out += this.char(v >> 6);
        if (this.padded) {
          out += "=";
        }
      } else if (this.padded) {
        out += "==";
      }
    }
    return out;
  }

  private char(v: number): string {
    return this.alphabet[v & 0x3f] as string;
  }

  // DecodeString. Characters outside Latin-1 are invalid input bytes.
  decodeString(s: string): Uint8Array<ArrayBuffer> {
    const src = s;
    const out: number[] = [];
    let si = 0;
    for (;;) {
      const dbuf = [0, 0, 0, 0];
      let dlen = 4;
      let j = 0;
      let done = false;
      for (; j < 4; j++) {
        if (src.length === si) {
          if (j === 0) {
            return Uint8Array.from(out);
          }
          if (j === 1 || this.padded) {
            throw new CorruptInputError(si - j);
          }
          dlen = j;
          done = true;
          break;
        }
        const c = src.charCodeAt(si);
        si++;
        const v = c < 256 ? (this.decodeMap[c] as number) : -1;
        if (v >= 0) {
          dbuf[j] = v;
          continue;
        }
        if (c === 0x0a || c === 0x0d) {
          j--;
          continue;
        }
        if (!this.padded || c !== 0x3d) {
          throw new CorruptInputError(si - 1);
        }
        // padding: we've reached the end and there's padding
        if (j === 0 || j === 1) {
          // incorrect padding
          throw new CorruptInputError(si - 1);
        }
        if (j === 2) {
          // "==" is expected; skip over newlines
          while (si < src.length && (src.charCodeAt(si) === 0x0a || src.charCodeAt(si) === 0x0d)) {
            si++;
          }
          if (si === src.length) {
            throw new CorruptInputError(src.length);
          }
          if (src.charCodeAt(si) !== 0x3d) {
            throw new CorruptInputError(si - 1);
          }
          si++;
        }
        // skip over newlines
        while (si < src.length && (src.charCodeAt(si) === 0x0a || src.charCodeAt(si) === 0x0d)) {
          si++;
        }
        if (si < src.length) {
          // trailing garbage
          throw new CorruptInputError(si);
        }
        dlen = j;
        done = true;
        break;
      }
      const val =
        ((dbuf[0] as number) << 18) |
        ((dbuf[1] as number) << 12) |
        ((dbuf[2] as number) << 6) |
        (dbuf[3] as number);
      const bytes = [(val >> 16) & 0xff, (val >> 8) & 0xff, val & 0xff];
      out.push(...bytes.slice(0, dlen - 1));
      if (done) {
        return Uint8Array.from(out);
      }
    }
  }
}

// base64.StdEncoding
export const StdEncoding = new Encoding(stdAlphabet, true);
// base64.URLEncoding
export const URLEncoding = new Encoding(urlAlphabet, true);
// base64.RawURLEncoding
export const RawURLEncoding = new Encoding(urlAlphabet, false);
