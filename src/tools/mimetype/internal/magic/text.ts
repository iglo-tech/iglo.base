// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/text.go.

import { contains, equal, hasPrefix, index, lit } from "@/tools/mimetype/go-bytes";
import { fromBOM } from "@/tools/mimetype/internal/charset/charset";
import {
  QueryCDX,
  QueryGLTF,
  QueryGeo,
  QueryHAR,
  QueryNone,
  TokArray,
  TokObject,
  parse as jsonParse,
} from "@/tools/mimetype/internal/json/parser";
import {
  ciPrefix,
  markup,
  shebang,
  xml,
  type shebangSig,
  type xmlSig,
} from "@/tools/mimetype/internal/magic/magic";
import { getAnAttribute, skipAComment } from "@/tools/mimetype/internal/markup/markup";
import {
  Bytes,
  CompactWS,
  FullWord,
  IgnoreCase,
  byteIsWS,
} from "@/tools/mimetype/internal/scan/bytes";
import { parse as timeParse, type ParsedTime } from "@/tools/types/go-time";
import { bytesToText } from "@/tools/types/go-json";

const sigs = (...s: string[]) => s.map(lit);

const htmlSigs = sigs(
  "<!DOCTYPE HTML",
  "<HTML",
  "<HEAD",
  "<SCRIPT",
  "<IFRAME",
  "<H1",
  "<DIV",
  "<FONT",
  "<TABLE",
  "<A",
  "<STYLE",
  "<TITLE",
  "<B",
  "<BODY",
  "<BR",
  "<P",
  "<!--",
);
// HTML matches a Hypertext Markup Language file.
export function HTML(raw: Uint8Array, _limit: number): boolean {
  return markup(raw, ...htmlSigs);
}

const xmlDecl = lit("<?XML");
// XML matches an Extensible Markup Language file.
export function XML(raw: Uint8Array, _limit: number): boolean {
  return markup(raw, xmlDecl);
}

const sig = (localName: string, xmlns: string): xmlSig => ({
  localName: lit(localName),
  xmlns: lit(xmlns),
});

const owl2Sigs = [sig("<Ontology", `xmlns="http://www.w3.org/2002/07/owl#"`)];
// Owl2 matches an Owl ontology file.
export function Owl2(raw: Uint8Array, _limit: number): boolean {
  return xml(raw, ...owl2Sigs);
}

const rssSigs = [sig("<rss", "")];
// Rss matches a Rich Site Summary file.
export function Rss(raw: Uint8Array, _limit: number): boolean {
  return xml(raw, ...rssSigs);
}

const atomSigs = [sig("<feed", `xmlns="http://www.w3.org/2005/Atom"`)];
// Atom matches an Atom Syndication Format file.
export function Atom(raw: Uint8Array, _limit: number): boolean {
  return xml(raw, ...atomSigs);
}

const kmlSigs = [
  sig("<kml", `xmlns="http://www.opengis.net/kml/2.2"`),
  sig("<kml", `xmlns="http://earth.google.com/kml/2.0"`),
  sig("<kml", `xmlns="http://earth.google.com/kml/2.1"`),
  sig("<kml", `xmlns="http://earth.google.com/kml/2.2"`),
];
// Kml matches a Keyhole Markup Language file.
export function Kml(raw: Uint8Array, _limit: number): boolean {
  return xml(raw, ...kmlSigs);
}

const xliffSigs = [sig("<xliff", `xmlns="urn:oasis:names:tc:xliff:document:1.2"`)];
// Xliff matches a XML Localization Interchange File Format file.
export function Xliff(raw: Uint8Array, _limit: number): boolean {
  return xml(raw, ...xliffSigs);
}

const colladaSigs = [sig("<COLLADA", `xmlns="http://www.collada.org/2005/11/COLLADASchema"`)];
// Collada matches a COLLAborative Design Activity file.
export function Collada(raw: Uint8Array, _limit: number): boolean {
  return xml(raw, ...colladaSigs);
}

