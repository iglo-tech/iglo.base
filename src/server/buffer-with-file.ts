// Upstream: tools/router/buffer_with_file.go
//
// BufferWithFile is similar to an in-memory buffer but after the limit it
// falls back to a temporary file to minimize excessive memory usage.

import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DefaultMaxMemory: 16mb
export const DefaultMaxMemory = 16 << 20;

export interface ReadResult {
  // number of bytes read into p
  n: number;
  // io.EOF
  eof: boolean;
  // an error returned together with the n bytes read (Go's (n, err) with
  // n > 0); a read that fails without data throws instead
  err?: unknown;
}

// io.ReadCloser, with Go's Read semantics: read up to p.length bytes into p.
export interface ReadCloser {
  read(p: Uint8Array): Promise<ReadResult> | ReadResult;
  close(): void;
}

export class BufferWithFile implements ReadCloser {
  #buf: Uint8Array[] | undefined = [];
  #bufLen = 0;
  #file: { fd: number; dir: string; name: string } | undefined;
  #fileReadOffset = 0;
  readonly memoryLimit: number;

  // If memoryLimit is negative or zero, defaults to DefaultMaxMemory.
  constructor(memoryLimit: number) {
    this.memoryLimit = memoryLimit <= 0 ? DefaultMaxMemory : memoryLimit;
  }

  // length of the in-memory part (for tests)
  memoryLength(): number {
    return this.#bufLen;
  }

  // path of the temporary file, if one was created (for tests)
  fileName(): string | undefined {
    return this.#file?.name;
  }

  isClosed(): boolean {
    return this.#buf === undefined;
  }

  // Read reads up to p.length bytes into p: first from the memory buffer,
  // then from the file.
  read(p: Uint8Array): ReadResult {
    if (this.#buf === undefined) {
      throw new Error("[bufferWithFile.Read] not initialized or already closed");
    }

    // eagerly get length because the buffer may resize and change it
    const maxToRead = p.length;
    let n = 0;
    let eof = false;

    // read first from the memory buffer
    while (n < maxToRead && this.#buf.length > 0) {
      const chunk = this.#buf[0] as Uint8Array;
      const take = Math.min(chunk.length, maxToRead - n);
      p.set(chunk.subarray(0, take), n);
      n += take;
      this.#bufLen -= take;
      if (take === chunk.length) {
        this.#buf.shift();
      } else {
        this.#buf[0] = chunk.subarray(take);
      }
    }

    // continue reading from the file to fill the remaining bytes
    if (n < maxToRead && this.#file) {
      const fileN = readSync(this.#file.fd, p, n, maxToRead - n, this.#fileReadOffset);
      this.#fileReadOffset += fileN;
      n += fileN;
      // ReadAt returns io.EOF when fewer bytes than requested were read
      eof = n < maxToRead;
    }

    // return EOF if the buffers are empty and nothing has been read
    // (for consistency with the bytes.Buffer rules)
    if (n === 0 && maxToRead > 0) {
      return { n: 0, eof: true };
    }

    return { n, eof };
  }

  // Write writes p into the buffer. If the memory buffer doesn't have enough
  // space to hold p, it writes p into a temp disk file.
  write(p: Uint8Array): number {
    if (this.#buf === undefined) {
      throw new Error("[bufferWithFile.Write] not initialized or already closed");
    }

    // already above the limit -> continue with the file
    if (this.#file) {
      return writeAll(this.#file.fd, p);
    }

    // above limit -> create and write to file
    if (this.#bufLen + p.length > this.memoryLimit) {
      const dir = mkdtempSync(join(tmpdir(), "pb_buffer_file_"));
      const name = join(dir, "buffer");
      this.#file = { fd: openSync(name, "w+", 0o600), dir, name };
      return writeAll(this.#file.fd, p);
    }

    // write in memory (copied: the caller may reuse p)
    this.#buf.push(p.slice());
    this.#bufLen += p.length;
    return p.length;
  }

  // Close unsets the memory buffer and removes the temporary file (if any).
  // It is safe to call Close multiple times.
  close(): void {
    if (this.#file) {
      const file = this.#file;
      this.#file = undefined;
      closeSync(file.fd);
      rmSync(file.dir, { recursive: true, force: true });
    }
    this.#buf = undefined;
    this.#bufLen = 0;
  }
}

function writeAll(fd: number, p: Uint8Array): number {
  let written = 0;
  while (written < p.length) {
    written += writeSync(fd, p, written, p.length - written);
  }
  return written;
}
