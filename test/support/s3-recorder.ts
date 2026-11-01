// A local HTTP server for the S3 tests. It records every request the S3 client
// sends (method, path, query, headers, body) and answers each one with what the
// test's respond function returns. Tests stop it when they finish.

export interface RecordedRequest {
  method: string;
  // the request target as sent: the path, and the query without the "?"
  path: string;
  query: string;
  headers: Headers;
  body: Uint8Array;
}

export interface S3Recorder {
  // the endpoint for S3Config, with a trailing slash
  endpoint: string;
  requests: RecordedRequest[];
  stop(): void;
}

export function startS3Recorder(respond: (req: RecordedRequest) => Response): S3Recorder {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const recorded: RecordedRequest = {
        method: req.method,
        path: url.pathname,
        query: url.search.slice(1),
        headers: req.headers,
        body: new Uint8Array(await req.arrayBuffer()),
      };
      requests.push(recorded);
      return respond(recorded);
    },
  });

  return {
    endpoint: `http://127.0.0.1:${server.port}/`,
    requests,
    stop: () => {
      server.stop(true);
    },
  };
}
