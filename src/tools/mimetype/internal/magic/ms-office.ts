// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/ms_office.go.

import { contains, hasPrefix, leUint32, lit } from "@/tools/mimetype/go-bytes";
import {
  CDFTypeDoc,
  CDFTypeGeneric,
  CDFTypeInstaller,
  CDFTypeMsg,
  CDFTypePpt,
  CDFTypeXls,
  detect as cdfDetect,
} from "@/tools/mimetype/internal/cdf/cdf";
import { msoxml, type zipEntries } from "@/tools/mimetype/internal/magic/zip";

const dirEntry = (name: string): zipEntries => [{ name: lit(name), dir: true }];

const xlsxEntries = dirEntry("xl/");
// Xlsx matches a Microsoft Excel 2007 file.
export function Xlsx(raw: Uint8Array, _limit: number): boolean {
  return msoxml(raw, xlsxEntries, 100);
}

const docxEntries = dirEntry("word/");
// Docx matches a Microsoft Word 2007 file.
export function Docx(raw: Uint8Array, _limit: number): boolean {
  return msoxml(raw, docxEntries, 100);
}

const pptxEntries = dirEntry("ppt/");
// Pptx matches a Microsoft PowerPoint 2007 file.
export function Pptx(raw: Uint8Array, _limit: number): boolean {
  return msoxml(raw, pptxEntries, 100);
}

const visioEntries = dirEntry("visio/");
// Visio matches a Microsoft Visio 2013+ file.
export function Visio(raw: Uint8Array, _limit: number): boolean {
  return msoxml(raw, visioEntries, 100);
}

const oleSig = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
// Ole matches an Open Linking and Embedding file.
//
// https://en.wikipedia.org/wiki/Object_Linking_and_Embedding
export function Ole(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, oleSig);
}

