// Upstream: gabriel-vasile/mimetype v1.4.16 internal/magic/font.go.

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
const possibleTables = new Set([
  0x61_63_6e_74, // "acnt"
  0x61_6e_6b_72, // "ankr"
  0x61_76_61_72, // "avar"
  0x62_64_61_74, // "bdat"
  0x62_68_65_64, // "bhed"
  0x62_6c_6f_63, // "bloc"
  0x62_73_6c_6e, // "bsln"
  0x63_6d_61_70, // "cmap"
  0x63_76_61_72, // "cvar"
  0x63_76_74_20, // "cvt "
  0x45_42_53_43, // "EBSC"
  0x66_64_73_63, // "fdsc"
  0x66_65_61_74, // "feat"
  0x66_6d_74_78, // "fmtx"
  0x66_6f_6e_64, // "fond"
  0x66_70_67_6d, // "fpgm"
  0x66_76_61_72, // "fvar"
  0x67_61_73_70, // "gasp"
  0x67_63_69_64, // "gcid"
  0x67_6c_79_66, // "glyf"
  0x67_76_61_72, // "gvar"
  0x68_64_6d_78, // "hdmx"
  0x68_65_61_64, // "head"
  0x68_68_65_61, // "hhea"
  0x68_6d_74_78, // "hmtx"
  0x68_76_67_6c, // "hvgl"
  0x68_76_70_6d, // "hvpm"
  0x6a_75_73_74, // "just"
  0x6b_65_72_6e, // "kern"
  0x6b_65_72_78, // "kerx"
  0x6c_63_61_72, // "lcar"
  0x6c_6f_63_61, // "loca"
  0x6c_74_61_67, // "ltag"
  0x6d_61_78_70, // "maxp"
  0x6d_65_74_61, // "meta"
  0x6d_6f_72_74, // "mort"
  0x6d_6f_72_78, // "morx"
  0x6e_61_6d_65, // "name"
  0x6f_70_62_64, // "opbd"
  0x4f_53_2f_32, // "OS/2"
  // The above tables come from the original Apple TTF specification,
  // but the later Microsoft specification has additional tables.
  // Common tables: https://learn.microsoft.com/en-us/typography/opentype/spec/otvarcommonformats
  // Layout tables: https://learn.microsoft.com/en-us/typography/opentype/spec/chapter2
  // Even if the Microsoft specification says OpenType, the tables are
  // valid for TrueType as well.
  0x47_53_55_42, // "GSUB"
  0x47_50_4f_53, // "GPOS"
  0x42_41_53_45, // "BASE"
  0x4a_53_54_46, // "JSTF"
  0x47_44_45_46, // "GDEF"
  0x4d_41_54_48, // "MATH"
  0x43_42_44_54, // "CBDT"
  0x43_42_4c_43, // "CBLC"
  0x43_46_46_20, // "CFF "
  0x43_46_46_32, // "CFF2"
  0x43_4f_4c_52, // "COLR"
  0x43_50_41_4c, // "CPAL"
  0x44_53_49_47, // "DSIG"
  0x45_42_44_54, // "EBDT"
  0x45_42_4c_43, // "EBLC"
  0x48_56_41_52, // "HVAR"
  0x4c_54_53_48, // "LTSH"
  0x4d_45_52_47, // "MERG"
  0x4d_56_41_52, // "MVAR"
  0x50_43_4c_54, // "PCLT"
  0x70_6f_73_74, // "post"
  0x70_72_65_70, // "prep"
  0x73_62_69_78, // "sbix"
  0x53_54_41_54, // "STAT"
  0x53_56_47_20, // "SVG "
  0x56_44_4d_58, // "VDMX"
  0x76_68_65_61, // "vhea"
  0x76_6d_74_78, // "vmtx"
  0x56_4f_52_47, // "VORG"
  0x56_56_41_52, // "VVAR"
]);

function hasSFNTTable(raw: Uint8Array): boolean {
  if (raw.length < 16) {
    return false;
  }

  const ourTable = beUint32(raw, 12);
  return possibleTables.has(ourTable);
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
