// Upstream: Go go1.27.2 src/archive/zip/reader.go and struct.go
//
// Reads the central directory of a zip archive (Zip64 included, data before
// the archive allowed) with a bounded buffer, and streams an entry's content
// to a sink. The content is checked as Go's checksumReader checks it: the
// size and, when set, the CRC-32. A Deflate stream that yields more than the
// entry's size fails as soon as it does.
//
// Runs in the backup worker (src/backups/backup-worker.ts).

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { once } from "node:events";
import { createInflateRaw } from "node:zlib";

// ErrFormat is returned when zip encounters an invalid zip file.
export const ErrFormat = new Error("zip: not a valid zip file");
// ErrAlgorithm is returned when an entry uses an unsupported method.
export const ErrAlgorithm = new Error("zip: unsupported compression algorithm");
// ErrChecksum is returned when reading a file with a bad checksum.
export const ErrChecksum = new Error("zip: checksum error");
// io.ErrUnexpectedEOF
export const ErrUnexpectedEOF = new Error("unexpected EOF");

const fileHeaderSignature = 0x04034b50;
const directoryHeaderSignature = 0x02014b50;
const directoryEndSignature = 0x06054b50;
const directory64LocSignature = 0x07064b50;
const directory64EndSignature = 0x06064b50;

const fileHeaderLen = 30;
const directoryHeaderLen = 46;
const directoryEndLen = 22;
const directory64LocLen = 20;
const directory64EndLen = 56;

const uint16max = 0xffff;
const uint32max = 0xffffffff;

const zip64ExtraID = 0x0001;

const methodStore = 0;
const methodDeflate = 8;

const creatorFAT = 0;
const creatorUnix = 3;
const creatorNTFS = 11;
const creatorVFAT = 14;
const creatorMacOSX = 19;

const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;

const msdosDir = 0x10;
const msdosReadOnly = 0x01;

const readChunk = 1 << 20;

const decoder = new TextDecoder();

export interface ZipEntry {
  name: string;
  creatorVersion: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  externalAttrs: number;
  headerOffset: number;
}

// what FileInfo().IsDir(), Mode().IsRegular() and Mode().Perm() report
export function entryMode(f: ZipEntry): { isDir: boolean; isRegular: boolean; perm: number } {
  let type = 0;
  let perm = 0;
  switch (f.creatorVersion >> 8) {
    case creatorUnix:
    case creatorMacOSX: {
      const m = f.externalAttrs >>> 16;
      perm = m & 0o777;
      type = m & S_IFMT;
      if (type === S_IFREG) {
        type = 0;
      }
      break;
    }
    case creatorNTFS:
    case creatorVFAT:
    case creatorFAT:
      if ((f.externalAttrs & msdosDir) !== 0) {
        type = S_IFDIR;
        perm = 0o777;
      } else {
        perm = (f.externalAttrs & msdosReadOnly) !== 0 ? 0o444 : 0o666;
      }
      break;
  }
  if (f.name.endsWith("/")) {
    type = S_IFDIR;
  }
  return { isDir: type === S_IFDIR, isRegular: type === 0, perm };
}

function uint64(view: DataView, pos: number): number {
  const v = view.getBigUint64(pos, true);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw ErrFormat;
  }
  return Number(v);
}

export class ZipReader {
  readonly #fd: number;
  readonly #size: number;
  #baseOffset = 0;
  readonly files: ZipEntry[] = [];

