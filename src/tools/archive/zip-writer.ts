// Upstream: Go go1.27.2 src/archive/zip/writer.go and struct.go (the format
// and FileInfoHeader's fields), as tools/archive/create.go and
// core/backup_create.go use them
//
// Writes a zip archive with streaming Deflate entries: flag bit 3, zero
// sizes in the local header and a data descriptor after the data, so a file
// that changes while it is read still gives a valid entry of the bytes read.
// Zip64 records appear as Go writes them: sizes or offsets of 4 GiB and more,
// or 65,535 entries and more. Each block of 1 MiB is compressed on its own
// with a sync flush, so the memory stays bounded and the entry is a plain
// Deflate stream.
//
// Synchronous: it runs in the backup worker (src/backups/backup-worker.ts).

import { closeSync, fstatSync, lstatSync, openSync, readSync, writeSync } from "node:fs";
import { constants, deflateRawSync } from "node:zlib";

const fileHeaderSignature = 0x04034b50;
const directoryHeaderSignature = 0x02014b50;
const directoryEndSignature = 0x06054b50;
const directory64LocSignature = 0x07064b50;
const directory64EndSignature = 0x06064b50;
const dataDescriptorSignature = 0x08074b50;

const zipVersion20 = 20;
const zipVersion45 = 45;
const creatorUnix = 3;
const methodDeflate = 8;
const flagDataDescriptor = 0x8;
const flagUTF8 = 0x800;

const zip64ExtraID = 0x0001;
const extTimeExtraID = 0x5455;

const uint16max = 0xffff;
const uint32max = 0xffffffff;

const msdosReadOnly = 0x01;

// flate.BestSpeed
const deflateLevel = 1;
const blockSize = 1 << 20;
// how much of a block shows whether it compresses at the fastest level
const sampleSize = 1 << 16;
const incompressibleRatio = 0.9;
const outBufferSize = 1 << 20;

// the last, empty Deflate block
const finalBlock = new Uint8Array([0x03, 0x00]);

const encoder = new TextEncoder();

interface DirEntry {
  name: Uint8Array;
  flags: number;
  dosTime: number;
  dosDate: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
  extra: Uint8Array;
  externalAttrs: number;
}

class ByteWriter {
  readonly bytes: Uint8Array;
  readonly #view: DataView;
  #pos = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.#view = new DataView(this.bytes.buffer);
  }

  uint16(v: number): this {
    this.#view.setUint16(this.#pos, v, true);
    this.#pos += 2;
    return this;
  }

  uint32(v: number): this {
    this.#view.setUint32(this.#pos, v, true);
    this.#pos += 4;
    return this;
  }

  uint64(v: number): this {
    this.#view.setBigUint64(this.#pos, BigInt(v), true);
    this.#pos += 8;
    return this;
  }

  put(p: Uint8Array): this {
    this.bytes.set(p, this.#pos);
    this.#pos += p.length;
    return this;
  }
}

// detectUTF8's require: a name outside the characters ZIP readers agree on
function requiresUTF8Flag(name: string): boolean {
  for (const c of name) {
    const r = c.codePointAt(0) as number;
    if (r < 0x20 || r > 0x7d || r === 0x5c) {
      return true;
    }
  }
  return false;
}

// timeToMsDosTime: the local date and time fields
function msDosTime(t: Date): { date: number; time: number } {
  return {
    date: t.getDate() + ((t.getMonth() + 1) << 5) + (Math.max(t.getFullYear() - 1980, 0) << 9),
    time: Math.trunc(t.getSeconds() / 2) + (t.getMinutes() << 5) + (t.getHours() << 11),
  };
}

export class ZipWriter {
  readonly #fd: number;
  readonly #block = new Uint8Array(blockSize);
  readonly #out = new Uint8Array(outBufferSize);
  #outLen = 0;
  #offset = 0;
  readonly #dir: DirEntry[] = [];
  #closed = false;

  // os.Create
  constructor(path: string) {
    this.#fd = openSync(path, "w", 0o666);
  }

