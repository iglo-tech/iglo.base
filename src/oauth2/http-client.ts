// Upstream: Go net/http client.go (Client.do, redirectBehavior,
// shouldCopyHeaderOnRedirect, isDomainOrSubdomain)
//
// Provider requests follow redirects as Go's default client does, because
// fetch's own rules differ: fetch drops Authorization on any change of
// origin, Go keeps it for the same host name on another port or scheme and
// for its subdomains. Once dropped, it stays dropped for the rest of the chain.
// `tokenAuthorization` is oauth2.Transport's header: the transport sets it on
// every request of a chain, redirects to other hosts included, and is what
// upstream's userinfo requests go through.
//
// Only http and https go out: Go has no other transport, and Bun's fetch would
// read a `file:` URL, which a provider could name in a Location header.

// Go's defaultCheckRedirect: 10 requests in total
const maxRequests = 10;

const sensitiveHeaders = ["Authorization", "Www-Authenticate", "Cookie", "Cookie2"];

function isDomainOrSubdomain(sub: string, parent: string): boolean {
  if (sub === parent) {
    return true;
  }
  // an IPv6 address is not a host name
  if (sub.includes(":") || sub.includes("%")) {
    return false;
  }
  return sub.endsWith("." + parent);
}

export async function fetchFollowingRedirects(
  rawURL: string,
  init: RequestInit = {},
  tokenAuthorization?: string,
): Promise<Response> {
  const initial = new URL(rawURL);
  const headers = new Headers(init.headers);
  let url = initial;
  let method = init.method ?? "GET";
  let body = init.body ?? null;
  let stripped = false;

  for (let requests = 1; ; requests++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`unsupported protocol scheme ${url.protocol}`);
    }

    if (tokenAuthorization !== undefined) {
      headers.set("Authorization", tokenAuthorization);
    }

    const res = await fetch(url, { ...init, method, headers, body, redirect: "manual" });

    const location = res.headers.get("Location") ?? "";
    if (![301, 302, 303, 307, 308].includes(res.status) || location === "") {
      return res;
    }

    await res.body?.cancel();

    if (requests >= maxRequests) {
      throw new Error(`stopped after ${maxRequests} redirects`);
    }

    url = new URL(location, url);

    if (res.status < 307) {
      body = null;
      headers.delete("Content-Type");
      if (method !== "HEAD") {
        method = "GET";
      }
    }

    if (
      !stripped &&
      url.host !== initial.host &&
      !isDomainOrSubdomain(url.hostname, initial.hostname)
    ) {
      stripped = true;
      for (const name of sensitiveHeaders) {
        headers.delete(name);
      }
    }
  }
}
