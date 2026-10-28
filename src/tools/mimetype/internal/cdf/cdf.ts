// Upstream: gabriel-vasile/mimetype v1.4.15 internal/cdf/cdf.go.
//
// Package cdf implements parsing of CDF (OLE2) files. It is greatly inspired
// by src/readcdf.c from libmagic. One difference is this implementation is
// permissive of truncated inputs. See readLimit in mimetype.go for the
// reason why truncated inputs need to be handled.
// http://sc.openoffice.org/compdocfileformat.pdf
//
// Go's int64 offsets stay below 2^53 here (a sector size is at most 2^20 and
// a sector id below 2^31), so they are plain numbers. A Go nil slice is
// null, which matters where Go tells nil from empty (userStream, readShort).

import { equal, hasPrefix, leUint16, leUint32, lit } from "@/tools/mimetype/go-bytes";
import { Bytes, IgnoreCase } from "@/tools/mimetype/internal/scan/bytes";

export type CDFType = number;

export const CDFTypeGeneric = 0;
export const CDFTypeInstaller = 1;
export const CDFTypeDoc = 2;
export const CDFTypePpt = 3;
export const CDFTypeXls = 4;
export const CDFTypeMsg = 5;

// Detect parses raw as a CDF (OLE2) compound file and returns the document type
// it contains. It returns CDFTypeGeneric for input that is not a CDF file or
// whose type cannot be narrowed down.
export function detect(raw: Uint8Array): CDFType {
  if (raw.length < 512) {
    return CDFTypeGeneric;
  }
  const c = new cdf();
  if (!parse(raw, c)) {
    return CDFTypeGeneric;
  }
  return c.detect();
}

const cdfMagic = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);

const dirTypeUserStorage = 1;
const dirTypeUserStream = 2;
const dirTypeRootStorage = 5;

const dirEntrySize = 128;
const masterSATSize = 109; // first 109 SAT secids live in the file header

// int32(binary.LittleEndian.Uint32(b[off:]))
function readSecID(b: Uint8Array, off = 0): number {
  return leUint32(b, off) | 0;
}

// int32s works like a slice of LE int32 and is backed by a slice of bytes.
class int32s {
  constructor(public b: Uint8Array = new Uint8Array(0)) {}

  at(i: number): number {
    return readSecID(this.b, 4 * i);
  }
  len(): number {
    return Math.floor(this.b.length / 4);
  }
}

// dirEntry is a single CDF directory record. The UTF-16LE name is pre-decoded
// into an ASCII buffer: the low byte of each code unit, up to the first NUL.
class dirEntry {
  name = new Uint8Array(32);
  nameLen = 0;
  typ = 0;
  streamFirst = 0;
  size = 0;
  storageUUID = new Uint8Array(16);

  // nameBytes returns the decoded ASCII name without copying.
  nameBytes(): Uint8Array {
    return this.name.subarray(0, this.nameLen);
  }
}

// parse reads the entire on-disk structure required for type detection. It
// returns true on success and false if the header does not look like a CDF file.
// Truncated or partially malformed bodies are tolerated: sector reads degrade
// to whatever could be collected so detection can still succeed from partial data.
function parse(raw: Uint8Array, c: cdf): boolean {
  if (raw.length < 512 || !hasPrefix(raw, cdfMagic)) {
    return false;
  }
  const secP2 = leUint16(raw, 30);
  const shortP2 = leUint16(raw, 32);
  if (secP2 > 20 || shortP2 > 20) {
    return false;
  }
  c.data = raw;
  c.secSize = 2 ** secP2;
  c.shortSecSize = 2 ** shortP2;
  c.minStdStream = leUint32(raw, 56);
  if (c.secSize < dirEntrySize) {
    return false;
  }
  const firstDirSec = readSecID(raw, 48);
  c.firstSSAT = readSecID(raw, 60);
  const firstMSAT = readSecID(raw, 68);
  const nMSAT = leUint32(raw, 72);
  const masterSAT = new int32s(raw.subarray(76, 76 + 4 * masterSATSize));

  c.buildSAT(masterSAT, firstMSAT, nMSAT);
  c.dirRaw = c.readLong(firstDirSec, 0) ?? new Uint8Array(0);

  c.rootStreamFirst = -1;
  const d = new dirEntry();
  for (let i = 0, n = c.dirLen(); i < n; i++) {
    c.dirAt(i, d);
    if (d.typ !== dirTypeRootStorage || d.streamFirst < 0) {
      continue;
    }
    c.rootStorageUUID = d.storageUUID.slice();
    // Record where the short-stream pool lives; it is loaded lazily by
    // shortStream the first time a short stream is actually read.
    c.rootStreamFirst = d.streamFirst;
    c.rootStreamSize = d.size;
    break;
  }
  return true;
}

