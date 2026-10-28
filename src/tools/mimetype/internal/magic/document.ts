// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/document.go.

import { beUint32, contains, hasPrefix, lit } from "@/tools/mimetype/go-bytes";
import { offset } from "@/tools/mimetype/internal/magic/magic";
import { Bytes, IgnoreCase } from "@/tools/mimetype/internal/scan/bytes";

const pdfSig = lit("%PDF-");
const pdfNLSig = lit("\x0A%PDF-");
const pdfBOMSig = lit("\xef\xbb\xbf%PDF-");
// Pdf matches a Portable Document Format file.
// https://github.com/file/file/blob/11010cc805546a3e35597e67e1129a481aed40e8/magic/Magdir/pdf
export function Pdf(raw: Uint8Array, _limit: number): boolean {
  // usual pdf signature
  return (
    hasPrefix(raw, pdfSig) ||
    // new-line prefixed signature
    hasPrefix(raw, pdfNLSig) ||
    // UTF-8 BOM prefixed signature
    hasPrefix(raw, pdfBOMSig)
  );
}

const fdfSig = lit("%FDF");
// Fdf matches a Forms Data Format file.
export function Fdf(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, fdfSig);
}

const mobiSig = lit("BOOKMOBI");
// Mobi matches a Mobi file.
export function Mobi(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, mobiSig, 60);
}

const litSig = lit("ITOLITLS");
// Lit matches a Microsoft Lit file.
export function Lit(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, litSig);
}

// PDF matches a Portable Document Format file.
// The %PDF- header should be the first thing inside the file but many
// implementations don't follow the rule. The PDF spec at Appendix H says the
// signature can be prepended by anything.
// https://bugs.astron.com/view.php?id=446
export function PDF(raw: Uint8Array, _limit: number): boolean {
  raw = raw.subarray(0, Math.min(raw.length, 1024));
  return contains(raw, pdfSig);
}

const djvuForm = Uint8Array.of(0x41, 0x54, 0x26, 0x54, 0x46, 0x4f, 0x52, 0x4d);
const djvuKinds = [lit("DJVM"), lit("DJVU"), lit("DJVI"), lit("THUM")];
// DjVu matches a DjVu file.
export function DjVu(raw: Uint8Array, _limit: number): boolean {
  if (raw.length < 12) {
    return false;
  }
  if (!hasPrefix(raw, djvuForm)) {
    return false;
  }
  const rest = raw.subarray(12);
  return djvuKinds.some((k) => hasPrefix(rest, k));
}

const pkcs7PEM = lit("-----BEGIN PKCS7");
// Magic Bytes for the signedData ASN.1 encoding.
const startHeader = [
  Uint8Array.of(0x30, 0x80),
  Uint8Array.of(0x30, 0x81),
  Uint8Array.of(0x30, 0x82),
  Uint8Array.of(0x30, 0x83),
  Uint8Array.of(0x30, 0x84),
];
const signedDataMatch = Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07);
// P7s matches an .p7s signature File (PEM, Base64).
export function P7s(raw: Uint8Array, _limit: number): boolean {
  // Check for PEM Encoding.
  if (hasPrefix(raw, pkcs7PEM)) {
    return true;
  }
  // Check if DER Encoding is long enough.
  if (raw.length < 20) {
    return false;
  }
  // Check if Header is correct. There are multiple valid headers.
  for (let i = 0; i < startHeader.length; i++) {
    // If first bytes match, then check for ASN.1 Object Type.
    if (hasPrefix(raw, startHeader[i] as Uint8Array)) {
      if (hasPrefix(raw.subarray(i + 2), signedDataMatch)) {
        return true;
      }
    }
  }

  return false;
}

// Lotus123 matches a Lotus 1-2-3 spreadsheet document.
export function Lotus123(raw: Uint8Array, _limit: number): boolean {
  if (raw.length <= 20) {
    return false;
  }
  const version = beUint32(raw, 0);
  if (version === 0x00000200) {
    return raw[6] !== 0 && raw[7] === 0;
  }

  return version === 0x00001a00 && (raw[20] as number) > 0 && (raw[20] as number) < 32;
}

const chmSig = lit("ITSF\x03\x00\x00\x00\x60\x00\x00\x00");
// CHM matches a Microsoft Compiled HTML Help file.
export function CHM(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, chmSig);
}

const infSig = lit("HSP\x01\x9b\x00");
// Inf matches an OS/2 .inf file.
export function Inf(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, infSig);
}

const hlpSig = lit("HSP\x10\x9b\x00");
// Hlp matches an OS/2 .hlp file.
export function Hlp(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, hlpSig);
}

const makerFile = lit("<MakerFile");
const makerDictionary = lit("<MakerDictionary");
const bookFile = lit("<BOOKFILE");
// FrameMaker matches an Adobe FrameMaker file.
export function FrameMaker(raw: Uint8Array, _limit: number): boolean {
  const b = new Bytes(raw);
  if (
    !hasPrefix(b.b, makerFile) &&
    !hasPrefix(b.b, makerDictionary) &&
    b.match(bookFile, IgnoreCase) === -1
  ) {
    return false;
  }

  // To avoid plain text false positives.
  return b.b.subarray(0, Math.min(b.length, 512)).indexOf(0x00) !== -1;
}
