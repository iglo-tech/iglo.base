// Upstream: Go net/http client.go (Client.do, redirectBehavior,
// shouldCopyHeaderOnRedirect, isDomainOrSubdomain)
//
// Provider requests follow redirects as Go's default client does, because
// fetch's own rules differ: fetch drops Authorization on any change of
// origin, Go keeps it for the same host name on another port or scheme and
// for its subdomains. Once dropped, it stays dropped for the rest of the chain.

const maxRedirects = 10;

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
): Promise<Response> {
  const initial = new URL(rawURL);
  const headers = new Headers(init.headers);
  let url = initial;
  let method = init.method ?? "GET";
  let body = init.body ?? null;
  let stripped = false;

  for (let redirects = 0; ; redirects++) {
    const res = await fetch(url, { ...init, method, headers, body, redirect: "manual" });

    const location = res.headers.get("Location") ?? "";
    if (![301, 302, 303, 307, 308].includes(res.status) || location === "") {
      return res;
    }

    await res.body?.cancel();

    if (redirects >= maxRedirects) {
      throw new Error(`stopped after ${maxRedirects} redirects`);
    }

    url = new URL(location, url);

    if (res.status < 307) {
      body = null;
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