// cdf holds everything we need from a CDF file to do detection.
class cdf {
  data: Uint8Array = new Uint8Array(0);
  secSize = 0;
  shortSecSize = 0;
  minStdStream = 0;
  satSecs = new int32s(); // list of SAT sector ids; usually a sub-slice of raw input
  satEntries = 0; // number of valid SAT entries reachable through satSecs
  firstSSAT = 0;
  dirRaw: Uint8Array = new Uint8Array(0); // directory stream bytes (entries are decoded on demand)
  sst: Uint8Array | null = null; // short-stream pool (root storage's stream)
  sstBuilt = false; // whether sst was already loaded (it is loaded lazily)
  rootStreamFirst = 0; // first sector of the root storage short-stream pool
  rootStreamSize = 0; // size of the root storage short-stream pool
  rootStorageUUID: Uint8Array | null = null;

  detect(): CDFType {
    for (const name of ["\x05SummaryInformation", "\x05DocumentSummaryInformation"]) {
      const [t, ok] = this.detectFromSummary(lit(name));
      if (ok) {
        return t;
      }
    }
    const d = new dirEntry();
    for (let i = 0, n = this.dirLen(); i < n; i++) {
      this.dirAt(i, d);
      const [t, ok] = lookupSection(d.nameBytes(), d.typ);
      if (ok) {
        return t;
      }
    }
    return CDFTypeGeneric;
  }

  // detectFromSummary inspects a (Doc)SummaryInformation stream and tries to
  // derive a CDFType from the root-storage CLSID, the property NameOfApplication,
  // and finally the names of sibling user streams.
  detectFromSummary(streamName: Uint8Array): [CDFType, boolean] {
    if (this.rootStorageUUID !== null && equal(this.rootStorageUUID, msiCLSID)) {
      return [CDFTypeInstaller, true];
    }
    const raw = this.userStream(streamName);
    if (raw === null) {
      return [CDFTypeGeneric, false];
    }
    const app = summaryAppName(raw);
    if (app !== null && app.length > 0) {
      const [t, ok] = lookupSubstring(app, app2type);
      if (ok) {
        return [t, true];
      }
    }
    for (let i = 0, n = this.dirLen(); i < n; i++) {
      const d = new dirEntry();
      this.dirAt(i, d);
      if (d.nameLen === 0) {
        continue;
      }
      const [t, ok] = lookupSubstring(d.nameBytes(), name2type);
      if (ok) {
        return [t, true];
      }
    }
    return [CDFTypeGeneric, true];
  }

  ssatAt(i: number): number {
    for (let sid = this.firstSSAT; sid >= 0;) {
      if (sid >= this.satLen()) {
        break; // SAT is truncated; stop collecting
      }
      const buf = this.sector(sid);
      if (buf === null) {
        break;
      }
      const lbuf = Math.floor(buf.length / 4);
      if (i < lbuf) {
        return readSecID(buf, 4 * i);
      }
      i -= lbuf;
      sid = this.satAt(sid);
    }
    return -1;
  }

