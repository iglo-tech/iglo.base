// The sample corpus of the MIME detection reference test (mimetype.test.ts):
// mimetype's testdata files, the inline samples of its mimetype_test.go
// table, and generated edge cases around the matchers and the 4096-byte read
// limit.

import { readdirSync } from "node:fs";

import { defaultLimit } from "@/tools/mimetype/mimetype";

import { bin, concat, disk, fixturesDir, g, raw } from "@test/tools/mimetype/go-literal";
import { testcases } from "@test/tools/mimetype/testcases";

export interface Sample {
  name: string;
  data: Uint8Array;
}

const samples: Array<Sample> = [];
const add = (name: string, data: Uint8Array) => samples.push({ name, data });

// mimetype's testdata
for (const name of readdirSync(fixturesDir).toSorted()) {
  if (!name.endsWith(".md") && name !== "LICENSE") {
    add(`testdata ${name}`, disk(name));
  }
}

// mimetype_test.go's table
for (const [name, data] of testcases) {
  add(`table ${name}`, data);
}

// repeat(s) until the result has n bytes, cut at n
function fill(head: Uint8Array, line: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  out.set(head.subarray(0, n));
  for (let off = head.length; off < n; off += line.length) {
    out.set(line.subarray(0, n - off), off);
  }
  return out;
}

// sizes around the read limit: under it, at it, and cut by it
const around = [defaultLimit - 1, defaultLimit, defaultLimit + 1, defaultLimit + 1000];

// empty input, one byte, BOMs
add("empty", new Uint8Array(0));
for (const b of [0x00, 0x09, 0x0a, 0x1b, 0x20, 0x41, 0x7f, 0x80, 0xc3, 0xff]) {
  add(`one byte ${b.toString(16)}`, Uint8Array.of(b));
}
const boms: Array<[string, Uint8Array]> = [
  ["utf-8", g`\xef\xbb\xbf`],
  ["utf-16be", g`\xfe\xff`],
  ["utf-16le", g`\xff\xfe`],
  ["utf-32be", g`\x00\x00\xfe\xff`],
  ["utf-32le", g`\xff\xfe\x00\x00`],
];
for (const [name, bom] of boms) {
  add(`bom ${name} alone`, bom);
  add(`bom ${name} text`, concat(bom, raw("hello")));
  add(`bom ${name} binary`, concat(bom, g`\x00\x01\x02\x03`));
  add(`bom ${name} html`, concat(bom, raw("<html><body>x</body></html>")));
  add(`bom ${name} xml`, concat(bom, raw(`<?xml version="1.0"?><a/>`)));
}
add("utf-16le text with bom", g`\xff\xfeh\x00e\x00l\x00l\x00o\x00`);
add("utf-16be text with bom", g`\xfe\xff\x00h\x00e\x00l\x00l\x00o`);
add("utf-16le text without bom", g`h\x00e\x00l\x00l\x00o\x00`);

// plain text: UTF-8, invalid UTF-8, Latin-1, Windows-1252, control bytes
add("ascii", raw("just some text\n"));
add("utf-8 multibyte", raw("zażółć gęślą jaźń ☃ 𝄞\n"));
add("utf-8 rune cut at the end", g`abc\xe2\x98`);
add("invalid utf-8 in the middle", g`abc\xc3\x28def`);
add("latin-1", g`caf\xe9 cr\xe8me`);
add("windows-1252", g`\x93quoted\x94 \x85`);
add("latin-1 with del", g`caf\xe9\x7f`);
add("utf-8 cut at the limit", fill(new Uint8Array(0), raw("żółw "), defaultLimit + 3));
add("latin-1 past 1024 bytes", concat(fill(new Uint8Array(0), raw("a"), 1100), g`\xe9`));
add("latin-1 within 1024 bytes", concat(fill(new Uint8Array(0), raw("a"), 1000), g`\xe9`));
for (let b = 0; b < 0x20; b++) {
  add(`control byte ${b.toString(16)}`, concat(raw("hello "), Uint8Array.of(b), raw(" world")));
}
add("binary byte after 4096", concat(fill(new Uint8Array(0), raw("a"), 4100), Uint8Array.of(0)));

