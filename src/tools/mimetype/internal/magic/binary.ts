// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/binary.go.

import {
  beUint32,
  contains,
  equal,
  hasPrefix,
  leUint16,
  leUint32,
  lit,
} from "@/tools/mimetype/go-bytes";

const lnkSig = Uint8Array.of(0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00);
// Lnk matches Microsoft lnk binary format.
export function Lnk(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, lnkSig);
}

const wasmSig = Uint8Array.of(0x00, 0x61, 0x73, 0x6d);
// Wasm matches a web assembly File Format file.
export function Wasm(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, wasmSig);
}

// Exe matches a Windows/DOS executable file.
export function Exe(raw: Uint8Array, _limit: number): boolean {
  return raw.length > 1 && raw[0] === 0x4d && raw[1] === 0x5a;
}

const elfSig = Uint8Array.of(0x7f, 0x45, 0x4c, 0x46);
// Elf matches an Executable and Linkable Format file.
export function Elf(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, elfSig);
}

const nesSig = Uint8Array.of(0x4e, 0x45, 0x53, 0x1a);
// Nes matches a Nintendo Entertainment system ROM file.
export function Nes(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, nesSig);
}

const cws = lit("CWS");
const fws = lit("FWS");
const zws = lit("ZWS");
// SWF matches an Adobe Flash swf file.
export function SWF(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, cws) || hasPrefix(raw, fws) || hasPrefix(raw, zws);
}

const torrentSig = lit("d8:announce");
// Torrent has bencoded text in the beginning.
export function Torrent(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, torrentSig);
}

const par1Sig = Uint8Array.of(0x50, 0x41, 0x52, 0x31);
// PAR1 matches a parquet file.
export function Par1(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, par1Sig);
}

const cborSig = Uint8Array.of(0xd9, 0xd9, 0xf7);
// CBOR matches a Concise Binary Object Representation https://cbor.io/
export function CBOR(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, cborSig);
}

// debug/macho's MagicFat, Magic32 and Magic64.
const machoMagicFat = 0xcafebabe;
const machoMagic32 = 0xfeedface;
const machoMagic64 = 0xfeedfacf;

// Java bytecode and Mach-O binaries share the same magic number.
// More info here https://github.com/threatstack/libmagic/blob/master/magic/Magdir/cafebabe
function classOrMachOFat(input: Uint8Array): boolean {
  // There should be at least 8 bytes for both of them because the only way to
  // quickly distinguish them is by comparing byte at position 7
  if (input.length < 8) {
    return false;
  }

  return beUint32(input, 0) === machoMagicFat;
}

// Class matches a java class file.
export function Class(raw: Uint8Array, _limit: number): boolean {
  return classOrMachOFat(raw) && (raw[7] as number) > 30;
}

// MachO matches Mach-O binaries format.
export function MachO(raw: Uint8Array, _limit: number): boolean {
  if (classOrMachOFat(raw) && (raw[7] as number) < 0x14) {
    return true;
  }

  if (raw.length < 4) {
    return false;
  }

  const be = beUint32(raw, 0);
  const le = leUint32(raw, 0);

  return be === machoMagic32 || le === machoMagic32 || be === machoMagic64 || le === machoMagic64;
}

// dbf type is dictated by the first byte.
// prettier-ignore
const dbfTypes = [
  0x02, 0x03, 0x04, 0x05, 0x30, 0x31, 0x32, 0x42, 0x62, 0x7B, 0x82,
  0x83, 0x87, 0x8A, 0x8B, 0x8E, 0xB3, 0xCB, 0xE5, 0xF5, 0xF4, 0xFB,
];
// Dbf matches a dBase file.
// https://www.dbase.com/Knowledgebase/INT/db7_file_fmt.htm
export function Dbf(raw: Uint8Array, _limit: number): boolean {
  if (raw.length < 68) {
    return false;
  }

  // 3rd and 4th bytes contain the last update month and day of month.
  const month = raw[2] as number;
  const day = raw[3] as number;
  if (month === 0 || month > 12 || day === 0 || day > 31) {
    return false;
  }

  // 12, 13, 30, 31 are reserved bytes and always filled with 0x00.
  if (raw[12] !== 0x00 || raw[13] !== 0x00 || raw[30] !== 0x00 || raw[31] !== 0x00) {
    return false;
  }
  // Production MDX flag;
  // 0x01 if a production .MDX file exists for this table;
  // 0x00 if no .MDX file exists.
  if ((raw[28] as number) > 0x01) {
    return false;
  }

  return dbfTypes.includes(raw[0] as number);
}