  // Adds the file at localPath as zipPath, with the mode and mod time of
  // its lstat. A symlink is stored with its link mode and its target's
  // content, as fs.WalkDir and fsys.Open do. Anything else that is not a
  // regular file is left out (false): a named pipe would block the read.
  //
  // Throws the open or read error. Nothing is written when the open fails.
  addFile(localPath: string, zipPath: string): boolean {
    const info = lstatSync(localPath);
    if (!info.isFile() && !info.isSymbolicLink()) {
      return false;
    }

    const fd = openSync(localPath, "r");
    try {
      // the content of a symlink to a directory fails as in Go, not here
      if (info.isSymbolicLink() && fstatSync(fd).isDirectory()) {
        throw Object.assign(new Error(`read ${localPath}: is a directory`), { code: "EISDIR" });
      }
      this.#addEntry(fd, zipPath, info.mode, info.mtime);
    } finally {
      closeSync(fd);
    }
    return true;
  }

  // Adds the regular file open at fd, read from the start, as zipPath, with
  // the mode and mod time of its fstat. It may have been deleted by now. The
  // fd stays open.
  addOpenFile(fd: number, zipPath: string): void {
    const info = fstatSync(fd);
    this.#addEntry(fd, zipPath, info.mode, info.mtime);
  }

  #addEntry(fd: number, zipPath: string, mode: number, modified: Date): void {
    const name = encoder.encode(zipPath);
    const { date, time } = msDosTime(modified);
    const flags = flagDataDescriptor | (requiresUTF8Flag(zipPath) ? flagUTF8 : 0);

    // the extended timestamp: the mod time in Unix seconds
    const extra = new ByteWriter(9)
      .uint16(extTimeExtraID)
      .uint16(5) // Size: SizeOf(uint8) + SizeOf(uint32)
      .put(new Uint8Array([1])) // Flags: ModTime
      .uint32(Math.trunc(modified.getTime() / 1000) >>> 0).bytes;

    const entry: DirEntry = {
      name,
      flags,
      dosTime: time,
      dosDate: date,
      crc32: 0,
      compressedSize: 0,
      uncompressedSize: 0,
      offset: this.#offset,
      extra,
      // FileHeader.SetMode: the Unix mode, and the MS-DOS read-only attribute
      externalAttrs: (mode * 65536 + ((mode & 0o200) === 0 ? msdosReadOnly : 0)) >>> 0,
    };