  // shortStream returns the root storage short-stream pool, loading it on first
  // use. Detection often finishes (e.g. via the root CLSID or a long-stream
  // summary) without ever reading a short stream, so building this eagerly would
  // be wasted work.
  shortStream(): Uint8Array | null {
    if (!this.sstBuilt) {
      this.sstBuilt = true;
      if (this.rootStreamFirst >= 0) {
        this.sst = this.readLong(this.rootStreamFirst, this.rootStreamSize);
      }
    }
    return this.sst;
  }

  // satLen is the number of sector ids reachable through the SAT.
  satLen(): number {
    return this.satEntries;
  }

  // satAt returns the i-th sector id from the SAT. Callers must ensure
  // i < satLen(). The SAT is not materialized; the entry is fetched directly
  // from the input by translating i into (SAT sector index, entry offset).
  satAt(i: number): number {
    const perSec = this.secSize / 4;
    const secIdx = Math.floor(i / perSec);
    const entryIdx = i % perSec;
    const secID = this.satSecs.at(secIdx);
    const off = this.secSize * (1 + secID) + 4 * entryIdx;
    return readSecID(this.data, off);
  }

  // sector returns the bytes of long sector secid. If the file is truncated
  // inside the requested sector the result is the available bytes (no padding).
  // If the sector starts past EOF or secid is negative, then it is null.
  sector(secid: number): Uint8Array | null {
    if (secid < 0) {
      return null;
    }
    const off = this.secSize * (1 + secid);
    if (off >= this.data.length) {
      return null;
    }
    // The returned sector might be truncated,
    // but we still return it as best effort.
    const end = Math.min(off + this.secSize, this.data.length);
    // If not even one int32 fits, then fail.
    if (end - off < 4) {
      return null;
    }
    return this.data.subarray(off, end);
  }

  sectorIDs(secid: number): int32s | null {
    const buf = this.sector(secid);
    if (buf === null) {
      return null;
    }
    return new int32s(buf);
  }

  // buildSAT records the list of SAT sector ids from the master-SAT (header)
  // plus any extension blocks chained via firstMSAT. The SAT itself is not
  // materialized: satAt computes the requested entry directly from c.data via
  // satSecs. In the common case (no extension chain) satSecs is a zero-copy
  // sub-slice of the input header.
  buildSAT(masterSAT: int32s, firstMSAT: number, nMSAT: number): void {
    // Fast path: no extension chain. masterSAT is already a sub-slice of raw
    // input; reuse it directly.
    if (firstMSAT < 0 || nMSAT === 0) {
      this.satSecs = masterSAT;
      this.satEntries = this.computeSATLen();
      return;
    }

    // Slow path: gather sector ids from the header plus the extension chain
    // into a fresh buffer. Even here we only allocate space for ids (4 bytes
    // each), not the full SAT contents.
    const maxIDs = Math.floor(this.data.length / this.secSize) + 1;
    const buf: number[] = [];
    for (let i = 0; i < masterSAT.len(); i++) {
      if (masterSAT.at(i) < 0) {
        break;
      }
      buf.push(...masterSAT.b.subarray(4 * i, 4 * i + 4));
    }
    const perSec = this.secSize / 4 - 1;
    let mid = firstMSAT;
    chain: for (let j = 0; j < nMSAT && mid >= 0; j++) {
      const msa = this.sectorIDs(mid);
      if (msa === null) {
        break;
      }
      for (let k = 0; k < perSec; k++) {
        if (k >= msa.len() || msa.at(k) < 0) {
          break chain;
        }
        buf.push(...msa.b.subarray(4 * k, 4 * k + 4));
        if (Math.floor(buf.length / 4) > maxIDs) {
          break chain; // cyclic MSAT chain; stop allocating
        }
      }
      if (perSec >= msa.len()) {
        break; // no next-MSAT pointer available
      }
      mid = msa.at(perSec);
    }
    this.satSecs = new int32s(Uint8Array.from(buf));
    this.satEntries = this.computeSATLen();
  }

