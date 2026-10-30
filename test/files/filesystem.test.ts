// Upstream: tools/filesystem/filesystem_test.go (TestFilesystemServe,
// TestFilesystemServeSingleRange, TestFilesystemServeMultiRange,
// TestFilesystemCreateThumb, TestFilesystemCreateThumbWithMaxPixelsLimit;
// createTestDir)
//
// The hook call counts (OnDelete, OnNewWriter) are dropped (D5). The
// thumbs are rendered by the app's thumb pool (src/files/thumb-pool.ts),
// in its worker, as the file API renders them. Go's tiny test images are
// written by Go's encoders; here a 5x5 white PNG and JPEG are encoded by
// Bun.Image, so the PNG's Content-Length is its own size, not Go's 78.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ThumbPool } from "@/files/thumb-pool";
import { encodePng } from "@/files/png-raw";
import { ResponseWriter } from "@/server/router";
import { NewLocal, type System } from "@/tools/filesystem/filesystem";
import { detect } from "@/tools/mimetype/mimetype";

import { newTestRequest } from "@test/support/router";

const attrs = (contentType: string): string =>
  `{"user.cache_control":"","user.content_disposition":"","user.content_encoding":"","user.content_language":"","user.content_type":"${contentType}","user.metadata":null}`;

const white5x5 = encodePng({ width: 5, height: 5, pix: new Uint8Array(100).fill(255) }, 6);

let dir: string;
let pngSize: number;

async function createTestDir(): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), "pb_test"));
  mkdirSync(join(d, "empty"));
  mkdirSync(join(d, "test"));
  writeFileSync(join(d, "test/sub1.txt"), "sub1");
  writeFileSync(join(d, "test/sub2.txt"), "sub2");

  // png
  const png = await new Bun.Image(white5x5).png().bytes();
  pngSize = png.length;
  writeFileSync(join(d, "image.png"), png);
  writeFileSync(join(d, "image.png.attrs"), attrs("image/png"));

  // jpg
  const jpg = await new Bun.Image(white5x5).jpeg().bytes();
  writeFileSync(join(d, "image.jpg"), jpg);
  writeFileSync(join(d, "image.jpg.attrs"), attrs("image/jpeg"));

  // svg
  writeFileSync(join(d, "image.svg"), "");

  // webp
  writeFileSync(
    join(d, "image.webp"),
    new Uint8Array([
      82, 73, 70, 70, 36, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32, 24, 0, 0, 0, 48, 1, 0, 157, 1,
      42, 1, 0, 1, 0, 2, 0, 52, 37, 164, 0, 3, 112, 0, 254, 251, 253, 80, 0,
    ]),
  );

  // invalid/special characters
  writeFileSync(join(d, "image_!@ special"), png);

  // no extension
  writeFileSync(join(d, "image_noext"), jpg);
  writeFileSync(join(d, "image_noext.attrs"), attrs("image/jpeg"));

  // empty files with the extensions Serve maps to a content type
  for (const name of [
    "style.css",
    "main.js",
    "main.mjs",
    "dummy.xlsx",
    "dummy.docx",
    "dummy.pptx",
  ]) {
    writeFileSync(join(d, name), "");
  }

  return d;
}

