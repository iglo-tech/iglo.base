// A local HTTP proxy in front of an S3 test server. It records every request
// and passes it on unchanged (a signed request keeps its Host header), except
// the ones a test tells it to refuse, which get an S3 error.

export interface ProxiedRequest {
  method: string;
  // the decoded object path, without the bucket's leading slash
  path: string;
  query: string;
}

export interface S3Proxy {
  endpoint: string;
  requests: ProxiedRequest[];
  // a request it returns true for gets an AccessDenied error
  refuse: ((req: ProxiedRequest) => boolean) | null;
  stop(): void;
}

const denied = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>AccessDenied</Code><Message>Access Denied.</Message></Error>`;

export function startS3Proxy(target: string): S3Proxy {
  const proxy: S3Proxy = {
    endpoint: "",
    requests: [],
    refuse: null,
    stop: () => {},
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    // S3 answers a slow multipart request later than Bun's default
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const recorded: ProxiedRequest = {
        method: req.method,
        path: decodeURIComponent(url.pathname).slice(1),
        query: url.search.slice(1),
      };
      proxy.requests.push(recorded);

      if (proxy.refuse?.(recorded) === true) {
        return new Response(denied, {
          status: 403,
          headers: { "Content-Type": "application/xml" },
        });
      }

      const res = await fetch(target + url.pathname + url.search, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer(),
        decompress: false,
        redirect: "manual",
      });
      return new Response(req.method === "HEAD" ? null : res.body, {
        status: res.status,
        headers: res.headers,
      });
    },
  });

  proxy.endpoint = `http://127.0.0.1:${server.port}`;
  proxy.stop = () => {
    server.stop(true);
  };
  return proxy;
}
