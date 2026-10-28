// Upstream: gabriel-vasile/mimetype v1.4.15 internal/cdf/cdf_test.go

import { describe, expect, test } from "bun:test";

import {
  CDFTypeDoc,
  CDFTypeGeneric,
  CDFTypeInstaller,
  CDFTypeMsg,
  CDFTypePpt,
  CDFTypeXls,
  type CDFType,
  detect,
  summaryAppName,
} from "@/tools/mimetype/internal/cdf/cdf";
import { bytesToText } from "@/tools/types/go-json";
import { raw } from "@test/tools/mimetype/go-literal";

// Format constants from the CDF/OLE2 layout that the Go test builds by hand.
const cdfMagic = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
const dirEntrySize = 128;
const masterSATSize = 109; // first 109 SAT secids live in the file header
const dirTypeUserStorage = 1;
const dirTypeUserStream = 2;
const dirTypeRootStorage = 5;
const propIDNameOfApplication = 0x12;
const typeStringASCII = 0x1e;
const typeStringWide = 0x1f;
const sectionDeclOffset = 0x1c; // section declaration in property-set header

// Microsoft Installer root-storage CLSID, in on-disk byte order.
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

const testSecSize = 512;

// testSecSizes are the two sector sizes a CDF file may use: 512 (v3) and
// 4096 (v4). Table tests generate inputs for each.
const testSecSizes = [512, 4096];

// secP2 returns the power-of-two exponent stored in the header for secSize.
const secP2 = (secSize: number): number => Math.log2(secSize);

// view is a DataView over b's own bytes, so writes land in b.
const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);
const put16 = (b: Uint8Array, off: number, v: number): void => view(b).setUint16(off, v, true);
// setUint32 wraps negative values, so int32 secIDs like -1 store as 0xFFFFFFFF.
const put32 = (b: Uint8Array, off: number, v: number): void => view(b).setUint32(off, v, true);

