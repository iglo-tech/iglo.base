// Upstream: apis/middlewares.go (superuserIPsWhitelist) and
// apis/middlewares_rate_limit.go (isIPInList, also used by the rate
// limiter's excluded IPs)
//
// The superuser IP check of the other upstream callers (recordAuthResponse
// in apis/record_helpers.go, M4; the protected file token in apis/file.go,
// M5.2; apis/backup.go, M5.3) comes with those handlers; they call
// isIPInList with the same settings.
//
// net/netip comparisons need the address bytes, which the validation's
// ParseAddr (src/validation/is/go-netip.ts) does not keep: a string that
// it accepts is converted here (parseIP).

import type { RequestEvent } from "@/app/event-request";
import type { Handler } from "@/server/handler";
import {
  DefaultSuperuserIPsWhitelistMiddlewareId,
  DefaultSuperuserIPsWhitelistMiddlewarePriority,
} from "@/middlewares/middlewares";
import { ParseAddr, ParsePrefix } from "@/validation/is/go-netip";

// superuserIPsWhitelist middleware checks the current authenticated superuser IP
// against the configured SuperuserIPs whitelist setting.
export function superuserIPsWhitelist(): Handler<RequestEvent> {
  return {
    id: DefaultSuperuserIPsWhitelistMiddlewareId,
    priority: DefaultSuperuserIPsWhitelistMiddlewarePriority,
    func: (e) => {
      if (e.hasSuperuserAuth()) {
        const ips = e.app.settings.SuperuserIPs ?? [];

        if (ips.length > 0 && !isIPInList(ips, e.realIP())) {
          return e.forbiddenError("", new Error("superuser IP is not whitelisted"));
        }
      }

      return e.next();
    },
  };
}

// isIPInList checks if the specified IP is in a list of other individual IPs or subnets.
export function isIPInList(ipsOrSubnets: readonly string[], ip: string): boolean {
  if (ipsOrSubnets.length === 0 || ip === "") {
    return false;
  }

  // normalize
  const searchAddr = parseAddr(ip);
  if (searchAddr === null) {
    return false;
  }

  for (const item of ipsOrSubnets) {
    // subnet?
    const prefix = parsePrefix(item);
    if (prefix !== null) {
      if (prefixContains(prefix, searchAddr)) {
        return true;
      }
      continue;
    }

    // individual ip?
    const addr = parseAddr(item);
    if (addr !== null) {
      if (addrEqual(addr, searchAddr)) {
        return true;
      }
      continue;
    }
  }

  return false;
}

// a netip.Addr: the family, the 4 or 16 address bytes and the IPv6 zone
interface IP {
  is4: boolean;
  bytes: number[];
  zone: string;
}

interface IPPrefix {
  addr: IP;
  bits: number;
}

// netip.ParseAddr, or null for an error
function parseAddr(s: string): IP | null {
  let parsed;
  try {
    parsed = ParseAddr(s);
  } catch {
    return null;
  }
  return parseIP(s, parsed.is4, parsed.zone);
}

// netip.ParsePrefix, or null for an error
function parsePrefix(s: string): IPPrefix | null {
  let parsed;
  try {
    parsed = ParsePrefix(s);
  } catch {
    return null;
  }
  const addr = parseIP(s.slice(0, s.lastIndexOf("/")), parsed.addr.is4, parsed.addr.zone);
  return { addr, bits: parsed.bits };
}

// the bytes of an address that ParseAddr accepted
function parseIP(s: string, is4: boolean, zone: string): IP {
  if (is4) {
    return { is4, bytes: s.split(".").map(Number), zone: "" };
  }

  const percent = s.indexOf("%");
  let text = percent >= 0 ? s.slice(0, percent) : s;

  // an embedded IPv4 address in the last 32 bits
  let tail: number[] = [];
  const dot = text.indexOf(".");
  if (dot >= 0) {
    const colon = text.lastIndexOf(":");
    const v4 = text
      .slice(colon + 1)
      .split(".")
      .map(Number);
    tail = [
      ((v4[0] as number) << 8) | (v4[1] as number),
      ((v4[2] as number) << 8) | (v4[3] as number),
    ];
    text = text.slice(0, colon + 1);
    if (text.endsWith(":") && !text.endsWith("::")) {
      text = text.slice(0, -1);
    }
  }

  let words: number[];
  const ellipsis = text.indexOf("::");
  if (ellipsis >= 0) {
    const head = groups(text.slice(0, ellipsis));
    const rest = groups(text.slice(ellipsis + 2));
    const fill = 8 - head.length - rest.length - tail.length;
    words = [...head, ...Array.from({ length: fill }, () => 0), ...rest, ...tail];
  } else {
    words = [...groups(text), ...tail];
  }

  const bytes: number[] = [];
  for (const w of words) {
    bytes.push(w >> 8, w & 0xff);
  }
  return { is4: false, bytes, zone };
}

// Addr == Addr: same family, bytes and zone
function addrEqual(a: IP, b: IP): boolean {
  return a.is4 === b.is4 && a.zone === b.zone && a.bytes.every((byte, i) => byte === b.bytes[i]);
}

// Prefix.Contains: an address with a zone is never contained; the family
// must match and the first bits must be equal.
function prefixContains(p: IPPrefix, ip: IP): boolean {
  if (ip.zone !== "" || p.addr.is4 !== ip.is4) {
    return false;
  }
  let bits = p.bits;
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if (((p.addr.bytes[i] as number) & mask) !== ((ip.bytes[i] as number) & mask)) {
      return false;
    }
  }
  return true;
}

// the 16-bit groups of a colon-separated IPv6 part
function groups(part: string): number[] {
  return part === "" ? [] : part.split(":").map((g) => parseInt(g, 16));
}