// CSV and TSV, whole and cut at the read limit
add("csv two rows", raw("a,b,c\n1,2,3\n"));
add("csv quoted", raw(`"a","b,c"\n"1","2"\r\n`));
add("csv one row", raw("a,b,c\n"));
add("csv ragged", raw("a,b,c\n1,2\n"));
add("tsv two rows", raw("a\tb\n1\t2\n"));
add("csv comment line", raw("#comment\na,b\n1,2\n"));
for (const n of around) {
  add(`csv rows ${n}`, fill(raw("name,value,other\n"), raw('abc,12345,"x,y"\n'), n));
  add(`tsv rows ${n}`, fill(raw("name\tvalue\n"), raw("abc\t12345\n"), n));
  add(`csv crlf ${n}`, fill(raw("a,b\r\n"), raw("1,2\r\n"), n));
}
add("csv quoted newline cut", fill(raw("a,b\n"), raw(`1,"multi\nline"\n`), defaultLimit + 7));

// JSON and NDJSON, whole and cut at the read limit
add("json object", raw(`{"a": 1, "b": [true, false, null], "c": {"d": "e\\u00e9"}}`));
add("json array", raw(`[1, 2.5, -3e10, "x"]`));
add("json string only", raw(`"just a string"`));
add("json number only", raw("12345"));
add("json trailing comma", raw(`{"a": 1,}`));
add("json unicode escape cut", raw(`{"a": "\\u00`));
add("json with bom", concat(g`\xef\xbb\xbf`, raw(`{"a": 1}`)));
add("geojson", raw(`{"type": "Feature", "geometry": null}`));
add("har", raw(`{"log": {"version": "1.2", "entries": []}}`));
add("gltf", raw(`{"asset": {"version": "2.0"}}`));
add("cyclonedx json", raw(`{"bomFormat": "CycloneDX", "specVersion": "1.5"}`));
add("ndjson", raw(`{"a":1}\n{"a":2}\n[3]\n`));
add("ndjson scalars only", raw("1\n2\n3\n"));
add("json over lines", raw(`{"a":\n1}\n{"b":2}`));
for (const n of around) {
  add(`json array ${n}`, fill(raw("["), raw(`{"key": "value", "n": 12345},`), n));
  add(`json object string ${n}`, fill(raw(`{"key": "`), raw("abcdefghij"), n));
  add(`json number ${n}`, fill(raw(`{"key": 1`), raw("1234567890"), n));
  add(
    `geojson ${n}`,
    fill(raw(`{"type": "FeatureCollection", "features": [`), raw(`{"a": [1,2]},`), n),
  );
  add(`ndjson ${n}`, fill(new Uint8Array(0), raw(`{"key": "value", "n": [1, 2]}\n`), n));
}