  // computeSATLen walks satSecs and counts how many SAT entries are actually
  // reachable in c.data, stopping at the first sentinel id or sector that is not
  // fully present in the file.
  computeSATLen(): number {
    const perSec = this.secSize / 4;
    let total = 0;
    for (let i = 0; i < this.satSecs.len(); i++) {
      const sec = this.satSecs.at(i);
      if (sec < 0) {
        break;
      }
      const off = this.secSize * (1 + sec);
      if (off >= this.data.length) {
        break;
      }
      const avail = this.data.length - off;
      if (avail >= this.secSize) {
        total += perSec;
        continue;
      }
      total += Math.floor(avail / 4);
      break;
    }
    return total;
  }

  // readLong reads a long-sector chain starting at sid. If length > 0 the
  // result is truncated to that many bytes. On truncation or any other failure
  // it returns whatever sectors were readable.
  readLong(sid: number, length: number): Uint8Array | null {
    // Fast path: when the chain is a single physically contiguous run of
    // sectors (the common case for the directory and summary streams) the data
    // is already laid out sequentially in the input, so return a sub-slice of
    // it instead of allocating a buffer and copying every sector.
    if (sid >= 0) {
      const maxSec = Math.floor(this.data.length / this.secSize) + 1;
      let n = 0;
      let s = sid;
      let contiguous = true;
      while (s >= 0) {
        if (s >= this.satLen()) {
          break; // SAT truncated; what remains is still contiguous
        }
        n++;
        if (n > maxSec) {
          contiguous = false; // cyclic chain; let the slow path guard it
          break;
        }
        const next = this.satAt(s);
        if (next >= 0 && next !== s + 1) {
          contiguous = false;
          break;
        }
        s = next;
      }
      if (contiguous) {
        const off = this.secSize * (1 + sid);
        if (off >= this.data.length) {
          return null;
        }
        const end = Math.min(off + n * this.secSize, this.data.length);
        let out = this.data.subarray(off, end);
        if (length > 0 && length < out.length) {
          out = out.subarray(0, length);
        }
        return out;
      }
    }

    // Slow path: gather a fragmented chain into a fresh buffer. Real-world
    // writers (MSI builders, edited Office documents) routinely produce
    // non-contiguous directory and stream chains, so this fallback is required
    // for correct detection on those files.
    const maxBytes = this.data.length;
    const parts: Uint8Array[] = [];
    let outLen = 0;
    while (sid >= 0) {
      if (sid >= this.satLen()) {
        break; // SAT truncated; return what we have
      }
      const buf = this.sector(sid);
      if (buf === null) {
        break;
      }
      parts.push(buf);
      outLen += buf.length;
      if (outLen >= maxBytes) {
        break; // chain longer than the file: cyclic SAT, stop
      }
      sid = this.satAt(sid);
    }
    let out = concat(parts, outLen);
    if (length > 0 && length < out.length) {
      out = out.subarray(0, length);
    }
    return out;
  }

  // readShort reads a short-sector chain at sid by indexing into the short-stream
  // pool. On truncation or if the pool is unavailable it returns whatever was
  // readable (possibly null).
  readShort(sid: number, length: number): Uint8Array | null {
    const sst = this.shortStream();
    if (sst === null) {
      return null;
    }
    const parts: Uint8Array[] = [];
    let outLen = 0;
    while (sid >= 0) {
      const off = sid * this.shortSecSize;
      if (off + this.shortSecSize > sst.length) {
        break; // short-stream pool truncated or sid out of range
      }
      parts.push(sst.subarray(off, off + this.shortSecSize));
      outLen += this.shortSecSize;
      if (outLen >= sst.length) {
        break; // chain longer than the pool: cyclic SSAT, stop
      }
      sid = this.ssatAt(sid);
    }
    let out = concat(parts, outLen);
    if (length > 0 && length < out.length) {
      out = out.subarray(0, length);
    }
    return out;
  }

  // readChain dispatches to the long or short reader depending on stream size.
  readChain(sid: number, length: number): Uint8Array | null {
    if (length < this.minStdStream && this.rootStreamFirst >= 0) {
      return this.readShort(sid, length);
    }
    return this.readLong(sid, length);
  }

