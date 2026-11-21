// Upstream: Go 1.27.2 net/http/internal/sniff.go (http.DetectContentType), which http.ServeContent uses for a file whose extension has no type.
//
// Line-by-line port. Names and table order follow the Go source so the two
// files can be compared side by side. All matching works on bytes; no data
// is ever decoded to a JS string. The byte-string constants below are
// written as Go's byte-escape literals, converted with bytes().

// SniffLen is the number of leading bytes the algorithm uses.
const SniffLen = 512;

// SniffSig is Go's sniffSig interface: match returns the MIME type of the
// data, or "" if unknown.
interface SniffSig {
  match(data: Uint8Array, firstNonWS: number): string;
}

// bytes converts a Go-style byte literal (each char code is one byte, < 256)
// into a Uint8Array. Constants only; never used on request data.
function bytes(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// byteAt returns data[i]. Callers check bounds first, as the Go code does;
// an out-of-range index is a bug and throws, as Go's index panic would.
function byteAt(data: Uint8Array, i: number): number {
  const b = data[i];
  if (b === undefined) {
    throw new RangeError(`sniff: index ${i} out of range ${data.length}`);
  }
  return b;
}

// hasPrefix mirrors bytes.HasPrefix.
function hasPrefix(data: Uint8Array, prefix: Uint8Array): boolean {
  return equalAt(data, 0, prefix);
}

// equalAt reports whether data[off:off+len(pat)] equals pat. It is false when
// that range does not fit in data (bytes.Equal on a shorter slice).
function equalAt(data: Uint8Array, off: number, pat: Uint8Array): boolean {
  if (off + pat.length > data.length) {
    return false;
  }
  for (let i = 0; i < pat.length; i++) {
    if (byteAt(data, off + i) !== byteAt(pat, i)) {
      return false;
    }
  }
  return true;
}

// DetectContentType implements the algorithm described
// at https://mimesniff.spec.whatwg.org/ to determine the
// Content-Type of the given data. It considers at most the
// first 512 bytes of data. DetectContentType always returns
// a valid MIME type: if it cannot determine a more specific one, it
// returns "application/octet-stream".
export function detectContentType(data: Uint8Array): string {
  if (data.length > SniffLen) {
    data = data.subarray(0, SniffLen);
  }

  // Index of the first non-whitespace byte in data.
  let firstNonWS = 0;
  while (firstNonWS < data.length && isWS(byteAt(data, firstNonWS))) {
    firstNonWS++;
  }

  for (const sig of sniffSignatures) {
    const ct = sig.match(data, firstNonWS);
    if (ct !== "") {
      return ct;
    }
  }

  return "application/octet-stream"; // fallback
}

// isWS reports whether the provided byte is a whitespace byte (0xWS)
// as defined in https://mimesniff.spec.whatwg.org/#terminology.
function isWS(b: number): boolean {
  switch (b) {
    case 0x09: // '\t'
    case 0x0a: // '\n'
    case 0x0c: // '\x0c'
    case 0x0d: // '\r'
    case 0x20: // ' '
      return true;
  }
  return false;
}

// isTT reports whether the provided byte is a tag-terminating byte (0xTT)
// as defined in https://mimesniff.spec.whatwg.org/#terminology.
function isTT(b: number): boolean {
  switch (b) {
    case 0x20: // ' '
    case 0x3e: // '>'
      return true;
  }
  return false;
}

// htmlSig matches an HTML tag such as "<HTML", ignoring the case of ASCII
// letters in the tag, after leading whitespace, and requires a tag-terminating
// byte right after the tag name.
function htmlSig(tag: string): SniffSig {
  const h = bytes(tag);
  return {
    match(data, firstNonWS) {
      data = data.subarray(firstNonWS);
      if (data.length < h.length + 1) {
        return "";
      }
      let i = 0;
      for (const b of h) {
        let db = byteAt(data, i);
        if (0x41 <= b && b <= 0x5a) {
          db &= 0xdf;
        }
        if (b !== db) {
          return "";
        }
        i++;
      }
      // Next byte must be a tag-terminating byte(0xTT).
      if (!isTT(byteAt(data, h.length))) {
        return "";
      }
      return "text/html; charset=utf-8";
    },
  };
}

// maskedSig matches data against pat after masking each data byte with mask
// (section 6 pattern matching algorithm).
function maskedSig(opts: {
  mask: Uint8Array;
  pat: Uint8Array;
  skipWS?: boolean;
  ct: string;
}): SniffSig {
  const { mask, pat, skipWS = false, ct } = opts;
  return {
    match(data, firstNonWS) {
      // pattern matching algorithm section 6
      // https://mimesniff.spec.whatwg.org/#pattern-matching-algorithm
      if (skipWS) {
        data = data.subarray(firstNonWS);
      }
      if (pat.length !== mask.length) {
        return "";
      }
      if (data.length < pat.length) {
        return "";
      }
      for (let i = 0; i < pat.length; i++) {
        const maskedData = byteAt(data, i) & byteAt(mask, i);
        if (maskedData !== byteAt(pat, i)) {
          return "";
        }
      }
      return ct;
    },
  };
}

// exactSig matches when data starts with sig.
function exactSig(sig: Uint8Array, ct: string): SniffSig {
  return {
    match(data) {
      if (hasPrefix(data, sig)) {
        return ct;
      }
      return "";
    },
  };
}

const mp4ftype = bytes("ftyp");
const mp4 = bytes("mp4");

// mp4Sig matches an ISO base media file whose ftyp box lists an "mp4" brand.
const mp4Sig: SniffSig = {
  match(data) {
    // https://mimesniff.spec.whatwg.org/#signature-for-mp4
    // c.f. section 6.2.1
    if (data.length < 12) {
      return "";
    }
    // binary.BigEndian.Uint32(data[:4])
    const boxSize =
      byteAt(data, 0) * 0x1_00_00_00 +
      ((byteAt(data, 1) << 16) | (byteAt(data, 2) << 8) | byteAt(data, 3));
    if (data.length < boxSize || boxSize % 4 !== 0) {
      return "";
    }
    if (!equalAt(data, 4, mp4ftype)) {
      return "";
    }
    for (let st = 8; st < boxSize; st += 4) {
      if (st === 12) {
        // Ignores the four bytes that correspond to the version number of the "major brand".
        continue;
      }
      if (equalAt(data, st, mp4)) {
        return "video/mp4";
      }
    }
    return "";
  },
};

// textSig matches when no byte is a binary control byte (section 5, step 4).
const textSig: SniffSig = {
  match(data, firstNonWS) {
    // c.f. section 5, step 4.
    for (const b of data.subarray(firstNonWS)) {
      if (b <= 0x08 || b === 0x0b || (0x0e <= b && b <= 0x1a) || (0x1c <= b && b <= 0x1f)) {
        return "";
      }
    }
    return "text/plain; charset=utf-8";
  },
};

// Data matching the table in section 6.
const sniffSignatures: ReadonlyArray<SniffSig> = [
  htmlSig("<!DOCTYPE HTML"),
  htmlSig("<HTML"),
  htmlSig("<HEAD"),
  htmlSig("<SCRIPT"),
  htmlSig("<IFRAME"),
  htmlSig("<H1"),
  htmlSig("<DIV"),
  htmlSig("<FONT"),
  htmlSig("<TABLE"),
  htmlSig("<A"),
  htmlSig("<STYLE"),
  htmlSig("<TITLE"),
  htmlSig("<B"),
  htmlSig("<BODY"),
  htmlSig("<BR"),
  htmlSig("<P"),
  htmlSig("<!--"),
  maskedSig({
    mask: bytes("\u00FF\u00FF\u00FF\u00FF\u00FF"),
    pat: bytes("<?xml"),
    skipWS: true,
    ct: "text/xml; charset=utf-8",
  }),
  exactSig(bytes("%PDF-"), "application/pdf"),
  exactSig(bytes("%!PS-Adobe-"), "application/postscript"),

  // UTF BOMs.
  maskedSig({
    mask: bytes("\u00FF\u00FF\u0000\u0000"),
    pat: bytes("\u00FE\u00FF\u0000\u0000"),
    ct: "text/plain; charset=utf-16be",
  }),
  maskedSig({
    mask: bytes("\u00FF\u00FF\u0000\u0000"),
    pat: bytes("\u00FF\u00FE\u0000\u0000"),
    ct: "text/plain; charset=utf-16le",
  }),
  maskedSig({
    mask: bytes("\u00FF\u00FF\u00FF\u0000"),
    pat: bytes("\u00EF\u00BB\u00BF\u0000"),
    ct: "text/plain; charset=utf-8",
  }),

  // Image types
  // For posterity, we originally returned "image/vnd.microsoft.icon" from
  // https://tools.ietf.org/html/draft-ietf-websec-mime-sniff-03#section-7
  // https://codereview.appspot.com/4746042
  // but that has since been replaced with "image/x-icon" in Section 6.2
  // of https://mimesniff.spec.whatwg.org/#matching-an-image-type-pattern
  exactSig(bytes("\u0000\u0000\u0001\u0000"), "image/x-icon"),
  exactSig(bytes("\u0000\u0000\u0002\u0000"), "image/x-icon"),
  exactSig(bytes("BM"), "image/bmp"),
  exactSig(bytes("GIF87a"), "image/gif"),
  exactSig(bytes("GIF89a"), "image/gif"),
  maskedSig({
    mask: bytes(
      "\u00FF\u00FF\u00FF\u00FF\u0000\u0000\u0000\u0000\u00FF\u00FF\u00FF\u00FF\u00FF\u00FF",
    ),
    pat: bytes("RIFF\u0000\u0000\u0000\u0000WEBPVP"),
    ct: "image/webp",
  }),
  exactSig(bytes("\u0089PNG\u000D\u000A\u001A\u000A"), "image/png"),
  exactSig(bytes("\u00FF\u00D8\u00FF"), "image/jpeg"),

  // Audio and Video types
  // Enforce the pattern match ordering as prescribed in
  // https://mimesniff.spec.whatwg.org/#matching-an-audio-or-video-type-pattern
  maskedSig({
    mask: bytes("\u00FF\u00FF\u00FF\u00FF\u0000\u0000\u0000\u0000\u00FF\u00FF\u00FF\u00FF"),
    pat: bytes("FORM\u0000\u0000\u0000\u0000AIFF"),
    ct: "audio/aiff",
  }),
  maskedSig({
    mask: bytes("\u00FF\u00FF\u00FF"),
    pat: bytes("ID3"),
    ct: "audio/mpeg",
  }),
  maskedSig({
    mask: bytes("\u00FF\u00FF\u00FF\u00FF\u00FF"),
    pat: bytes("OggS\u0000"),
    ct: "application/ogg",
  }),
  maskedSig({
    mask: bytes("\u00FF\u00FF\u00FF\u00FF\u00FF\u00FF\u00FF\u00FF"),
    pat: bytes("MThd\u0000\u0000\u0000\u0006"),
    ct: "audio/midi",
  }),
  maskedSig({
    mask: bytes("\u00FF\u00FF\u00FF\u00FF\u0000\u0000\u0000\u0000\u00FF\u00FF\u00FF\u00FF"),
    pat: bytes("RIFF\u0000\u0000\u0000\u0000AVI "),
    ct: "video/avi",
  }),
  maskedSig({
    mask: bytes("\u00FF\u00FF\u00FF\u00FF\u0000\u0000\u0000\u0000\u00FF\u00FF\u00FF\u00FF"),
    pat: bytes("RIFF\u0000\u0000\u0000\u0000WAVE"),
    ct: "audio/wave",
  }),
  // 6.2.0.2. video/mp4
  mp4Sig,
  // 6.2.0.3. video/webm
  exactSig(bytes("\u001A\u0045\u00DF\u00A3"), "video/webm"),

  // Font types
  maskedSig({
    // 34 NULL bytes followed by the string "LP"
    pat: bytes("\u0000".repeat(34) + "LP"),
    // 34 NULL bytes followed by \xF\xF
    mask: bytes("\u0000".repeat(34) + "\u00FF\u00FF"),
    ct: "application/vnd.ms-fontobject",
  }),
  exactSig(bytes("\u0000\u0001\u0000\u0000"), "font/ttf"),
  exactSig(bytes("OTTO"), "font/otf"),
  exactSig(bytes("ttcf"), "font/collection"),
  exactSig(bytes("wOFF"), "font/woff"),
  exactSig(bytes("wOF2"), "font/woff2"),

  // Archive types
  exactSig(bytes("\u001F\u008B\u0008"), "application/x-gzip"),
  exactSig(bytes("PK\u0003\u0004"), "application/zip"),
  // RAR's signatures are incorrectly defined by the MIME spec as per
  //    https://github.com/whatwg/mimesniff/issues/63
  // However, RAR Labs correctly defines it at:
  //    https://www.rarlab.com/technote.htm#rarsign
  // so we use the definition from RAR Labs.
  // TODO: do whatever the spec ends up doing.
  exactSig(bytes("Rar!\u001A\u0007\u0000"), "application/x-rar-compressed"), // RAR v1.5-v4.0
  exactSig(bytes("Rar!\u001A\u0007\u0001\u0000"), "application/x-rar-compressed"), // RAR v5+

  exactSig(bytes("\u0000\u0061\u0073\u006D"), "application/wasm"),

  textSig, // should be last
];