const docClsids = [
  // Microsoft Word 97-2003 Document (Word.Document.8)
  [0x06, 0x09, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
  // Microsoft Word 6.0-7.0 Document (Word.Document.6)
  [0x00, 0x09, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
  // Microsoft Word Picture (Word.Picture.8)
  [0x07, 0x09, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
].map((c) => Uint8Array.from(c));

// Doc matches a Microsoft Word 97-2003 file.
// See: https://github.com/decalage2/oletools/blob/412ee36ae45e70f42123e835871bac956d958461/oletools/common/clsid.py
export function Doc(raw: Uint8Array, _limit: number): boolean {
  const fromParsing = cdfDetect(raw);
  if (fromParsing === CDFTypeDoc) {
    return true;
  }
  if (fromParsing !== CDFTypeGeneric) {
    return false;
  }
  // Fallback for inputs where the CDF directory is past the read limit: match
  // the root storage CLSID, which often lies within the first sectors.
  for (const clsid of docClsids) {
    if (matchOleClsid(raw, clsid)) {
      return true;
    }
  }
  return false;
}

const pptClsid1 = Uint8Array.of(
  0x10,
  0x8d,
  0x81,
  0x64,
  0x9b,
  0x4f,
  0xcf,
  0x11,
  0x86,
  0xea,
  0x00,
  0xaa,
  0x00,
  0xb9,
  0x29,
  0xe8,
);
const pptClsid2 = Uint8Array.of(
  0x70,
  0xae,
  0x7b,
  0xea,
  0x3b,
  0xfb,
  0xcd,
  0x11,
  0xa9,
  0x03,
  0x00,
  0xaa,
  0x00,
  0x51,
  0x0e,
  0xa3,
);
const pptSubHeaders = [
  Uint8Array.of(0xa0, 0x46, 0x1d, 0xf0),
  Uint8Array.of(0x00, 0x6e, 0x1e, 0xf0),
  Uint8Array.of(0x0f, 0x00, 0xe8, 0x03),
];
const pptName = lit(
  "P\x00o\x00w\x00e\x00r\x00P\x00o\x00i\x00n\x00t\x00 D\x00o\x00c\x00u\x00m\x00e\x00n\x00t",
);

// Ppt matches a Microsoft PowerPoint 97-2003 file or a PowerPoint 95 presentation.
export function Ppt(raw: Uint8Array, _limit: number): boolean {
  const fromParsing = cdfDetect(raw);
  if (fromParsing === CDFTypePpt) {
    return true;
  }
  if (fromParsing !== CDFTypeGeneric) {
    return false;
  }
  // Fallback for inputs where the CDF directory is past the read limit.
  // Root CLSID test is the safest way to identify the OLE, however, the format
  // often places the root CLSID at the end of the file.
  if (matchOleClsid(raw, pptClsid1) || matchOleClsid(raw, pptClsid2)) {
    return true;
  }

  const lin = raw.length;
  if (lin < 520) {
    return false;
  }
  for (const h of pptSubHeaders) {
    if (hasPrefix(raw.subarray(512), h)) {
      return true;
    }
  }

  return lin > 1152 && contains(raw.subarray(1152, Math.min(4096, lin)), pptName);
}

const xlsClsid1 = Uint8Array.of(0x10, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00);
const xlsClsid2 = Uint8Array.of(0x20, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00);
const xlsSubHeaders = [
  Uint8Array.of(0x09, 0x08, 0x10, 0x00, 0x00, 0x06, 0x05, 0x00),
  Uint8Array.of(0xfd, 0xff, 0xff, 0xff, 0x10),
  Uint8Array.of(0xfd, 0xff, 0xff, 0xff, 0x1f),
  Uint8Array.of(0xfd, 0xff, 0xff, 0xff, 0x22),
  Uint8Array.of(0xfd, 0xff, 0xff, 0xff, 0x23),
  Uint8Array.of(0xfd, 0xff, 0xff, 0xff, 0x28),
  Uint8Array.of(0xfd, 0xff, 0xff, 0xff, 0x29),
];
const xlsName = lit("W\x00k\x00s\x00S\x00S\x00W\x00o\x00r\x00k\x00B\x00o\x00o\x00k");

// Xls matches a Microsoft Excel 97-2003 file.
export function Xls(raw: Uint8Array, _limit: number): boolean {
  const fromParsing = cdfDetect(raw);
  if (fromParsing === CDFTypeXls) {
    return true;
  }
  if (fromParsing !== CDFTypeGeneric) {
    return false;
  }
  // Fallback for inputs where the CDF directory is past the read limit.
  // Root CLSID test is the safest way to identify the OLE, however, the format
  // often places the root CLSID at the end of the file.
  if (matchOleClsid(raw, xlsClsid1) || matchOleClsid(raw, xlsClsid2)) {
    return true;
  }

  const lin = raw.length;
  if (lin < 520) {
    return false;
  }
  for (const h of xlsSubHeaders) {
    if (hasPrefix(raw.subarray(512), h)) {
      return true;
    }
  }

  return lin > 1152 && contains(raw.subarray(1152, Math.min(4096, lin)), xlsName);
}

const pubClsid = Uint8Array.of(
  0x01,
  0x12,
  0x02,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0xc0,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x46,
);
// Pub matches a Microsoft Publisher file.
export function Pub(raw: Uint8Array, _limit: number): boolean {
  return matchOleClsid(raw, pubClsid);
}

const msgClsid = Uint8Array.of(
  0x0b,
  0x0d,
  0x02,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0xc0,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x46,
);
// Msg matches a Microsoft Outlook email file.
export function Msg(raw: Uint8Array, _limit: number): boolean {
  const fromParsing = cdfDetect(raw);
  if (fromParsing === CDFTypeMsg) {
    return true;
  }
  if (fromParsing !== CDFTypeGeneric) {
    return false;
  }
  // Fallback for inputs where the CDF directory does not carry the streams the
  // parser keys on: match the root storage CLSID instead.
  return matchOleClsid(raw, msgClsid);
}

// Msi matches a Microsoft Windows Installer file.
// http://fileformats.archiveteam.org/wiki/Microsoft_Compound_File
export function Msi(raw: Uint8Array, _limit: number): boolean {
  return cdfDetect(raw) === CDFTypeInstaller;
}

const oneSig = Uint8Array.of(
  0xe4,
  0x52,
  0x5c,
  0x7b,
  0x8c,
  0xd8,
  0xa7,
  0x4d,
  0xae,
  0xb1,
  0x53,
  0x78,
  0xd0,
  0x29,
  0x96,
  0xd3,
);
// One matches a Microsoft OneNote file.
export function One(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, oneSig);
}

// Helper to match by a specific CLSID of a compound file.
//
// http://fileformats.archiveteam.org/wiki/Microsoft_Compound_File
function matchOleClsid(input: Uint8Array, clsid: Uint8Array): boolean {
  // Microsoft Compound files v3 have a sector length of 512, while v4 has 4096.
  // Change sector offset depending on file version.
  // https://www.loc.gov/preservation/digital/formats/fdd/fdd000392.shtml
  let sectorLength = 512;
  if (input.length < sectorLength) {
    return false;
  }
  if (input[26] === 0x04 && input[27] === 0x00) {
    sectorLength = 4096;
  }

  // SecID of first sector of the directory stream. (Go's int is 64 bits, so
  // the offset below cannot overflow there, and is exact here.)
  const firstSecID = leUint32(input, 48);

  // Expected offset of CLSID for root storage object.
  const clsidOffset = sectorLength * (1 + firstSecID) + 80;

  // #731 offset is outside in or wrapped around due to integer overflow.
  if (input.length <= clsidOffset + 16 || clsidOffset < 0) {
    return false;
  }

  return hasPrefix(input.subarray(clsidOffset), clsid);
}

const wpcSig = lit("\xffWPC");
// WPD matches a WordPerfect document.
export function WPD(raw: Uint8Array, _limit: number): boolean {
  if (raw.length < 10) {
    return false;
  }
  if (!hasPrefix(raw, wpcSig)) {
    return false;
  }
  return raw[8] === 1 && raw[9] === 10;
}
