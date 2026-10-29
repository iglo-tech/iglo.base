// Upstream: apis/middlewares_body_limit_test.go (TestBodyLimitMiddleware)
//
// The default router (apis/base.ts) of a test app with three test routes:
// /a under the global BodyLimit, /b and /iof with a custom limit. A "lazy"
// request has no Content-Length (chunked), so only the limited reader can
// refuse it. Upstream binds into `any` and sends a JSON string of the
// limit's size; BindBody here binds a map (MapRef), so the bodies are JSON
// objects of the same sizes. The per-collection limit of the record routes is covered by
// the records write scenarios (body > / <= collection BodyLimit).

import { afterAll, beforeAll, expect, test } from "bun:test";

import { newRouter } from "@/apis/base";
import type { RequestEvent } from "@/app/event-request";
import { bodyLimit } from "@/middlewares/body-limit";
import { DefaultMaxBodySize } from "@/middlewares/middlewares";
import { bytesReader, readAll, RereadableReadCloser } from "@/server/rereadable-read-closer";
import { HttpRequest } from "@/server/request";
import { ResponseWriter, type Mux } from "@/server/router";
import type { MapRef } from "@/server/unmarshal-request-data";

import { openFixtureApp, type TestApp } from "@test/app/app";

let testApp: TestApp;
let mux: Mux;

const customLimit = 20;

const testHandler = async (e: RequestEvent) => {
  // read the body multiple times to ensure that the limited
  // reader guards and rereads are invoked
  const result: MapRef = { map: {} };
  let err = await e.bindBody(result);
  if (err) {
    return err;
  }

  err = await e.bindBody(result);
  if (err) {
    return err;
  }

  return e.json(200, result.map);
};

beforeAll(() => {
  testApp = openFixtureApp();
  const pbRouter = newRouter(testApp);

  pbRouter.POST("/a", testHandler); // default global BodyLimit check
  pbRouter.POST("/b", testHandler).bind(bodyLimit(customLimit));
  pbRouter
    .POST("/iof", async (e) => {
      // ensure that normal io methods still operate correctly
      const b = await readAll(e.request.body);
      return e.string(200, new TextDecoder().decode(b));
    })
    .bind(bodyLimit(customLimit));

  mux = pbRouter.buildMux();
});

afterAll(() => testApp.cleanup());

async function send(url: string, body: string, lazyContentLength: boolean): Promise<number> {
  const bytes = new TextEncoder().encode(body);
  const req = new HttpRequest({
    method: "POST",
    host: "example.com",
    escapedPath: url,
    rawQuery: "",
    headers: new Headers({ "Content-Type": "application/json" }),
    body: new RereadableReadCloser(bytesReader(bytes)),
    contentLength: lazyContentLength ? -1 : bytes.length,
    remoteAddr: "127.0.0.1:12345",
    tls: false,
  });
  const rw = new ResponseWriter(() => {});
  await mux.serveHTTP(rw, req);
  return (rw.finish() as Response).status;
}

// a JSON object of n + 2 bytes (upstream's `"` + n bytes + `"`)
const quoted = (n: number) => `{"a":"${"a".repeat(n - 6)}"}`;

const scenarios: {
  name: string;
  url: string;
  body: () => string;
  lazy: boolean;
  status: number;
}[] = [
  {
    name: "(eager content-length check) with body = default limit",
    url: "/a",
    body: () => quoted(DefaultMaxBodySize - 2),
    lazy: false,
    status: 200,
  },
  {
    name: "(eager content-length check) with body > default limit",
    url: "/a",
    body: () => quoted(DefaultMaxBodySize),
    lazy: false,
    status: 413,
  },
  {
    name: "(lazy content-length check) with body = default limit",
    url: "/a",
    body: () => quoted(DefaultMaxBodySize - 2),
    lazy: true,
    status: 200,
  },
  {
    name: "(lazy content-length check) with body > default limit",
    url: "/a",
    body: () => quoted(DefaultMaxBodySize),
    lazy: true,
    status: 413,
  },
  // ---
  {
    name: "(eager content-length check) with body = custom limit",
    url: "/b",
    body: () => quoted(customLimit - 2),
    lazy: false,
    status: 200,
  },
  {
    name: "(eager content-length check) with body > custom limit",
    url: "/b",
    body: () => quoted(customLimit),
    lazy: false,
    status: 413,
  },
  {
    name: "(lazy content-length check) with body = custom limit",
    url: "/b",
    body: () => quoted(customLimit - 2),
    lazy: true,
    status: 200,
  },
  {
    name: "(lazy content-length check) with body > custom limit",
    url: "/b",
    body: () => quoted(customLimit),
    lazy: true,
    status: 413,
  },
  // ---
  {
    name: "io.ReadAll io.EOF exact limit check",
    url: "/iof",
    body: () => quoted(customLimit - 2),
    lazy: true,
    status: 200,
  },
];

for (const s of scenarios) {
  test(s.name, async () => {
    expect(await send(s.url, s.body(), s.lazy)).toBe(s.status);
  });
}