const gmlSigs = [
  sig("", `xmlns:gml="http://www.opengis.net/gml"`),
  sig("", `xmlns:gml="http://www.opengis.net/gml/3.2"`),
  sig("", `xmlns:gml="http://www.opengis.net/gml/3.3/exr"`),
];
// Gml matches a Geography Markup Language file.
export function Gml(raw: Uint8Array, _limit: number): boolean {
  return xml(raw, ...gmlSigs);
}

const gpxSigs = [sig("<gpx", `xmlns="http://www.topografix.com/GPX/1/1"`)];
// Gpx matches a GPS Exchange Format file.
export function Gpx(raw: Uint8Array, _limit: number): boolean {
  return xml(raw, ...gpxSigs);
}

const tcxSigs = [
  sig(
    "<TrainingCenterDatabase",
    `xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"`,
  ),
];
// Tcx matches a Training Center XML file.
export function Tcx(raw: Uint8Array, _limit: number): boolean {
  return xml(raw, ...tcxSigs);
}

const x3dSigs = [sig("<X3D", `xmlns:xsd="http://www.w3.org/2001/XMLSchema-instance"`)];
// X3d matches an Extensible 3D Graphics file.
export function X3d(raw: Uint8Array, _limit: number): boolean {
  return xml(raw, ...x3dSigs);
}

const amfSigs = [sig("<amf", "")];
// Amf matches an Additive Manufacturing XML file.
export function Amf(raw: Uint8Array, _limit: number): boolean {
  return xml(raw, ...amfSigs);
}

const threemfSigs = [
  sig("<model", `xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"`),
];
// Threemf matches a 3D Manufacturing Format file.
export function Threemf(raw: Uint8Array, _limit: number): boolean {
  return xml(raw, ...threemfSigs);
}

const xfdfSigs = [sig("<xfdf", `xmlns="http://ns.adobe.com/xfdf/"`)];
// Xfdf matches a XML Forms Data Format file.
export function Xfdf(raw: Uint8Array, _limit: number): boolean {
  return xml(raw, ...xfdfSigs);
}

// xmlns is missing the version suffix because there are too many past versions
// and probably future versions to come.
const cdxxmlSigs = [sig("<bom", `xmlns="http://cyclonedx.org/schema/bom/`)];
// CDXXML matches a CycloneDX XML BOM file.
// https://cyclonedx.org/docs/1.7/xml/
export function CDXXML(raw: Uint8Array, _limit: number): boolean {
  return xml(raw, ...cdxxmlSigs);
}

const vcardSigs = sigs("BEGIN:VCARD\n", "BEGIN:VCARD\r\n");
// VCard matches a Virtual Contact File.
export function VCard(raw: Uint8Array, _limit: number): boolean {
  return ciPrefix(raw, ...vcardSigs);
}

const icalendarSigs = sigs("BEGIN:VCALENDAR\n", "BEGIN:VCALENDAR\r\n");
// ICalendar matches a iCalendar file.
export function ICalendar(raw: Uint8Array, _limit: number): boolean {
  return ciPrefix(raw, ...icalendarSigs);
}

const snone = 0;
const scws = CompactWS;
const sfw = FullWord;
const scwsfw = CompactWS | FullWord;

const sb = (s: string, flag: number): shebangSig => ({ sig: lit(s), flag });

const phpPageSigs = sigs("<?PHP", "<?\n", "<?\r", "<? ");
function phpPageF(raw: Uint8Array, _limit: number): boolean {
  return ciPrefix(raw, ...phpPageSigs);
}
const phpScriptSigs = [
  sb("/usr/local/bin/php", snone),
  sb("/usr/bin/php", snone),
  sb("/usr/bin/env php", scws),
  sb("/usr/bin/env -S php", scws),
];
function phpScriptF(raw: Uint8Array, _limit: number): boolean {
  return shebang(raw, ...phpScriptSigs);
}