// ElfObj matches an object file.
export function ElfObj(raw: Uint8Array, _limit: number): boolean {
  return (
    raw.length > 17 &&
    ((raw[16] === 0x01 && raw[17] === 0x00) || (raw[16] === 0x00 && raw[17] === 0x01))
  );
}

// ElfExe matches an executable file.
export function ElfExe(raw: Uint8Array, _limit: number): boolean {
  return (
    raw.length > 17 &&
    ((raw[16] === 0x02 && raw[17] === 0x00) || (raw[16] === 0x00 && raw[17] === 0x02))
  );
}

// ElfLib matches a shared library file.
export function ElfLib(raw: Uint8Array, _limit: number): boolean {
  return (
    raw.length > 17 &&
    ((raw[16] === 0x03 && raw[17] === 0x00) || (raw[16] === 0x00 && raw[17] === 0x03))
  );
}

// ElfDump matches a core dump file.
export function ElfDump(raw: Uint8Array, _limit: number): boolean {
  return (
    raw.length > 17 &&
    ((raw[16] === 0x04 && raw[17] === 0x00) || (raw[16] === 0x00 && raw[17] === 0x04))
  );
}

const dicm = Uint8Array.of(0x44, 0x49, 0x43, 0x4d);
// Dcm matches a DICOM medical format file.
export function Dcm(raw: Uint8Array, _limit: number): boolean {
  return raw.length > 131 && equal(raw.subarray(128, 132), dicm);
}

const marc4500 = lit("4500");
const marcTerminator = Uint8Array.of(0x1e);
// Marc matches a MARC21 (MAchine-Readable Cataloging) file.
export function Marc(raw: Uint8Array, _limit: number): boolean {
  // File is at least 24 bytes ("leader" field size).
  if (raw.length < 24) {
    return false;
  }

  // Fixed bytes at offset 20.
  if (!equal(raw.subarray(20, 24), marc4500)) {
    return false;
  }

  // First 5 bytes are ASCII digits.
  for (let i = 0; i < 5; i++) {
    const c = raw[i] as number;
    if (c < 0x30 || c > 0x39) {
      return false;
    }
  }

  // Field terminator is present in first 2048 bytes.
  return contains(raw.subarray(0, Math.min(2048, raw.length)), marcTerminator);
}

const glb2 = lit("\x67\x6C\x54\x46\x02\x00\x00\x00");
const glb1 = lit("\x67\x6C\x54\x46\x01\x00\x00\x00");
// GLB matches a glTF model format file.
// GLB is the binary file format representation of 3D models saved in
// the GL transmission Format (glTF).
// GLB uses little endian and its header structure is as follows:
//
//	<-- 12-byte header                             -->
//	| magic            | version          | length   |
//	| (uint32)         | (uint32)         | (uint32) |
//	| \x67\x6C\x54\x46 | \x01\x00\x00\x00 | ...      |
//	| g   l   T   F    | 1                | ...      |
//
// Visit [glTF specification] and [IANA glTF entry] for more details.
//
// [glTF specification]: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
// [IANA glTF entry]: https://www.iana.org/assignments/media-types/model/gltf-binary
export function GLB(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, glb2) || hasPrefix(raw, glb1);
}

const tzifSig = lit("TZif");
// TzIf matches a Time Zone Information Format (TZif) file.
// See more: https://tools.ietf.org/id/draft-murchison-tzdist-tzif-00.html#rfc.section.3
// Its header structure is shown below:
//
//	+---------------+---+
//	|  magic    (4) | <-+-- version (1)
//	+---------------+---+---------------------------------------+
//	|           [unused - reserved for future use] (15)         |
//	+---------------+---------------+---------------+-----------+
//	|  isutccnt (4) |  isstdcnt (4) |  leapcnt  (4) |
//	+---------------+---------------+---------------+
//	|  timecnt  (4) |  typecnt  (4) |  charcnt  (4) |
export function TzIf(raw: Uint8Array, _limit: number): boolean {
  // File is at least 44 bytes (header size).
  if (raw.length < 44) {
    return false;
  }

  if (!hasPrefix(raw, tzifSig)) {
    return false;
  }

  // Field "typecnt" MUST not be zero.
  if (beUint32(raw, 36) === 0) {
    return false;
  }

  // Version has to be NUL (0x00), '2' (0x32) or '3' (0x33).
  return raw[4] === 0x00 || raw[4] === 0x32 || raw[4] === 0x33;
}

