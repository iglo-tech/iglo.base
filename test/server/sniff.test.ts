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
const htmlTags: Array<[string, string]> = [
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
check("html: leading tab/LF/FF/CR/space", " \t\r\n\u000c<html>", HTML);
check("html: leading whitespace before <p>", "\n\n  <p>x", HTML);
// Vertical tab is not whitespace in the sniffing algorithm; it is a binary byte.
check("html: VT before tag is not skipped", "\u000b<html>", BINARY);

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
check("bom: UTF-16BE", "\u00FE\u00FF\u0000\u0041", "text/plain; charset=utf-16be");
check(
  "bom: UTF-16BE, masked zero bytes ignore data",
  "\u00FE\u00FF\u0012\u0034",
  "text/plain; charset=utf-16be",
);
check("bom: UTF-16BE needs four bytes", "\u00FE\u00FF\u0000", BINARY);
check("bom: UTF-16LE", "\u00FF\u00FE\u0000\u0000", "text/plain; charset=utf-16le");
check("bom: UTF-16LE needs four bytes", "\u00FF\u00FE\u0000", BINARY);
check("bom: UTF-8 with masked fourth byte", "\u00EF\u00BB\u00BF\u0000", TEXT);
check("bom: UTF-8 three bytes falls to text fallback", "\u00EF\u00BB\u00BF", TEXT);

// Image types.
check("image: ICO", "\u0000\u0000\u0001\u0000", "image/x-icon");
check("image: CUR", "\u0000\u0000\u0002\u0000", "image/x-icon");
check("image: BMP", "BM", "image/bmp");
check("image: GIF87a", "GIF87a", "image/gif");
check("image: GIF89a with trailing binary", "GIF89a" + "\u0000".repeat(600), "image/gif");
check("image: WebP", "RIFF\u0000\u0000\u0000\u0000WEBPVP8 ", "image/webp");
check("image: WebP with non-zero size field", "RIFF\u0012\u0034\u0056\u0078WEBPVP8L", "image/webp");
check("image: RIFF with wrong WebP tail is binary", "RIFF\u0000\u0000\u0000\u0000WEBPXX", BINARY);
check("image: PNG", "\u0089PNG\u000D\u000A\u001A\u000A", "image/png");
check("image: JPEG", "\u00FF\u00D8\u00FF", "image/jpeg");
check("image: JPEG with more bytes", "\u00FF\u00D8\u00FF\u00E0\u0000\u0010", "image/jpeg");

// Audio and video: pattern ordering as in the spec.
check("av: AIFF", "FORM\u0000\u0000\u0000\u0000AIFFCOMM", "audio/aiff");
check("av: ID3 (mpeg)", "ID3\u0003\u0000", "audio/mpeg");
check("av: Ogg", "OggS\u0000\u0002", "application/ogg");
check("av: Ogg needs NUL at offset 4", "OggS\u0001", BINARY);
check("av: MIDI", "MThd\u0000\u0000\u0000\u0006\u0000\u0001", "audio/midi");
check("av: MIDI header too short", "MThd\u0000\u0000\u0000", BINARY);
check("av: AVI", "RIFF\u0000\u0000\u0000\u0000AVI LIST", "video/avi");
check("av: WAVE", "RIFF\u0000\u0000\u0000\u0000WAVEfmt ", "audio/wave");
check("av: WebM", "\u001A\u0045\u00DF\u00A3\u0001", "video/webm");

// mp4: ftyp box with "mp4" as a brand, skipping the version field at offset 12.
// Box size is the big-endian uint32 at offset 0; it must be a multiple of 4
// and no larger than the data.
check(
  "mp4: mp41 in compatible brands",
  "\u0000\u0000\u0000\u0018ftypisom\u0000\u0000\u0000\u0001mp41isom",
  "video/mp4",
);
check(
  "mp4: mp42 as major brand",
  "\u0000\u0000\u0000\u0010ftypmp42\u0000\u0000\u0000\u0000",
  "video/mp4",
);
check("mp4: mp4 only in version field is ignored", "\u0000\u0000\u0000\u0010ftypisommp4 ", BINARY);
check(
  "mp4: box size larger than data",
  "\u0000\u0000\u0000\u001Aftypisom\u0000\u0000\u0000\u0001mp41isom",
  BINARY,
);
check(
  "mp4: box size not a multiple of 4",
  "\u0000\u0000\u0000\u0016ftypisom\u0000\u0000\u0000\u0001mp41isom",
  BINARY,
);
check(
  "mp4: box type is not ftyp",
  "\u0000\u0000\u0000\u0010freeisom\u0000\u0000\u0000\u0000mp41",
  BINARY,
);
check("mp4: zero box size", "\u0000\u0000\u0000\u0000ftypmp41", BINARY);
check("mp4: under 12 bytes", "\u0000\u0000\u0000\u0008ftyp", BINARY);

// Fonts.
check(
  "font: EOT (34 NULs then LP)",
  "\u0000".repeat(34) + "LP\u0000\u0000",
  "application/vnd.ms-fontobject",
);
check("font: EOT with wrong trailer is binary", "\u0000".repeat(34) + "LQ", BINARY);
check("font: TrueType", "\u0000\u0001\u0000\u0000\u0000", "font/ttf");
check("font: OpenType CFF", "OTTO\u0000", "font/otf");
check("font: TrueType collection", "ttcf\u0000", "font/collection");
check("font: WOFF", "wOFF\u0000", "font/woff");
check("font: WOFF2", "wOF2\u0000", "font/woff2");

// Archives and wasm.
check("archive: gzip", "\u001F\u008B\u0008\u0000", "application/x-gzip");
check("archive: zip", "PK\u0003\u0004\u0014", "application/zip");
check("archive: RAR v1.5-v4.0", "Rar!\u001A\u0007\u0000", "application/x-rar-compressed");
check("archive: RAR v5+", "Rar!\u001A\u0007\u0001\u0000", "application/x-rar-compressed");
check("archive: RAR prefix only is binary", "Rar!\u001A\u0007\u0001", BINARY);
check("wasm: magic", "\u0000asm\u0001\u0000\u0000\u0000", "application/wasm");

// Text fallback versus binary control bytes.
check("text: ASCII words", "hello, world\n", TEXT);
check("text: tab, LF, form feed, CR, space", "\u0009\u000A\u000C\u000D\u0020", TEXT);
check("text: ESC (0x1B) is allowed", "\u001B", TEXT);
check("text: DEL (0x7F) is allowed", "\u007F", TEXT);
check("text: UTF-8 bytes are allowed", "\u00C3\u00A9", TEXT);
check("binary: NUL", "\u0000", BINARY);
check("binary: BS (0x08)", "\u0008", BINARY);
check("binary: VT (0x0B)", "\u000B", BINARY);
check("binary: SO (0x0E)", "\u000E", BINARY);
check("binary: SUB (0x1A)", "\u001A", BINARY);
check("binary: FS (0x1C)", "\u001C", BINARY);
check("binary: US (0x1F)", "\u001F", BINARY);
check("binary: NUL inside text", "hello\u0000world", BINARY);

// The algorithm looks at no more than the first 512 bytes.
check("limit: NUL at index 511 is seen", "a".repeat(511) + "\u0000", BINARY);
check("limit: NUL at index 512 is ignored", "a".repeat(512) + "\u0000", TEXT);
check("limit: NUL far past the window is ignored", "a".repeat(600) + "\u0000", TEXT);
check("limit: html tag ends at index 511", " ".repeat(506) + "<html>", HTML);
check("limit: html terminator at index 512 is not seen", " ".repeat(507) + "<html>", TEXT);
check("limit: html start beyond window", " ".repeat(600) + "<html>", TEXT);
check(
  "limit: signature inside window with bytes after",
  "GIF89a" + "\u0000".repeat(600),
  "image/gif",
);

// The input may be a view into a larger buffer.
test("view: subarray with non-zero byteOffset", () => {
  const backing = b("\u0000\u0000\u0000\u0000GIF89a");
  expect(detectContentType(backing.subarray(4))).toBe("image/gif");
});
