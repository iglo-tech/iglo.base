// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/font.go.

import { beUint32, contains, equal, hasPrefix, lit } from "@/tools/mimetype/go-bytes";

const woffSig = lit("wOFF");
// Woff matches a Web Open Font Format file.
export function Woff(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, woffSig);
}

const woff2Sig = lit("wOF2");
// Woff2 matches a Web Open Font Format version 2 file.
export function Woff2(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, woff2Sig);
}

const ottoSig = lit("OTTO\x00");
const cffTable = lit("CFF ");
// Otf matches an OpenType font file.
export function Otf(raw: Uint8Array, _limit: number): boolean {
  // After OTTO an little endian int16 specifies the number of tables.
  // Since the number of tables cannot exceed 256, the first byte of the
  // int16 is always 0. PUID: fmt/520
  return raw.length > 48 && hasPrefix(raw, ottoSig) && contains(raw.subarray(12, 48), cffTable);
}

const ttfSig = Uint8Array.of(0x00, 0x01, 0x00, 0x00);
// Ttf matches a TrueType font file.
export function Ttf(raw: Uint8Array, _limit: number): boolean {
  if (!hasPrefix(raw, ttfSig)) {
    return false;
  }
  // We cannot rely on the first 4 bytes because of false-positives.
  // We have to digg deeper into the SFNT tables.
  return hasSFNTTable(raw);
}

// libmagic says there are 47 table names in specification, but it seems
// they reached 49 in the meantime.
// https://github.com/file/file/blob/5184ca2471c0e801c156ee120a90e669fe27b31d/magic/Magdir/fonts#L279
// At the same time, the TrueType docs seem misleading:
// 1. https://developer.apple.com/fonts/TrueType-Reference-Manual/index.html
// 2. https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6.html
// Page 1. has 48 tables. Page 2. has 49 tables. The diff is the gcid table.
// Take a permissive approach.
const possibleTables = [
  0x61636e74, // "acnt"
  0x616e6b72, // "ankr"
  0x61766172, // "avar"
  0x62646174, // "bdat"
  0x62686564, // "bhed"
  0x626c6f63, // "bloc"
  0x62736c6e, // "bsln"
  0x636d6170, // "cmap"
  0x63766172, // "cvar"
  0x63767420, // "cvt "
  0x45425343, // "EBSC"
  0x66647363, // "fdsc"
  0x66656174, // "feat"
  0x666d7478, // "fmtx"
  0x666f6e64, // "fond"
  0x6670676d, // "fpgm"
  0x66766172, // "fvar"
  0x67617370, // "gasp"
  0x67636964, // "gcid"
  0x676c7966, // "glyf"
  0x67766172, // "gvar"
  0x68646d78, // "hdmx"
  0x68656164, // "head"
  0x68686561, // "hhea"
  0x686d7478, // "hmtx"
  0x6876676c, // "hvgl"
  0x6876706d, // "hvpm"
  0x6a757374, // "just"
  0x6b65726e, // "kern"
  0x6b657278, // "kerx"
  0x6c636172, // "lcar"
  0x6c6f6361, // "loca"
  0x6c746167, // "ltag"
  0x6d617870, // "maxp"
  0x6d657461, // "meta"
  0x6d6f7274, // "mort"
  0x6d6f7278, // "morx"
  0x6e616d65, // "name"
  0x6f706264, // "opbd"
  0x4f532f32, // "OS/2"
  // The above tables come from the original Apple TTF specification,
  // but the later Microsoft specification has additional tables.
  // Common tables: https://learn.microsoft.com/en-us/typography/opentype/spec/otvarcommonformats
  // Layout tables: https://learn.microsoft.com/en-us/typography/opentype/spec/chapter2
  // Even if the Microsoft specification says OpenType, the tables are
  // valid for TrueType as well.
  0x47535542, // "GSUB"
  0x47504f53, // "GPOS"
  0x42415345, // "BASE"
  0x4a535446, // "JSTF"
  0x47444546, // "GDEF"
  0x4d415448, // "MATH"
  0x43424454, // "CBDT"
  0x43424c43, // "CBLC"
  0x43464620, // "CFF "
  0x43464632, // "CFF2"
  0x434f4c52, // "COLR"
  0x4350414c, // "CPAL"
  0x44534947, // "DSIG"
  0x45424454, // "EBDT"
  0x45424c43, // "EBLC"
  0x48564152, // "HVAR"
  0x4c545348, // "LTSH"
  0x4d455247, // "MERG"
  0x4d564152, // "MVAR"
  0x50434c54, // "PCLT"
  0x706f7374, // "post"
  0x70726570, // "prep"
  0x73626978, // "sbix"
  0x53544154, // "STAT"
  0x53564720, // "SVG "
  0x56444d58, // "VDMX"
  0x76686561, // "vhea"
  0x766d7478, // "vmtx"
  0x564f5247, // "VORG"
  0x56564152, // "VVAR"
];

function hasSFNTTable(raw: Uint8Array): boolean {
  if (raw.length < 16) {
    return false;
  }

  const ourTable = beUint32(raw, 12);
  return possibleTables.includes(ourTable);
}

const eotLP = Uint8Array.of(0x4c, 0x50);
const eotVersions = [
  Uint8Array.of(0x02, 0x00, 0x01),
  Uint8Array.of(0x01, 0x00, 0x00),
  Uint8Array.of(0x02, 0x00, 0x02),
];
// Eot matches an Embedded OpenType font file.
export function Eot(raw: Uint8Array, _limit: number): boolean {
  return (
    raw.length > 35 &&
    equal(raw.subarray(34, 36), eotLP) &&
    eotVersions.some((v) => equal(raw.subarray(8, 11), v))
  );
}

const ttcfSig = lit("ttcf");
const ttcV1 = Uint8Array.of(0x00, 0x01, 0x00, 0x00);
const ttcV2 = Uint8Array.of(0x00, 0x02, 0x00, 0x00);
// Ttc matches a TrueType Collection font file.
export function Ttc(raw: Uint8Array, _limit: number): boolean {
  return (
    raw.length > 7 &&
    hasPrefix(raw, ttcfSig) &&
    (equal(raw.subarray(4, 8), ttcV1) || equal(raw.subarray(4, 8), ttcV2))
  );
}
