// Upstream: apis/record_auth_with_oauth2.go (safeHTTPClient, safeFileFromURL)
//
// The avatar download of a new OAuth2 user. Upstream's dialer checks each
// resolved address right before connecting (dns rebinding); fetch has no such
// hook, so the name is resolved here, each address is checked, and the
// request goes to the checked address itself, with the original name in the
// Host header and in the TLS server name (certificates are still verified
// against the name). A failed connection tries the next address, as the
// dialer does. The redirects are followed here for the same reason: every hop
// goes through the same checks.
//
// The limits are upstream's: 10 s for the whole download (the 10 s context
// around safeFileFromURL, shorter than the client's own timeouts), 10
// requests, and DefaultMaxBodySize, where the rest of the body is dropped
// and not an error.
//
// One difference: Bun's fetch uses the HTTP(S)_PROXY environment, which
// safeHTTPClient does not, and it cannot be turned off per request. The
// target stays the checked address.
//
// SafeFileOptions is a seam for in-process tests. It is passed only through
// newRouter's options, which nothing in the executable sets, so no request
// or setting can reach it.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { DefaultMaxBodySize } from "@/middlewares/middlewares";
import { readLimited } from "@/oauth2/token";
import { type File, goBase, NewFileFromBytes } from "@/tools/filesystem/file";

const safeFileTimeoutMs = 10_000;

// http.Client's defaultCheckRedirect
const maxRequests = 10;

export interface SafeFileOptions {
  // overrides isAllowedAddress
  isAllowedAddress?: (address: string) => boolean;
  // overrides the name resolution
  lookupAddresses?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
  // a certificate authority to trust
  ca?: string;
}

function parseIPv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^[0-9]{1,3}$/.test(p) && Number(p) <= 255)) {
    return null;
  }
  return parts.map(Number);
}

function groups(part: string): number[] {
  return part === "" ? [] : part.split(":").map((g) => parseInt(g, 16));
}

// the 16 bytes of an IPv6 address; null for anything else (a zone is not
// part of net.ParseIP's input)
function parseIPv6(address: string): number[] | null {
  if (isIP(address) !== 6 || address.includes("%")) {
    return null;
  }

  let text = address;
  const lastColon = text.lastIndexOf(":");
  const v4 = parseIPv4(text.slice(lastColon + 1));
  if (v4 !== null) {
    const [a, b, c, d] = v4 as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head = "", tail] = text.split("::");
  const start = groups(head);
  const end = tail === undefined ? [] : groups(tail);
  const words = [
    ...start,
    ...Array.from({ length: 8 - start.length - end.length }, () => 0),
    ...end,
  ];
  return words.flatMap((w) => [w >> 8, w & 0xff]);
}

// the dialer's check: net.ParseIP (nil is refused), then IsLoopback,
// IsUnspecified, IsPrivate, IsLinkLocalUnicast, IsLinkLocalMulticast and
// IsMulticast, which treat an IPv4-mapped address as its IPv4 address
export function isAllowedAddress(address: string): boolean {
  let bytes = parseIPv4(address);
  if (bytes === null) {
    const v6 = parseIPv6(address);
    if (v6 === null) {
      return false;
    }
    const mapped = v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
    bytes = mapped ? v6.slice(12) : v6;
  }

  if (bytes.length === 4) {
    const [a, b] = bytes as [number, number, number, number];
    return !(
      a === 127 || // loopback
      (a === 0 && bytes.every((v) => v === 0)) || // unspecified
      a === 10 ||
      (a === 172 && (b & 0xf0) === 16) ||
      (a === 192 && b === 168) || // private
      (a === 169 && b === 254) || // link-local unicast
      (a & 0xf0) === 224 // multicast, link-local included
    );
  }

  const [a = 0, b = 0] = bytes;
  const loopbackOrUnspecified =
    bytes.slice(0, 15).every((v) => v === 0) && (bytes[15] === 0 || bytes[15] === 1);
  return !(
    loopbackOrUnspecified ||
    (a & 0xfe) === 0xfc || // private
    (a === 0xfe && (b & 0xc0) === 0x80) || // link-local unicast
    a === 0xff // multicast, link-local included
  );
}

async function resolve(host: string, opts: SafeFileOptions): Promise<string[]> {
  if (isIP(host) !== 0) {
    return [host];
  }
  if (opts.lookupAddresses !== undefined) {
    return opts.lookupAddresses(host);
  }
  return (await lookup(host, { all: true })).map((a) => a.address);
}

// the name resolution ends at the download's deadline too: a lookup can't
// be cancelled, so it is left behind
async function resolveUntilDeadline(
  host: string,
  signal: AbortSignal,
  opts: SafeFileOptions,
): Promise<string[]> {
  signal.throwIfAborted();
  return Promise.race([
    resolve(host, opts),
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
    }),
  ]);
}

// one request, as the dialer connects: to the first allowed address that
// accepts the connection
async function request(url: URL, signal: AbortSignal, opts: SafeFileOptions): Promise<Response> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported protocol scheme ${url.protocol}`);
  }

  // the brackets of an IPv6 literal aren't part of the address
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const isAllowed = opts.isAllowedAddress ?? isAllowedAddress;

  let lastErr: unknown = new Error(`no addresses for ${host}`);
  for (const address of await resolveUntilDeadline(host, signal, opts)) {
    if (!isAllowed(address)) {
      lastErr = new Error(`address ${address} is invalid or resolve to disallowed IP`);
      continue;
    }

    const target = new URL(url);
    target.hostname = isIP(address) === 6 ? `[${address}]` : address;

    const init: BunFetchRequestInit = {
      headers: { Host: url.host },
      redirect: "manual",
      keepalive: false,
      signal,
    };
    if (url.protocol === "https:") {
      init.tls = {
        ...(isIP(host) === 0 ? { serverName: host } : {}),
        ...(opts.ca === undefined ? {} : { ca: opts.ca }),
      };
    }

    try {
      return await fetch(target, init);
    } catch (err) {
      lastErr = err;
      if (signal.aborted) {
        break;
      }
    }
  }

  throw lastErr;
}

// safeHTTPClient().Do: the response of the last request, after the redirects
async function safeFetch(rawURL: string, signal: AbortSignal, opts: SafeFileOptions) {
  let url = new URL(rawURL);

  for (let requests = 1; ; requests++) {
    const res = await request(url, signal, opts);

    const location = res.headers.get("Location") ?? "";
    if (![301, 302, 303, 307, 308].includes(res.status) || location === "") {
      return res;
    }

    if (requests >= maxRequests) {
      throw new Error(`stopped after ${maxRequests} redirects`);
    }

    await res.body?.cancel();
    url = new URL(location, url);
  }
}

// safeFileFromURL downloads the file from the specified url (with the
// checks at the top of this file) and creates a new File value from its
// content (limited to DefaultMaxBodySize). Throws on a refused address, a
// failed download and an empty file.
export async function safeFileFromURL(url: string, opts: SafeFileOptions = {}): Promise<File> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? safeFileTimeoutMs);

  const res = await safeFetch(url, signal, opts);

  if (res.status < 200 || res.status > 399) {
    await res.body?.cancel();
    throw new Error(`failed to download url ${url} (${res.status})`);
  }

  const body = await readLimited(res, DefaultMaxBodySize);

  return NewFileFromBytes(body, goBase(url));
}