// copyInto copies src into the start of dst, like Go's copy.
function copyInto(dst: Uint8Array, src: Uint8Array): void {
  dst.set(src.subarray(0, Math.min(dst.length, src.length)));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// testHeader builds a 512-byte CDF header with secSize-byte sectors and
// 64-byte short sectors. A null masterSAT is Go's nil slice.
function testHeader(
  secSize: number,
  firstDirSec: number,
  firstSSAT: number,
  minStdStream: number,
  masterSAT: number[] | null,
): Uint8Array {
  const h = new Uint8Array(512);
  h.set(cdfMagic, 0);
  put16(h, 30, secP2(secSize));
  put16(h, 32, 6); // 64-byte short sectors
  put32(h, 48, firstDirSec);
  put32(h, 56, minStdStream);
  put32(h, 60, firstSSAT);
  put32(h, 68, 0xfffffffe); // no extra master SAT sectors
  put32(h, 72, 0);
  for (let i = 0; i < masterSATSize; i++) {
    const v = masterSAT !== null && i < masterSAT.length ? (masterSAT[i] ?? -1) : -1;
    put32(h, 76 + 4 * i, v);
  }
  return h;
}

// idSector encodes ids as a secSize-byte sector of little-endian int32s,
// padding with -1 (free).
function idSector(secSize: number, ids: number[] = []): Uint8Array {
  const s = new Uint8Array(secSize);
  for (let i = 0; i < secSize / 4; i++) {
    put32(s, 4 * i, i < ids.length ? (ids[i] ?? -1) : -1);
  }
  return s;
}

// padSector pads b with zeros to a full secSize-byte sector. A null b is Go's
// nil slice.
function padSector(secSize: number, b: Uint8Array | null): Uint8Array {
  const s = new Uint8Array(secSize);
  if (b !== null) {
    copyInto(s, b);
  }
  return s;
}

// dirEntryBytes encodes a single 128-byte directory entry. The name is
// encoded as NUL-terminated UTF-16LE.
function dirEntryBytes(
  name: string,
  typ: number,
  first: number,
  size: number,
  uuid: Uint8Array | null,
): Uint8Array {
  const e = new Uint8Array(dirEntrySize);
  for (let i = 0; i < name.length; i++) {
    put16(e, 2 * i, name.charCodeAt(i));
  }
  put16(e, 64, 2 * (name.length + 1));
  e[66] = typ;
  if (uuid !== null) {
    copyInto(e.subarray(80, 96), uuid);
  }
  put32(e, 116, first);
  put32(e, 120, size);
  return e;
}

// summaryStream builds a minimal (Doc)SummaryInformation property-set stream
// containing a single NameOfApplication (0x12) property. If wide is true the
// value is encoded as UTF-16LE, otherwise as ASCII.
function summaryStream(appName: string, wide: boolean): Uint8Array {
  const strType = wide ? typeStringWide : typeStringASCII;
  const step = wide ? 2 : 1;
  const strData = new Uint8Array((appName.length + 1) * step); // NUL-terminated
  for (let i = 0; i < appName.length; i++) {
    strData[i * step] = appName.charCodeAt(i);
  }
  // Section: 8-byte header, one 8-byte property declaration, then the value.
  const section = new Uint8Array(24 + strData.length);
  put32(section, 4, 1); // one property
  put32(section, 8, propIDNameOfApplication);
  put32(section, 12, 16); // value offset in section
  put32(section, 16, strType);
  put32(section, 20, appName.length + 1);
  section.set(strData, 24);
  put32(section, 0, section.length); // section length

  // 48-byte property-set header; the first section declaration starts at
  // 0x1c and its offset field (at 0x2c) points right after the header.
  const stream = new Uint8Array(48 + section.length);
  put32(stream, 44, 48);
  stream.set(section, 48);
  return stream;
}

interface entrySpec {
  name: string;
  typ: number;
}

// makeCDF assembles a complete single-SAT-sector CDF file with secSize-byte
// sectors:
//   sector 0: SAT
//   sector 1: directory (root entry, optional summary entry, extras)
//   sector 2: root storage's stream (short-sector pool, zero-filled)
//   sector 3: summary stream (when summary != nil)
// The 512-byte header is zero-padded to a full sector so sector 0 starts at
// offset secSize. minStdStream is 0 so every stream is read through the
// long-sector path. Extra entries carry no stream data; detection only
// inspects their names.
function makeCDF(
  secSize: number,
  rootUUID: Uint8Array | null,
  summaryName: string,
  summary: Uint8Array | null,
  ...extras: entrySpec[]
): Uint8Array {
  if (summary !== null && summary.length > secSize) {
    throw new Error("summary stream larger than one sector");
  }
  let dir = dirEntryBytes("Root Entry", dirTypeRootStorage, 2, secSize, rootUUID);
  if (summary !== null) {
    dir = concat(dir, dirEntryBytes(summaryName, dirTypeUserStream, 3, summary.length, null));
  }
  for (const e of extras) {
    dir = concat(dir, dirEntryBytes(e.name, e.typ, -2, 0, null));
  }
  if (dir.length > secSize) {
    throw new Error("directory larger than one sector");
  }

  return concat(
    padSector(secSize, testHeader(secSize, 1, -2, 0, [0])),
    idSector(secSize, [-3, -2, -2, -2]), // all chains are single-sector
    padSector(secSize, dir),
    new Uint8Array(secSize),
    padSector(secSize, summary),
  );
}

describe("TestDetectInvalidInput", () => {
  const badSectorSize = testHeader(testSecSize, 1, -2, 0, null);
  put16(badSectorSize, 30, 21); // secP2 > 20

  const tooSmallSector = testHeader(testSecSize, 1, -2, 0, null);
  put16(tooSmallSector, 30, 5); // 32 < dirEntrySize

  // firstDirSec * secSize == 2^31 overflows int on 32bit arch and causes
  // slice-bounds panic.
  const dirSecOverflow = testHeader(testSecSize, (1 << 22) - 1, -2, 0, null);

  // secSize=4096, masterSAT[0]=0, firstSSAT=0. sector(0) is only 1 byte (file
  // ends one byte into it), so collectIDs must not loop forever trying to read
  // int32s from a sub-4-byte buffer.
  const truncatedSSAT = concat(
    padSector(4096, testHeader(4096, -2, 0, 0, [0])),
    Uint8Array.of(0x00), // one-byte sector 0 — too small for even one int32
  );

  const tests: { name: string; data: Uint8Array }[] = [
    { name: "nil", data: Uint8Array.of() },
    { name: "short", data: Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0) },
    { name: "bad magic", data: new Uint8Array(512) },
    { name: "bad sector size", data: badSectorSize },
    { name: "sector smaller than dir entry", data: tooSmallSector },
    { name: "dir sector overflows int32", data: dirSecOverflow },
    { name: "truncated sector in SSAT chain loops forever", data: truncatedSSAT },
  ];
  for (const tt of tests) {
    test(tt.name, () => {
      expect(detect(tt.data)).toBe(CDFTypeGeneric);
    });
  }
});

