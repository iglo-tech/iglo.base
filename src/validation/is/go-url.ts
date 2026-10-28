// Upstream: Go go1.27.2 src/net/url/url.go (Parse, parse, getScheme,
// parseAuthority, parseHost, unescape, validUserinfo, validOptionalPort,
// stringContainsCTLByte, setPath and setFragment without the RawPath and
// RawFragment hints) and encoding_table.go (the encodeHost/encodeZone and
// hexChar classes).
//
// Only what govalidator's IsURL reads is kept: whether Parse fails, and
// the parsed Host and Path. Go works on the bytes of the string, so the
// input is converted to its UTF-8 bytes, held as a "binary" string (one
// char per byte); Host and Path are returned in that form. The
// urlstrictcolons GODEBUG has its go1.26+ default (strict colons for http
// and https hosts).

import { textToBytes } from "@/tools/types/go-json";
import { ParseAddr } from "@/validation/is/go-netip";

export interface URL {
  scheme: string;
  opaque: string;
  host: string; // host or host:port, unescaped (binary string)
  path: string; // path, unescaped (binary string)
}

export class URLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "URLError";
  }
}

const enum encoding {
  encodePath,
  encodeHost,
  encodeZone,
  encodeUserPassword,
  encodeFragment,
}

// the ASCII bytes that encoding_table.go marks for encodeHost (the same
// set as encodeZone): they need no escaping in a host
const hostChars = new Set(
  "!\"$&'()*+,-.0123456789:;<=>ABCDEFGHIJKLMNOPQRSTUVWXYZ[]_abcdefghijklmnopqrstuvwxyz~",
);

function ishex(c: string | undefined): boolean {
  return c !== undefined && /^[0-9a-fA-F]$/.test(c);
}

// Precondition: ishex(c) is true.
function unhex(c: string): number {
  return parseInt(c, 16);
}

// shouldEscape for the host and zone modes, the only ones unescape asks
function shouldEscapeHost(c: string): boolean {
  return !hostChars.has(c);
}

// unescape unescapes a string; the mode specifies which section of the
// URL string is being unescaped.
function unescape(s: string, mode: encoding): string {
  // Count %, check that they're well-formed.
  let n = 0;
  for (let i = 0; i < s.length;) {
    const c = s[i] as string;
    switch (c) {
      case "%": {
        n++;
        if (i + 2 >= s.length || !ishex(s[i + 1]) || !ishex(s[i + 2])) {
          throw new URLError("invalid URL escape " + JSON.stringify(s.slice(i, i + 3)));
        }
        // Per https://tools.ietf.org/html/rfc3986#page-21
        // in the host component %-encoding can only be used
        // for non-ASCII bytes.
        // But https://tools.ietf.org/html/rfc6874#section-2
        // introduces %25 being allowed to escape a percent sign
        // in IPv6 scoped-address literals. Yay.
        const hi = unhex(s[i + 1] as string);
        if (mode === encoding.encodeHost && hi < 8 && s.slice(i, i + 3) !== "%25") {
          throw new URLError("invalid URL escape " + JSON.stringify(s.slice(i, i + 3)));
        }
        if (mode === encoding.encodeZone) {
          // RFC 6874 says basically "anything goes" for zone identifiers
          // and that even non-ASCII can be redundantly escaped,
          // but it seems prudent to restrict %-escaped bytes here to those
          // that are valid host name bytes in their unescaped form.
          const v = (hi << 4) | unhex(s[i + 2] as string);
          if (
            s.slice(i, i + 3) !== "%25" &&
            v !== 0x20 &&
            shouldEscapeHost(String.fromCharCode(v))
          ) {
            throw new URLError("invalid URL escape " + JSON.stringify(s.slice(i, i + 3)));
          }
        }
        i += 3;
        break;
      }
      default:
        if (
          (mode === encoding.encodeHost || mode === encoding.encodeZone) &&
          c.charCodeAt(0) < 0x80 &&
          shouldEscapeHost(c)
        ) {
          throw new URLError("invalid character " + JSON.stringify(c) + " in host name");
        }
        i++;
    }
  }

  if (n === 0) {
    return s;
  }

  let t = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%") {
      t += String.fromCharCode((unhex(s[i + 1] as string) << 4) | unhex(s[i + 2] as string));
      i += 2;
    } else {
      t += s[i];
    }
  }
  return t;
}

