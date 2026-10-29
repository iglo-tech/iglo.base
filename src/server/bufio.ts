// Upstream: Go's bufio/bufio.go (go1.27.2), the Reader methods that
// mime/multipart, mime/quotedprintable and net/textproto use: NewReaderSize,
// Peek, Read, ReadByte, UnreadByte, Buffered, ReadSlice and ReadLine.
//
// Reads from the underlying reader are async; the buffer sizes and the
// points at which the buffer is filled are Go's, so the underlying reader
// (the request body behind the body limit) is read in the same steps.
// Returned slices point into the buffer, as Go's, and stop being valid at
// the next read.

import { ErrNoProgress, type Reader as IoReader } from "@/server/io";

const defaultBufSize = 4096;
const minReadBufferSize = 16;
const maxConsecutiveEmptyReads = 100;

export const ErrInvalidUnreadByte = new Error("bufio: invalid use of UnreadByte");
export const ErrBufferFull = new Error("bufio: buffer full");
export const ErrNegativeCount = new Error("bufio: negative count");

// Reader implements buffering for an io.Reader object.
export class Reader implements IoReader {
  #buf: Uint8Array;
  readonly #rd: IoReader; // reader provided by the client
  #r = 0; // buf read position
  #w = 0; // buf write position
  #err: unknown = undefined;
  #lastByte = -1; // last byte read for UnreadByte; -1 means invalid

  // NewReaderSize returns a new Reader whose buffer has at least the
  // specified size (NewReader: the default size, 4096).
  constructor(rd: IoReader, size = defaultBufSize) {
    this.#buf = new Uint8Array(Math.max(size, minReadBufferSize));
    this.#rd = rd;
  }

  // fill reads a new chunk into the buffer.
  async #fill(): Promise<void> {
    // Slide existing data to beginning.
    if (this.#r > 0) {
      this.#buf.copyWithin(0, this.#r, this.#w);
      this.#w -= this.#r;
      this.#r = 0;
    }

    if (this.#w >= this.#buf.length) {
      throw new Error("bufio: tried to fill full buffer");
    }