const jsSigs = [
  sb("/bin/node", snone),
  sb("/usr/bin/node", snone),
  sb("/bin/nodejs", snone),
  sb("/usr/bin/nodejs", snone),
  sb("/usr/bin/env node", scws),
  sb("/usr/bin/env -S node", scws),
  sb("/usr/bin/env nodejs", scws),
  sb("/usr/bin/env -S nodejs", scws),
];
// Js matches a Javascript file.
export function Js(raw: Uint8Array, _limit: number): boolean {
  return shebang(raw, ...jsSigs);
}

const luaSigs = [
  sb("/usr/bin/lua", sfw),
  sb("/usr/local/bin/lua", sfw),
  sb("/usr/bin/env lua", scwsfw),
  sb("/usr/bin/env -S lua", scwsfw),
];
// Lua matches a Lua programming language file.
export function Lua(raw: Uint8Array, _limit: number): boolean {
  return shebang(raw, ...luaSigs);
}

const perlSigs = [
  sb("/usr/bin/perl", sfw),
  sb("/usr/bin/env perl", scwsfw),
  sb("/usr/bin/env -S perl", scwsfw),
];
// Perl matches a Perl programming language file.
export function Perl(raw: Uint8Array, _limit: number): boolean {
  return shebang(raw, ...perlSigs);
}

const pythonSigs = [
  sb("/usr/bin/python", snone),
  sb("/usr/local/bin/python", snone),
  sb("/usr/bin/env python", scws),
  sb("/usr/bin/env -S python", scws),
  sb("/usr/bin/python2", snone),
  sb("/usr/local/bin/python2", snone),
  sb("/usr/bin/env python2", scws),
  sb("/usr/bin/env -S python2", scws),
  sb("/usr/bin/python3", snone),
  sb("/usr/local/bin/python3", snone),
  sb("/usr/bin/env python3", scws),
  sb("/usr/bin/env -S python3", scws),
];
// Python matches a Python programming language file.
export function Python(raw: Uint8Array, _limit: number): boolean {
  return shebang(raw, ...pythonSigs);
}

const rubySigs = [
  sb("/usr/bin/ruby", snone),
  sb("/usr/local/bin/ruby", snone),
  sb("/usr/bin/env ruby", scws),
  sb("/usr/bin/env -S ruby", scws),
];
// Ruby matches a Ruby programming language file.
export function Ruby(raw: Uint8Array, _limit: number): boolean {
  return shebang(raw, ...rubySigs);
}

const tclSigs = [
  sb("/usr/bin/tcl", snone),
  sb("/usr/local/bin/tcl", snone),
  sb("/usr/bin/env tcl", scws),
  sb("/usr/bin/env -S tcl", scws),
  sb("/usr/bin/tclsh", snone),
  sb("/usr/local/bin/tclsh", snone),
  sb("/usr/bin/env tclsh", scws),
  sb("/usr/bin/env -S tclsh", scws),
  sb("/usr/bin/wish", snone),
  sb("/usr/local/bin/wish", snone),
  sb("/usr/bin/env wish", scws),
  sb("/usr/bin/env -S wish", scws),
];
// Tcl matches a Tcl programming language file.
export function Tcl(raw: Uint8Array, _limit: number): boolean {
  return shebang(raw, ...tclSigs);
}

const rtfSig = lit("{\\rtf");
// Rtf matches a Rich Text Format file.
export function Rtf(raw: Uint8Array, _limit: number): boolean {
  return hasPrefix(raw, rtfSig);
}