// HTML variants and their charsets
const htmls = [
  "<html></html>",
  "<!DOCTYPE html><html><head><title>x</title></head></html>",
  "<!-- comment --><p>x</p>",
  "   \n<div>x</div>",
  "<HTML><BODY>X</BODY></HTML>",
  "<b>bold</b>",
  "<a href='x'>",
  "<htmlx>not html</htmlx>",
  `<meta charset="utf-8"><p>x`,
  `<meta charset="ISO-8859-2"><p>x`,
  `<META CHARSET=windows-1250>`,
  `<html><head><meta http-equiv="Content-Type" content="text/html; charset=koi8-r"></head>`,
  `<html><head><meta content="text/html; charset=koi8-r"></head>`,
  `<html><head><meta http-equiv="refresh" content="text/html; charset=x"></head>`,
  `<html><body><meta charset="utf-16"></body>`,
  `<html><!-- <meta charset="x"> --><meta charset="y">`,
  `<meta charset='a b'><p>x`,
  `<meta charset='a;charset=b'><p>x`,
  `<meta charset="  spaced  ">`,
  `<meta charset="">`,
  `<meta http-equiv="content-type" content="text/html; charset = 'quoted' ">`,
  `<meta http-equİv="content-type" content="text/html; charset=dotted-i">`,
];
for (const h of htmls) {
  add(`html ${h}`, raw(h));
}
add("html with latin-1 body", concat(raw("<p>caf"), g`\xe9</p>`));
add("html charset with invalid byte", concat(raw(`<meta charset="a`), g`\xff`, raw(`b">`)));
add("html charset with nbsp", concat(raw(`<meta charset="`), g`\xc2\xa0utf-8\xc2\xa0`, raw(`">`)));
add(
  "html meta after 1024 bytes",
  concat(raw("<p>"), fill(new Uint8Array(0), raw("x"), 1100), raw(`<meta charset="late">`)),
);
add(
  "html cut at the limit",
  fill(raw("<html><body>"), raw("<p>paragraph</p>\n"), defaultLimit + 50),
);

// XML variants
const xmls = [
  `<?xml version="1.0"?><root/>`,
  `<?xml version="1.0" encoding="ISO-8859-1"?><root/>`,
  `<?xml version='1.0' encoding='UTF-16'?><root/>`,
  `  <?xml version="1.0" encoding="x y"?><root/>`,
  `<?XML VERSION="1.0"?><root/>`,
  `<?xml version="1.0"?><rss version="2.0"></rss>`,
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`,
  `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"/>`,
  `<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1"/>`,
  `<?xml version="1.0"?><bom xmlns="http://cyclonedx.org/schema/bom/1.6"/>`,
  `<?xml version="1.0"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"><html/>`,
  `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"></html>`,
  `<?xml version="1.0"?><amf unit="mm"></amf>`,
];
for (const x of xmls) {
  add(`xml ${x}`, raw(x));
}
add("xml with latin-1 and no declaration", concat(raw(`<?xml version="1.0"?><a>caf`), g`\xe9</a>`));
add(
  "xml cut at the limit",
  fill(raw(`<?xml version="1.0"?><root>`), raw("<item>value</item>\n"), defaultLimit + 9),
);

// SVG
const svgs = [
  `<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
  `<!-- c --><svg width="1" xmlns="http://www.w3.org/2000/svg"/>`,
  `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"/>`,
  `<?xml encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"/>`,
  `<svg xmlns="http://example.com/other"></svg>`,
  `<svg></svg>`,
];
for (const s of svgs) {
  add(`svg ${s}`, raw(s));
}
add(
  "svg tag past 4096",
  concat(raw(`<?xml version="1.0"?>`), fill(new Uint8Array(0), raw(" "), 4200), raw("<svg")),
);

// scripts, subtitles and other text formats
const texts = [
  "#!/bin/sh\necho",
  "#! /usr/bin/env   python3\nprint()",
  "#!/usr/bin/env -S node --flag\n",
  "#!/usr/bin/perl -w\n",
  "#!/usr/bin/perlx\n",
  "#!/usr/local/bin/lua\n",
  "<?php echo 1;",
  "<?PHP\n",
  String.raw`{\rtf1\ansi}`,
  "1\n00:00:01,000 --> 00:00:02,500\nHello\n",
  "1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n",
  "1\n00:00:02,000 --> 00:00:01,000\nbackwards\n",
  "1\n24:00:01,000 --> 25:00:02,500\nbad hour\n",
  "1\n0:00:01,000 --> 00:00:02,5000\none digit\n",
  "1\n00:00:01.000 --> 00:00:02.500\nperiod\n",
  "WEBVTT\n\n00:01.000 --> 00:04.000\nx",
  "WEBVTT",
  "BEGIN:VCARD\nVERSION:3.0\nEND:VCARD",
  "begin:vcalendar\r\nEND:VCALENDAR",
  "From: a@example.com\nTo: b@example.com\nSubject: hi\n\nbody",
  "Message-Id: <x>\nmessage-id: <y>\n",
  "0 HEAD\n1 GEDC\n2 VERS 5.5.1",
  "P1\n# comment\n2 2\n0 1\n1 0",
  "P2\n2 0\n",
  "P7\nWIDTH 1\nHEIGHT 1\nDEPTH 1\nMAXVAL 255\nENDHDR\n",
  "#EXTM3U\n#EXTINF:1,x\n",
  "#?RADIANCE\n",
  "WARC/1.0\r\n",
  "%!PS-Adobe-3.0\n",
  "0\nSECTION\n",
  "-----BEGIN PKCS7-----\n",
];
for (const t of texts) {
  add(`text ${t}`, raw(t));
}
add("netpbm huge size", raw("P3\n99999999999999999999 1\n"));
add("netpbm signed size", raw("P3\n+5 -6\n"));

