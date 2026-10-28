// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/archive.go.

import {
  beUint16,
  contains,
  equal,
  hasPrefix,
  leUint16,
  leUint32,
  lit,
  trim,
} from "@/tools/mimetype/go-bytes";
import { offset } from "@/tools/mimetype/internal/magic/magic";
import { Text } from "@/tools/mimetype/internal/magic/text";
import { Zip } from "@/tools/mimetype/internal/magic/zip";

const sevenZSig = Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c);
// SevenZ matches a 7z archive.
export function SevenZ(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, sevenZSig);
}

const gzipSig = Uint8Array.of(0x1f, 0x8b);
// Gzip matches gzip files based on http://www.zlib.org/rfc-gzip.html#header-trailer.
export function Gzip(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, gzipSig);
}

// prettier-ignore
const fitsSig = Uint8Array.of(
  0x53, 0x49, 0x4D, 0x50, 0x4C, 0x45, 0x20, 0x20, 0x3D, 0x20,
  0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20,
  0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x54,
);
// Fits matches an Flexible Image Transport System file.
export function Fits(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, fitsSig);
}

const xarSig = Uint8Array.of(0x78, 0x61, 0x72, 0x21);
// Xar matches an eXtensible ARchive format file.
export function Xar(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, xarSig);
}

const bz2Sig = Uint8Array.of(0x42, 0x5a, 0x68);
// Bz2 matches a bzip2 file.
export function Bz2(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, bz2Sig);
}

const arSig = Uint8Array.of(0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e);
// Ar matches an ar (Unix) archive file.
export function Ar(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, arSig);
}

// prettier-ignore
const debSig = Uint8Array.of(
  0x64, 0x65, 0x62, 0x69, 0x61, 0x6E, 0x2D,
  0x62, 0x69, 0x6E, 0x61, 0x72, 0x79,
);
// Deb matches a Debian package file.
export function Deb(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, debSig, 8);
}

const warc10 = lit("WARC/1.0");
const warc11 = lit("WARC/1.1");
// Warc matches a Web ARChive file.
export function Warc(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, warc10) || hasPrefix(raw, warc11);
}

const cabSig = lit("MSCF\x00\x00\x00\x00");
// Cab matches a Microsoft Cabinet archive file.
export function Cab(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, cabSig);
}

const xzSig = Uint8Array.of(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00);
// Xz matches an xz compressed stream based on https://tukaani.org/xz/xz-file-format.txt.
export function Xz(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, xzSig);
}

const lzipSig = Uint8Array.of(0x4c, 0x5a, 0x49, 0x50);
// Lzip matches an Lzip compressed file.
export function Lzip(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, lzipSig);
}

const rpmSig = Uint8Array.of(0xed, 0xab, 0xee, 0xdb);
const drpmSig = lit("drpm");
// RPM matches an RPM or Delta RPM package file.
export function RPM(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, rpmSig) || hasPrefix(raw, drpmSig);
}

const rar15 = lit("Rar!\x1A\x07\x00");
const rar50 = lit("Rar!\x1A\x07\x01\x00");
// RAR matches a RAR archive file.
export function RAR(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, rar15) || hasPrefix(raw, rar50);
}

const iscSig = lit("ISc(");
// InstallShieldCab matches an InstallShield Cabinet archive file.
export function InstallShieldCab(raw: Uint8Array, _limit: number): boolean {
  return (
    raw.length > 7 &&
    equal(raw.subarray(0, 4), iscSig) &&
    raw[6] === 0 &&
    (raw[7] === 1 || raw[7] === 2 || raw[7] === 4)
  );
}

// Zstd matches a Zstandard archive file.
// https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md
export function Zstd(raw: Uint8Array, _limit: number): boolean {
  if (raw.length < 4) {
    return false;
  }
  const sig = leUint32(raw, 0);
  // Check for Zstandard frames and skippable frames.
  return (sig >= 0xfd2fb522 && sig <= 0xfd2fb528) || (sig >= 0x184d2a50 && sig <= 0x184d2a5f);
}