  // dirLen returns the number of directory entries in dirRaw.
  dirLen(): number {
    return Math.floor(this.dirRaw.length / dirEntrySize);
  }

  // dirAt decodes the i-th directory entry into *out. Callers must ensure
  // i < dirLen(). The UTF-16LE name is decoded into out.name, ASCII-style,
  // stopping at the first NUL.
  dirAt(i: number, out: dirEntry): void {
    const raw = this.dirRaw.subarray(i * dirEntrySize);
    const nameLen = Math.min(leUint16(raw, 64), 64);
    let k = 0;
    for (let j = 0; j < Math.floor(nameLen / 2); j++) {
      // Names are ASCII; keep the low byte of each little-endian UTF-16
      // code unit and stop at the first NUL.
      const lo = raw[2 * j] as number;
      const hi = raw[2 * j + 1] as number;
      if (lo === 0 && hi === 0) {
        break;
      }
      out.name[k] = lo;
      k++;
    }
    out.nameLen = k;
    out.typ = raw[66] as number;
    out.streamFirst = readSecID(raw, 116);
    out.size = leUint32(raw, 120);
    out.storageUUID.set(raw.subarray(80, 96));
  }

  // userStream finds a user stream by name and returns its bytes, or null.
  userStream(name: Uint8Array): Uint8Array | null {
    const d = new dirEntry();
    for (let i = 0, n = this.dirLen(); i < n; i++) {
      this.dirAt(i, d);
      if (d.typ === dirTypeUserStream && equal(d.nameBytes(), name)) {
        return this.readChain(d.streamFirst, d.size);
      }
    }
    return null;
  }
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const propIDNameOfApplication = 0x12;

const typeMask = 0x0fff;
const typeVector = 0x1000;
const typeStringASCII = 0x1e;
const typeStringWide = 0x1f;

const sectionDeclOffset = 0x1c; // section declaration in property-set header

// summaryAppName parses a (Doc)SummaryInformation stream and returns the
// value of property NameOfApplication (0x12) as printable ASCII, or nil if
// not present or the stream is malformed. This is the only summary property
// the detection logic ever consults.
export function summaryAppName(stream: Uint8Array): Uint8Array | null {
  if (stream.length < sectionDeclOffset + 20) {
    return null;
  }
  const sdOff = leUint32(stream, sectionDeclOffset + 16);
  if (sdOff + 8 > stream.length) {
    return null;
  }
  const section = stream.subarray(sdOff);
  const shLen = leUint32(section, 0);
  const nProps = leUint32(section, 4);
  if (shLen > section.length || nProps > 1 << 16 || 8 + 8 * nProps > shLen) {
    return null;
  }
  for (let i = 0; i < nProps; i++) {
    const base = 8 + 8 * i;
    const id = leUint32(section, base);
    if (id !== propIDNameOfApplication) {
      continue;
    }
    const off = leUint32(section, base + 4);
    if (off + 8 > shLen) {
      return null;
    }
    const typ = leUint32(section, off);
    if ((typ & typeVector) !== 0) {
      return null;
    }
    let step = 0;
    switch (typ & typeMask) {
      case typeStringASCII:
        step = 1;
        break;
      case typeStringWide:
        step = 2;
        break;
      default:
        return null;
    }
    const slen = leUint32(section, off + 4);
    const start = off + 8;
    const end = start + slen * step;
    if (end > shLen) {
      return null;
    }
    return printableLowBytes(section.subarray(start, end), step);
  }
  return null;
}

// printableLowBytes copies the printable low byte of each step-byte unit
// in b, stopping at the first NUL.
function printableLowBytes(b: Uint8Array, step: number): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i + step <= b.length; i += step) {
    const c = b[i] as number;
    if (c === 0) {
      break;
    }
    if (c >= 0x20 && c < 0x7f) {
      out.push(c);
    }
  }
  return Uint8Array.from(out);
}