// zip-based formats: local file headers as Go's archive/zip writes them
function zipEntry(name: string, data: Uint8Array = new Uint8Array(0), extra = new Uint8Array(0)) {
  const header = new Uint8Array(30);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04_03_4b_50, true);
  view.setUint16(4, 20, true);
  view.setUint32(18, data.length, true);
  view.setUint32(22, data.length, true);
  view.setUint16(26, name.length, true);
  view.setUint16(28, extra.length, true);
  return concat(header, bin(name), extra, data);
}
const zips: Array<[string, Uint8Array]> = [
  ["empty entry", zipEntry("a.txt")],
  ["docx", concat(zipEntry("[Content_Types].xml"), zipEntry("word/document.xml"))],
  ["xlsx", concat(zipEntry("_rels/.rels"), zipEntry("xl/workbook.xml"))],
  ["pptx", concat(zipEntry("docProps/app.xml"), zipEntry("ppt/presentation.xml"))],
  ["vsdx", concat(zipEntry("[Content_Types].xml"), zipEntry("visio/document.xml"))],
  ["office with other first entry", concat(zipEntry("other"), zipEntry("word/document.xml"))],
  ["jar manifest", concat(zipEntry("META-INF/MANIFEST.MF"), zipEntry("A.class"))],
  ["jar dir", concat(zipEntry("META-INF/"), zipEntry("META-INF/MANIFEST.MF"))],
  ["jar executable", zipEntry("x", new Uint8Array(0), Uint8Array.of(0xfe, 0xca, 0, 0))],
  ["apk", concat(zipEntry("res/x"), zipEntry("classes.dex"))],
  ["epub", zipEntry("mimetype", raw("application/epub+zip"))],
  ["odt", zipEntry("mimetype", raw("application/vnd.oasis.opendocument.text"))],
  ["ott", zipEntry("mimetype", raw("application/vnd.oasis.opendocument.text-template"))],
  ["ods", zipEntry("mimetype", raw("application/vnd.oasis.opendocument.spreadsheet"))],
  ["odp", zipEntry("mimetype", raw("application/vnd.oasis.opendocument.presentation"))],
  ["odg", zipEntry("mimetype", raw("application/vnd.oasis.opendocument.graphics"))],
  ["sxc", zipEntry("mimetype", raw("application/vnd.sun.xml.calc"))],
  ["kmz", concat(zipEntry("files/"), zipEntry("doc.kml"))],
  ["zip with stored text", zipEntry("a.txt", fill(new Uint8Array(0), raw("hello "), 600))],
];
for (const [name, data] of zips) {
  add(`zip ${name}`, data);
}
add(
  "crx",
  concat(
    raw("Cr24"),
    Uint8Array.of(3, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0),
    raw("kkss"),
    zipEntry("a"),
  ),
);

