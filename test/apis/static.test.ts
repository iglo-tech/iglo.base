// Upstream: apis/base_test.go (TestStatic, createTestDir) and
// tools/router/event_test.go (TestEventFileFS)
//
// TestStatic calls Static directly with the path value set, as upstream
// does (through the mux, Go's ServeMux and its port answer a raw ".."
// segment with a 307 first). TestEventFileFS and the other cases go through
// the default router's static route (newRouter with a public dir, as `serve
// --publicDir` binds it), in-process, where a returned error is rendered as
// the 404 "File not found." body. test/differential/serve/static.test.ts
// compares served files with upstream's binary.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { newRouter, staticHandler, StaticWildcardParam } from "@/apis/base";
import { dirFS } from "@/apis/static-fs";
import { RequestEvent } from "@/app/event-request";
import { ApiError } from "@/server/error";
import { ResponseWriter, type Mux } from "@/server/router";

import { openFixtureApp, type TestApp } from "@test/app/app";
import { tempDir } from "@test/support/executable";
import { newTestRequest, serveTest } from "@test/support/router";

const notFound = `{"data":{},"message":"File not found.","status":404}`;

let app: TestApp;
let dir: string;

// createTestDir
function createTestDir(): string {
  const d = tempDir();
  writeFileSync(join(d, "index.html"), "root index.html");
  writeFileSync(join(d, "testroot"), "root test");
  mkdirSync(join(d, "sub", "sub2"), { recursive: true });
  writeFileSync(join(d, "sub/index.html"), "sub index.html");
  writeFileSync(join(d, "sub/test"), "sub test");
  writeFileSync(join(d, "sub/sub2/index.html"), "sub2 index.html");
  writeFileSync(join(d, "sub/sub2/test"), "sub2 test");
  return d;
}

beforeAll(async () => {
  app = await openFixtureApp({ clock: { now: () => new Date(Date.UTC(2026, 9, 29)) } });
  dir = createTestDir();
});