beforeAll(async () => {
  dir = await createTestDir();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function serve(
  fsys: System,
  path: string,
  name: string,
  init: { query?: string; headers?: Record<string, string>; preset?: Record<string, string> } = {},
): Response {
  const rw = new ResponseWriter();
  for (const [k, v] of Object.entries(init.preset ?? {})) {
    rw.header.set(k, v);
  }
  fsys.serve(
    rw,
    newTestRequest({ target: "/" + (init.query ? "?" + init.query : ""), headers: init.headers }),
    path,
    name,
  );
  return rw.finish() as Response;
}

describe("TestFilesystemServe", () => {
  const csp = "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox";
  const cacheControl = "max-age=2592000, stale-while-revalidate=86400";

  const scenarios: {
    path: string;
    name: string;
    query?: string;
    headers?: Record<string, string>;
    expectError: boolean;
    expectHeaders?: () => Record<string, string>;
  }[] = [
    // missing
    { path: "missing.txt", name: "test_name.txt", expectError: true },
    // existing regular file
    {
      path: "test/sub1.txt",
      name: "test_name.txt",
      expectError: false,
      expectHeaders: () => ({
        "Content-Disposition": `attachment; filename="test_name.txt"`,
        "Content-Type": "application/octet-stream",
        "Content-Length": "4",
        "Content-Security-Policy": csp,
        "Cache-Control": cacheControl,
      }),
    },
    // png inline
    {
      path: "image.png",
      name: "test_name.png",
      expectError: false,
      expectHeaders: () => ({
        "Content-Disposition": `inline; filename="test_name.png"`,
        "Content-Type": "image/png",
        "Content-Length": String(pngSize),
        "Content-Security-Policy": csp,
        "Cache-Control": cacheControl,
      }),
    },
    // png with forced attachment
    {
      path: "image.png",
      name: "test_name_download.png",
      query: "download=1",
      expectError: false,
      expectHeaders: () => ({
        "Content-Disposition": `attachment; filename="test_name_download.png"`,
        "Content-Type": "image/png",
        "Content-Length": String(pngSize),
        "Content-Security-Policy": csp,
        "Cache-Control": cacheControl,
      }),
    },
    // svg exception
    ...(
      [
        ["image.svg", "image/svg+xml"],
        ["style.css", "text/css"],
        ["main.js", "text/javascript"],
        ["main.mjs", "text/javascript"],
        ["dummy.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
        ["dummy.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
        ["dummy.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ] as const
    ).map(([path, contentType]) => ({
      path,
      name: path === "style.css" ? "test_name" : "test_name.abc",
      expectError: false,
      expectHeaders: () => ({
        "Content-Disposition": `attachment; filename="${path === "style.css" ? "test_name" : "test_name.abc"}"`,
        "Content-Type": contentType,
        "Content-Length": "0",
        "Content-Security-Policy": csp,
        "Cache-Control": cacheControl,
      }),
    })),
    // custom header
    {
      path: "test/sub2.txt",
      name: "test_name.txt",
      headers: {
        "Content-Disposition": "1",
        "Content-Type": "2",
        "Content-Length": "1",
        "Content-Security-Policy": "4",
        "Cache-Control": "5",
        "X-Custom": "6",
      },
      expectError: false,
      expectHeaders: () => ({
        "Content-Disposition": "1",
        "Content-Type": "2",
        "Content-Length": "4", // overwriten by http.ServeContent
        "Content-Security-Policy": "4",
        "Cache-Control": "5",
        "X-Custom": "6",
      }),
    },
  ];

  for (const s of scenarios) {
    test(`${s.path} as ${s.name}${s.query ? "?" + s.query : ""}`, () => {
      const fsys = NewLocal(dir);
      try {
        let res: Response | undefined;
        let err: unknown;
        try {
          res = serve(fsys, s.path, s.name, {
            ...(s.query ? { query: s.query } : {}),
            ...(s.headers ? { preset: s.headers } : {}),
          });
        } catch (e) {
          err = e;
        }
        expect(err !== undefined).toBe(s.expectError);
        if (s.expectError) {
          return;
        }
        for (const [name, value] of Object.entries(s.expectHeaders?.() ?? {})) {
          expect(`${name}: ${res?.headers.get(name)}`).toBe(`${name}: ${value}`);
        }
      } finally {
        fsys.close();
      }
    });
  }
});

test("TestFilesystemServeSingleRange", () => {
  const fsys = NewLocal(dir);
  try {
    const res = serve(fsys, "image.png", "image.png", { headers: { Range: "bytes=0-20" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-20/${pngSize}`);
    expect(res.headers.get("Content-Length")).toBe("21");
  } finally {
    fsys.close();
  }
});

test("TestFilesystemServeMultiRange", async () => {
  const fsys = NewLocal(dir);
  try {
    const res = serve(fsys, "image.png", "image.png", { headers: { Range: "bytes=0-20, 25-30" } });
    expect(res.status).toBe(206);
    const ct = res.headers.get("Content-Type") ?? "";
    expect(ct.startsWith("multipart/byteranges; boundary=")).toBe(true);
    // the body is the parts, as Content-Length says
    const body = new Uint8Array(await res.arrayBuffer());
    expect(String(body.length)).toBe(res.headers.get("Content-Length") as string);
  } finally {
    fsys.close();
  }
});

describe("TestFilesystemCreateThumb", () => {
  const scenarios: [file: string, thumb: string, size: string, expectedMimeType: string][] = [
    // missing
    ["missing.txt", "thumb_test_missing", "100x100", ""],
    // non-image existing file
    ["test/sub1.txt", "thumb_test_sub1", "100x100", ""],
    // existing image file with existing thumb path = should fail
    ["image.png", "test", "100x100", ""],
    // existing image file with invalid thumb size
    ["image.png", "thumb0", "invalid", ""],
    // existing image file with 0xH thumb size
    ["image.png", "thumb_0xH", "0x100", "image/png"],
    // existing image file with Wx0 thumb size
    ["image.png", "thumb_Wx0", "100x0", "image/png"],
    // existing image file with WxH thumb size
    ["image.png", "thumb_WxH", "100x100", "image/png"],
    // existing image file with WxHt thumb size
    ["image.png", "thumb_WxHt", "100x100t", "image/png"],
    // existing image file with WxHb thumb size
    ["image.png", "thumb_WxHb", "100x100b", "image/png"],
    // existing image file with WxHf thumb size
    ["image.png", "thumb_WxHf", "100x100f", "image/png"],
    // jpg
    ["image.jpg", "thumb.jpg", "100x100", "image/jpeg"],
    // webp (should produce png)
    ["image.webp", "thumb.webp", "100x100", "image/png"],
    // without extension (should extract the mimetype from its stored ContentType)
    ["image_noext", "image_noext.jpeg", "100x100", "image/jpeg"],
  ];

  let pool: ThumbPool;
  beforeAll(() => {
    pool = new ThumbPool({ getenv: () => "" });
  });
  afterAll(() => {
    pool.close();
  });

  for (const [file, thumb, size, expectedMimeType] of scenarios) {
    test(`${file}_${thumb}_${size}`, async () => {
      const fsys = NewLocal(dir);
      try {
        const expectErr = expectedMimeType === "";
        let err: unknown;
        try {
          await fsys.createThumb(file, thumb, size, (input, contentType, thumbSize) =>
            pool.render(input, contentType, thumbSize),
          );
        } catch (e) {
          err = e;
        }
        expect(err !== undefined).toBe(expectErr);
        if (expectErr) {
          return;
        }

        const f = fsys.getReader(thumb);
        try {
          const head = new Uint8Array(3072);
          const n = f.read(head);
          expect(detect(head.subarray(0, n)).string()).toBe(expectedMimeType);
          expect(f.contentType).toBe(expectedMimeType);
        } finally {
          f.close();
        }
      } finally {
        fsys.close();
      }
    });
  }
});

describe("TestFilesystemCreateThumbWithMaxPixelsLimit", () => {
  const scenarios: [name: string, maxPixels: number, expectErr: boolean][] = [
    ["default limit", 0, false],
    ["below limit", 24, true],
    ["exact limit", 25, false],
    ["above limit", 26, false],
  ];

  for (const [name, maxPixels, expectErr] of scenarios) {
    test(name, async () => {
      const pool = new ThumbPool({
        getenv: (key) => (key === "PB_THUMBS_MAX_SOURCE_PIXELS" ? String(maxPixels) : ""),
      });
      const fsys = NewLocal(dir);
      try {
        let err: unknown;
        try {
          await fsys.createThumb("image.png", "thumb_WxH", "100x100", (input, ct, size) =>
            pool.render(input, ct, size),
          );
        } catch (e) {
          err = e;
        }
        expect(err !== undefined).toBe(expectErr);
        if (expectErr) {
          expect(String(err)).toContain(
            "the original image is too large (5x5) and exceeds the total max allowed 24 pixels",
          );
        }
      } finally {
        fsys.close();
        pool.close();
      }
    });
  }
});
