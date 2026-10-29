// Upstream: apis/record_crud.go (recordsList's randomized throttle)
//
// The throttle is not visible in a response, only in its timing, so it is
// checked in-process with the router's sleep option and a fixed clock:
// after three empty filtered lists by a non-superuser on a collection with
// a list rule (listTimingRateLimitRule: 3 per 3 s), the fourth sleeps for
// less than 500 ms. The list and view responses themselves are covered by
// the scenarios (test/scenarios/record-crud.ts) and the differential
// cases (test/differential/records-read/).

import { afterAll, beforeAll, expect, test } from "bun:test";

import { newRouter } from "@/apis/base";
import { findCollectionByNameOrId } from "@/collections/collection-query";
import { saveCollection } from "@/collections/collection-save";

import { openFixtureApp, type TestApp } from "@test/app/app";
import { superuserToken } from "@test/scenarios/record-crud";
import { serveTest } from "@test/support/router";

let now = new Date("2030-01-01T00:00:00Z");
let app: TestApp;

beforeAll(() => {
  // read through a read worker pool, as `serve` does
  app = openFixtureApp({ clock: { now: () => now }, readWorkers: 2 });
  const demo2 = findCollectionByNameOrId(app, "demo2");
  demo2.listRule = "title != ''";
  saveCollection(app, demo2);
});

afterAll(() => app.cleanup());

function router(sleeps: number[]): ReturnType<typeof newRouter> {
  return newRouter(app, {
    recordCrud: {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  });
}

const emptyFilter = "/api/collections/demo2/records?filter=title%3D'nope'";

test("the fourth empty filtered list in a window is throttled", async () => {
  const sleeps: number[] = [];
  const mux = router(sleeps).buildMux();

  for (let i = 0; i < 3; i++) {
    const res = await serveTest(mux, { target: emptyFilter, remoteAddr: "10.0.0.1:1000" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`"items":[]`);
  }
  expect(sleeps).toEqual([]);

  const res = await serveTest(mux, { target: emptyFilter, remoteAddr: "10.0.0.1:1000" });
  expect(res.status).toBe(200);
  expect(sleeps.length).toBe(1);
  expect(sleeps[0]).toBeGreaterThanOrEqual(0);
  expect(sleeps[0]).toBeLessThan(500);

  // another client has its own window
  await serveTest(mux, { target: emptyFilter, remoteAddr: "10.0.0.2:1000" });
  expect(sleeps.length).toBe(1);

  // a new window starts after 3 seconds
  now = new Date(now.getTime() + 3000);
  await serveTest(mux, { target: emptyFilter, remoteAddr: "10.0.0.1:1000" });
  expect(sleeps.length).toBe(1);
});

test("superusers, unfiltered and non-empty lists are not throttled", async () => {
  now = new Date(now.getTime() + 60_000);
  const sleeps: number[] = [];
  const mux = router(sleeps).buildMux();

  for (let i = 0; i < 5; i++) {
    await serveTest(mux, {
      target: emptyFilter,
      headers: { Authorization: superuserToken },
      remoteAddr: "10.0.0.3:1000",
    });
    await serveTest(mux, {
      target: "/api/collections/demo2/records",
      remoteAddr: "10.0.0.3:1000",
    });
    await serveTest(mux, {
      target: "/api/collections/demo2/records?filter=title!%3D''",
      remoteAddr: "10.0.0.3:1000",
    });
  }
  expect(sleeps).toEqual([]);
});
