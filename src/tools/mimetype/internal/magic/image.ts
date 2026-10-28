// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/image.go.

import { equal, hasPrefix, leUint32, lit } from "@/tools/mimetype/go-bytes";
import { offset } from "@/tools/mimetype/internal/magic/magic";
import { Bytes } from "@/tools/mimetype/internal/scan/bytes";

const pngSig = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
// Png matches a Portable Network Graphics file.
// https://www.w3.org/TR/PNG/
export function Png(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, pngSig);
}

const acTL = lit("acTL");
const IDAT = lit("IDAT");
// Apng matches an Animated Portable Network Graphics file.
// https://wiki.mozilla.org/APNG_Specification
export function Apng(raw: Uint8Array, _limit: number): boolean {
  const b = new Bytes(raw);
  b.advance(8); // the first 8 bytes matched by regular png

  // PNG chunks are composed of:
  // 4 bytes: length in big endian
  // 4 bytes: chunk type
  // length bytes: chunk data
  // 4 bytes: CRC
  //
  // Limit to 32, so we don't waste time on huge inputs.
  // acTL chunk must come before any IDAT chunks.
  // https://www.w3.org/TR/png-3/#structure
  for (let i = 0; i < 32 && b.length > 0; i++) {
    const [sz] = b.uint32be();
    if (hasPrefix(b.b, acTL)) {
      return true;
    }
    if (hasPrefix(b.b, IDAT)) {
      return false;
    }
    // sz + 8 is uint32 arithmetic in Go: it wraps for sz >= 2^32-8.
    if (!b.advance((sz + 8) >>> 0)) {
      return false;
    }
  }
  return false;
}

const jpgSig = Uint8Array.of(0xff, 0xd8, 0xff);
// Jpg matches a Joint Photographic Experts Group file.
export function Jpg(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, jpgSig);
}

const jp2Sig = Uint8Array.of(0x6a, 0x70, 0x32, 0x20);
// Jp2 matches a JPEG 2000 Image file (ISO 15444-1).
export function Jp2(raw: Uint8Array, _limit: number): boolean {
  return jpeg2k(raw, jp2Sig);
}

const jpxSig = Uint8Array.of(0x6a, 0x70, 0x78, 0x20);
// Jpx matches a JPEG 2000 Image file (ISO 15444-2).
export function Jpx(raw: Uint8Array, _limit: number): boolean {
  return jpeg2k(raw, jpxSig);
}

const jpmSig = Uint8Array.of(0x6a, 0x70, 0x6d, 0x20);
// Jpm matches a JPEG 2000 Image file (ISO 15444-6).
export function Jpm(raw: Uint8Array, _limit: number): boolean {
  return jpeg2k(raw, jpmSig);
}

const gif87a = lit("GIF87a");
const gif89a = lit("GIF89a");
// Gif matches a Graphics Interchange Format file.
export function Gif(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, gif87a) || hasPrefix(raw, gif89a);
}

// sourced from libmagic Magdir/images
const possibleFormats = [
  48, // PC bitmap, OS/2 2.x format (DIB header size=48)
  24, // PC bitmap, OS/2 2.x format (DIB header size=24)
  16, // PC bitmap, OS/2 2.x format (DIB header size=16)
  64, // PC bitmap, OS/2 2.x format
  52, // PC bitmap, Adobe Photoshop
  56, // PC bitmap, Adobe Photoshop with alpha channel mask
  40, // PC bitmap, Windows 3.x format
  124, // PC bitmap, Windows 98/2000 and newer format
  108, // PC bitmap, Windows 95/NT4 and newer format
];

// Bmp matches a bitmap image file.
export function Bmp(raw: Uint8Array, _limit: number): boolean {
  if (raw.length < 18) {
    return false;
  }
  if (raw[0] !== 0x42 || raw[1] !== 0x4d) {
    return false;
  }

  const bmpFormat = leUint32(raw, 14);
  return possibleFormats.includes(bmpFormat);
}

const psSig = lit("%!PS-Adobe-");
// Ps matches a PostScript file.
export function Ps(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, psSig);
}

const psdSig = lit("8BPS");
// Psd matches a Photoshop Document file.
export function Psd(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, psdSig);
}

const icoSig1 = Uint8Array.of(0x00, 0x00, 0x01, 0x00);
const icoSig2 = Uint8Array.of(0x00, 0x00, 0x02, 0x00);
// Ico matches an ICO file.
export function Ico(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, icoSig1) || hasPrefix(raw, icoSig2);
}

const icnsSig = lit("icns");
// Icns matches an ICNS (Apple Icon Image format) file.
export function Icns(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, icnsSig);
}

const tiffLE = Uint8Array.of(0x49, 0x49, 0x2a, 0x00);
const tiffBE = Uint8Array.of(0x4d, 0x4d, 0x00, 0x2a);
// Tiff matches a Tagged Image File Format file.
export function Tiff(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, tiffLE) || hasPrefix(raw, tiffBE);
}

