// Upstream: tools/router/router.go (ResponseWriter) with the response side
// of net/http: the body of writeBody survives a flush, a write after the
// handler returned is refused instead of lost, and the gzip middleware
// compresses a writeBody body and passes its cleanups on.

import { expect, test } from "bun:test";

import { newRouter as newAppRouter } from "@/apis/base";
import { gzip } from "@/middlewares/gzip";
import { Event } from "@/server/event";
import { ErrWriteAfterFinish, ResponseWriter, Router } from "@/server/router";

import { openFixtureApp } from "@test/app/app";
import { serveTest } from "@test/support/router";

function newRouter(): Router<Event> {
  return new Router<Event>((w, req) => [new Event(w, req), () => {}]);
}

test("a writeBody body is sent after a flush", async () => {
  const r = newRouter();
  r.GET("/a", (e) => {
    e.response.header.set("Content-Type", "text/plain");
    expect(e.response.writeBody(new Blob(["whole body"]))).toBeUndefined();
    e.response.flush();
    return undefined;
  });
  r.GET("/promised", (e) => {
    e.response.writeBody(Promise.resolve(new Blob(["promised body"])));
    e.response.flush();
    return undefined;
  });
  r.GET("/stream", (e) => {
    e.response.writeBody(new Blob(["streamed body"]).stream());
    e.response.flush();
    return undefined;
  });
  const mux = r.buildMux();

  const cases: [string, string][] = [
    ["/a", "whole body"],
    ["/promised", "promised body"],
    ["/stream", "streamed body"],
  ];
  for (const [path, body] of cases) {
    const res = await serveTest(mux, { target: path });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
  }
});

test("a write after the response finished is refused", () => {
  const rw = new ResponseWriter(() => {});
  rw.write("body");
  rw.finish();
  expect(rw.write("late")).toBe(ErrWriteAfterFinish);
  expect(rw.writeBody(new Blob(["late"]))).toBe(ErrWriteAfterFinish);
});

test("gzip compresses a writeBody body and runs the cleanups after the response", async () => {
  const app = await openFixtureApp();
  const r = newAppRouter(app);
  let cleaned = 0;
  r.GET("/file", (e) => {
    e.response.header.set("Content-Type", "text/plain");
    e.response.afterResponse(() => {
      cleaned++;
    });
    e.response.writeBody(new Blob(["compressed body"]));
    return undefined;
  }).bind(gzip());
  const mux = r.buildMux();

  const res = await serveTest(mux, { target: "/file", headers: { "Accept-Encoding": "gzip" } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-encoding")).toBe("gzip");
  expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer())))).toBe(
    "compressed body",
  );
  // the cleanups run on a timer after the response reached the server
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(cleaned).toBe(1);
  await app.cleanup();
});