// ftyp variants
const brands = [
  "isom",
  "mp41",
  "mp42",
  "avif",
  "avis",
  "3gp4",
  "3gp5",
  "3g2a",
  "KDDI",
  "F4A ",
  "M4A ",
  "M4B ",
  "M4V ",
  "M4VH",
  "mqt ",
  "heic",
  "heix",
  "hevc",
  "mif1",
  "msf1",
  "avic",
  "mj2s",
  "dby1",
  "qt  ",
  "moov",
  "crx ",
  "????",
];
for (const brand of brands) {
  add(`ftyp ${brand}`, concat(g`\x00\x00\x00\x18ftyp`, raw(brand), g`\x00\x00\x00\x00`));
}
add("ftyp with nonzero size byte", concat(raw("Xxxxftypisom"), g`\x00\x00`));
add("quicktime moov atom", g`\x00\x00\x00\x08moov\x00\x00\x00\x00`);
add("quicktime wide atom", g`\x00\x00\x00\x08wide\x00\x00\x00\x00`);
add("ftyp short", g`\x00\x00\x00\x18ftypis`);

// binary signatures cut short and mp3 frames
add("png cut", g`\x89PNG\r\n\x1a`);
add("png", g`\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR`);
add("jpeg", g`\xff\xd8\xff\xe0`);
add("gzip", g`\x1f\x8b\x08\x00`);
add("pdf after garbage", concat(fill(new Uint8Array(0), raw("x"), 500), raw("%PDF-1.7")));
add("pdf after 1024 bytes", concat(fill(new Uint8Array(0), raw("x"), 1030), raw("%PDF-1.7")));
add("ole cut", g`\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1`);
add("tar header only", disk("tar.tar").subarray(0, 512));
add("tar cut", disk("tar.tar").subarray(0, 511));
add("zlib text-like", raw("x^ hello"));
add("zlib", g`x\x9c\xcbH\xcd\xc9\xc9\x07\x00\x06,\x02\x15`);
add("id3", g`ID3\x04\x00\x00\x00\x00\x00\x10`);
const frame = new Uint8Array(417);
frame.set(g`\xff\xfb\x90\x00`);
add("mp3 frames", concat(frame, frame, frame, frame));
add("mp3 frame after garbage", concat(raw("garbage!"), frame, frame, frame));
add("mp3 single frame", frame);
add(
  "mp4 with mp3 inside",
  concat(g`\x00\x00\x00\x18ftypisom\x00\x00\x00\x00`, frame, frame, frame),
);

// An OLE2 file of 512-byte sectors (3 KiB, inside the read limit) whose root
// storage holds an ObjectPool storage with an embedded object's summary stream.
// The embedded summary is the first SummaryInformation a flat directory scan
// meets; the root's is the one that counts (v1.4.16, #837). pool is written at
// offset 200 of the root pool sector, for a name a matcher may find there.
function oleSummary(app: string): Uint8Array {
  const value = new Uint8Array(app.length + 1); // NUL-terminated
  for (let i = 0; i < app.length; i++) {
    value[i] = app.charCodeAt(i);
  }
  const section = new Uint8Array(24 + value.length);
  const sv = new DataView(section.buffer);
  sv.setUint32(0, section.length, true);
  sv.setUint32(4, 1, true); // one property
  sv.setUint32(8, 0x12, true); // NameOfApplication
  sv.setUint32(12, 16, true); // value offset in section
  sv.setUint32(16, 0x1e, true); // VT_LPSTR
  sv.setUint32(20, app.length + 1, true);
  section.set(value, 24);
  const stream = new Uint8Array(48 + section.length);
  new DataView(stream.buffer).setUint32(44, 48, true); // section offset
  stream.set(section, 48);
  return stream;
}