  // zip.OpenReader. Throws ErrFormat when path is not a valid zip file.
  constructor(path: string) {
    this.#fd = openSync(path, "r");
    try {
      this.#size = fstatSync(this.#fd).size;
      this.#init();
    } catch (err) {
      closeSync(this.#fd);
      throw err;
    }
  }

  close(): void {
    closeSync(this.#fd);
  }

  #readAt(p: Uint8Array, offset: number): number {
    let n = 0;
    while (n < p.length) {
      const m = readSync(this.#fd, p, n, p.length - n, offset + n);
      if (m === 0) {
        break;
      }
      n += m;
    }
    return n;
  }

  #init(): void {
    const end = this.#readDirectoryEnd();

    let pos = this.#baseOffset + end.directoryOffset;
    if (pos < 0 || pos > this.#size) {
      throw ErrFormat;
    }

    // The count of files inside a zip is truncated to fit in a uint16.
    // Gloss over this by reading headers until we encounter a bad one, and
    // then only report an ErrFormat if the file count modulo 65536 is
    // incorrect.
    let buf = new Uint8Array(0);
    let start = 0;
    const need = (n: number): boolean => {
      if (buf.length - start >= n) {
        return true;
      }
      const next = new Uint8Array(Math.max(n, readChunk));
      next.set(buf.subarray(start));
      const kept = buf.length - start;
      const read = this.#readAt(next.subarray(kept), pos);
      pos += read;
      buf = next.subarray(0, kept + read);
      start = 0;
      return buf.length >= n;
    };

    for (;;) {
      if (!need(directoryHeaderLen)) {
        break;
      }
      const view = new DataView(buf.buffer, buf.byteOffset + start, directoryHeaderLen);
      if (view.getUint32(0, true) !== directoryHeaderSignature) {
        break;
      }
      const nameLen = view.getUint16(28, true);
      const extraLen = view.getUint16(30, true);
      const commentLen = view.getUint16(32, true);
      const total = directoryHeaderLen + nameLen + extraLen + commentLen;
      const creatorVersion = view.getUint16(4, true);
      const method = view.getUint16(10, true);
      const crc32 = view.getUint32(16, true);
      let compressedSize = view.getUint32(20, true);
      let uncompressedSize = view.getUint32(24, true);
      const externalAttrs = view.getUint32(38, true);
      let headerOffset = view.getUint32(42, true);
      if (!need(total)) {
        break;
      }
      const name = decoder.decode(
        buf.subarray(start + directoryHeaderLen, start + directoryHeaderLen + nameLen),
      );
      const extra = buf.subarray(
        start + directoryHeaderLen + nameLen,
        start + directoryHeaderLen + nameLen + extraLen,
      );
      start += total;

      let needUSize = uncompressedSize === uint32max;
      let needCSize = compressedSize === uint32max;
      let needHeaderOffset = headerOffset === uint32max;

      const ev = new DataView(extra.buffer, extra.byteOffset, extra.length);
      for (let p = 0; p + 4 <= extra.length;) {
        const fieldTag = ev.getUint16(p, true);
        const fieldSize = ev.getUint16(p + 2, true);
        p += 4;
        if (p + fieldSize > extra.length) {
          break;
        }
        if (fieldTag === zip64ExtraID) {
          let q = p;
          const fieldEnd = p + fieldSize;
          if (needUSize) {
            if (q + 8 > fieldEnd) {
              throw ErrFormat;
            }
            needUSize = false;
            uncompressedSize = uint64(ev, q);
            q += 8;
          }
          if (needCSize) {
            if (q + 8 > fieldEnd) {
              throw ErrFormat;
            }
            needCSize = false;
            compressedSize = uint64(ev, q);
            q += 8;
          }
          if (needHeaderOffset) {
            if (q + 8 > fieldEnd) {
              throw ErrFormat;
            }
            needHeaderOffset = false;
            headerOffset = uint64(ev, q);
          }
        }
        p += fieldSize;
      }

      if (needCSize || needHeaderOffset) {
        throw ErrFormat;
      }

      this.files.push({
        name,
        creatorVersion,
        method,
        crc32,
        compressedSize,
        uncompressedSize,
        externalAttrs,
        headerOffset: headerOffset + this.#baseOffset,
      });
    }

    // only compare 16 bits here
    if ((this.files.length & uint16max) !== (end.directoryRecords & uint16max)) {
      throw ErrFormat;
    }
  }

  // findDirectoryEnd, with the Zip64 records and the offset of the archive
  // in the file
  #readDirectoryEnd(): {
    directoryRecords: number;
    directorySize: number;
    directoryOffset: number;
  } {
    const tail = new Uint8Array(Math.min(this.#size, directoryEndLen + uint16max));
    const tailOffset = this.#size - tail.length;
    this.#readAt(tail, tailOffset);
    const view = new DataView(tail.buffer);

    let p = -1;
    for (let i = tail.length - directoryEndLen; i >= 0; i--) {
      if (view.getUint32(i, true) === directoryEndSignature) {
        // a comment that runs past the end is not an end record
        if (view.getUint16(i + 20, true) + directoryEndLen + i > tail.length) {
          throw ErrFormat;
        }
        p = i;
        break;
      }
    }
    if (p === -1) {
      throw ErrFormat;
    }

    const endOffset = tailOffset + p;
    let directoryRecords = view.getUint16(p + 10, true);
    let directorySize = view.getUint32(p + 12, true);
    let directoryOffset = view.getUint32(p + 16, true);

    if (
      directoryRecords === uint16max ||
      directorySize === uint32max ||
      directoryOffset === uint32max
    ) {
      const end64 = this.#readDirectory64End(endOffset);
      if (end64 !== null) {
        ({ directoryRecords, directorySize, directoryOffset } = end64);
        // the Zip64 end record comes before the locator
        this.#baseOffset = Math.max(end64.endOffset - directorySize - directoryOffset, 0);
        return { directoryRecords, directorySize, directoryOffset };
      }
    }

    if (endOffset >= directorySize + directoryOffset) {
      // data prepended to the archive shifts every offset
      const base = endOffset - directorySize - directoryOffset;
      if (base > 0 && this.#directoryStartsAt(base + directoryOffset, directoryRecords)) {
        this.#baseOffset = base;
      }
    }

    return { directoryRecords, directorySize, directoryOffset };
  }

  #directoryStartsAt(offset: number, records: number): boolean {
    if (records === 0) {
      return true;
    }
    const sig = new Uint8Array(4);
    return (
      this.#readAt(sig, offset) === 4 &&
      new DataView(sig.buffer).getUint32(0, true) === directoryHeaderSignature
    );
  }

  // findDirectory64End and readDirectory64End
  #readDirectory64End(directoryEndOffset: number): {
    directoryRecords: number;
    directorySize: number;
    directoryOffset: number;
    endOffset: number;
  } | null {
    const locOffset = directoryEndOffset - directory64LocLen;
    if (locOffset < 0) {
      return null; // no need to look for a header outside the file
    }
    const loc = new Uint8Array(directory64LocLen);
    if (this.#readAt(loc, locOffset) !== loc.length) {
      return null;
    }
    const locView = new DataView(loc.buffer);
    if (locView.getUint32(0, true) !== directory64LocSignature) {
      return null;
    }
    if (locView.getUint32(16, true) !== 1) {
      return null; // the file is not a valid zip64-file
    }

    const endOffset = uint64(locView, 8);
    const end = new Uint8Array(directory64EndLen);
    if (this.#readAt(end, endOffset) !== end.length) {
      throw ErrFormat;
    }
    const view = new DataView(end.buffer);
    if (view.getUint32(0, true) !== directory64EndSignature) {
      throw ErrFormat;
    }
    return {
      directoryRecords: uint64(view, 32),
      directorySize: uint64(view, 40),
      directoryOffset: uint64(view, 48),
      endOffset,
    };
  }

