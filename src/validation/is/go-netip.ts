// Upstream: Go go1.27.2 src/net/netip/netip.go (ParseAddr, parseIPv4,
// parseIPv4Fields, parseIPv6, ParsePrefix) and src/net/ip.go (ParseIP).
//
// Only the parse results the ported callers need are kept: the address
// family, its zone and the prefix bits, not the address bytes. Errors are
// thrown as ParseAddrError with Go's messages.

// Addr is the result of ParseAddr: an IPv4 or IPv6 address (with an
// optional zone).
export interface Addr {
  is4: boolean;
  zone: string;
}

export class ParseAddrError extends Error {
  constructor(input: string, msg: string, at = "") {
    super(
      at !== ""
        ? `ParseAddr(${JSON.stringify(input)}): ${msg} (at ${JSON.stringify(at)})`
        : `ParseAddr(${JSON.stringify(input)}): ${msg}`,
    );
    this.name = "ParseAddrError";
  }
}

export class ParsePrefixError extends Error {
  constructor(input: string, msg: string) {
    super(`netip.ParsePrefix(${JSON.stringify(input)}): ${msg}`);
    this.name = "ParsePrefixError";
  }
}

// ParseAddr parses s as an IP address, returning the result. The string s
// can be in dotted decimal ("192.0.2.1"), IPv6 ("2001:db8::68"), or IPv6
// with a scoped addressing zone ("fe80::1cc0:3e8c:119f:c2e1%ens18").
export function ParseAddr(s: string): Addr {
  for (let i = 0; i < s.length; i++) {
    switch (s[i]) {
      case ".":
        return parseIPv4(s);
      case ":":
        return parseIPv6(s);
      case "%":
        // Assume that this was trying to be an IPv6 address with
        // a zone specifier, but the address is missing.
        throw new ParseAddrError(s, "missing IPv6 address");
    }
  }
  throw new ParseAddrError(s, "unable to parse IP");
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

// parseIPv4Fields parses in[off:end] as dotted decimal
function parseIPv4Fields(input: string, off: number, end: number): void {
  let val = 0;
  let pos = 0;
  let digLen = 0; // number of digits in current octet
  const s = input.slice(off, end);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (isDigit(c)) {
      if (digLen === 1 && val === 0) {
        throw new ParseAddrError(input, "IPv4 field has octet with leading zero");
      }
      val = val * 10 + Number(c);
      digLen++;
      if (val > 255) {
        throw new ParseAddrError(input, "IPv4 field has value >255");
      }
    } else if (c === ".") {
      // .1.2.3
      // 1.2.3.
      // 1..2.3
      if (i === 0 || i === s.length - 1 || s[i - 1] === ".") {
        throw new ParseAddrError(input, "IPv4 field must have at least one digit", s.slice(i));
      }
      // 1.2.3.4.5
      if (pos === 3) {
        throw new ParseAddrError(input, "IPv4 address too long");
      }
      pos++;
      val = 0;
      digLen = 0;
    } else {
      throw new ParseAddrError(input, "unexpected character", s.slice(i));
    }
  }
  if (pos < 3) {
    throw new ParseAddrError(input, "IPv4 address too short");
  }
}

function parseIPv4(s: string): Addr {
  parseIPv4Fields(s, 0, s.length);
  return { is4: true, zone: "" };
}

function hexValue(c: string | undefined): number {
  if (c === undefined) {
    return -1;
  }
  if (c >= "0" && c <= "9") {
    return c.charCodeAt(0) - 48;
  }
  if (c >= "a" && c <= "f") {
    return c.charCodeAt(0) - 97 + 10;
  }
  if (c >= "A" && c <= "F") {
    return c.charCodeAt(0) - 65 + 10;
  }
  return -1;
}

