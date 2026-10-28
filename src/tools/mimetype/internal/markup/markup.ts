// Upstream: gabriel-vasile/mimetype v1.4.15 internal/markup/markup.go.
//
// Package markup implements functions for extracting info from
// HTML and XML documents.
//
// Go's nil slices are null here.

import { hasPrefix, index, lit } from "@/tools/mimetype/go-bytes";
import { byteIsWS, type Bytes } from "@/tools/mimetype/internal/scan/bytes";

// GetAnAttribute assumes we passed over an SGML tag and extracts first
// attribute and its value.
//
// Initially, this code existed inside charset/charset.go, because it was part of
// implementing the https://html.spec.whatwg.org/multipage/parsing.html#prescan-a-byte-stream-to-determine-its-encoding
// algorithm. But because extracting an attribute from a tag is the same for
// both HTML and XML, then the code was moved here.
export function getAnAttribute(
  s: Bytes,
): [name: Uint8Array | null, val: Uint8Array | null, hasMore: boolean] {
  while (byteIsWS(s.peek()) || s.peek() === 0x2f) {
    s.advance(1);
  }
  if (s.peek() === 0x3e) {
    return [null, null, false];
  }
  const origS = s.b;
  let end = 0;
  // step 4 and 5
  for (;;) {
    // bap means byte at position in the specification.
    const bap = s.pop();
    if (bap === 0) {
      return [null, null, false];
    }
    if (bap === 0x3d && end > 0) {
      const [val, hasMore] = getAValue(s);
      return [origS.subarray(0, end), val, hasMore];
    } else if (byteIsWS(bap)) {
      while (byteIsWS(s.peek())) {
        s.advance(1);
      }
      if (s.peek() !== 0x3d) {
        return [origS.subarray(0, end), null, true];
      }
      s.advance(1);
      while (byteIsWS(s.peek())) {
        s.advance(1);
      }
      const [val, hasMore] = getAValue(s);
      return [origS.subarray(0, end), val, hasMore];
    } else if (bap === 0x2f || bap === 0x3e) {
      return [origS.subarray(0, end), null, false];
    } else {
      // for any ASCII, non-ASCII, just advance
      end++;
    }
  }
}

export function getAValue(s: Bytes): [val: Uint8Array | null, hasMore: boolean] {
  while (byteIsWS(s.peek())) {
    s.advance(1);
  }
  const origS = s.b;
  let end = 0;
  let bap = s.pop();
  if (bap === 0) {
    return [null, false];
  }
  end++;
  // Step 10
  switch (bap) {
    case 0x22:
    case 0x27: {
      const val = s.popUntil(bap);
      if (s.pop() !== bap) {
        return [null, false];
      }
      return [val.b, s.peek() !== 0 && s.peek() !== 0x3e];
    }
    case 0x3e:
      return [null, false];
  }

  // Step 11
  for (;;) {
    bap = s.pop();
    if (bap === 0) {
      return [null, false];
    }
    if (byteIsWS(bap)) {
      return [origS.subarray(0, end), true];
    } else if (bap === 0x3e) {
      return [origS.subarray(0, end), false];
    } else {
      end++;
    }
  }
}

const commentStart = lit("<!--");
const commentEnd = lit("-->");

export function skipAComment(s: Bytes): boolean {
  if (hasPrefix(s.b, commentStart)) {
    // Offset by 2 len(<!) because the starting and ending -- can be the same.
    const i = index(s.b.subarray(2), commentEnd);
    if (i !== -1) {
      s.advance(i + 2 + 3); // 2 comes from len(<!) and 3 comes from len(-->).
      return true;
    }
  }
  return false;
}
