// The Bun.serve transport (@/server/serve handleRequest) with the app's
// router, over real sockets. The test-only routes (a handler that panics,
// one that streams, one that echoes the request) exist only here.

import { afterAll, beforeAll, expect, test } from "bun:test";

import { newRouter } from "@/apis/base";
import { newApp } from "@/app/app";
import { handleRequest } from "@/server/serve";
import { rawRequest } from "@test/support/raw-http";

const errors: string[] = [];
const app = newApp({
  dataDir: "/tmp/pb_data",
  isDev: false,
  encryptionEnv: "",
  queryTimeout: 30,
  clock: { now: () => new Date(0) },
  logger: { error: (message) => errors.push(message) },
});

let server: ReturnType<typeof Bun.serve>;
let url: string;

beforeAll(() => {
  const router = newRouter(app);
  router.GET("/test-panic", () => {
    throw new Error("test panic");
  });
  router.GET("/test-stream", async (e) => {
    e.response.header.set("Content-Type", "text/plain");
    e.response.write("first;");
    e.flush();
    await Bun.sleep(10);
    e.response.write("second");
    return undefined;
  });
  router.POST("/test-echo", async (e) => {
    const info = await e.requestInfo();
    if (info instanceof Error) {
      return info;
    }
    return e.json(200, { info, remoteIP: e.remoteIP(), host: e.request.host });
  });
  const mux = router.buildMux();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, s) => handleRequest(app, mux, request, s.requestIP(request)),
  });
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
});

test("a panic inside a handler returns upstream's 500 body", async () => {
  const res = await fetch(`${url}/test-panic`);
  expect(res.status).toBe(500);
  expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  expect(await res.json()).toEqual({
    data: {},
    message: "Something went wrong while processing your request.",
    status: 500,
  });
  expect(errors).toEqual([]);
});

test("a flushed response is streamed", async () => {
  const res = await fetch(`${url}/test-stream`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/plain");
  expect(await res.text()).toBe("first;second");
});

test("the request reaches the handler as Go's server would pass it", async () => {
  const res = await fetch(`${url}/test-echo?q=1&q=2`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Token": "abc" },
    body: `{"a":1}`,
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    info: { query: unknown; headers: Record<string, string>; body: unknown; method: string };
    remoteIP: string;
    host: string;
  };
  expect(json.info.query).toEqual({ q: "1" });
  expect(json.info.body).toEqual({ a: 1 });
  expect(json.info.method).toBe("POST");
  expect(json.info.headers.x_token).toBe("abc");
  // Go moves Host out of the header map
  expect(json.info.headers.host).toBeUndefined();
  expect(json.host).toBe(`127.0.0.1:${server.port}`);
  expect(json.remoteIP).toBe("127.0.0.1");
});

test("an invalid percent escape is rejected before routing", async () => {
  const res = await rawRequest(url, "GET", "/api/%zz");
  expect(res.status).toBe(400);
  expect(res.headers.get("connection")).toBe("close");
  expect(res.body).toBe("400 Bad Request");
});