const shellSigs = [
  sb("/bin/sh", sfw),
  sb("/bin/bash", sfw),
  sb("/usr/local/bin/bash", sfw),
  sb("/usr/bin/env bash", scwsfw),
  sb("/usr/bin/env -S bash", scwsfw),
  sb("/bin/csh", sfw),
  sb("/usr/local/bin/csh", sfw),
  sb("/usr/bin/env csh", scwsfw),
  sb("/usr/bin/env -S csh", scwsfw),
  sb("/bin/dash", sfw),
  sb("/usr/local/bin/dash", sfw),
  sb("/usr/bin/env dash", scwsfw),
  sb("/usr/bin/env -S dash", scwsfw),
  sb("/bin/ksh", sfw),
  sb("/usr/local/bin/ksh", sfw),
  sb("/usr/bin/env ksh", scwsfw),
  sb("/usr/bin/env -S ksh", scwsfw),
  sb("/bin/tcsh", sfw),
  sb("/usr/local/bin/tcsh", sfw),
  sb("/usr/bin/env tcsh", scwsfw),
  sb("/usr/bin/env -S tcsh", scwsfw),
  sb("/bin/zsh", sfw),
  sb("/usr/local/bin/zsh", sfw),
  sb("/usr/bin/env zsh", scwsfw),
  sb("/usr/bin/env -S zsh", scwsfw),
];
// Shell matches a shell script file.
export function Shell(raw: Uint8Array, _limit: number): boolean {
  return shebang(raw, ...shellSigs);
}

// Text matches a plain text file.
//
// TODO: This function does not parse BOM-less UTF16 and UTF32 files. Not really
// sure it should. libmagic also requires a BOM for UTF16 and UTF32.
export function Text(raw: Uint8Array, _limit: number): boolean {
  // First look for BOM.
  if (fromBOM(raw) !== "") {
    return true;
  }
  // Binary data bytes as defined here: https://mimesniff.spec.whatwg.org/#binary-data-byte
  for (let i = 0; i < Math.min(raw.length, 4096); i++) {
    const b = raw[i] as number;
    if (b <= 0x08 || b === 0x0b || (0x0e <= b && b <= 0x1a) || (0x1c <= b && b <= 0x1f)) {
      return false;
    }
  }
  return true;
}

const xhtmlDoctype = lit("<!DOCTYPE HTML");
const xhtmlRoot = lit("<HTML XMLNS=");
// XHTML matches an XHTML file. This check depends on the XML check to have passed.
export function XHTML(raw: Uint8Array, _limit: number): boolean {
  raw = raw.subarray(0, Math.min(raw.length, 1024));
  const b = new Bytes(raw);
  let [i] = b.search(xhtmlDoctype, CompactWS | IgnoreCase);
  if (i !== -1) {
    return true;
  }
  [i] = b.search(xhtmlRoot, CompactWS | IgnoreCase);
  return i !== -1;
}

// Php matches a PHP: Hypertext Preprocessor file.
export function Php(raw: Uint8Array, limit: number): boolean {
  if (phpPageF(raw, limit)) {
    return true;
  }
  return phpScriptF(raw, limit);
}

// JSON matches a JavaScript Object Notation file.
export function JSON(raw: Uint8Array, limit: number): boolean {
  // #175 A single JSON string, number or bool is not considered JSON.
  // JSON objects and arrays are reported as JSON.
  return jsonHelper(raw, limit, QueryNone, TokObject | TokArray);
}

// GeoJSON matches a RFC 7946 GeoJSON file.
//
// GeoJSON detection implies searching for key:value pairs like: `"type": "Feature"`
// in the input.
export function GeoJSON(raw: Uint8Array, limit: number): boolean {
  return jsonHelper(raw, limit, QueryGeo, TokObject);
}

// HAR matches a HAR Spec file.
// Spec: http://www.softwareishard.com/blog/har-12-spec/
export function HAR(raw: Uint8Array, limit: number): boolean {
  return jsonHelper(raw, limit, QueryHAR, TokObject);
}

// GLTF matches a GL Transmission Format (JSON) file.
// Visit [glTF specification] and [IANA glTF entry] for more details.
//
// [glTF specification]: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
// [IANA glTF entry]: https://www.iana.org/assignments/media-types/model/gltf+json
export function GLTF(raw: Uint8Array, limit: number): boolean {
  return jsonHelper(raw, limit, QueryGLTF, TokObject);
}