afterAll(async () => {
  await app.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe("TestStatic", () => {
  interface StaticScenario {
    path: string;
    indexFallback: boolean;
    expectedStatus: number;
    expectBody: string;
    expectError: boolean;
  }

  const scenarios: StaticScenario[] = [
    {
      path: "",
      indexFallback: false,
      expectedStatus: 200,
      expectBody: "sub index.html",
      expectError: false,
    },
    {
      path: "missing/a/b/c",
      indexFallback: false,
      expectedStatus: 404,
      expectBody: "",
      expectError: true,
    },
    {
      path: "missing/a/b/c",
      indexFallback: true,
      expectedStatus: 200,
      expectBody: "sub index.html",
      expectError: false,
    },
    // parent directory file
    {
      path: "testroot",
      indexFallback: false,
      expectedStatus: 404,
      expectBody: "",
      expectError: true,
    },
    {
      path: "test",
      indexFallback: false,
      expectedStatus: 200,
      expectBody: "sub test",
      expectError: false,
    },
    { path: "sub2", indexFallback: false, expectedStatus: 301, expectBody: "", expectError: false },
    {
      path: "sub2/",
      indexFallback: false,
      expectedStatus: 200,
      expectBody: "sub2 index.html",
      expectError: false,
    },
    {
      path: "sub2/test",
      indexFallback: false,
      expectedStatus: 200,
      expectBody: "sub2 test",
      expectError: false,
    },
    {
      path: "sub2/test/",
      indexFallback: false,
      expectedStatus: 301,
      expectBody: "",
      expectError: false,
    },
  ];

  // extra directory traversal checks
  const dtp = [
    "/../",
    "\\../",
    "../",
    "../../",
    "..\\",
    "..\\..\\",
    "../..\\",
    "..\\..//",
    "%2e%2e%2f",
    "%2e%2e%2f%2e%2e%2f",
    "%2e%2e/",
    "%2e%2e/%2e%2e/",
    "..%2f",
    "..%2f..%2f",
    "%2e%2e%5c",
    "%2e%2e%5c%2e%2e%5c",
    "%2e%2e\\",
    "%2e%2e\\%2e%2e\\",
    "..%5c",
    "..%5c..%5c",
    "%252e%252e%255c",
    "%252e%252e%255c%252e%252e%255c",
    "..%255c",
    "..%255c..%255c",
  ];
  for (const p of dtp) {
    scenarios.push(
      {
        path: p + "testroot",
        indexFallback: false,
        expectedStatus: 404,
        expectBody: "",
        expectError: true,
      },
      {
        path: p + "testroot",
        indexFallback: true,
        expectedStatus: 200,
        expectBody: "sub index.html",
        expectError: false,
      },
    );
  }

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.path}_${s.indexFallback}`, async () => {
      const req = newTestRequest({ target: "/" + s.path });
      req.setPathValue(StaticWildcardParam, s.path);
      const rec = new ResponseWriter();
      const e = new RequestEvent(app, rec, req);

      const err = await staticHandler(dirFS(join(dir, "sub"), dir), s.indexFallback)(e);

      expect(err !== undefined).toBe(s.expectError);
      const res = rec.finish() as Response | undefined;
      const body = res ? await res.text() : "";
      expect(body).toBe(s.expectBody);
      if (err) {
        expect(err instanceof ApiError ? err.status : 0).toBe(s.expectedStatus);
      } else {
        expect(res?.status).toBe(s.expectedStatus);
      }
    });
  }
});

describe("TestEventFileFS", () => {
  let fileDir: string;

  beforeAll(() => {
    fileDir = tempDir();
    writeFileSync(join(fileDir, "index.html"), "index");
    writeFileSync(join(fileDir, "test.txt"), "test");
    // create sub directory with an index.html file inside it
    mkdirSync(join(fileDir, "sub1"));
    writeFileSync(join(fileDir, "sub1", "index.html"), "sub1 index");
    mkdirSync(join(fileDir, "sub2"));
    writeFileSync(join(fileDir, "sub2", "test.txt"), "sub2 test");
  });

  afterAll(() => rmSync(fileDir, { recursive: true, force: true }));

  // FileFS through Static: for an existing file or a directory with a
  // trailing slash, Static serves it with FileFS; "" is fs.ValidPath's
  // failure, reached here as the stat of the root's missing name
  const scenarios: [name: string, path: string, expected: string][] = [
    ["root with no explicit file", "/", "index"],
    ["root with explicit file", "/test.txt", "test"],
    ["sub dir with no explicit file", "/sub1/", "sub1 index"],
    ["sub dir with no explicit file (no index.html)", "/sub2/", ""],
    ["sub dir explicit file", "/sub2/test.txt", "sub2 test"],
  ];

  for (const [name, path, expected] of scenarios) {
    test(name, async () => {
      const m = newRouter(app, { publicDir: { dir: fileDir, indexFallback: false } }).buildMux();
      const res = await serveTest(m, { target: path });
      const body = await res.text();
      if (expected === "") {
        expect(res.status).toBe(404);
        expect(body.trimEnd()).toBe(notFound);
        return;
      }
      expect(res.status).toBe(200);
      expect(body).toBe(expected);
      // ensure that the proper file headers are added
      // (aka. http.ServeContent is invoked)
      expect(Number(res.headers.get("content-length"))).toBe(expected.length);
      expect(res.headers.get("last-modified")).not.toBeNull();
      expect(res.headers.get("accept-ranges")).toBe("bytes");
    });
  }

  test("missing file: fs.ValidPath fails for an empty name", () => {
    const fsys = dirFS(fileDir, fileDir);
    expect(fsys.stat("")).toBeUndefined();
    expect(fsys.open("")).toBeUndefined();
    expect(fsys.stat(".")).toBe("dir");
    expect(fsys.open("a\0b")).toBeUndefined();
    expect(fsys.stat("sub1/../test.txt")).toBeUndefined();
  });
});

describe("the public dir", () => {
  let pub: string;
  let outside: string;

  beforeAll(() => {
    const root = tempDir();
    pub = join(root, "pb_public");
    outside = join(root, "outside");
    mkdirSync(pub);
    mkdirSync(outside);
    writeFileSync(join(pub, "index.html"), "index");
    writeFileSync(join(pub, "app.zip"), new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]));
    writeFileSync(join(pub, "noext"), "plain text");
    writeFileSync(join(outside, "secret.txt"), "outside");
    symlinkSync(join(outside, "secret.txt"), join(pub, "link.txt"));
  });

  afterAll(() => rmSync(join(pub, ".."), { recursive: true, force: true }));

  function mux(indexFallback: boolean): Mux {
    return newRouter(app, { publicDir: { dir: pub, indexFallback } }).buildMux();
  }

  test("a symbolic link is followed, as os.DirFS does", async () => {
    const res = await serveTest(mux(false), { target: "/link.txt" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("outside");
  });

  test("a type without an extension entry is sniffed", async () => {
    const res = await serveTest(mux(false), { target: "/noext" });
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  test("no Content-Disposition is added to a file response", async () => {
    const res = await serveTest(mux(false), { target: "/app.zip" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]),
    );
  });

  test("/api/ and the other routes keep priority; unknown paths fall back", async () => {
    const m = mux(true);
    const health = await serveTest(m, { target: "/api/health" });
    expect(health.status).toBe(200);
    expect(await health.text()).toContain("API is healthy.");
    // no API route matches: the static route's index fallback, as upstream
    const unknown = await serveTest(m, { target: "/api/unknown" });
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toBe("index");
  });

  test("a missing public dir answers File not found.", async () => {
    const m = newRouter(app, {
      publicDir: { dir: join(pub, "missing"), indexFallback: true },
    }).buildMux();
    const res = await serveTest(m, { target: "/a/b" });
    expect(res.status).toBe(404);
    expect((await res.text()).trimEnd()).toBe(notFound);
  });
});