// python 1.0 through 3.7 signatures, magic/Magdir/python:13:190
// prettier-ignore
const pycMagic = [
  0x02099900, 0x03099900, 0x892e0d0a, 0x04170d0a, 0x994e0d0a, 0xfcc40d0a,
  0xfdc40d0a, 0x87c60d0a, 0x88c60d0a, 0x2aeb0d0a, 0x2beb0d0a, 0x2ded0d0a,
  0x2eed0d0a, 0x3bf20d0a, 0x3cf20d0a, 0x45f20d0a, 0x59f20d0a, 0x63f20d0a,
  0x6df20d0a, 0x6ef20d0a, 0x77f20d0a, 0x81f20d0a, 0x8bf20d0a, 0x8cf20d0a,
  0x95f20d0a, 0x9ff20d0a, 0xa9f20d0a, 0xb3f20d0a, 0xb4f20d0a, 0xc7f20d0a,
  0xd1f20d0a, 0xd2f20d0a, 0xdbf20d0a, 0xe5f20d0a, 0xeff20d0a, 0xf9f20d0a,
  0x03f30d0a, 0x04f30d0a, 0x0af30d0a, 0xb80b0d0a, 0xc20b0d0a, 0xcc0b0d0a,
  0xd60b0d0a, 0xe00b0d0a, 0xea0b0d0a, 0xf40b0d0a, 0xf50b0d0a, 0xff0b0d0a,
  0x090c0d0a, 0x130c0d0a, 0x1d0c0d0a, 0x1f0c0d0a, 0x270c0d0a, 0x3b0c0d0a,
  0x450c0d0a, 0x4f0c0d0a, 0x580c0d0a, 0x620c0d0a, 0x6c0c0d0a, 0x760c0d0a,
  0x800c0d0a, 0x8a0c0d0a, 0x940c0d0a, 0x9e0c0d0a, 0xb20c0d0a, 0xbc0c0d0a,
  0xc60c0d0a, 0xd00c0d0a, 0xda0c0d0a, 0xe40c0d0a, 0xee0c0d0a, 0xf80c0d0a,
  0x020d0d0a, 0x0c0d0d0a, 0x160d0d0a, 0x170d0d0a, 0x200d0d0a, 0x210d0d0a,
  0x2a0d0d0a, 0x2b0d0d0a, 0x2c0d0d0a, 0x2d0d0d0a, 0x2f0d0d0a, 0x300d0d0a,
  0x310d0d0a, 0x320d0d0a, 0x330d0d0a, 0x3e0d0d0a, 0x3f0d0d0a,
];

// Pyc matches a Python compiled file.
// The signatures are sourced from libmagic v5.47
export function Pyc(raw: Uint8Array, _limit: number): boolean {
  if (raw.length < 8) {
    return false;
  }

  const n = beUint32(raw, 0);

  if (pycMagic.includes(n)) {
    return true;
  }

  if (raw[2] === 0x0d && raw[3] === 0x0a) {
    // Only two bits of flag field are currently used.
    if (leUint32(raw, 4) > 3) {
      return false;
    }
    if (raw[1] === 0x0d || raw[1] === 0x0e) {
      return true;
    }
    // PyPy magic numbers, magic/Magdir/python:233
    const pypy = leUint16(raw, 0);
    return pypy === 240 || pypy === 256 || pypy === 336 || pypy === 384 || pypy === 416;
  }

  return false;
}

// Pcap identifies "libpcap" capture files.
// https://www.tcpdump.org/manpages/pcap-savefile.5.html
export function Pcap(raw: Uint8Array, _limit: number): boolean {
  if (raw.length < 4) {
    return false;
  }
  const be = beUint32(raw, 0);
  const le = leUint32(raw, 0);
  return be === 0xa1b2c3d4 || be === 0xa1b23c4d || le === 0xa1b2c3d4 || le === 0xa1b23c4d;
}
