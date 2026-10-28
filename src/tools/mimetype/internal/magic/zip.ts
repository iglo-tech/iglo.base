// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/zip.go.

import { equal, hasPrefix, index, lit } from "@/tools/mimetype/go-bytes";
import { offset } from "@/tools/mimetype/internal/magic/magic";
import { Bytes } from "@/tools/mimetype/internal/scan/bytes";

const odt = lit("mimetypeapplication/vnd.oasis.opendocument.text");
// Odt matches an OpenDocument Text file.
export function Odt(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, odt, 30);
}

const ott = lit("mimetypeapplication/vnd.oasis.opendocument.text-template");
// Ott matches an OpenDocument Text Template file.
export function Ott(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, ott, 30);
}

const ods = lit("mimetypeapplication/vnd.oasis.opendocument.spreadsheet");
// Ods matches an OpenDocument Spreadsheet file.
export function Ods(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, ods, 30);
}

const ots = lit("mimetypeapplication/vnd.oasis.opendocument.spreadsheet-template");
// Ots matches an OpenDocument Spreadsheet Template file.
export function Ots(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, ots, 30);
}

const odp = lit("mimetypeapplication/vnd.oasis.opendocument.presentation");
// Odp matches an OpenDocument Presentation file.
export function Odp(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, odp, 30);
}

const otp = lit("mimetypeapplication/vnd.oasis.opendocument.presentation-template");
// Otp matches an OpenDocument Presentation Template file.
export function Otp(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, otp, 30);
}

const odg = lit("mimetypeapplication/vnd.oasis.opendocument.graphics");
// Odg matches an OpenDocument Drawing file.
export function Odg(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, odg, 30);
}

const otg = lit("mimetypeapplication/vnd.oasis.opendocument.graphics-template");
// Otg matches an OpenDocument Drawing Template file.
export function Otg(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, otg, 30);
}

const odf = lit("mimetypeapplication/vnd.oasis.opendocument.formula");
// Odf matches an OpenDocument Formula file.
export function Odf(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, odf, 30);
}

const odc = lit("mimetypeapplication/vnd.oasis.opendocument.chart");
// Odc matches an OpenDocument Chart file.
export function Odc(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, odc, 30);
}

const epub = lit("mimetypeapplication/epub+zip");
// Epub matches an EPUB file.
export function Epub(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, epub, 30);
}

const sxc = lit("mimetypeapplication/vnd.sun.xml.calc");
// Sxc matches an OpenOffice Spreadsheet file.
export function Sxc(raw: Uint8Array, _limit: number): boolean {
  return offset(raw, sxc, 30);
}

// Zip matches a zip archive.
export function Zip(raw: Uint8Array, _limit: number): boolean {
  return (
    raw.length > 3 &&
    raw[0] === 0x50 &&
    raw[1] === 0x4b &&
    (raw[2] === 0x3 || raw[2] === 0x5 || raw[2] === 0x7) &&
    (raw[3] === 0x4 || raw[3] === 0x6 || raw[3] === 0x8)
  );
}

// First entry must be an empty META-INF directory or the manifest.
const jarEntries: zipEntries = [
  { name: lit("META-INF/"), dir: false },
  { name: lit("META-INF/MANIFEST.MF"), dir: false },
];

// Jar matches a Java archive file. There are two types of Jar files:
// 1. the ones that can be opened with jexec and have 0xCAFE optional flag
// https://stackoverflow.com/tags/executable-jar/info
// 2. regular jars, same as above, just without the executable flag
// https://bugs.freebsd.org/bugzilla/show_bug.cgi?id=262278#c0
// There is an argument to only check for manifest, since it's the common nominator
// for both executable and non-executable versions. But the traversing zip entries
// is unreliable because it does linear search for signatures
// (instead of relying on offsets told by the file.)
export function Jar(raw: Uint8Array, _limit: number): boolean {
  return (
    executableJar(new Bytes(raw)) ||
    // First entry must be an empty META-INF directory or the manifest.
    // There is no specification saying that, but the jar reader and writer
    // implementations from Java do it that way.
    // https://github.com/openjdk/jdk/blob/88c4678eed818cbe9380f35352e90883fed27d33/src/java.base/share/classes/java/util/jar/JarInputStream.java#L170-L173
    zipHas(raw, jarEntries, 1)
  );
}

const kmzEntries: zipEntries = [{ name: lit("doc.kml"), dir: false }];
// KMZ matches a zipped KML file, which is "doc.kml" by convention.
export function KMZ(raw: Uint8Array, _limit: number): boolean {
  return zipHas(raw, kmzEntries, 100);
}

// An executable Jar has a 0xCAFE flag enabled in the first zip entry.
// The rule from file/file is:
// >(26.s+30)	leshort	0xcafe		Java archive data (JAR)
function executableJar(b: Bytes): boolean {
  b.advance(0x1a);
  const [off, ok] = b.uint16();
  if (!ok) {
    return false;
  }
  b.advance(off + 2);

  const [cafe, ok2] = b.uint16();
  return ok2 && cafe === 0xcafe;
}

export type zipEntries = {
  name: Uint8Array;
  dir: boolean; // dir means checking just the prefix of the entry, not the whole path
}[];