const crxSig = lit("Cr24");
// CRX matches a Chrome extension file: a zip archive prepended by a package header.
export function CRX(raw: Uint8Array, limit: number): boolean {
  const minHeaderLen = 16;
  if (raw.length < minHeaderLen || !hasPrefix(raw, crxSig)) {
    return false;
  }
  const pubkeyLen = leUint32(raw, 8);
  const sigLen = leUint32(raw, 12);
  const zipOffset = minHeaderLen + pubkeyLen + sigLen;
  if (zipOffset < 0 || raw.length < zipOffset) {
    return false;
  }
  return Zip(raw.subarray(zipOffset), limit);
}

const cpioPortable = lit("070707");
const cpioNew = lit("070701");
const cpioCRC = lit("070702");
// Cpio matches a cpio archive file.
export function Cpio(raw: Uint8Array, _limit: number): boolean {
  if (raw.length < 6) {
    return false;
  }
  return (
    leUint16(raw, 0) === 0o70707 || // binary cpio
    hasPrefix(raw, cpioPortable) || // portable ASCII cpios
    hasPrefix(raw, cpioNew) ||
    hasPrefix(raw, cpioCRC)
  );
}

const gpkg = lit("/gpkg-1\x00");
// Tar matches a (t)ape (ar)chive file.
// Tar files are divided into 512 bytes records. First record contains a 257
// bytes header padded with NUL.
export function Tar(raw: Uint8Array, _limit: number): boolean {
  const sizeRecord = 512;

  // The structure of a tar header:
  // type TarHeader struct {
  // 	Name     [100]byte
  // 	Mode     [8]byte
  // 	Uid      [8]byte
  // 	Gid      [8]byte
  // 	Size     [12]byte
  // 	Mtime    [12]byte
  // 	Chksum   [8]byte
  // 	Linkflag byte
  // 	Linkname [100]byte
  // 	Magic    [8]byte
  // 	Uname    [32]byte
  // 	Gname    [32]byte
  // 	Devmajor [8]byte
  // 	Devminor [8]byte
  // }

  if (raw.length < sizeRecord) {
    return false;
  }
  raw = raw.subarray(0, sizeRecord);

  // First 100 bytes of the header represent the file name.
  // Check if file looks like Gentoo GLEP binary package.
  if (contains(raw.subarray(0, 100), gpkg)) {
    return false;
  }

  // Get the checksum recorded into the file.
  const recsum = tarParseOctal(raw.subarray(148, 156));
  if (recsum === -1) {
    return false;
  }
  const [sum1, sum2] = tarChksum(raw);
  return recsum === sum1 || recsum === sum2;
}

// tarParseOctal converts octal string to decimal int.
//
// Go accumulates in an int64; the field is at most 8 octal digits, so the
// value fits a number exactly.
export function tarParseOctal(b: Uint8Array): number {
  // Because unused fields are filled with NULs, we need to skip leading NULs.
  // Fields may also be padded with spaces or NULs.
  // So we remove leading and trailing NULs and spaces to be sure.
  b = trim(b, " \x00");

  if (b.length === 0) {
    return -1;
  }
  let ret = 0;
  for (const c of b) {
    if (c === 0) {
      break;
    }
    if (c < 0x30 || c > 0x37) {
      return -1;
    }
    ret = ret * 8 + (c - 0x30);
  }
  return ret;
}

// tarChksum computes the checksum for the header block b.
// The actual checksum is written to same b block after it has been calculated.
// Before calculation the bytes from b reserved for checksum have placeholder
// value of ASCII space 0x20.
// POSIX specifies a sum of the unsigned byte values, but the Sun tar used
// signed byte values. We compute and return both.
function tarChksum(b: Uint8Array): [unsigned: number, signed: number] {
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < b.length; i++) {
    let c = b[i] as number;
    if (148 <= i && i < 156) {
      c = 0x20; // Treat the checksum field itself as all spaces.
    }
    unsigned += c;
    signed += (c << 24) >> 24;
  }
  return [unsigned, signed];
}

// Zlib matches zlib compressed files.
export function Zlib(raw: Uint8Array, _limit: number): boolean {
  // https://www.ietf.org/rfc/rfc6713.txt
  // This check has one fault: ASCII code can satisfy it; for ex: []byte("x ")
  const zlib = raw.length > 1 && raw[0] === 0x78 && beUint16(raw, 0) % 31 === 0;
  // Check that the file is not a regular text to avoid false positives.
  return zlib && !Text(raw, 0);
}