test("TestDetectMSIRootCLSID", () => {
  for (const secSize of testSecSizes) {
    const data = makeCDF(secSize, msiCLSID, "", null);
    expect(detect(data)).toBe(CDFTypeInstaller);
  }
});

describe("TestDetectFromAppName", () => {
  const tests: { app: string; want: CDFType }[] = [
    { app: "Microsoft Office Word", want: CDFTypeDoc },
    { app: "Microsoft Excel", want: CDFTypeXls },
    { app: "Microsoft Powerpoint", want: CDFTypePpt },
    { app: "Advanced Installer 19.0", want: CDFTypeInstaller },
    { app: "InstallShield", want: CDFTypeInstaller },
    { app: "Microsoft Patch Compiler", want: CDFTypeInstaller },
    { app: "NAnt", want: CDFTypeInstaller },
    { app: "Windows Installer XML Toolset", want: CDFTypeInstaller },
    { app: "MICROSOFT WORD", want: CDFTypeDoc }, // matching is case-insensitive
  ];
  const summaryNames = ["\x05SummaryInformation", "\x05DocumentSummaryInformation"];
  for (const secSize of testSecSizes) {
    for (const summaryName of summaryNames) {
      for (const wide of [false, true]) {
        for (const tt of tests) {
          test(tt.app, () => {
            const data = makeCDF(secSize, null, summaryName, summaryStream(tt.app, wide));
            expect(detect(data)).toBe(tt.want);
          });
        }
      }
    }
  }
});

// TestDetectFromSiblingNames exercises the fallback inside detectFromSummary:
// the application name does not match, so detection relies on the names of
// the other directory entries.
describe("TestDetectFromSiblingNames", () => {
  const tests: { sibling: string; want: CDFType }[] = [
    { sibling: "Book", want: CDFTypeXls },
    { sibling: "Workbook", want: CDFTypeXls },
    { sibling: "WordDocument", want: CDFTypeDoc },
    { sibling: "PowerPoint Document", want: CDFTypePpt },
    { sibling: "\x05DigitalSignature", want: CDFTypeInstaller },
    // A non-distinctive sibling name yields no match, so detection
    // falls back to the generic OLE storage type.
    { sibling: "Contents", want: CDFTypeGeneric },
  ];
  for (const secSize of testSecSizes) {
    for (const tt of tests) {
      test(tt.sibling, () => {
        const summary = summaryStream("Unknown Application", false);
        const data = makeCDF(secSize, null, "\x05SummaryInformation", summary, {
          name: tt.sibling,
          typ: dirTypeUserStream,
        });
        expect(detect(data)).toBe(tt.want);
      });
    }
  }
});

