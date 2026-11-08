// A browser's cookie jar for the SSR differential tests: it stores the Set-Cookie headers an
// adapter applied to a response, and sends them back as a Cookie header on the next request.
export class Browser {
  readonly jar = new Map<string, string>();

  store(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      if (/Max-Age=0/i.test(line)) {
        this.jar.delete(name);
      } else {
        this.jar.set(name, pair.slice(eq + 1));
      }
    }
  }

  request(url: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    if (this.jar.size > 0) {
      headers.set("cookie", [...this.jar].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    return new Request(url, { ...init, headers });
  }
}