  // File.Open's checks: the method, and the local header (findBodyOffset).
  // Returns the offset of the entry's content.
  dataOffset(f: ZipEntry): number {
    if (f.method !== methodStore && f.method !== methodDeflate) {
      throw ErrAlgorithm;
    }
    const header = new Uint8Array(fileHeaderLen);
    if (this.#readAt(header, f.headerOffset) !== header.length) {
      throw ErrUnexpectedEOF;
    }
    const view = new DataView(header.buffer);
    if (view.getUint32(0, true) !== fileHeaderSignature) {
      throw ErrFormat;
    }
    return f.headerOffset + fileHeaderLen + view.getUint16(26, true) + view.getUint16(28, true);
  }

  // Passes the entry's content to sink, chunk by chunk, and checks it.
  async copyTo(f: ZipEntry, sink: (chunk: Uint8Array) => void): Promise<void> {
    const offset = this.dataOffset(f);

    let crc32 = 0;
    let nread = 0;
    const check = (chunk: Uint8Array): void => {
      nread += chunk.length;
      if (nread > f.uncompressedSize) {
        throw ErrUnexpectedEOF;
      }
      crc32 = Bun.hash.crc32(chunk, crc32);
      sink(chunk);
    };

    if (f.method === methodStore) {
      for (let left = f.compressedSize, pos = offset; left > 0;) {
        const chunk = new Uint8Array(Math.min(left, readChunk));
        const n = this.#readAt(chunk, pos);
        if (n !== chunk.length) {
          throw ErrUnexpectedEOF;
        }
        check(chunk);
        pos += n;
        left -= n;
      }
    } else {
      await this.#inflate(offset, f.compressedSize, check);
    }

    if (nread !== f.uncompressedSize) {
      throw ErrUnexpectedEOF;
    }
    if (f.crc32 !== 0 && crc32 !== f.crc32) {
      throw ErrChecksum;
    }
  }

  async #inflate(offset: number, length: number, sink: (c: Uint8Array) => void): Promise<void> {
    const inflate = createInflateRaw();
    let sinkErr: unknown;
    inflate.on("data", (chunk: Uint8Array) => {
      if (sinkErr !== undefined) {
        return;
      }
      try {
        sink(chunk);
      } catch (err) {
        sinkErr = err;
        inflate.destroy();
      }
    });
    const ended = new Promise<void>((resolve, reject) => {
      inflate.once("end", resolve);
      inflate.once("close", resolve);
      inflate.once("error", reject);
    });

    try {
      for (let left = length, pos = offset; left > 0;) {
        if (sinkErr !== undefined) {
          break;
        }
        const chunk = new Uint8Array(Math.min(left, readChunk));
        const n = this.#readAt(chunk, pos);
        if (n !== chunk.length) {
          throw ErrUnexpectedEOF;
        }
        pos += n;
        left -= n;
        if (!inflate.write(chunk)) {
          await Promise.race([once(inflate, "drain"), ended]);
        }
      }
      inflate.end();
      await ended;
    } catch (err) {
      inflate.destroy();
      throw sinkErr ?? err;
    }
    if (sinkErr !== undefined) {
      throw sinkErr;
    }
  }
}