// TestDetectFromSectionNames exercises the final fallback in Detect: no
// summary stream at all, detection relies on distinctive directory entries.
describe("TestDetectFromSectionNames", () => {
  const tests: { entry: entrySpec; want: CDFType }[] = [
    { entry: { name: "EncryptedPackage", typ: dirTypeUserStream }, want: CDFTypeGeneric },
    { entry: { name: "EncryptedSummary", typ: dirTypeUserStream }, want: CDFTypeGeneric },
    { entry: { name: "Book", typ: dirTypeUserStream }, want: CDFTypeXls },
    { entry: { name: "Workbook", typ: dirTypeUserStream }, want: CDFTypeXls },
    { entry: { name: "WordDocument", typ: dirTypeUserStream }, want: CDFTypeDoc },
    { entry: { name: "PowerPoint Document", typ: dirTypeUserStream }, want: CDFTypePpt },
    { entry: { name: "__properties_version1.0", typ: dirTypeUserStream }, want: CDFTypeMsg },
    {
      entry: { name: "__recip_version1.0_#00000000", typ: dirTypeUserStorage },
      want: CDFTypeMsg,
    },
    // A non-distinctive entry matches nothing and degrades to generic.
    { entry: { name: "Contents", typ: dirTypeUserStream }, want: CDFTypeGeneric },
  ];
  for (const secSize of testSecSizes) {
    for (const tt of tests) {
      test(tt.entry.name, () => {
        const data = makeCDF(secSize, null, "", null, tt.entry);
        expect(detect(data)).toBe(tt.want);
      });
    }
  }
});

// TestDetectMasterSATExtension builds a file whose SAT does not fit in the
// 109 header slots, so part of it must be loaded through the master SAT
// extension chain. The directory and streams live in sectors mapped only by
// the extension SAT sector, so detection fails unless the chain is followed.
test("TestDetectMasterSATExtension", () => {
  const msatSec = 109; // master SAT extension sector
  const extSATSec = 110; // SAT sector referenced from the extension
  const dirSec = 13952; // first sector mapped by extSATSec (109*128)
  const rootSec = 13953;
  const summarySec = 13954;
  const nSectors = summarySec + 1;
  const summary = summaryStream("Microsoft Excel", false);

  const data = new Uint8Array((1 + nSectors) * testSecSize);
  const sector = (id: number): Uint8Array => {
    const off = (1 + id) * testSecSize;
    return data.subarray(off, off + testSecSize);
  };

  const masterSAT: number[] = [];
  for (let i = 0; i < masterSATSize; i++) {
    masterSAT.push(i); // SAT occupies sectors 0..108
  }
  copyInto(data, testHeader(testSecSize, dirSec, -2, 0, masterSAT));
  put32(data, 68, msatSec); // first extension sector
  put32(data, 72, 1); // one extension sector

  // Mark every SAT entry free, then set the entries actually used.
  for (let i = 0; i < masterSATSize; i++) {
    copyInto(sector(i), idSector(testSecSize));
  }
  const satIDs: number[] = [];
  for (let i = 0; i < testSecSize / 4; i++) {
    satIDs.push(-1);
  }
  for (let i = 0; i <= extSATSec; i++) {
    satIDs[i] = -3; // sectors 0..110 hold SAT/MSAT data
  }
  copyInto(sector(0), idSector(testSecSize, satIDs));

  // The extension lists one extra SAT sector; remaining slots are free.
  copyInto(sector(msatSec), idSector(testSecSize, [extSATSec]));
  // extSATSec maps sectors 13952..14079: dir, root stream and summary are
  // all single-sector chains.
  copyInto(sector(extSATSec), idSector(testSecSize, [-2, -2, -2]));

  let dir = dirEntryBytes("Root Entry", dirTypeRootStorage, rootSec, testSecSize, null);
  dir = concat(
    dir,
    dirEntryBytes("\x05SummaryInformation", dirTypeUserStream, summarySec, summary.length, null),
  );
  copyInto(sector(dirSec), dir);
  copyInto(sector(summarySec), summary);

  expect(detect(data)).toBe(CDFTypeXls);
});