function zipEntriesMatch(z: zipEntries, file: Uint8Array): boolean {
  for (const e of z) {
    if (e.dir) {
      if (hasPrefix(file, e.name)) {
        return true;
      }
    } else {
      if (equal(file, e.name)) {
        return true;
      }
    }
  }
  return false;
}

export function zipHas(raw: Uint8Array, searchFor: zipEntries, stopAfter: number): boolean {
  const iter = new zipIterator(raw);
  for (let i = 0; i < stopAfter; i++) {
    const f = iter.next();
    if (f === null || f.length === 0) {
      break;
    }
    if (zipEntriesMatch(searchFor, f)) {
      return true;
    }
  }

  return false;
}

const contentTypes = lit("[Content_Types].xml");
const relsDir = lit("_rels/");
const docPropsDir = lit("docProps/");
const customXmlDir = lit("customXml/");
const trashDir = lit("[trash]/");

// msoxml behaves like zipHas, but it puts restrictions on what the first zip
// entry can be.
export function msoxml(raw: Uint8Array, searchFor: zipEntries, stopAfter: number): boolean {
  const iter = new zipIterator(raw);
  for (let i = 0; i < stopAfter; i++) {
    const f = iter.next();
    if (f === null || f.length === 0) {
      break;
    }
    if (zipEntriesMatch(searchFor, f)) {
      return true;
    }
    // If the first is not one of the next usually expected entries,
    // then abort this check.
    if (i === 0) {
      if (
        !equal(f, contentTypes) && // this is a file
        !hasPrefix(f, relsDir) && // these are directories
        !hasPrefix(f, docPropsDir) &&
        !hasPrefix(f, customXmlDir) &&
        !hasPrefix(f, trashDir)
      ) {
        return false;
      }
    }
  }

  return false;
}

const zipLocalFileHeader = lit("PK\x03\x04");

// zipIterator iterates over a zip file returning the name of the zip entries
// in that file.
class zipIterator {
  b: Bytes;

  constructor(raw: Uint8Array) {
    this.b = new Bytes(raw);
  }

  // next extracts the name of the next zip entry.
  next(): Uint8Array | null {
    const n = index(this.b.b, zipLocalFileHeader);
    if (n === -1) {
      return null;
    }
    this.b.advance(n);
    if (!this.b.advance(0x1a)) {
      return null;
    }
    const [l, ok] = this.b.uint16();
    if (!ok) {
      return null;
    }
    if (!this.b.advance(0x02)) {
      return null;
    }
    if (this.b.length < l) {
      return null;
    }
    return this.b.b.subarray(0, l);
  }

  // skipZipflingerEntry tries to detect a Zipflinger virtual entry and skips it.
  // The detection is based on the following properties:
  // - compression method is 0
  // - CRC32 is 0
  // - compressed size is 0
  // - uncompressed size is 0
  // - file name is empty
  // Returns true if it was found and skipped.
  skipZipflingerEntry(): boolean {
    // Make a backup of the data so the inspection does not loses it.
    const b = this.b.b;
    const skipped = this.zipflingerEntry();
    // If no zipflinger was found, restore the original data.
    if (!skipped) {
      this.b.b = b;
    }
    return skipped;
  }

  private zipflingerEntry(): boolean {
    const n = index(this.b.b, zipLocalFileHeader);
    if (n === -1) {
      return false;
    }
    if (!this.b.advance(0x08)) {
      return false;
    }

    // Check compression method
    const [cm, cmOk] = this.b.uint16();
    if (!cmOk || cm !== 0) {
      return false;
    }

    // Advance up to the CRC32 field
    if (!this.b.advance(0x04)) {
      return false;
    }

    // Check CRC32
    const [crc32, crcOk] = this.b.uint32();
    if (!crcOk || crc32 !== 0) {
      return false;
    }

    // Check compressed size
    const [compressedSize, csOk] = this.b.uint32();
    if (!csOk || compressedSize !== 0) {
      return false;
    }

    // Check uncompressed size
    const [uncompressedSize, usOk] = this.b.uint32();
    if (!usOk || uncompressedSize !== 0) {
      return false;
    }

    // Check for empty file name
    const [nameLen, nlOk] = this.b.uint16();
    if (!nlOk || nameLen !== 0) {
      return false;
    }

    // Reached a zipflinger virtual entry: skip extra data
    const [l, ok] = this.b.uint16();
    if (!ok) {
      return false;
    }

    if (!this.b.advance(l)) {
      return false;
    }
    return true;
  }
}

const apkEntries: zipEntries = [
  { name: lit("AndroidManifest.xml"), dir: false },
  { name: lit("META-INF/com/android/build/gradle/app-metadata.properties"), dir: false },
  { name: lit("classes.dex"), dir: false },
  { name: lit("resources.arsc"), dir: false },
  { name: lit("res/drawable"), dir: false },
];

// APK matches an Android Package Archive.
// The source of signatures is https://github.com/file/file/blob/1778642b8ba3d947a779a36fcd81f8e807220a19/magic/Magdir/archive#L1820-L1887
export function APK(raw: Uint8Array, _limit: number): boolean {
  const iter = new zipIterator(raw);

  // If a Zipflinger Virtual Entry is detected, then the data is considered APK
  if (iter.skipZipflingerEntry()) {
    return true;
  }

  return zipHas(iter.b.b, apkEntries, 100);
}