    this.#write(
      new ByteWriter(30 + name.length + extra.length)
        .uint32(fileHeaderSignature)
        .uint16(zipVersion20)
        .uint16(flags)
        .uint16(methodDeflate)
        .uint16(time)
        .uint16(date)
        .uint32(0) // since we are writing a data descriptor crc32,
        .uint32(0) // compressed size,
        .uint32(0) // and uncompressed size should be zero
        .uint16(name.length)
        .uint16(extra.length)
        .put(name)
        .put(extra).bytes,
    );

    for (;;) {
      const n = readSync(fd, this.#block, 0, blockSize, null);
      if (n === 0) {
        break;
      }
      const chunk = this.#block.subarray(0, n);
      entry.crc32 = Bun.hash.crc32(chunk, entry.crc32);
      entry.uncompressedSize += n;
      const compressed = compressBlock(chunk);
      entry.compressedSize += compressed.length;
      this.#write(compressed);
    }
    entry.compressedSize += finalBlock.length;
    this.#write(finalBlock);

    const zip64 = isZip64(entry);
    const descriptor = new ByteWriter(zip64 ? 24 : 16)
      .uint32(dataDescriptorSignature)
      .uint32(entry.crc32);
    if (zip64) {
      descriptor.uint64(entry.compressedSize).uint64(entry.uncompressedSize);
    } else {
      descriptor.uint32(entry.compressedSize).uint32(entry.uncompressedSize);
    }
    this.#write(descriptor.bytes);

    this.#dir.push(entry);
  }

  // Writes the central directory and closes the file.
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;

    try {
      const start = this.#offset;
      for (const entry of this.#dir) {
        this.#writeDirectoryHeader(entry);
      }
      const end = this.#offset;

      let records = this.#dir.length;
      let size = end - start;
      let offset = start;

      if (records >= uint16max || size >= uint32max || offset >= uint32max) {
        this.#write(
          new ByteWriter(76)
            .uint32(directory64EndSignature)
            .uint64(44) // length minus signature (uint32) and length fields (uint64)
            .uint16(zipVersion45) // version made by
            .uint16(zipVersion45) // version needed to extract
            .uint32(0) // number of this disk
            .uint32(0) // number of the disk with the start of the central directory
            .uint64(records) // total number of entries in the central directory on this disk
            .uint64(records) // total number of entries in the central directory
            .uint64(size) // size of the central directory
            .uint64(offset) // offset of start of central directory
            .uint32(directory64LocSignature)
            .uint32(0) // number of the disk with the start of the zip64 end of central directory
            .uint64(end) // relative offset of the zip64 end of central directory record
            .uint32(1).bytes, // total number of disks
        );

        // store max values in the regular end record to signal
        // that the zip64 values should be used instead
        records = uint16max;
        size = uint32max;
        offset = uint32max;
      }

      this.#write(
        new ByteWriter(22)
          .uint32(directoryEndSignature)
          .uint16(0) // number of this disk
          .uint16(0) // number of the disk with the start of the central directory
          .uint16(records) // number of entries on this disk
          .uint16(records) // number of entries total
          .uint32(size) // size of directory
          .uint32(offset) // start of directory
          .uint16(0).bytes, // comment length
      );
      this.#flush();
    } finally {
      closeSync(this.#fd);
    }
  }

  // Closes the file without completing the archive.
  abort(): void {
    if (!this.#closed) {
      this.#closed = true;
      closeSync(this.#fd);
    }
  }

  #writeDirectoryHeader(h: DirEntry): void {
    const zip64 = isZip64(h) || h.offset >= uint32max;
    let extra = h.extra;
    if (zip64) {
      // the file needs a zip64 header: store maxint in both 32 bit size
      // fields (and the offset) to signal that the zip64 extra header
      // should be used
      extra = new ByteWriter(h.extra.length + 28)
        .put(h.extra)
        .uint16(zip64ExtraID)
        .uint16(24) // size = 3x uint64
        .uint64(h.uncompressedSize)
        .uint64(h.compressedSize)
        .uint64(h.offset).bytes;
    }

    this.#write(
      new ByteWriter(46 + h.name.length + extra.length)
        .uint32(directoryHeaderSignature)
        .uint16((creatorUnix << 8) | zipVersion20)
        .uint16(zip64 ? zipVersion45 : zipVersion20)
        .uint16(h.flags)
        .uint16(methodDeflate)
        .uint16(h.dosTime)
        .uint16(h.dosDate)
        .uint32(h.crc32)
        .uint32(zip64 ? uint32max : h.compressedSize)
        .uint32(zip64 ? uint32max : h.uncompressedSize)
        .uint16(h.name.length)
        .uint16(extra.length)
        .uint16(0) // comment length
        .uint16(0) // disk number start
        .uint16(0) // internal file attributes
        .uint32(h.externalAttrs)
        .uint32(zip64 ? uint32max : h.offset)
        .put(h.name)
        .put(extra).bytes,
    );
  }

  #write(p: Uint8Array): void {
    this.#offset += p.length;
    if (p.length > this.#out.length - this.#outLen) {
      this.#flush();
      if (p.length >= this.#out.length) {
        this.#writeAll(p);
        return;
      }
    }
    this.#out.set(p, this.#outLen);
    this.#outLen += p.length;
  }

  #flush(): void {
    this.#writeAll(this.#out.subarray(0, this.#outLen));
    this.#outLen = 0;
  }

  #writeAll(p: Uint8Array): void {
    for (let off = 0; off < p.length;) {
      off += writeSync(this.#fd, p, off, p.length - off);
    }
  }
}

// A block as Deflate, not final, ending on a byte boundary. zlib's fastest
// level uses fixed codes and finds nothing in base64 or random bytes; for
// those, Huffman codes alone are as fast and gain what there is to gain.
function compressBlock(block: Uint8Array): Uint8Array {
  const finishFlush = constants.Z_SYNC_FLUSH;
  const sample = block.subarray(0, sampleSize);
  const compressed = deflateRawSync(sample, { level: deflateLevel, finishFlush });
  if (compressed.length > sample.length * incompressibleRatio) {
    return deflateRawSync(block, {
      level: deflateLevel,
      strategy: constants.Z_HUFFMAN_ONLY,
      finishFlush,
    });
  }
  return block.length === sample.length
    ? compressed
    : deflateRawSync(block, { level: deflateLevel, finishFlush });
}

// FileHeader.isZip64
function isZip64(h: DirEntry): boolean {
  return h.compressedSize >= uint32max || h.uncompressedSize >= uint32max;
}