// TestDetectShortStreamSummary stores the summary stream in the short-sector
// pool, exercising the SSAT and readShort paths.
test("TestDetectShortStreamSummary", () => {
  const summary = summaryStream("Microsoft Office Word", false);
  expect(summary.length > 64 && summary.length <= testSecSize).toBe(true);

  let dir = dirEntryBytes("Root Entry", dirTypeRootStorage, 2, testSecSize, null);
  // streamFirst is a short-sector id because size < minStdStream.
  dir = concat(
    dir,
    dirEntryBytes("\x05SummaryInformation", dirTypeUserStream, 0, summary.length, null),
  );

  // sector 0: SAT, sector 1: dir, sector 2: short-sector pool, sector 3: SSAT
  const nShort = Math.floor((summary.length + 63) / 64);
  const ssat: number[] = [];
  for (let i = 0; i < nShort - 1; i++) {
    ssat.push(i + 1);
  }
  ssat.push(-2);

  const data = concat(
    testHeader(testSecSize, 1, 3, 4096, [0]),
    idSector(testSecSize, [-3, -2, -2, -2]),
    padSector(testSecSize, dir),
    padSector(testSecSize, summary), // pool holds the summary in 64-byte short sectors
    idSector(testSecSize, ssat),
  );

  expect(detect(data)).toBe(CDFTypeDoc);
});

// TestDetectShortStreamMultiSectorSSAT verifies that detection still succeeds
// when the short-stream we care about lives outside the first SSAT sector.
// With secSize=512 each SSAT sector holds 128 entries, so placing the summary
// at short-sector id 128 forces the lookup to descend into the second SSAT
// sector. Any per-sector bound (e.g. ssatLen() returning secSize/4) would
// wrongly reject sid=128 and cause detection to fall back to CDFTypeGeneric.
test("TestDetectShortStreamMultiSectorSSAT", () => {
  const shortSecSz = 64;
  const perSec = testSecSize / 4; // 128 SSAT entries per long sector
  const sstSectors = 17; // SST must reach short-sector 128 (offset 8192)
  const firstSST = 2;
  const lastSST = firstSST + sstSectors - 1;
  const ssatSecA = lastSST + 1;
  const ssatSecB = ssatSecA + 1;
  const sidB0 = perSec; // first short-sector id in the second SSAT sector

  const summary = summaryStream("Microsoft Office Word", false);
  expect(summary.length <= 2 * shortSecSz).toBe(true);

  let dir = dirEntryBytes(
    "Root Entry",
    dirTypeRootStorage,
    firstSST,
    sstSectors * testSecSize,
    null,
  );
  dir = concat(
    dir,
    dirEntryBytes("\x05SummaryInformation", dirTypeUserStream, sidB0, summary.length, null),
  );

  // SAT layout: SAT itself, dir, chained SST sectors, two SSAT sectors.
  const sat: number[] = [];
  for (let i = 0; i < perSec; i++) {
    sat.push(-1);
  }
  sat[0] = -3;
  sat[1] = -2;
  for (let s = firstSST; s < lastSST; s++) {
    sat[s] = s + 1;
  }
  sat[lastSST] = -2;
  sat[ssatSecA] = ssatSecB;
  sat[ssatSecB] = -2;

  // Short-stream pool: 17 long sectors. Place the summary at short-sid 128,
  // which lives at byte offset 128*64 = 8192 inside the pool.
  const sst = new Uint8Array(sstSectors * testSecSize);
  copyInto(sst.subarray(sidB0 * shortSecSz), summary);

  // First SSAT sector: nothing useful (all entries free).
  // Second SSAT sector: chain short-sector 128 → 129 → end, so a correct
  // reader can recover the summary stream from the pool.
  const nShort = Math.floor((summary.length + shortSecSz - 1) / shortSecSz);
  const ssatB: number[] = [];
  for (let i = 0; i < perSec; i++) {
    ssatB.push(-1);
  }
  for (let i = 0; i < nShort - 1; i++) {
    ssatB[i] = sidB0 + i + 1;
  }
  ssatB[nShort - 1] = -2;

  const data = concat(
    testHeader(testSecSize, 1, ssatSecA, 4096, [0]),
    idSector(testSecSize, sat),
    padSector(testSecSize, dir),
    sst,
    idSector(testSecSize),
    idSector(testSecSize, ssatB),
  );

  expect(detect(data)).toBe(CDFTypeDoc); // short stream in 2nd SSAT sector
});

