// Upstream: gabriel-vasile/mimetype v1.4.15 mimetype.go.
//
// Package mimetype uses magic number signatures to detect the MIME type of a file.
//
// File formats are stored in a hierarchy with "application/octet-stream" at its root.
// For example, the hierarchy for HTML format is application/octet-stream ->
// text/plain -> text/html.
//
// Left out: SetLimit (upstream PocketBase never calls it, so the limit is
// always the default), Extend (no extension surface) and DetectFile (callers
// pass a Blob, such as Bun.file, to detectReader). An io.Reader is a
// ReadableStream or a Blob; Go's (MIME, error) result is a [MIME, error]
// pair.

import type { MIME } from "@/tools/mimetype/mime";
import { parseMediaType } from "@/tools/mimetype/mediatype";
import { errMIME, root } from "@/tools/mimetype/tree";

export const defaultLimit = 4096;

// readLimit is the maximum number of bytes from the input used when detecting.
const readLimit = defaultLimit;

// Detect returns the MIME type found from the provided byte slice.
//
// The result is always a valid MIME type, with "application/octet-stream"
// returned when identification failed.
export function detect(input: Uint8Array): MIME {
  const l = readLimit;
  if (l > 0 && input.length > l) {
    input = input.subarray(0, l);
  }
  return root.match(input, l, root);
}

// DetectReader returns the MIME type of the provided reader.
//
// The result is always a valid MIME type, with "application/octet-stream"
// returned when identification failed with or without an error.
// Any error returned is related to the reading from the input reader.
//
// DetectReader assumes the reader offset is at the start. The reader is a
// Blob (a Bun file, an upload part, an S3 file): only its first readLimit
// bytes are read, through a slice, and the Blob itself is left as it was.
// Upstream's callers rewind the file after detecting; a Blob needs no
// rewind, while a web stream cannot give unread bytes back, so streams are
// not accepted.
export async function detectReader(r: Blob): Promise<[MIME, Error | null]> {
  const l = readLimit;
  let input: Uint8Array;
  try {
    input = new Uint8Array(await r.slice(0, l).arrayBuffer());
  } catch (err) {
    return [errMIME, err instanceof Error ? err : new Error(String(err))];
  }

  return [root.match(input, l, root), null];
}

// EqualsAny reports whether s MIME type is equal to any MIME type in mimes.
// MIME type equality test is done on the "type/subtype" section, ignores
// any optional MIME parameters, ignores any leading and trailing whitespace,
// and is case insensitive.
export function equalsAny(s: string, ...mimes: string[]): boolean {
  [s] = parseMediaType(s);
  for (let m of mimes) {
    [m] = parseMediaType(m);
    if (s === m) {
      return true;
    }
  }

  return false;
}

// Lookup finds a MIME object by its string representation.
// The representation can be the main MIME type, or any of its aliases.
export function lookup(m: string): MIME | null {
  // We store the MIME types without optional params, so
  // perform parsing to extract the target MIME type without optional params.
  [m] = parseMediaType(m);
  return root.lookup(m);
}