function parseIPv6(input: string): Addr {
  let s = input;

  // Split off the zone right from the start.
  let zone = "";
  const zi = s.indexOf("%");
  if (zi !== -1) {
    zone = s.slice(zi + 1);
    s = s.slice(0, zi);
    if (zone === "") {
      // Not allowed to have an empty zone if explicitly specified.
      throw new ParseAddrError(input, "zone must be a non-empty string");
    }
  }

  let ellipsis = -1; // position of ellipsis in ip

  // Might have leading ellipsis
  if (s.length >= 2 && s[0] === ":" && s[1] === ":") {
    ellipsis = 0;
    s = s.slice(2);
    // Might be only ellipsis
    if (s.length === 0) {
      return { is4: false, zone };
    }
  }

  // Loop, parsing hex numbers followed by colon.
  let i = 0;
  while (i < 16) {
    let off = 0;
    let acc = 0;
    for (; off < s.length; off++) {
      const v = hexValue(s[off]);
      if (v < 0) {
        break;
      }
      acc = acc * 16 + v;
      if (off > 3) {
        // more than 4 digits in group, fail.
        throw new ParseAddrError(input, "each group must have 4 or less digits", s);
      }
      if (acc > 0xffff) {
        // Overflow, fail.
        throw new ParseAddrError(input, "IPv6 field has value >=2^16", s);
      }
    }
    if (off === 0) {
      // No digits found, fail.
      throw new ParseAddrError(input, "each colon-separated field must have at least one digit", s);
    }

    // If followed by dot, might be in trailing IPv4.
    if (off < s.length && s[off] === ".") {
      if (ellipsis < 0 && i !== 12) {
        // Not the right place.
        throw new ParseAddrError(
          input,
          "embedded IPv4 address must replace the final 2 fields of the address",
          s,
        );
      }
      if (i + 4 > 16) {
        // Not enough room.
        throw new ParseAddrError(
          input,
          "too many hex fields to fit an embedded IPv4 at the end of the address",
          s,
        );
      }

      let end = input.length;
      if (zone.length > 0) {
        end -= zone.length + 1;
      }
      parseIPv4Fields(input, end - s.length, end);
      s = "";
      i += 4;
      break;
    }

    // Save this 16-bit chunk.
    i += 2;

    // Stop at end of string.
    s = s.slice(off);
    if (s.length === 0) {
      break;
    }

    // Otherwise must be followed by colon and more.
    if (s[0] !== ":") {
      throw new ParseAddrError(input, "unexpected character, want colon", s);
    } else if (s.length === 1) {
      throw new ParseAddrError(input, "colon must be followed by more characters", s);
    }
    s = s.slice(1);

    // Look for ellipsis.
    if (s[0] === ":") {
      if (ellipsis >= 0) {
        // already have one
        throw new ParseAddrError(input, "multiple :: in address", s);
      }
      ellipsis = i;
      s = s.slice(1);
      if (s.length === 0) {
        // can be at end
        break;
      }
    }
  }

  // Must have used entire string.
  if (s.length !== 0) {
    throw new ParseAddrError(input, "trailing garbage after address", s);
  }

  // If didn't parse enough, expand ellipsis.
  if (i < 16) {
    if (ellipsis < 0) {
      throw new ParseAddrError(input, "address string too short");
    }
  } else if (ellipsis >= 0) {
    // Ellipsis must represent at least one 0 group.
    throw new ParseAddrError(input, "the :: must expand to at least one field of zeros");
  }
  return { is4: false, zone };
}

// Prefix is the result of ParsePrefix: an address and its prefix length.
export interface Prefix {
  addr: Addr;
  bits: number;
}

// ParsePrefix parses s as an IP address prefix. The string can be in the
// form "192.168.1.0/24" or "2001:db8::/32", the CIDR notation defined in
// RFC 4632 and RFC 4291. IPv6 zones are not permitted in prefixes, and an
// error will be returned if a zone is present.
export function ParsePrefix(s: string): Prefix {
  const i = s.lastIndexOf("/");
  if (i < 0) {
    throw new ParsePrefixError(s, "no '/'");
  }
  let ip: Addr;
  try {
    ip = ParseAddr(s.slice(0, i));
  } catch (err) {
    throw new ParsePrefixError(s, (err as Error).message);
  }
  // IPv6 zones are not allowed: https://go.dev/issue/51899
  if (!ip.is4 && ip.zone !== "") {
    throw new ParsePrefixError(s, "IPv6 zones cannot be present in a prefix");
  }

  const bitsStr = s.slice(i + 1);

  // strconv.Atoi accepts a leading sign and leading zeroes, but we don't want that.
  const first = bitsStr[0] as string;
  if (bitsStr.length > 1 && (first < "1" || first > "9")) {
    throw new ParsePrefixError(s, "bad bits after slash: " + JSON.stringify(bitsStr));
  }

  // strconv.Atoi: decimal digits only (a sign was ruled out above, a
  // value beyond int64 is a range error)
  if (!/^[0-9]+$/.test(bitsStr) || bitsStr.length > 18) {
    throw new ParsePrefixError(s, "bad bits after slash: " + JSON.stringify(bitsStr));
  }
  const bits = Number(bitsStr);
  const maxBits = ip.is4 ? 32 : 128;
  if (bits < 0 || bits > maxBits) {
    throw new ParsePrefixError(s, "prefix length out of range");
  }
  return { addr: ip, bits };
}

// net.ParseIP's validity: s is an IPv4 or IPv6 address without a zone.
export function isParseIP(s: string): boolean {
  try {
    return ParseAddr(s).zone === "";
  } catch {
    return false;
  }
}