// makeFragmentedDirCDF builds a CDF whose directory stream spans two
// physically non-contiguous long sectors. Layout:
//   sector 0: SAT
//   sector 1: directory part 1 (contains Root Entry)
//   sector 2: filler (free sector; SAT entry is -1)
//   sector 3: directory part 2 (contains a WordDocument entry)
// The directory chain in the SAT is 1 → 3 → -2, so the second dir sector is
// only reachable via a fragmented walk.
function makeFragmentedDirCDF(secSize: number): Uint8Array {
  const dir1 = dirEntryBytes("Root Entry", dirTypeRootStorage, -1, 0, null);
  const dir2 = dirEntryBytes("WordDocument", dirTypeUserStream, -1, 0, null);

  return concat(
    padSector(secSize, testHeader(secSize, 1, -1, 4096, [0])),
    idSector(secSize, [-3, 3, -1, -2]), // sector 0: SAT
    padSector(secSize, dir1), // sector 1: dir part 1
    padSector(secSize, null), // sector 2: filler
    padSector(secSize, dir2), // sector 3: dir part 2
  );
}

// TestDetectFragmentedDirChain verifies that detection still works when the
// directory stream is split across non-contiguous long sectors — a layout
// real-world CDF writers (MSI builders, edited Office documents) commonly
// produce. The distinctive entry (WordDocument) lives in the second dir
// sector, so a readLong implementation that only handles contiguous chains
// will miss it and incorrectly return CDFTypeGeneric.
describe("TestDetectFragmentedDirChain", () => {
  for (const secSize of testSecSizes) {
    test(`sec${secSize}`, () => {
      expect(detect(makeFragmentedDirCDF(secSize))).toBe(CDFTypeDoc);
    });
  }
});

// TestBuildSATTruncatedMSATNoPanic feeds a CDF whose master-SAT points at a
// partial (truncated) sector. The inner SAT loop walks perSec entries without
// checking len(msa), so a short sector triggers an index-out-of-range panic.
// CDF files use a sector size of either 512 (secP2 9) or 4096 (secP2 12); both
// are exercised here.
describe("TestBuildSATTruncatedMSATNoPanic", () => {
  const tests: { name: string; secP2: number; secSize: number }[] = [
    { name: "sector 512", secP2: 9, secSize: 512 },
    { name: "sector 4096", secP2: 12, secSize: 4096 },
  ];
  for (const tc of tests) {
    test(tc.name, () => {
      // One extra int32 (4 bytes) past the header: sector 0 starts at
      // offset secSize and is only 4 bytes long, so readInt32s yields a
      // single entry while the loop expects perSec of them.
      const data = new Uint8Array(tc.secSize + 4);
      data.set(cdfMagic, 0);
      put16(data, 30, tc.secP2);
      put16(data, 32, 6); // shortP2
      put32(data, 48, 0xffffffff); // firstDirSec = -1
      put32(data, 56, 4096); // minStdStream
      put32(data, 60, 0xffffffff); // firstSSAT = -1
      put32(data, 68, 0); // firstMSAT = sector 0
      put32(data, 72, 1); // nMSAT = 1
      // masterSAT[0] points past EOF so the header loop breaks
      // (errTruncated) and execution falls through to the master-SAT
      // extension loop.
      put32(data, 76, 100);
      for (let i = 1; i < masterSATSize; i++) {
        put32(data, 76 + 4 * i, 0xffffffff);
      }
      // data[secSize:secSize+4] = 0 -> msa = [0], a non-negative secid so
      // the loop keeps going and then dereferences msa[1].
      put32(data, tc.secSize, 0);

      expect(detect(data)).toBe(CDFTypeGeneric);
    });
  }
});

