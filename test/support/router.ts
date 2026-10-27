// Runs a request through a built router mux in-process, without a socket:
// the request target is passed as is (no URL normalization), and the
// response is the one the server would send.

import { bytesReader, RereadableReadCloser } from "@/server/rereadable-read-closer";
import { HttpRequest } from "@/server/request";
import { ResponseWriter, type Mux } from "@/server/router";

export interface TestRequest {
  method?: string;
  // origin-form request target, e.g. "/a/b?x=1"
  target: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  remoteAddr?: string;
}

export function newTestRequest(init: TestRequest): HttpRequest {
  const q = init.target.indexOf("?");
  const body = init.body ?? "";
  const headers = new Headers(init.headers ?? {});
  return new HttpRequest({
    method: init.method ?? "GET",
    host: headers.get("Host") ?? "example.com",
    escapedPath: q === -1 ? init.target : init.target.slice(0, q),
    rawQuery: q === -1 ? "" : init.target.slice(q + 1),
    headers,
    body: new RereadableReadCloser(bytesReader(body)),
    contentLength: typeof body === "string" ? new TextEncoder().encode(body).length : body.length,
    remoteAddr: init.remoteAddr ?? "127.0.0.1:12345",
    tls: false,
  });
}

export async function serveTest(mux: Mux, init: TestRequest): Promise<Response> {
  const req = newTestRequest(init);
  let streamed: Response | undefined;
  const rw = new ResponseWriter((response) => {
    streamed = response;
  });
  await mux.serveHTTP(rw, req);
  const response = rw.finish();
  return (response ?? streamed) as Response;
}
