// Forwards requests to a server and counts them at the server boundary. The test runs it as
// its own process: Bun caps concurrent HTTP requests per process (256 by default), and an
// in-process proxy shares that cap with the test's own 400 parallel requests, which then
// deadlock. Usage: bun counting-proxy.ts <target-url>; prints {"port": n} on the first line.
// Endpoints: /__counts and /__reset (counters); every other request is forwarded.

const target = new URL(Bun.argv[2] ?? "http://127.0.0.1:8090");
const counts = { sessionChecks: 0, dataRequests: 0 };

const server = Bun.serve({
  port: 0,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__counts") {
      return Response.json(counts);
    }
    if (url.pathname === "/__reset") {
      counts.sessionChecks = 0;
      counts.dataRequests = 0;
      return Response.json(counts);
    }
    if (url.pathname.includes("/auth-refresh")) {
      counts.sessionChecks++;
    } else {
      counts.dataRequests++;
    }
    const headers = new Headers(req.headers);
    headers.set("host", target.host);
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;
    return fetch(new URL(url.pathname + url.search, target), {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      ...(hasBody ? { duplex: "half" } : {}),
    });
  },
});

console.log(JSON.stringify({ port: server.port }));
