// Upstream: the parts of Go's io package (io.go) that the multipart form
// parser (src/server/multipart.ts) uses: the Reader interface with Go's
// (n, err) results, EOF, ErrUnexpectedEOF and CopyN, and an adapter from
// the router's request body (a ReadCloser) to that interface.
//
// A Go error is `unknown` here, and nil is undefined: a body read fails
// with whatever the body throws (an ApiError from the body limit).

import type { ReadCloser } from "@/server/buffer-with-file";

// EOF is the error returned by Read when no more input is available.
export const EOF = new Error("EOF");

// ErrUnexpectedEOF means that EOF was encountered in the middle of reading
// a fixed-size block or data structure.
export const ErrUnexpectedEOF = new Error("unexpected EOF");

// ErrNoProgress is returned by some clients of a Reader when many calls to
// Read have failed to return any data or error.
export const ErrNoProgress = new Error("multiple Read calls return no data or error");

// io.Reader: Read reads up to p.length bytes into p and returns the number
// of bytes read and any error encountered (both may be set).
export interface Reader {
  read(p: Uint8Array): Promise<[n: number, err: unknown]>;
}

// a Reader over a request body: io.EOF at its end, and a failed read (a
// thrown error, or one returned with data) as the error
export function bodyReader(body: ReadCloser): Reader {
  return {
    async read(p) {
      try {
        const { n, eof, err } = await body.read(p);
        if (err !== undefined) {
          return [n, err];
        }
        return [n, eof ? EOF : undefined];
      } catch (err) {
        return [0, err];
      }
    },
  };
}

// a Writer that keeps what is written in memory (bytes.Buffer)
export class BytesBuffer {
  readonly chunks: Uint8Array[] = [];
  length = 0;

  write(p: Uint8Array): void {
    if (p.length > 0) {
      this.chunks.push(p.slice());
      this.length += p.length;
    }
  }

  bytes(): Uint8Array {
    if (this.chunks.length === 1) {
      return this.chunks[0] as Uint8Array;
    }
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

// the size of a copy buffer (io.Copy uses 32 KiB; a multipart part
// returns at most its 4 KiB peek buffer per read, so the result is the
// same)
export const copyBufferSize = 4096;

// CopyN copies n bytes (or until an error) from src to dst (dst undefined
// discards them, as io.Discard). It returns the number of bytes copied and
// the earliest error encountered while copying. On return, written == n
// if and only if err == nil; a src that ends early returns EOF.
export async function copyN(
  dst: BytesBuffer | undefined,
  src: Reader,
  n: number,
  buf: Uint8Array = new Uint8Array(copyBufferSize),
): Promise<[written: number, err: unknown]> {
  const [written, err] = await copy(dst, src, n, buf);
  if (written === n) {
    return [n, undefined];
  }
  if (written < n && err === undefined) {
    // src stopped early; must have been EOF.
    return [written, EOF];
  }
  return [written, err];
}

// io.CopyBuffer (with an io.LimitReader of limit bytes when limit is
// given): copies until EOF, the limit or an error, through buf. A src that
// ends returns no error.
export async function copy(
  dst: BytesBuffer | undefined,
  src: Reader,
  limit = Number.POSITIVE_INFINITY,
  buf: Uint8Array = new Uint8Array(copyBufferSize),
): Promise<[written: number, err: unknown]> {
  let written = 0;
  while (written < limit) {
    const want = Math.min(buf.length, limit - written);
    const [nr, er] = await src.read(buf.subarray(0, want));
    if (nr > 0) {
      dst?.write(buf.subarray(0, nr));
      written += nr;
    }
    if (er !== undefined) {
      return [written, er === EOF ? undefined : er];
    }
  }
  return [written, undefined];
}
