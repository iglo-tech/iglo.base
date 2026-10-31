// A test-only fetch: while it is installed, the global fetch answers the
// routes of one test and fails every other request, so a test that reaches
// a fixed provider URL (Apple's JWKS, Gitee's emails) never reaches a real
// host. Only tests install it: the executable has no request or setting
// that reaches it, and the differential suite never does.

export interface StubRequest {
  method: string;
  headers: Headers;
  body: string;
}

// a route answers the request to one URL (its origin and path, no query)
export type StubRoute = (req: StubRequest) => Response | Promise<Response>;

export interface StubbedFetch {
  // the URLs (origin and path) requested while the stub was installed
  calls: string[];
  restore(): void;
}

// the fetch of the process, before any stub
const realFetch = globalThis.fetch;

export function stubFetch(routes: { [url: string]: StubRoute }): StubbedFetch {
  const calls: string[] = [];

  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const key = url.origin + url.pathname;
    calls.push(key);

    const route = Object.hasOwn(routes, key) ? routes[key] : undefined;
    if (route === undefined) {
      throw new Error(`unexpected request in a test: ${url.href}`);
    }

    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    return route({ method: init?.method ?? "GET", headers, body });
  };

  globalThis.fetch = stub as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