    // Read new data: try a limited number of times.
    for (let i = maxConsecutiveEmptyReads; i > 0; i--) {
      const [n, err] = await this.#rd.read(this.#buf.subarray(this.#w));
      this.#w += n;
      if (err !== undefined) {
        this.#err = err;
        return;
      }
      if (n > 0) {
        return;
      }
    }
    this.#err = ErrNoProgress;
  }

  #readErr(): unknown {
    const err = this.#err;
    this.#err = undefined;
    return err;
  }

  // Peek returns the next n bytes without advancing the reader. If Peek
  // returns fewer than n bytes, it also returns an error explaining why
  // the read is short. The error is ErrBufferFull if n is larger than b's
  // buffer size.
  async peek(n: number): Promise<[Uint8Array, unknown]> {
    if (n < 0) {
      return [new Uint8Array(0), ErrNegativeCount];
    }

    this.#lastByte = -1;

    while (
      this.#w - this.#r < n &&
      this.#w - this.#r < this.#buf.length &&
      this.#err === undefined
    ) {
      await this.#fill(); // b.w-b.r < len(b.buf) => buffer is not full
    }

    if (n > this.#buf.length) {
      return [this.#buf.subarray(this.#r, this.#w), ErrBufferFull];
    }

    // 0 <= n <= len(b.buf)
    let err: unknown = undefined;
    const avail = this.#w - this.#r;
    if (avail < n) {
      // not enough data in buffer
      n = avail;
      err = this.#readErr();
      if (err === undefined) {
        err = ErrBufferFull;
      }
    }
    return [this.#buf.subarray(this.#r, this.#r + n), err];
  }

  // Read reads data into p. It returns the number of bytes read into p.
  // The bytes are taken from at most one Read on the underlying Reader,
  // hence n may be less than len(p).
  async read(p: Uint8Array): Promise<[number, unknown]> {
    let n = p.length;
    if (n === 0) {
      if (this.buffered() > 0) {
        return [0, undefined];
      }
      return [0, this.#readErr()];
    }
    if (this.#r === this.#w) {
      if (this.#err !== undefined) {
        return [0, this.#readErr()];
      }
      if (p.length >= this.#buf.length) {
        // Large read, empty buffer.
        // Read directly into p to avoid copy.
        [n, this.#err] = await this.#rd.read(p);
        if (n > 0) {
          this.#lastByte = p[n - 1] as number;
        }
        return [n, this.#readErr()];
      }
      // One read.
      // Do not use b.fill, which will loop.
      this.#r = 0;
      this.#w = 0;
      [n, this.#err] = await this.#rd.read(this.#buf);
      if (n === 0) {
        return [0, this.#readErr()];
      }
      this.#w += n;
    }

    // copy as much as we can
    n = Math.min(p.length, this.#w - this.#r);
    p.set(this.#buf.subarray(this.#r, this.#r + n));
    this.#r += n;
    this.#lastByte = this.#buf[this.#r - 1] as number;
    return [n, undefined];
  }

  // ReadByte reads and returns a single byte. If no byte is available,
  // returns an error.
  async readByte(): Promise<[number, unknown]> {
    while (this.#r === this.#w) {
      if (this.#err !== undefined) {
        return [0, this.#readErr()];
      }
      await this.#fill(); // buffer is empty
    }
    const c = this.#buf[this.#r] as number;
    this.#r++;
    this.#lastByte = c;
    return [c, undefined];
  }

  // UnreadByte unreads the last byte. Only the most recently read byte can
  // be unread.
  unreadByte(): unknown {
    if (this.#lastByte < 0 || (this.#r === 0 && this.#w > 0)) {
      return ErrInvalidUnreadByte;
    }
    // b.r > 0 || b.w == 0
    if (this.#r > 0) {
      this.#r--;
    } else {
      // b.r == 0 && b.w == 0
      this.#w = 1;
    }
    this.#buf[this.#r] = this.#lastByte;
    this.#lastByte = -1;
    return undefined;
  }

  // Buffered returns the number of bytes that can be read from the current
  // buffer.
  buffered(): number {
    return this.#w - this.#r;
  }

  // ReadSlice reads until the first occurrence of delim in the input,
  // returning a slice pointing at the bytes in the buffer. If ReadSlice
  // encounters an error before finding a delimiter, it returns all the
  // data in the buffer and the error itself (often io.EOF). ReadSlice
  // fails with error ErrBufferFull if the buffer fills without a delim.
  // ReadSlice returns err != nil if and only if line does not end in
  // delim.
  async readSlice(delim: number): Promise<[Uint8Array, unknown]> {
    let s = 0; // search start index
    let line: Uint8Array;
    let err: unknown = undefined;
    for (;;) {
      // Search buffer.
      const i = this.#buf.indexOf(delim, this.#r + s);
      if (i >= 0 && i < this.#w) {
        const end = i + 1;
        line = this.#buf.subarray(this.#r, end);
        this.#r = end;
        break;
      }

      // Pending error?
      if (this.#err !== undefined) {
        line = this.#buf.subarray(this.#r, this.#w);
        this.#r = this.#w;
        err = this.#readErr();
        break;
      }

      // Buffer full?
      if (this.buffered() >= this.#buf.length) {
        this.#r = this.#w;
        line = this.#buf;
        err = ErrBufferFull;
        break;
      }

      s = this.#w - this.#r; // do not rescan area we scanned before

      await this.#fill(); // buffer is not full
    }

    // Handle last byte, if any.
    if (line.length > 0) {
      this.#lastByte = line[line.length - 1] as number;
    }

    return [line, err];
  }

  // ReadLine is a low-level line-reading primitive. ReadLine tries to
  // return a single line, not including the end-of-line bytes. If the line
  // was too long for the buffer then isPrefix is set and the beginning of
  // the line is returned. The rest of the line will be returned from
  // future calls. The text returned from ReadLine does not include the
  // line end ("\r\n" or "\n"). No indication or error is given if the
  // input ends without a final line end.
  async readLine(): Promise<[line: Uint8Array | undefined, isPrefix: boolean, err: unknown]> {
    let [line, err] = await this.readSlice(0x0a);
    if (err === ErrBufferFull) {
      // Handle the case where "\r\n" straddles the buffer.
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        // Put the '\r' back on buf and drop it from line.
        // Let the next call to ReadLine check for "\r\n".
        if (this.#r === 0) {
          // should be unreachable
          throw new Error("bufio: tried to rewind past start of buffer");
        }
        this.#r--;
        line = line.subarray(0, line.length - 1);
      }
      return [line, true, undefined];
    }

    if (line.length === 0) {
      return [err !== undefined ? undefined : line, false, err];
    }
    err = undefined;

    if (line[line.length - 1] === 0x0a) {
      let drop = 1;
      if (line.length > 1 && line[line.length - 2] === 0x0d) {
        drop = 2;
      }
      line = line.subarray(0, line.length - drop);
    }
    return [line, false, err];
  }
}
