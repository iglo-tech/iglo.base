// Upstream: Go 1.27.2 net/http/internal/sniff.go (DetectContentType)
//
// No upstream test table for DetectContentType is available locally, so these
// cases are derived by tracing each signature in sniff.go by hand. Byte-string
// inputs use Go-style escapes: each char code is one byte.

import { expect, test } from "bun:test";
import { detectContentType } from "@/server/sniff";

const HTML = "text/html; charset=utf-8";
const XML = "text/xml; charset=utf-8";
const TEXT = "text/plain; charset=utf-8";
const BINARY = "application/octet-stream";

// b converts a byte string (char code = byte value, all < 256) to bytes.
function b(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function check(name: string, input: Uint8Array | string, want: string): void {
  test(name, () => {
    const data = typeof input === "string" ? b(input) : input;
    expect(detectContentType(data)).toBe(want);
  });
}

// Empty input: no signature matches and the text fallback accepts zero bytes.
check("empty input is text/plain", "", TEXT);
check("whitespace only is text/plain", "   \n\t", TEXT);

// HTML: every tag variant, lower/mixed case, and a tag-terminating byte (' ' or '>').
const htmlTags: [string, string][] = [
  ["<!DOCTYPE HTML>", "<!DOCTYPE HTML>"],
  ["<!DOCTYPE HTML with space", "<!DOCTYPE HTML "],
  ["<!doctype html> lower", "<!doctype html>"],
  ["<!DoCtYpE hTmL> mixed", "<!DoCtYpE hTmL>"],
  ["<HTML>", "<HTML>"],
  ["<html space", "<html "],
  ["<Html>", "<Html>"],
  ["<HEAD>", "<HEAD>"],
  ["<head>", "<head>"],
  ["<SCRIPT>", "<SCRIPT>"],
  ["<script>", "<script>"],
  ["<IFRAME>", "<IFRAME>"],
  ["<iframe>", "<iframe>"],
  ["<H1>", "<H1>"],
  ["<h1>", "<h1>"],
  ["<DIV>", "<DIV>"],
  ["<div>", "<div>"],
  ["<FONT>", "<FONT>"],
  ["<font>", "<font>"],
  ["<TABLE>", "<TABLE>"],
  ["<table>", "<table>"],
  ["<A>", "<A>"],
  ["<a>", "<a>"],
  ["<STYLE>", "<STYLE>"],
  ["<style>", "<style>"],
  ["<TITLE>", "<TITLE>"],
  ["<title>", "<title>"],
  ["<B>", "<B>"],
  ["<b>", "<b>"],
  ["<BODY>", "<BODY>"],
  ["<body>", "<body>"],
  ["<BR>", "<BR>"],
  ["<br>", "<br>"],
  ["<P>", "<P>"],
  ["<p>", "<p>"],
  ["<!-- comment -->", "<!-- comment -->"],
];
for (const [label, input] of htmlTags) {
  check(`html: ${label}`, input, HTML);
}

// Leading whitespace is skipped: tab, LF, form feed, CR and space.
check("html: leading tab/LF/FF/CR/space", " \t\r\n\x0c<html>", HTML);
check("html: leading whitespace before <p>", "\n\n  <p>x", HTML);
// Vertical tab is not whitespace in the sniffing algorithm; it is a binary byte.
check("html: VT before tag is not skipped", "\x0b<html>", BINARY);

// Tag-terminating byte is required and must be ' ' or '>'.
check("html: no terminating byte at end of data", "<html", TEXT);
check("html: tab is not a tag-terminating byte", "<html\t>", TEXT);
check("html: newline is not a tag-terminating byte", "<html\n", TEXT);
check("html: <!DOCTYPE HTML needs terminator", "<!DOCTYPE HTML", TEXT);
check("html: <!DOCTYPE HTMLX> is not an HTML doctype", "<!DOCTYPE HTMLX>", TEXT);
check("html: <!DOCTYPE with no HTML", "<!DOCTYPE", TEXT);
check("html: <!-- needs five bytes", "<!--", TEXT);
check("html: <pre> is not <P followed by TT", "<pre>", TEXT);
check("html: space between < and tag name", "< html>", TEXT);
check("html: tag not at start of data", "hello <html>", TEXT);

// <?xml is masked with 0xFF and skips leading whitespace; it is case-sensitive.
check("xml: declaration", '<?xml version="1.0"?>', XML);
check("xml: after leading whitespace", "\r\n\t <?xml", XML);
check("xml: uppercase is not matched", "<?XML version", TEXT);
check("xml: too short", "<?xm", TEXT);

// Exact-prefix and masked signatures for documents.
check("pdf: %PDF-", "%PDF-1.7", "application/pdf");
check("pdf: %PDF without dash is text", "%PDF", TEXT);
check("postscript: %!PS-Adobe-", "%!PS-Adobe-3.0", "application/postscript");
check("postscript: too short", "%!PS-Adobe", TEXT);

// UTF BOMs are masked: only the listed bytes are compared.
check("bom: UTF-16BE", "\xFE\xFF\x00\x41", "text/plain; charset=utf-16be");
check(
  "bom: UTF-16BE, masked zero bytes ignore data",
  "\xFE\xFF\x12\x34",
  "text/plain; charset=utf-16be",
);
check("bom: UTF-16BE needs four bytes", "\xFE\xFF\x00", BINARY);
check("bom: UTF-16LE", "\xFF\xFE\x00\x00", "text/plain; charset=utf-16le");
check("bom: UTF-16LE needs four bytes", "\xFF\xFE\x00", BINARY);
check("bom: UTF-8 with masked fourth byte", "\xEF\xBB\xBF\x00", TEXT);
check("bom: UTF-8 three bytes falls to text fallback", "\xEF\xBB\xBF", TEXT);

// Image types.
check("image: ICO", "\x00\x00\x01\x00", "image/x-icon");
check("image: CUR", "\x00\x00\x02\x00", "image/x-icon");
check("image: BMP", "BM", "image/bmp");
check("image: GIF87a", "GIF87a", "image/gif");
check("image: GIF89a with trailing binary", "GIF89a" + "\x00".repeat(600), "image/gif");
check("image: WebP", "RIFF\x00\x00\x00\x00WEBPVP8 ", "image/webp");
check("image: WebP with non-zero size field", "RIFF\x12\x34\x56\x78WEBPVP8L", "image/webp");
check("image: RIFF with wrong WebP tail is binary", "RIFF\x00\x00\x00\x00WEBPXX", BINARY);
check("image: PNG", "\x89PNG\x0D\x0A\x1A\x0A", "image/png");
check("image: JPEG", "\xFF\xD8\xFF", "image/jpeg");
check("image: JPEG with more bytes", "\xFF\xD8\xFF\xE0\x00\x10", "image/jpeg");

// Audio and video: pattern ordering as in the spec.
check("av: AIFF", "FORM\x00\x00\x00\x00AIFFCOMM", "audio/aiff");
check("av: ID3 (mpeg)", "ID3\x03\x00", "audio/mpeg");
check("av: Ogg", "OggS\x00\x02", "application/ogg");
check("av: Ogg needs NUL at offset 4", "OggS\x01", BINARY);
check("av: MIDI", "MThd\x00\x00\x00\x06\x00\x01", "audio/midi");
check("av: MIDI header too short", "MThd\x00\x00\x00", BINARY);
check("av: AVI", "RIFF\x00\x00\x00\x00AVI LIST", "video/avi");
check("av: WAVE", "RIFF\x00\x00\x00\x00WAVEfmt ", "audio/wave");
check("av: WebM", "\x1A\x45\xDF\xA3\x01", "video/webm");

// mp4: ftyp box with "mp4" as a brand, skipping the version field at offset 12.
// Box size is the big-endian uint32 at offset 0; it must be a multiple of 4
// and no larger than the data.
check(
  "mp4: mp41 in compatible brands",
  "\x00\x00\x00\x18ftypisom\x00\x00\x00\x01mp41isom",
  "video/mp4",
);
check("mp4: mp42 as major brand", "\x00\x00\x00\x10ftypmp42\x00\x00\x00\x00", "video/mp4");
check("mp4: mp4 only in version field is ignored", "\x00\x00\x00\x10ftypisommp4 ", BINARY);
check("mp4: box size larger than data", "\x00\x00\x00\x1Aftypisom\x00\x00\x00\x01mp41isom", BINARY);
check(
  "mp4: box size not a multiple of 4",
  "\x00\x00\x00\x16ftypisom\x00\x00\x00\x01mp41isom",
  BINARY,
);
check("mp4: box type is not ftyp", "\x00\x00\x00\x10freeisom\x00\x00\x00\x00mp41", BINARY);
check("mp4: zero box size", "\x00\x00\x00\x00ftypmp41", BINARY);
check("mp4: under 12 bytes", "\x00\x00\x00\x08ftyp", BINARY);

// Fonts.
check(
  "font: EOT (34 NULs then LP)",
  "\x00".repeat(34) + "LP\x00\x00",
  "application/vnd.ms-fontobject",
);
check("font: EOT with wrong trailer is binary", "\x00".repeat(34) + "LQ", BINARY);
check("font: TrueType", "\x00\x01\x00\x00\x00", "font/ttf");
check("font: OpenType CFF", "OTTO\x00", "font/otf");
check("font: TrueType collection", "ttcf\x00", "font/collection");
check("font: WOFF", "wOFF\x00", "font/woff");
check("font: WOFF2", "wOF2\x00", "font/woff2");

// Archives and wasm.
check("archive: gzip", "\x1F\x8B\x08\x00", "application/x-gzip");
check("archive: zip", "PK\x03\x04\x14", "application/zip");
check("archive: RAR v1.5-v4.0", "Rar!\x1A\x07\x00", "application/x-rar-compressed");
check("archive: RAR v5+", "Rar!\x1A\x07\x01\x00", "application/x-rar-compressed");
check("archive: RAR prefix only is binary", "Rar!\x1A\x07\x01", BINARY);
check("wasm: magic", "\x00asm\x01\x00\x00\x00", "application/wasm");

// Text fallback versus binary control bytes.
check("text: ASCII words", "hello, world\n", TEXT);
check("text: tab, LF, form feed, CR, space", "\x09\x0A\x0C\x0D\x20", TEXT);
check("text: ESC (0x1B) is allowed", "\x1B", TEXT);
check("text: DEL (0x7F) is allowed", "\x7F", TEXT);
check("text: UTF-8 bytes are allowed", "\xC3\xA9", TEXT);
check("binary: NUL", "\x00", BINARY);
check("binary: BS (0x08)", "\x08", BINARY);
check("binary: VT (0x0B)", "\x0B", BINARY);
check("binary: SO (0x0E)", "\x0E", BINARY);
check("binary: SUB (0x1A)", "\x1A", BINARY);
check("binary: FS (0x1C)", "\x1C", BINARY);
check("binary: US (0x1F)", "\x1F", BINARY);
check("binary: NUL inside text", "hello\x00world", BINARY);

// The algorithm looks at no more than the first 512 bytes.
check("limit: NUL at index 511 is seen", "a".repeat(511) + "\x00", BINARY);
check("limit: NUL at index 512 is ignored", "a".repeat(512) + "\x00", TEXT);
check("limit: NUL far past the window is ignored", "a".repeat(600) + "\x00", TEXT);
check("limit: html tag ends at index 511", " ".repeat(506) + "<html>", HTML);
check("limit: html terminator at index 512 is not seen", " ".repeat(507) + "<html>", TEXT);
check("limit: html start beyond window", " ".repeat(600) + "<html>", TEXT);
check(
  "limit: signature inside window with bytes after",
  "GIF89a" + "\x00".repeat(600),
  "image/gif",
);

// The input may be a view into a larger buffer.
test("view: subarray with non-zero byteOffset", () => {
  const backing = b("\x00\x00\x00\x00GIF89a");
  expect(detectContentType(backing.subarray(4))).toBe("image/gif");
});