// TestCyclicChainBounded feeds a CDF whose SAT contains a self-referential
// entry (sector 1 points at itself) together with the maximum sector size of
// 1MiB (secP2 20). Walking such a cycle must be bounded by the input size: a
// stream can never be longer than the file. Without that bound the reader would
// follow the cycle thousands of times, each step appending a whole 1MiB sector,
// and attempt a multi-gigabyte allocation.
test("TestCyclicChainBounded", () => {
  const secP2Max = 20;
  const secSize = 1 << secP2Max;
  // Header region [0,secSize), then sector 0 and sector 1.
  const data = new Uint8Array(3 * secSize);
  data.set(cdfMagic, 0);
  put16(data, 30, secP2Max);
  put16(data, 32, 6); // shortP2
  put32(data, 48, 1); // firstDirSec = sector 1
  put32(data, 56, 4096); // minStdStream
  put32(data, 60, 0xffffffff); // firstSSAT = -1
  put32(data, 68, 0xffffffff); // firstMSAT = -1
  put32(data, 72, 0); // nMSAT = 0
  // masterSAT[0] = sector 0 holds the SAT; the rest are unused (-1).
  put32(data, 76, 0);
  for (let i = 1; i < masterSATSize; i++) {
    put32(data, 76 + 4 * i, 0xffffffff);
  }
  // SAT lives in sector 0 (file offset secSize). Make sat[1] = 1 so the
  // directory chain starting at sector 1 loops forever.
  put32(data, secSize + 4, 1);

  expect(detect(data)).toBe(CDFTypeGeneric);
});

// TestSummaryAppNameNoPanic feeds summaryAppName streams whose length/offset
// fields are crafted to overflow or go negative, plus one well-formed stream.
// Malformed inputs must not panic and must yield "". The sdOff case is
// 386-specific: int(sdOff) is negative there, so the bounds check is bypassed
// and stream[sdOff:] would panic.
describe("TestSummaryAppNameNoPanic", () => {
  const tests: { name: string; stream: () => Uint8Array; want: string }[] = [
    {
      // A well-formed stream with NameOfApplication = "Word".
      name: "valid app name",
      stream: () => {
        const stream = new Uint8Array(80);
        put32(stream, sectionDeclOffset + 16, 48); // sdOff -> section at 48
        const sec = stream.subarray(48);
        put32(sec, 0, 29); // shLen
        put32(sec, 4, 1); // nProps
        put32(sec, 8, propIDNameOfApplication);
        put32(sec, 12, 16); // off -> value at section[16:]
        put32(sec, 16, typeStringASCII); // step = 1
        put32(sec, 20, 5); // slen ("Word\0")
        sec.set(raw("Word\x00"), 24);
        return stream;
      },
      want: "Word",
    },
    {
      // off is near math.MaxUint32 so that off+8 overflows uint32 and
      // bypasses the bounds check, then section[off:] panics.
      name: "offset overflow",
      stream: () => {
        const stream = new Uint8Array(64);
        put32(stream, sectionDeclOffset + 16, 48); // sdOff -> section at 48
        const sec = stream.subarray(48);
        put32(sec, 0, 16); // shLen
        put32(sec, 4, 1); // nProps
        put32(sec, 8, propIDNameOfApplication);
        put32(sec, 12, 0xffffffff); // off; off+8 wraps to 7
        return stream;
      },
      want: "",
    },
    {
      // slen*step overflows uint32, producing end < start so that
      // section[start:end] panics.
      name: "length overflow",
      stream: () => {
        const stream = new Uint8Array(80);
        put32(stream, sectionDeclOffset + 16, 48); // sdOff -> section at 48
        const sec = stream.subarray(48);
        put32(sec, 0, 32); // shLen
        put32(sec, 4, 1); // nProps
        put32(sec, 8, propIDNameOfApplication);
        put32(sec, 12, 16); // off -> value at section[16:]
        put32(sec, 16, typeStringWide); // step = 2
        put32(sec, 20, 0xffffffff); // slen; slen*2 overflows uint32
        return stream;
      },
      want: "",
    },
    {
      // sdOff above math.MaxInt32. On 386 int(sdOff) is negative, the
      // bounds check passes and stream[sdOff:] panics.
      name: "sdOff negative on 386",
      stream: () => {
        const stream = new Uint8Array(64);
        put32(stream, sectionDeclOffset + 16, 0x80000000); // sdOff > MaxInt32
        return stream;
      },
      want: "",
    },
  ];
  for (const tc of tests) {
    test(tc.name, () => {
      const got = summaryAppName(tc.stream());
      expect(got === null ? "" : bytesToText(got)).toBe(tc.want);
    });
  }
});