const bpgSig = Uint8Array.of(0x42, 0x50, 0x47, 0xfb);
// Bpg matches a Better Portable Graphics file.
export function Bpg(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, bpgSig);
}

const xcfSig = lit("gimp xcf");
// Xcf matches GIMP image data.
export function Xcf(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, xcfSig);
}

const gpatSig = lit("GPAT");
// Pat matches GIMP pattern data.
export function Pat(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, gpatSig, 20);
}

const gimpSig = lit("GIMP");
// Gbr matches GIMP brush data.
export function Gbr(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, gimpSig, 20);
}

const hdrSig = lit("#?RADIANCE\n");
// Hdr matches Radiance HDR image.
// https://web.archive.org/web/20060913152809/http://local.wasp.uwa.edu.au/~pbourke/dataformats/pic/
export function Hdr(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, hdrSig);
}

const xpmSig = Uint8Array.of(0x2f, 0x2a, 0x20, 0x58, 0x50, 0x4d, 0x20, 0x2a, 0x2f);
// Xpm matches X PixMap image data.
export function Xpm(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, xpmSig);
}

const jxsSig = Uint8Array.of(
  0x00,
  0x00,
  0x00,
  0x0c,
  0x4a,
  0x58,
  0x53,
  0x20,
  0x0d,
  0x0a,
  0x87,
  0x0a,
);
// Jxs matches a JPEG XS coded image file (ISO/IEC 21122-3).
export function Jxs(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, jxsSig);
}

const jxrSig = Uint8Array.of(0x49, 0x49, 0xbc, 0x01);
// Jxr matches Microsoft HD JXR photo file.
export function Jxr(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, jxrSig);
}

const jP = Uint8Array.of(0x6a, 0x50, 0x20, 0x20);
const jP2 = Uint8Array.of(0x6a, 0x50, 0x32, 0x20);
function jpeg2k(raw: Uint8Array, sig: Uint8Array): boolean {
  if (raw.length < 24) {
    return false;
  }

  if (!equal(raw.subarray(4, 8), jP) && !equal(raw.subarray(4, 8), jP2)) {
    return false;
  }
  return equal(raw.subarray(20, 24), sig);
}

const riff = lit("RIFF");
const webpSig = Uint8Array.of(0x57, 0x45, 0x42, 0x50);
// Webp matches a WebP file.
export function Webp(raw: Uint8Array, _limit: number): boolean {
  return raw.length > 12 && equal(raw.subarray(0, 4), riff) && equal(raw.subarray(8, 12), webpSig);
}

const dwgVersions = [
  [0x31, 0x2e, 0x34, 0x30],
  [0x31, 0x2e, 0x35, 0x30],
  [0x32, 0x2e, 0x31, 0x30],
  [0x31, 0x30, 0x30, 0x32],
  [0x31, 0x30, 0x30, 0x33],
  [0x31, 0x30, 0x30, 0x34],
  [0x31, 0x30, 0x30, 0x36],
  [0x31, 0x30, 0x30, 0x39],
  [0x31, 0x30, 0x31, 0x32],
  [0x31, 0x30, 0x31, 0x34],
  [0x31, 0x30, 0x31, 0x35],
  [0x31, 0x30, 0x31, 0x38],
  [0x31, 0x30, 0x32, 0x31],
  [0x31, 0x30, 0x32, 0x34],
  [0x31, 0x30, 0x33, 0x32],
].map((v) => Uint8Array.from(v));

// Dwg matches a CAD drawing file.
export function Dwg(raw: Uint8Array, _limit: number): boolean {
  if (raw.length < 6 || raw[0] !== 0x41 || raw[1] !== 0x43) {
    return false;
  }

  for (const d of dwgVersions) {
    if (equal(raw.subarray(2, 6), d)) {
      return true;
    }
  }

  return false;
}

const jxlCodestream = Uint8Array.of(0xff, 0x0a);
const jxlContainer = lit("\x00\x00\x00\x0cJXL\x20\x0d\x0a\x87\x0a");
// Jxl matches JPEG XL image file.
export function Jxl(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, jxlCodestream) || hasPrefix(raw, jxlContainer);
}

const dxfSigs = [
  lit("  0\x0ASECTION\x0A"),
  lit("  0\x0D\x0ASECTION\x0D\x0A"),
  lit("0\x0ASECTION\x0A"),
  lit("0\x0D\x0ASECTION\x0D\x0A"),
];
// DXF matches Drawing Exchange Format AutoCAD file.
// There does not seem to be a clear specification and the files in the wild
// differ wildly.
// https://images.autodesk.com/adsk/files/autocad_2012_pdf_dxf-reference_enu.pdf
//
// I collected these signatures by downloading a few dozen files from
// http://cd.textfiles.com/amigaenv/DXF/OBJEKTE/ and
// https://sembiance.com/fileFormatSamples/poly/dxf/ and then
// xxd -l 16 {} | sort | uniq.
// These signatures are only for the ASCII version of DXF. There is a binary version too.
export function DXF(raw: Uint8Array, _limit: number): boolean {
  return dxfSigs.some((s) => hasPrefix(raw, s));
}