// Maybe rawURL is of the form scheme:path.
// (Scheme must be [a-zA-Z][a-zA-Z0-9+.-]*)
// If so, return scheme, path; else return "", rawURL.
function getScheme(rawURL: string): [scheme: string, path: string] {
  for (let i = 0; i < rawURL.length; i++) {
    const c = rawURL[i] as string;
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z")) {
      // do nothing
    } else if ((c >= "0" && c <= "9") || c === "+" || c === "-" || c === ".") {
      if (i === 0) {
        return ["", rawURL];
      }
    } else if (c === ":") {
      if (i === 0) {
        throw new URLError("missing protocol scheme");
      }
      return [rawURL.slice(0, i), rawURL.slice(i + 1)];
    } else {
      // we have encountered an invalid character,
      // so there is no valid scheme
      return ["", rawURL];
    }
  }
  return ["", rawURL];
}

// the UTF-8 bytes of s as a binary string
function binary(s: string): string {
  let ascii = true;
  for (let i = 0; i < s.length && ascii; i++) {
    ascii = s.charCodeAt(i) < 0x80;
  }
  if (ascii) {
    return s;
  }
  let out = "";
  for (const b of textToBytes(s)) {
    out += String.fromCharCode(b);
  }
  return out;
}

// Parse parses a raw url into a URL structure.
//
// The url may be relative (a path, without a host) or absolute (starting
// with a scheme). Trying to parse a hostname and path without a scheme is
// invalid but may not necessarily return an error, due to parsing
// ambiguities.
export function Parse(rawURL: string): URL {
  const raw = binary(rawURL);
  // Cut off #frag
  const hash = raw.indexOf("#");
  const u = hash < 0 ? raw : raw.slice(0, hash);
  const url = parse(u, false);
  if (hash >= 0) {
    const frag = raw.slice(hash + 1);
    if (frag !== "") {
      unescape(frag, encoding.encodeFragment);
    }
  }
  return url;
}

// parse parses a URL from a string in one of two contexts. If viaRequest
// is true, the URL is assumed to have arrived via an HTTP request, in
// which case only absolute URLs or path-absolute relative URLs are
// allowed. If viaRequest is false, all forms of relative URLs are allowed.
function parse(rawURL: string, viaRequest: boolean): URL {
  if (stringContainsCTLByte(rawURL)) {
    throw new URLError("net/url: invalid control character in URL");
  }

  if (rawURL === "" && viaRequest) {
    throw new URLError("empty url");
  }
  const url: URL = { scheme: "", opaque: "", host: "", path: "" };

  if (rawURL === "*") {
    url.path = "*";
    return url;
  }

  // Split off possible leading "http:", "mailto:", etc.
  // Cannot contain escaped characters.
  let rest: string;
  [url.scheme, rest] = getScheme(rawURL);
  url.scheme = url.scheme.toLowerCase();

  if (rest.endsWith("?") && rest.split("?").length - 1 === 1) {
    rest = rest.slice(0, -1);
  } else {
    const q = rest.indexOf("?");
    if (q >= 0) {
      rest = rest.slice(0, q);
    }
  }

  if (!rest.startsWith("/")) {
    if (url.scheme !== "") {
      // We consider rootless paths per RFC 3986 as opaque.
      url.opaque = rest;
      return url;
    }
    if (viaRequest) {
      throw new URLError("invalid URI for request");
    }

    // Avoid confusion with malformed schemes, like cache_object:foo/bar.
    // See golang.org/issue/16822.
    //
    // RFC 3986, §3.3:
    // In addition, a URI reference (Section 4.1) may be a relative-path
    // reference, in which case the first path segment cannot contain a
    // colon (":") character.
    const slash = rest.indexOf("/");
    const segment = slash < 0 ? rest : rest.slice(0, slash);
    if (segment.includes(":")) {
      // First path segment has colon. Not allowed in relative URL.
      throw new URLError("first path segment in URL cannot contain colon");
    }
  }

  if ((url.scheme !== "" || (!viaRequest && !rest.startsWith("///"))) && rest.startsWith("//")) {
    let authority = rest.slice(2);
    rest = "";
    const i = authority.indexOf("/");
    if (i >= 0) {
      rest = authority.slice(i);
      authority = authority.slice(0, i);
    }
    url.host = parseAuthority(url.scheme, authority);
  }

  // Set Path (RawPath, the hint of the original escaping, is not kept).
  url.path = unescape(rest, encoding.encodePath);
  return url;
}

