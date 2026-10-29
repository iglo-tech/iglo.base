// Upstream: Go's mime/quotedprintable/reader.go (go1.27.2): the
// quoted-printable decoder (RFC 2045) that mime/multipart's NextPart puts
// in front of a part with "Content-Transfer-Encoding: quoted-printable".

import { ErrUnexpectedEOF, EOF, type Reader as IoReader } from "@/server/io";
import { Reader as BufReader } from "@/server/bufio";
import { goQuote } from "@/server/textproto";

// Reader is a quoted-printable decoder.
export class Reader implements IoReader {
  readonly #br: BufReader;
  #rerr: unknown = undefined; // last read error
  #line: Uint8Array = new Uint8Array(0); // to be consumed before more of br

  // NewReader returns a quoted-printable reader, decoding from r.
  constructor(r: IoReader) {
    this.#br = new BufReader(r);
  }

  // Read reads and decodes quoted-printable data from the underlying
  // reader.
  async read(p: Uint8Array): Promise<[number, unknown]> {
    // Deviations from RFC 2045:
    // 1. in addition to "=\r\n", "=\n" is also treated as soft line break.
    // 2. it will pass through a '\r' or '\n' not preceded by '=', consistent
    //    with other broken QP encoders & decoders.
    // 3. it accepts soft line-break (=) at end of message (issue 15486); i.e.
    //    the final byte read from the underlying reader is allowed to be '=',
    //    and it will be silently ignored.
    // 4. it takes = as literal = if not followed by two hex digits
    //    but not at end of line (issue 13219).
    let n = 0;
    while (n < p.length) {
      if (this.#line.length === 0) {
        if (this.#rerr !== undefined) {
          return [n, this.#rerr];
        }
        const [wholeLine, rerr] = await this.#br.readSlice(0x0a);
        this.#rerr = rerr;

        // Does the line end in CRLF instead of just LF?
        const hasLF = wholeLine.length > 0 && wholeLine[wholeLine.length - 1] === 0x0a;
        const hasCR = hasLF && wholeLine.length > 1 && wholeLine[wholeLine.length - 2] === 0x0d;
        let end = wholeLine.length;
        while (end > 0 && isQPDiscardWhitespace(wholeLine[end - 1] as number)) {
          end--;
        }
        let line = wholeLine.subarray(0, end);
        if (line.length > 0 && line[line.length - 1] === 0x3d) {
          // rightStripped: what follows the "=", without leading LWSP
          let rs = end;
          while (rs < wholeLine.length && (wholeLine[rs] === 0x20 || wholeLine[rs] === 0x09)) {
            rs++;
          }
          const rightStripped = wholeLine.subarray(rs);
          line = line.subarray(0, line.length - 1);
          if (
            !(rightStripped.length > 0 && rightStripped[0] === 0x0a) &&
            !(rightStripped.length > 1 && rightStripped[0] === 0x0d && rightStripped[1] === 0x0a) &&
            !(rightStripped.length === 0 && line.length > 0 && this.#rerr === EOF)
          ) {
            this.#rerr = new Error(
              `quotedprintable: invalid bytes after =: ${goQuote(rightStripped)}`,
            );
          }
        } else if (hasLF) {
          const withEnd = new Uint8Array(line.length + (hasCR ? 2 : 1));
          withEnd.set(line);
          withEnd.set(hasCR ? [0x0d, 0x0a] : [0x0a], line.length);
          line = withEnd;
        }
        // a copy: the bufio buffer is reused by the next read
        this.#line = line.slice();
        continue;
      }
      let b = this.#line[0] as number;

      if (b === 0x3d) {
        const [hex, err] = readHexByte(this.#line.subarray(1));
        if (err !== undefined) {
          if (this.#line.length >= 2 && this.#line[1] !== 0x0d && this.#line[1] !== 0x0a) {
            // Take the = as a literal =.
            b = 0x3d;
          } else {
            return [n, err];
          }
        } else {
          b = hex;
          this.#line = this.#line.subarray(2); // 2 of the 3; other 1 is done below
        }
      } else if (b === 0x09 || b === 0x0d || b === 0x0a) {
        // passed through
      } else if (b >= 0x80) {
        // As an extension to RFC 2045, we accept
        // values >= 0x80 without complaint. Issue 22597.
      } else if (b < 0x20 || b > 0x7e) {
        return [
          n,
          new Error(
            `quotedprintable: invalid unescaped byte 0x${b.toString(16).padStart(2, "0")} in body`,
          ),
        ];
      }
      p[n] = b;
      this.#line = this.#line.subarray(1);
      n++;
    }
    return [n, undefined];
  }
}

function fromHex(b: number): [number, unknown] {
  if (b >= 0x30 && b <= 0x39) {
    return [b - 0x30, undefined];
  }
  if (b >= 0x41 && b <= 0x46) {
    return [b - 0x41 + 10, undefined];
  }
  // Accept badly encoded bytes.
  if (b >= 0x61 && b <= 0x66) {
    return [b - 0x61 + 10, undefined];
  }
  return [0, new Error(`quotedprintable: invalid hex byte 0x${b.toString(16).padStart(2, "0")}`)];
}

function readHexByte(v: Uint8Array): [number, unknown] {
  if (v.length < 2) {
    return [0, ErrUnexpectedEOF];
  }
  const [hb, herr] = fromHex(v[0] as number);
  if (herr !== undefined) {
    return [0, herr];
  }
  const [lb, lerr] = fromHex(v[1] as number);
  if (lerr !== undefined) {
    return [0, lerr];
  }
  return [(hb << 4) | lb, undefined];
}

function isQPDiscardWhitespace(r: number): boolean {
  return r === 0x0a || r === 0x0d || r === 0x20 || r === 0x09;
}