// oleEntry encodes one 128-byte directory entry; -1 is "none".
function oleEntry(
  name: string,
  typ: number,
  child: number,
  right: number,
  first: number,
  size: number,
): Uint8Array {
  const e = new Uint8Array(128);
  const v = new DataView(e.buffer);
  for (let i = 0; i < name.length; i++) {
    v.setUint16(2 * i, name.charCodeAt(i), true);
  }
  v.setUint16(64, 2 * (name.length + 1), true);
  e[66] = typ;
  v.setUint32(68, 0xff_ff_ff_ff, true); // left sibling
  v.setUint32(72, right >>> 0, true);
  v.setUint32(76, child >>> 0, true);
  v.setUint32(116, first >>> 0, true);
  v.setUint32(120, size, true);
  return e;
}

// pad512 zero-pads b to one 512-byte sector.
function pad512(b: Uint8Array): Uint8Array {
  const s = new Uint8Array(512);
  s.set(b.subarray(0, 512));
  return s;
}

function cdfEmbedded(rootApp: string, embeddedApp: string, pool = new Uint8Array(0)): Uint8Array {
  const header = new Uint8Array(512);
  const hv = new DataView(header.buffer);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  hv.setUint16(30, 9, true); // 512-byte sectors
  hv.setUint16(32, 6, true); // 64-byte short sectors
  hv.setUint32(48, 1, true); // first directory sector
  hv.setUint32(56, 0, true); // minStdStream: every stream in long sectors
  hv.setUint32(60, 0xff_ff_ff_fe, true); // no SSAT
  hv.setUint32(68, 0xff_ff_ff_fe, true); // no extra master SAT sectors
  hv.setUint32(72, 0, true);
  for (let i = 0; i < 109; i++) {
    hv.setUint32(76 + 4 * i, 0xff_ff_ff_ff, true);
  }
  hv.setUint32(76, 0, true); // master SAT: sector 0

  // Sector 0 is the SAT; 1 the directory; 2 the root's short pool; 3 and 4 the
  // two summary streams.
  const sat = new Uint8Array(512);
  const sv = new DataView(sat.buffer);
  for (let i = 0; i < 128; i++) {
    sv.setUint32(4 * i, 0xff_ff_ff_ff, true);
  }
  sv.setUint32(0, 0xff_ff_ff_fd, true); // the SAT itself
  for (let i = 1; i <= 4; i++) {
    sv.setUint32(4 * i, 0xff_ff_ff_fe, true); // single-sector chains
  }

  const embedded = oleSummary(embeddedApp);
  const root = oleSummary(rootApp);
  const dir = concat(
    oleEntry("Root Entry", 5, 2, -1, 2, 0), // child: ObjectPool
    oleEntry("\x05SummaryInformation", 2, -1, -1, 3, embedded.length), // embedded summary
    oleEntry("ObjectPool", 1, 1, 3, -2, 0), // child: entry 1; right: entry 3
    oleEntry("\x05SummaryInformation", 2, -1, -1, 4, root.length), // the root's summary
  );
  const rootPool = new Uint8Array(512);
  rootPool.set(pool.subarray(0, 512 - 200), 200);
  return concat(header, sat, pad512(dir), rootPool, pad512(embedded), pad512(root));
}

add(
  "cdf: Word root, embedded Excel object",
  cdfEmbedded("Microsoft Office Word", "Microsoft Excel"),
);
add(
  "cdf: Excel root, embedded Word object",
  cdfEmbedded("Microsoft Excel", "Microsoft Office Word"),
);
add(
  "cdf: Word root, Workbook name in the first 4 KiB",
  cdfEmbedded(
    "Microsoft Office Word",
    "Microsoft Office Word",
    Uint8Array.from(Array.from("Workbook").flatMap((c) => [c.charCodeAt(0), 0])),
  ),
);

// random bytes from a fixed seed
let seed = 0x5e_ed;
const rnd = () => {
  seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
  return seed >>> 24;
};
for (const n of [1, 3, 16, 100, 1000, defaultLimit + 100]) {
  add(`random ${n}`, Uint8Array.from({ length: n }, rnd));
}

export const corpus: ReadonlyArray<Sample> = samples;