// CDXJSON matches a CycloneDX JSON BOM file.
// https://cyclonedx.org/docs/1.7/json/
export function CDXJSON(raw: Uint8Array, limit: number): boolean {
  return jsonHelper(raw, limit, QueryCDX, TokObject);
}

// jsonHelper parses raw and tries to match the q query against it. wantToks
// ensures we're not wasting time parsing an input that would not pass anyway,
// ex: the input is a valid JSON array, but we're looking for a JSON object.
function jsonHelper(raw: Uint8Array, limit: number, q: string, ...wantToks: number[]): boolean {
  const firstNonWS = new Bytes(raw).firstNonWS();

  let hasTargetTok = false;
  for (const t of wantToks) {
    hasTargetTok = hasTargetTok || ((t & TokArray) > 0 && firstNonWS === 0x5b);
    hasTargetTok = hasTargetTok || ((t & TokObject) > 0 && firstNonWS === 0x7b);
  }
  if (!hasTargetTok) {
    return false;
  }
  const lraw = raw.length;
  const [parsed, inspected, , querySatisfied] = jsonParse(q, raw);
  if (!querySatisfied) {
    return false;
  }

  // If the full file content was provided, check that the whole input was parsed.
  if (limit === 0 || lraw < limit) {
    return parsed === lraw;
  }

  // If a section of the file was provided, check if all of it was inspected.
  // In other words, check that if there was a problem parsing, that problem
  // occurred after the last byte in the input.
  return inspected === lraw && lraw > 0;
}

// NdJSON matches a Newline delimited JSON file. All complete lines from raw
// must be valid JSON documents meaning they contain one of the valid JSON data
// types.
export function NdJSON(raw: Uint8Array, _limit: number): boolean {
  let lCount = 0;
  let objOrArr = 0;

  const s = new Bytes(raw);
  while (s.length !== 0) {
    const l = s.line();
    const [parsed, inspected, firstToken] = jsonParse(QueryNone, l.b);
    // Only the last line may be truncated by the read limit; for it, it is
    // enough that the parser inspected all of it. Every other line must be a
    // complete, valid JSON document, otherwise a single JSON document spread
    // over multiple lines would be mistaken for NDJSON. #803
    if (s.length === 0) {
      if (inspected !== l.length) {
        return false;
      }
    } else if (parsed !== l.length) {
      return false;
    }
    if (firstToken === TokArray || firstToken === TokObject) {
      objOrArr++;
    }
    lCount++;
  }

  return lCount > 1 && objOrArr > 0;
}

// Svg matches a SVG file.
export function Svg(raw: Uint8Array, _limit: number): boolean {
  return svgWithoutXMLDeclaration(new Bytes(raw)) || svgWithXMLDeclaration(new Bytes(raw));
}

const svgTag = lit("<svg");
const svgTargetName = lit("xmlns");
const svgTargetVal = lit("http://www.w3.org/2000/svg");

// svgWithoutXMLDeclaration matches a SVG image that does not have an XML header.
// Example:
//
//	<!-- xml comment ignored -->
//	<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
//	    <rect fill="#fff" stroke="#000" x="-70" y="-70" width="390" height="390"/>
//	</svg>
function svgWithoutXMLDeclaration(s: Bytes): boolean {
  while (byteIsWS(s.peek())) {
    s.advance(1);
  }
  while (skipAComment(s)) {
    // skip
  }
  if (!hasPrefix(s.b, svgTag)) {
    return false;
  }

  let hasMore = true;
  while (hasMore) {
    const [aName, aVal, more] = getAnAttribute(s);
    hasMore = more;
    if (equal(aName ?? empty, svgTargetName) && equal(aVal ?? empty, svgTargetVal)) {
      return true;
    }
    if (!hasMore) {
      return false;
    }
  }
  return false;
}

const empty = new Uint8Array(0);
const xmlHeader = lit("<?xml");
const versionName = lit("version");