// returns the host; the userinfo is only validated
function parseAuthority(scheme: string, authority: string): string {
  const i = authority.lastIndexOf("@");
  const host = parseHost(scheme, i < 0 ? authority : authority.slice(i + 1));
  if (i < 0) {
    return host;
  }
  const userinfo = authority.slice(0, i);
  if (!validUserinfo(userinfo)) {
    throw new URLError("net/url: invalid userinfo");
  }
  const colon = userinfo.indexOf(":");
  if (colon < 0) {
    unescape(userinfo, encoding.encodeUserPassword);
  } else {
    unescape(userinfo.slice(0, colon), encoding.encodeUserPassword);
    unescape(userinfo.slice(colon + 1), encoding.encodeUserPassword);
  }
  return host;
}

// parseHost parses host as an authority without user information. That
// is, as host[:port].
function parseHost(scheme: string, host: string): string {
  const openBracketIdx = host.lastIndexOf("[");
  if (openBracketIdx > 0) {
    throw new URLError("invalid IP-literal");
  } else if (openBracketIdx === 0) {
    // Parse an IP-Literal in RFC 3986 and RFC 6874.
    // E.g., "[fe80::1]", "[fe80::1%25en0]", "[fe80::1]:80".
    const closeBracketIdx = host.lastIndexOf("]");
    if (closeBracketIdx < 0) {
      throw new URLError("missing ']' in host");
    }

    const colonPort = host.slice(closeBracketIdx + 1);
    if (!validOptionalPort(colonPort)) {
      throw new URLError(`invalid port ${JSON.stringify(colonPort)} after host`);
    }
    const unescapedColonPort = unescape(colonPort, encoding.encodeHost);

    const hostname = host.slice(openBracketIdx + 1, closeBracketIdx);
    let unescapedHostname: string;
    // RFC 6874 defines that %25 (%-encoded percent) introduces
    // the zone identifier, and the zone identifier can use basically
    // any %-encoding it likes. That's different from the host, which
    // can only %-encode non-ASCII bytes.
    // We do impose some restrictions on the zone, to avoid stupidity
    // like newlines.
    const zoneIdx = hostname.indexOf("%25");
    if (zoneIdx >= 0) {
      const hostPart = unescape(hostname.slice(0, zoneIdx), encoding.encodeHost);
      const zonePart = unescape(hostname.slice(zoneIdx), encoding.encodeZone);
      unescapedHostname = hostPart + zonePart;
    } else {
      unescapedHostname = unescape(hostname, encoding.encodeHost);
    }

    // Per RFC 3986, only a host identified by a valid
    // IPv6 address can be enclosed by square brackets.
    // This excludes any IPv4, but notably not IPv4-mapped addresses.
    let is4: boolean;
    try {
      is4 = ParseAddr(unescapedHostname).is4;
    } catch (err) {
      throw new URLError(`invalid host: ${(err as Error).message}`);
    }
    if (is4) {
      throw new URLError("invalid IP-literal");
    }
    return "[" + unescapedHostname + "]" + unescapedColonPort;
  } else {
    let i = host.indexOf(":");
    if (i !== -1) {
      const lastColon = host.lastIndexOf(":");
      if (lastColon !== i) {
        // RFC 3986 does not allow colons to appear in the host
        // subcomponent; enforce strict colons only for http and https
        // URLs (urlstrictcolons=1, the go1.26+ default).
        if (scheme !== "http" && scheme !== "https") {
          i = lastColon;
        }
      }
      const colonPort = host.slice(i);
      if (!validOptionalPort(colonPort)) {
        throw new URLError(`invalid port ${JSON.stringify(colonPort)} after host`);
      }
    }
  }

  return unescape(host, encoding.encodeHost);
}

// validOptionalPort reports whether port is either an empty string or
// matches /^:\d*$/
function validOptionalPort(port: string): boolean {
  return /^(:[0-9]*)?$/.test(port);
}

// validUserinfo reports whether s is a valid userinfo string per RFC 3986
// Section 3.2.1 (plus '@', which Go also accepts). The bytes of s are
// checked as Go checks its runes: any non-ASCII rune is invalid.
function validUserinfo(s: string): boolean {
  return /^[A-Za-z0-9\-._:~!$&'()*+,;=%@]*$/.test(s);
}

// stringContainsCTLByte reports whether s contains any ASCII control
// character.
function stringContainsCTLByte(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const b = s.charCodeAt(i);
    if (b < 0x20 || b === 0x7f) {
      return true;
    }
  }
  return false;
}
