// Upstream: tools/router/rereadable_read_closer.go
//
// RereadableReadCloser wraps a reader and allows reading it multiple times:
// what is read is copied into an internal buffer (memory + temp file), and
// on EOF the reader is "rewound" to that copy.
//
// Close it after done working with the reader.

import { BufferWithFile, type ReadCloser, type ReadResult } from "@/server/buffer-with-file";

// Rereader defines an interface for rewindable readers.
export interface Rereader {
  reread(): void;
}

export function isRereader(r: unknown): r is Rereader {
  return typeof (r as Partial<Rereader> | null)?.reread === "function";
}

export class RereadableReadCloser implements ReadCloser, Rereader {
  #reader: ReadCloser;
  #copy: BufferWithFile | undefined;
  #closeErrors: unknown[] = [];

  // MaxMemory specifies the max size of the in memory copy buffer before
  // switching to read/write from temp disk file. If negative or zero,
  // defaults to DefaultMaxMemory.
  maxMemory: number;

  constructor(reader: ReadCloser, maxMemory = 0) {
    this.#reader = reader;
    this.maxMemory = maxMemory;
  }

  // the reader currently read from (for tests)
  current(): ReadCloser {
    return this.#reader;
  }

  // Read reads up to p.length bytes into p and at the same time copies
  // the read data into an internal buffer (memory + temp file).
  //
  // On EOF the reader is "rewound" to allow reading multiple times.
  async read(p: Uint8Array): Promise<ReadResult> {
    const result = await this.#reader.read(p);

    // copy the read bytes into the internal buffer
    if (result.n > 0) {
      this.#copy ??= new BufferWithFile(this.maxMemory);
      this.#copy.write(p.subarray(0, result.n));
    }

    // end reached -> reset for the next read
    if (result.eof) {
      this.reread();
    }

    return result;
  }

  // Reread resets the internal state to allow rereads.
  reread(): void {
    if (!this.#copy) {
      return; // nothing to reset
    }

    // eagerly close the old reader to prevent accumulating too much memory or temp files
    try {
      this.#reader.close();
    } catch (err) {
      this.#closeErrors.push(err);
    }

    this.#reader = this.#copy;
    this.#copy = undefined;
  }

  // Close cleans up related resources. It is safe to call Close multiple
  // times. Once Close is invoked the reader can no longer be used.
  close(): void {
    if (this.#copy) {
      try {
        this.#copy.close();
      } catch (err) {
        this.#closeErrors.push(err);
      }
    }

    try {
      this.#reader.close();
    } catch (err) {
      this.#closeErrors.push(err);
    }

    if (this.#closeErrors.length > 0) {
      throw new AggregateError(this.#closeErrors);
    }
  }
}

// Reads r until EOF (io.ReadAll).
export async function readAll(r: ReadCloser): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const p = new Uint8Array(32 * 1024);
  for (;;) {
    const { n, eof, err } = await r.read(p);
    if (n > 0) {
      chunks.push(p.slice(0, n));
      total += n;
    }
    if (err !== undefined) {
      throw err;
    }
    if (eof) {
      break;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// A ReadCloser over a web ReadableStream (the request body).
export function streamReader(stream: ReadableStream<Uint8Array> | null): ReadCloser {
  if (!stream) {
    return { read: () => ({ n: 0, eof: true }), close: () => {} };
  }
  const reader = stream.getReader();
  let pending: Uint8Array | undefined;
  let done = false;
  return {
    async read(p) {
      if (p.length === 0) {
        return { n: 0, eof: false };
      }
      while (!pending || pending.length === 0) {
        if (done) {
          return { n: 0, eof: true };
        }
        const chunk = await reader.read();
        if (chunk.done) {
          done = true;
          return { n: 0, eof: true };
        }
        pending = chunk.value;
      }
      const n = Math.min(pending.length, p.length);
      p.set(pending.subarray(0, n));
      pending = pending.subarray(n);
      return { n, eof: false };
    },
    close() {
      if (!done) {
        done = true;
        void reader.cancel().catch(() => {});
      }
    },
  };
}

// A ReadCloser over an in-memory byte slice (strings.NewReader + NopCloser).
export function bytesReader(data: Uint8Array | string): ReadCloser {
  let rest = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return {
    read(p) {
      if (rest.length === 0) {
        return { n: 0, eof: true };
      }
      const n = Math.min(rest.length, p.length);
      p.set(rest.subarray(0, n));
      rest = rest.subarray(n);
      return { n, eof: false };
    },
    close() {},
  };
}