// svgWithXMLDeclaration matches a SVG image that has an XML header.
// Example:
//
//	<?xml version="1.0" encoding="UTF-8" standalone="no"?>
//	<svg width="391" height="391" viewBox="-70.5 -70.5 391 391" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
//	    <rect fill="#fff" stroke="#000" x="-70" y="-70" width="390" height="390"/>
//	</svg>
function svgWithXMLDeclaration(s: Bytes): boolean {
  while (byteIsWS(s.peek())) {
    s.advance(1);
  }
  if (!hasPrefix(s.b, xmlHeader)) {
    return false;
  }

  // version is a required attribute for XML.
  let hasVersion = false;
  let hasMore = true;
  while (hasMore) {
    const [aName, , more] = getAnAttribute(s);
    hasMore = more;
    if (equal(aName ?? empty, versionName)) {
      hasVersion = true;
      break;
    }
    if (!hasMore) {
      break;
    }
  }
  if (s.length > 4096) {
    s.b = s.b.subarray(0, 4096);
  }
  return hasVersion && contains(s.b, svgTag);
}

const srtSep = lit(" --> ");
const srtLayout = "15:04:05,000";

// time.Parse(layout, string(b)) as the part of a time.Time Srt compares
// (Go's zero date, so only the clock and nanoseconds differ), or null when
// Go returns an error.
function parseSrtTime(b: Uint8Array): number | null {
  let t: ParsedTime;
  try {
    t = timeParse(srtLayout, bytesToText(b));
  } catch {
    return null;
  }
  return ((t.hour * 60 + t.min) * 60 + t.sec) * 1e9 + t.nsec;
}

// Srt matches a SubRip file.
export function Srt(raw: Uint8Array, _limit: number): boolean {
  const s = new Bytes(raw);
  let line = s.line();

  // First line must be 1.
  if (line.length !== 1 || line.b[0] !== 0x31) {
    return false;
  }
  line = s.line();
  // Timestamp format (e.g: 00:02:16,612 --> 00:02:19,376) limits second line
  // length to exactly 29 characters.
  if (line.length !== 29) {
    return false;
  }
  // Decimal separator of fractional seconds in the timestamps must be a
  // comma, not a period.
  if (line.b.indexOf(0x2e) !== -1) {
    return false;
  }
  const i = index(line.b, srtSep);
  if (i === -1) {
    return false;
  }
  const t0 = parseSrtTime(line.b.subarray(0, i));
  if (t0 === null) {
    return false;
  }
  const t1 = parseSrtTime(line.b.subarray(i + srtSep.length));
  if (t1 === null) {
    return false;
  }
  if (t0 > t1) {
    return false;
  }

  line = s.line();
  // A third line must exist and not be empty. This is the actual subtitle text.
  return line.length !== 0;
}

const vttPrefixes = [
  [0xef, 0xbb, 0xbf, 0x57, 0x45, 0x42, 0x56, 0x54, 0x54, 0x0a], // UTF-8 BOM, "WEBVTT" and a line feed
  [0xef, 0xbb, 0xbf, 0x57, 0x45, 0x42, 0x56, 0x54, 0x54, 0x0d], // UTF-8 BOM, "WEBVTT" and a carriage return
  [0xef, 0xbb, 0xbf, 0x57, 0x45, 0x42, 0x56, 0x54, 0x54, 0x20], // UTF-8 BOM, "WEBVTT" and a space
  [0xef, 0xbb, 0xbf, 0x57, 0x45, 0x42, 0x56, 0x54, 0x54, 0x09], // UTF-8 BOM, "WEBVTT" and a horizontal tab
  [0x57, 0x45, 0x42, 0x56, 0x54, 0x54, 0x0a], // "WEBVTT" and a line feed
  [0x57, 0x45, 0x42, 0x56, 0x54, 0x54, 0x0d], // "WEBVTT" and a carriage return
  [0x57, 0x45, 0x42, 0x56, 0x54, 0x54, 0x20], // "WEBVTT" and a space
  [0x57, 0x45, 0x42, 0x56, 0x54, 0x54, 0x09], // "WEBVTT" and a horizontal tab
].map((p) => Uint8Array.from(p));
const vttBOM = Uint8Array.of(0xef, 0xbb, 0xbf, 0x57, 0x45, 0x42, 0x56, 0x54, 0x54); // UTF-8 BOM and "WEBVTT"
const vttPlain = Uint8Array.of(0x57, 0x45, 0x42, 0x56, 0x54, 0x54); // "WEBVTT"