// pattern is a case-insensitive substring → CDFType mapping. Entries are
// tested in order; first match wins. needle is stored upper-cased so it can be
// matched case-insensitively by scan.Bytes.Search with scan.IgnoreCase.
interface pattern {
  needle: Uint8Array;
  typ: CDFType;
}

const pat = (needle: string, typ: CDFType): pattern => ({ needle: lit(needle), typ });

// app2type maps NameOfApplication values to CDFTypes.
// Mirrors app2mime[] in libmagic. Needles are upper-cased for case-insensitive
// matching via scan.IgnoreCase.
const app2type: pattern[] = [
  pat("WORD", CDFTypeDoc),
  pat("EXCEL", CDFTypeXls),
  pat("POWERPOINT", CDFTypePpt),
  pat("ADVANCED INSTALLER", CDFTypeInstaller),
  pat("INSTALLSHIELD", CDFTypeInstaller),
  pat("MICROSOFT PATCH COMPILER", CDFTypeInstaller),
  pat("NANT", CDFTypeInstaller),
  pat("WINDOWS INSTALLER", CDFTypeInstaller),
];

// name2type maps directory entry names to CDFTypes.
// Mirrors name2mime[] in libmagic. Needles are upper-cased for case-insensitive
// matching via scan.IgnoreCase.
const name2type: pattern[] = [
  pat("BOOK", CDFTypeXls),
  pat("WORKBOOK", CDFTypeXls),
  pat("WORDDOCUMENT", CDFTypeDoc),
  pat("POWERPOINT", CDFTypePpt),
  pat("DIGITALSIGNATURE", CDFTypeInstaller),
];

// lookupSubstring returns the CDFType for the first entry in t whose needle
// is a case-insensitive substring of v. Mirrors C's strcasestr semantics
// under the C locale.
function lookupSubstring(v: Uint8Array, t: pattern[]): [CDFType, boolean] {
  const s = new Bytes(v);
  for (const p of t) {
    const [i] = s.search(p.needle, IgnoreCase);
    if (i !== -1) {
      return [p.typ, true];
    }
  }
  return [CDFTypeGeneric, false];
}

// msiCLSID is the Microsoft Installer root-storage CLSID, in on-disk byte
// order (cdf_directory_t.d_storage_uuid stores two little-endian uint64s).
const msiCLSID = Uint8Array.of(
  0x84,
  0x10,
  0x0c,
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

// section is a (directory entry name, type) → CDFType mapping.
interface section {
  name: Uint8Array;
  typ: number;
  cdf: CDFType;
}

// sectionTypes maps distinctive directory entries to CDFTypes — a flattened
// equivalent of sectioninfo[] in libmagic. Used as a fallback when no
// SummaryInformation stream is present.
const sectionTypes: section[] = [
  // libmagic uses application/encrypted, but that is not a registered media type.
  // For now, we skip identifying that and fall-back on CDFTypeGeneric
  // {"EncryptedPackage", dirTypeUserStream, CDFTypeEncrypted},
  // {"EncryptedSummary", dirTypeUserStream, CDFTypeEncrypted},
  { name: lit("Book"), typ: dirTypeUserStream, cdf: CDFTypeXls },
  { name: lit("Workbook"), typ: dirTypeUserStream, cdf: CDFTypeXls },
  { name: lit("WordDocument"), typ: dirTypeUserStream, cdf: CDFTypeDoc },
  { name: lit("PowerPoint Document"), typ: dirTypeUserStream, cdf: CDFTypePpt },
  { name: lit("__properties_version1.0"), typ: dirTypeUserStream, cdf: CDFTypeMsg },
  { name: lit("__recip_version1.0_#00000000"), typ: dirTypeUserStorage, cdf: CDFTypeMsg },
];

// lookupSection returns the CDFType for a directory entry whose name and type
// match a sectionTypes entry exactly.
function lookupSection(name: Uint8Array, typ: number): [CDFType, boolean] {
  for (const s of sectionTypes) {
    if (s.typ === typ && equal(name, s.name)) {
      return [s.cdf, true];
    }
  }
  return [CDFTypeGeneric, false];
}