// Vtt matches a Web Video Text Tracks (WebVTT) file. See
// https://www.iana.org/assignments/media-types/text/vtt.
export function Vtt(raw: Uint8Array, _limit: number): boolean {
  // Prefix match.
  for (const p of vttPrefixes) {
    if (hasPrefix(raw, p)) {
      return true;
    }
  }

  // Exact match.
  return equal(raw, vttBOM) || equal(raw, vttPlain);
}

interface rfc822Hint {
  h: Uint8Array;
  matchFlags: number;
}

const hint = (h: string, matchFlags: number): rfc822Hint => ({ h: lit(h), matchFlags });

// Some of the hints are IgnoreCase, some not. I selected based on what libmagic
// does and based on personal observations from sample files.
const rfc822Hints: rfc822Hint[] = [
  // Enron dataset has Message-ID, Message-Id and Message-id.
  hint("Message-ID: ", IgnoreCase),
  hint("From: ", 0),
  hint("To: ", 0),
  hint("CC: ", IgnoreCase),
  hint("Date: ", 0),
  hint("Subject: ", 0),
  hint("Received: ", 0),
  hint("Relay-Version: ", 0),
  hint("#! rnews", 0),
  hint("N#! rnews", 0),
  hint("Forward to", 0),
  hint("Pipe to", 0),
  hint("DELIVERED-TO: ", IgnoreCase),
  hint("RETURN-PATH: ", IgnoreCase),
  hint("Content-Type: ", 0),
  hint("Content-Transfer-Encoding: ", 0),
];

// The hints come from libmagic, but the implementation is bit different. libmagic
// only checks if the file starts with the hint, while we additionally look for
// a secondary hint in the first few lines of input.
export function RFC822(raw: Uint8Array, _limit: number): boolean {
  const b = new Bytes(raw);

  if (!lineHasRFC822Hint(b.line(), rfc822Hints)) {
    return false;
  }
  for (let i = 0; i < 20; i++) {
    if (lineHasRFC822Hint(b.line(), rfc822Hints)) {
      return true;
    }
  }

  return false;
}

function lineHasRFC822Hint(b: Bytes, hints: rfc822Hint[]): boolean {
  for (const h of hints) {
    if (b.match(h.h, h.matchFlags) > -1) {
      return true;
    }
  }
  return false;
}

const gedcomBOMs = [
  Uint8Array.of(0xef, 0xbb, 0xbf), // UTF-8
  Uint8Array.of(0xfe, 0xff), // UTF-16BE
  Uint8Array.of(0xff, 0xfe), // UTF-16LE
];
const gedcomHead = lit("0 HEAD");
const gedcomGedc = lit("1 GEDC");

export function GEDCOM(raw: Uint8Array, _limit: number): boolean {
  // Skip if empty
  if (raw.length === 0) {
    return false;
  }

  // GEDCOM header fits within first 4KB
  const searchLimit = Math.min(raw.length, 4096);
  raw = raw.subarray(0, searchLimit);

  const b = new Bytes(raw);

  // Skip BOM if present: UTF-8, UTF-16BE, UTF-16LE
  for (const bom of gedcomBOMs) {
    if (hasPrefix(b.b, bom)) {
      b.advance(bom.length);
      break; // Only one BOM can exist at the start
    }
  }

  b.trimLWS();

  const firstLine = b.line();
  if (!equal(firstLine.b, gedcomHead)) {
    return false;
  }

  // "1 GEDC" is mandatory in the header
  for (let i = 0; i < 10; i++) {
    const line = b.line();
    if (equal(line.b, gedcomGedc)) {
      return true;
    }
  }
  return false;
}
