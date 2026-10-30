// Serving record files (GET /api/files/..., src/files/file-api.ts) and
// thumbnails against the reference PocketBase v0.41.0 binary. Not part of
// `bun test`: run `bun run test:reference`.
//
// Setup: upstream creates the collection `m52` on a copy of the vendored
// fixture and stores one record per test file through its records API
// (generated images, test/differential/files/images.ts, and a few
// documents). That pb_data is then copied, with the files' modification
// times, once for each server, so both serve the same stored names, bytes,
// `.attrs` and Last-Modified times.
//
// Every case sends the same request to both servers:
//
//   - originals and errors: the status, the headers in `comparedHeaders`
//     and the body must be equal (a multipart/byteranges boundary is
//     random on both sides and is replaced first);
//   - thumbs: both must serve a thumb (or both the original), with the same
//     status, Content-Type and Content-Disposition, the same dimensions and
//     a mean absolute error per channel within the tolerance the M0.7
//     report measured for the original's format (the decoders differ:
//     about 1/255 for JPEG, up to about 8/255 for lossy WebP; PNG, GIF and
//     lossless WebP give the same pixels). The stored thumb's `.attrs` must
//     match upstream's, apart from the MD5 of its own bytes.
//
// With M52_REPORT=<file>, the thumb comparisons are written there as
// Markdown table rows (docs/perf/M5.2-files.md).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { decodePng, type Raw } from "@/files/png-raw";

import {
  type TestImage,
  writeBaseSet,
  writeCompatSet,
  writeEdgeSet,
  writeLargePng,
  writeNoise,
} from "@test/differential/files/images";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { superuserToken, usersToken } from "@test/scenarios/record-crud";
import { startServer, type RunningServer } from "@test/support/executable";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

const comparedHeaders = [
  "content-type",
  "content-disposition",
  "content-security-policy",
  "cache-control",
  "content-range",
  "content-length",
  "accept-ranges",
  "last-modified",
  "x-frame-options",
  "x-content-type-options",
];

// the listed thumb sizes of the `pub` field (100x100 is always allowed)
const thumbSizes = ["50x50", "50x50t", "50x50b", "50x50f", "0x40", "40x0", "300x300f"];
// sizes only requested by the cross-cache cases
const crossSizes = ["60x60", "70x70"];
// the other sizes of the M0.7 compatibility set's limit cases
const compatSizes = ["70x50f", "0x50"];

// MAE tolerance per channel (0-255) by the original's format (note: the
// test image's description)
function tolerance(contentType: string, note: string): number {
  if (contentType === "image/jpeg") {
    return 2;
  }
  if (contentType === "image/webp" && !note.includes("lossless")) {
    return 9;
  }
  return 0.5;
}

interface Res {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

interface Pair {
  upstream: string;
  iglo: string;
  upstreamDir: string;
  igloDir: string;
}

interface Stored {
  id: string;
  name: string;
  contentType: string;
  note: string;
  // the file's PB_THUMBS_MAX_SOURCE_PIXELS case
  limit?: number;
  sizes?: string[];
}

const roots: string[] = [];
const running: { stop(): Promise<unknown> }[] = [];

let collectionId = "";
let main: Pair;
let limited: Pair;
const stored = new Map<string, Stored>();
let protectedPng: Stored;
let goneTxt: Stored;
let images: TestImage[] = [];
let compat: TestImage[] = [];
let edges: TestImage[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-m52-"));
  roots.push(root);
  return root;
}

async function send(
  base: string,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<Res> {
  const res = await fetch(base + path, { method, headers });
  return {
    status: res.status,
    headers: res.headers,
    body: new Uint8Array(await res.arrayBuffer()),
  };
}

async function both(
  pair: Pair,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<[Res, Res]> {
  return Promise.all([
    send(pair.upstream, path, headers, method),
    send(pair.iglo, path, headers, method),
  ]);
}

function boundaryOf(res: Res): string | undefined {
  return /^multipart\/byteranges; boundary=(.+)$/.exec(res.headers.get("content-type") ?? "")?.[1];
}

function normalized(res: Res): { headers: Map<string, string | null>; body: Buffer } {
  const boundary = boundaryOf(res);
  const headers = new Map<string, string | null>();
  for (const name of comparedHeaders) {
    let value = res.headers.get(name);
    if (boundary !== undefined && value !== null) {
      value = value.replaceAll(boundary, "BOUNDARY");
    }
    headers.set(name, value);
  }
  let body = Buffer.from(res.body);
  if (boundary !== undefined) {
    body = Buffer.from(body.toString("latin1").replaceAll(boundary, "BOUNDARY"), "latin1");
  }
  return { headers, body };
}

// the differences between the responses (originals and errors)
function differences(up: Res, ig: Res): string[] {
  const out: string[] = [];
  if (up.status !== ig.status) {
    out.push(`status: upstream ${up.status}, iglo.base ${ig.status}`);
  }
  const u = normalized(up);
  const i = normalized(ig);
  for (const name of comparedHeaders) {
    if (u.headers.get(name) !== i.headers.get(name)) {
      out.push(`${name}: upstream ${u.headers.get(name)}, iglo.base ${i.headers.get(name)}`);
    }
  }
  if (!u.body.equals(i.body)) {
    out.push(
      `body: upstream ${u.body.length} bytes ${JSON.stringify(u.body.subarray(0, 80).toString())}, iglo.base ${i.body.length} bytes ${JSON.stringify(i.body.subarray(0, 80).toString())}`,
    );
  }
  return out;
}

async function same(
  pair: Pair,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
) {
  const [up, ig] = await both(pair, path, headers, method);
  expect(differences(up, ig)).toEqual([]);
  return up;
}

async function pixels(bytes: Uint8Array): Promise<Raw> {
  return decodePng(await new Bun.Image(bytes).png({ compressionLevel: 0 }).bytes());
}

function mae(a: Raw, b: Raw): number[] {
  const sums = [0, 0, 0, 0];
  for (let i = 0; i < a.pix.length; i++) {
    sums[i % 4] = (sums[i % 4] as number) + Math.abs((a.pix[i] as number) - (b.pix[i] as number));
  }
  const n = a.width * a.height;
  return sums.map((s) => s / n);
}

function servedName(res: Res): string {
  return /filename="([^"]*)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "";
}

function thumbFile(dataDir: string, recordId: string, name: string, size: string): string {
  return join(dataDir, "storage", collectionId, recordId, `thumbs_${name}`, `${size}_${name}`);
}

const report: string[] = [];

// requests a thumb from both servers and compares the outcome
async function compareThumb(
  pair: Pair,
  file: Stored,
  size: string,
  query = "",
): Promise<"thumb" | "original"> {
  const path = `/api/files/m52/${file.id}/${file.name}?thumb=${size}${query}`;
  const [up, ig] = await both(pair, path);
  expect(ig.status).toBe(up.status);
  expect(up.status).toBe(200);
  const upThumb = servedName(up) === `${size}_${file.name}`;
  const igThumb = servedName(ig) === `${size}_${file.name}`;
  expect(`${file.name} ${size}: ${igThumb ? "thumb" : "original"}`).toBe(
    `${file.name} ${size}: ${upThumb ? "thumb" : "original"}`,
  );
  if (!upThumb) {
    expect(differences(up, ig)).toEqual([]);
    report.push(`| ${file.name} | ${size} | original | original | | |`);
    return "original";
  }

  for (const name of ["content-type", "content-disposition", "content-security-policy"]) {
    expect(`${name}: ${ig.headers.get(name)}`).toBe(`${name}: ${up.headers.get(name)}`);
  }
  const [a, b] = await Promise.all([pixels(up.body), pixels(ig.body)]);
  expect(`${b.width}x${b.height}`).toBe(`${a.width}x${a.height}`);
  const errors = mae(a, b);
  const tol = tolerance(file.contentType, file.note);
  report.push(
    `| ${file.name} | ${size} | ${a.width}x${a.height} ${up.headers.get("content-type")} | same | ${errors.map((e) => e.toFixed(2)).join(" / ")} | ${tol} |`,
  );
  for (const e of errors) {
    expect(e).toBeLessThanOrEqual(tol);
  }

  // the stored thumbs: same .attrs apart from the MD5 of their own bytes
  const upFile = thumbFile(pair.upstreamDir, file.id, file.name, size);
  const igFile = thumbFile(pair.igloDir, file.id, file.name, size);
  const upAttrs = JSON.parse(readFileSync(upFile + ".attrs", "utf8")) as Record<string, unknown>;
  const igAttrs = JSON.parse(readFileSync(igFile + ".attrs", "utf8")) as Record<string, unknown>;
  expect(igAttrs["md5"]).toBe(createHash("md5").update(readFileSync(igFile)).digest("base64"));
  expect({ ...igAttrs, md5: "" }).toEqual({ ...upAttrs, md5: "" });
  expect(Object.keys(igAttrs)).toEqual(Object.keys(upAttrs));
  return "thumb";
}

const enc = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");

// a file token signed as upstream signs them (HS256), with any claims
function signToken(claims: Record<string, unknown>, key: string): string {
  const unsigned = `${enc({ alg: "HS256", typ: "JWT" })}.${enc(claims)}`;
  return `${unsigned}.${createHmac("sha256", key).update(unsigned).digest("base64url")}`;
}

// users/4q1xlclmfloku33's file token key: the record's tokenKey and the
// collection's fileToken secret
function usersFileKey(dataDir: string): string {
  const db = new Database(join(dataDir, "data.db"), { readonly: true });
  try {
    const row = db.query("SELECT options FROM _collections WHERE id = '_pb_users_auth_'").get() as {
      options: string | Uint8Array;
    };
    const options = JSON.parse(
      typeof row.options === "string" ? row.options : new TextDecoder().decode(row.options),
    ) as { fileToken: { secret: string } };
    const user = db.query("SELECT tokenKey FROM users WHERE id = '4q1xlclmfloku33'").get() as {
      tokenKey: string;
    };
    return user.tokenKey + options.fileToken.secret;
  } finally {
    db.close();
  }
}

async function startPair(baseDir: string, env: Record<string, string> = {}): Promise<Pair> {
  const root = newRoot();
  const upstreamDir = join(root, "upstream", "pb_data");
  const igloDir = join(root, "iglo", "pb_data");
  for (const dir of [upstreamDir, igloDir]) {
    cpSync(baseDir, dir, { recursive: true, preserveTimestamps: true });
  }
  const upstream: UpstreamServer = await startUpstream({ dataDir: upstreamDir, env });
  running.push(upstream);
  const iglo: RunningServer = await startServer([], igloDir, "127.0.0.1", undefined, env);
  running.push(iglo);
  return { upstream: upstream.url, iglo: iglo.url, upstreamDir, igloDir };
}

beforeAll(async () => {
  const root = newRoot();
  const imagesDir = join(root, "images");
  mkdirSync(imagesDir);
  images = await writeBaseSet(imagesDir);
  compat = await writeCompatSet(imagesDir);
  const photoJpeg = readFileSync(join(imagesDir, "photo.jpg"));
  const photoPng = readFileSync(join(imagesDir, "photo.png"));
  edges = await writeEdgeSet(imagesDir, photoJpeg, photoPng);
  const documents: [string, string | Uint8Array][] = [
    ["drawing.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'],
    ["page.html", "<!DOCTYPE html><html><body><script>alert(1)</script></body></html>"],
    ["doc.pdf", "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"],
    ["data.bin", new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255])],
    ["notes.txt", "plain text notes\n".repeat(20)],
    ["gone.txt", "removed from storage before the servers start"],
    // replaced by large files in the running pairs' storage (see below)
    ["large.bin", "placeholder"],
    ["large.png", photoPng],
  ];
  for (const [name, content] of documents) {
    writeFileSync(join(imagesDir, name), content);
  }

  const baseDir = join(root, "base", "pb_data");
  copyDataDir(fixtureDir, baseDir);
  const setup = await startUpstream({ dataDir: baseDir });
  try {
    const auth = { authorization: superuserToken };
    const created = await fetch(setup.url + "/api/collections", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        name: "m52",
        type: "base",
        listRule: '@request.auth.id != ""',
        viewRule: '@request.auth.id != ""',
        fields: [
          {
            name: "pub",
            type: "file",
            maxSelect: 1,
            maxSize: 50_000_000,
            thumbs: [...thumbSizes, ...crossSizes, ...compatSizes],
          },
          {
            name: "prot",
            type: "file",
            maxSelect: 1,
            maxSize: 50_000_000,
            protected: true,
            thumbs: ["50x50"],
          },
        ],
      }),
    });
    const collection = (await created.json()) as { id: string };
    expect(created.status).toBe(200);
    collectionId = collection.id;

    const upload = async (field: string, name: string, note: string): Promise<Stored> => {
      const form = new FormData();
      form.append(field, new Blob([readFileSync(join(imagesDir, name))]), name);
      const res = await fetch(setup.url + "/api/collections/m52/records", {
        method: "POST",
        headers: auth,
        body: form,
      });
      const record = (await res.json()) as Record<string, string>;
      expect(`${name}: ${res.status}`).toBe(`${name}: 200`);
      return { id: record["id"] as string, name: record[field] as string, contentType: "", note };
    };

    for (const image of [...images, ...compat, ...edges]) {
      const s = await upload("pub", image.name, image.note);
      s.contentType = image.contentType;
      if (image.limit !== undefined) {
        s.limit = image.limit;
      }
      if (image.sizes !== undefined) {
        s.sizes = image.sizes;
      }
      stored.set(image.name, s);
    }
    for (const [name] of documents) {
      stored.set(name, await upload("pub", name, name));
    }
    protectedPng = await upload("prot", "photo.png", "protected PNG");
    protectedPng.contentType = "image/png";
    goneTxt = stored.get("gone.txt") as Stored;
  } finally {
    await setup.stop();
  }
  rmSync(join(baseDir, "storage", collectionId, goneTxt.id, goneTxt.name));
  rmSync(join(baseDir, "storage", collectionId, goneTxt.id, goneTxt.name + ".attrs"));

  main = await startPair(baseDir);
  limited = await startPair(baseDir, { PB_THUMBS_MAX_SOURCE_PIXELS: "1000000" });

  // large files only where they are used, written in pieces: 24 MB of
  // noise for multipart ranges over 16 MiB, and a valid 4000x2000 PNG of
  // about 24 MB over the limited pair's pixel limit
  const large = (pair: Pair, name: string, write: (path: string) => void): void => {
    const s = stored.get(name) as Stored;
    const source = join(newRoot(), name);
    write(source);
    for (const dir of [pair.upstreamDir, pair.igloDir]) {
      const path = join(dir, "storage", collectionId, s.id, s.name);
      copyFileSync(source, path);
      utimesSync(path, 1_700_000_000, 1_700_000_000);
    }
    rmSync(source);
  };
  large(main, "large.bin", (path) => writeNoise(path, 24_000_000, 3));
  large(limited, "large.png", (path) => writeLargePng(path, 4000, 2000, 4));
}, 180_000);

afterAll(async () => {
  for (const server of running.splice(0).toReversed()) {
    await server.stop();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  const out = process.env["M52_REPORT"];
  if (out) {
    writeFileSync(
      out,
      "| Original | Size | Upstream | iglo.base | MAE R / G / B / A | Tolerance |\n|---|---|---|---|---|---|\n",
    );
    appendFileSync(out, report.join("\n") + "\n");
  }
});

const file = (name: string): Stored => stored.get(name) as Stored;
const pathOf = (s: Stored): string => `/api/files/m52/${s.id}/${s.name}`;
const prot = (): string => pathOf(protectedPng);

describe("originals: Content-Type, Content-Disposition and CSP", () => {
  for (const name of [
    "photo.png",
    "photo.jpg",
    "photo.gif",
    "photo.webp",
    "photo.bmp",
    "photo.tiff",
    "drawing.svg",
    "page.html",
    "doc.pdf",
    "data.bin",
    "notes.txt",
  ]) {
    test(name, async () => {
      const res = await same(main, pathOf(file(name)));
      expect(res.status).toBe(200);
    });
  }

  for (const query of ["download=1", "download=true", "download=0", "download=yes"]) {
    test(`photo.png?${query}`, () => same(main, `${pathOf(file("photo.png"))}?${query}`));
    test(`page.html?${query}`, () => same(main, `${pathOf(file("page.html"))}?${query}`));
  }

  test("HEAD", () => same(main, pathOf(file("photo.png")), {}, "HEAD"));
  test("HEAD of a thumb", async () => {
    // the thumbs' encoded sizes differ (Content-Length); the rest is equal
    const [up, ig] = await both(main, `${pathOf(file("photo.png"))}?thumb=100x100`, {}, "HEAD");
    expect(differences(up, ig).filter((d) => !d.startsWith("content-length:"))).toEqual([]);
    expect(ig.body.length).toBe(0);
  });
});

describe("Range and conditional requests", () => {
  const cases: [string, Record<string, string>][] = [
    ["single range", { Range: "bytes=0-99" }],
    ["suffix range", { Range: "bytes=-50" }],
    ["open range", { Range: "bytes=100-" }],
    ["multiple ranges", { Range: "bytes=0-9, 20-29" }],
    ["unsatisfiable range", { Range: "bytes=99999999-" }],
    ["malformed range", { Range: "bytes=abc" }],
    ["ranges over the size", { Range: "bytes=0-, 0-, 0-" }],
    ["If-None-Match *", { "If-None-Match": "*" }],
    ["If-None-Match etag", { "If-None-Match": '"abc"' }],
    ["If-Match *", { "If-Match": "*" }],
    ["If-Match etag", { "If-Match": '"abc"' }],
    ["If-Modified-Since old", { "If-Modified-Since": "Mon, 01 Jan 2001 00:00:00 GMT" }],
    ["If-Modified-Since future", { "If-Modified-Since": "Fri, 01 Jan 2100 00:00:00 GMT" }],
    ["If-Modified-Since RFC 850", { "If-Modified-Since": "Friday, 01-Jan-99 00:00:00 GMT" }],
    ["If-Modified-Since ANSI C", { "If-Modified-Since": "Fri Jan  1 00:00:00 2100" }],
    ["If-Modified-Since invalid", { "If-Modified-Since": "yesterday" }],
    ["If-Unmodified-Since old", { "If-Unmodified-Since": "Mon, 01 Jan 2001 00:00:00 GMT" }],
    ["If-Unmodified-Since future", { "If-Unmodified-Since": "Fri, 01 Jan 2100 00:00:00 GMT" }],
    ["If-Range etag", { Range: "bytes=0-9", "If-Range": '"abc"' }],
    ["If-Range old date", { Range: "bytes=0-9", "If-Range": "Mon, 01 Jan 2001 00:00:00 GMT" }],
  ];
  for (const [name, headers] of cases) {
    test(name, () => same(main, pathOf(file("notes.txt")), headers));
  }

  test("multiple ranges over 16 MiB: Content-Length, body, and GET as HEAD", async () => {
    const headers = { Range: "bytes=0-9437183,10485760-19922943" };
    const up = await same(main, pathOf(file("large.bin")), headers);
    expect(up.status).toBe(206);
    expect(Number(up.headers.get("content-length"))).toBeGreaterThan(16 << 20);
    const [upHead, igHead] = await both(main, pathOf(file("large.bin")), headers, "HEAD");
    expect(differences(upHead, igHead)).toEqual([]);
    expect(igHead.headers.get("content-length")).toBe(up.headers.get("content-length"));
  });

  test("If-Modified-Since and If-Range with the Last-Modified time", async () => {
    const up = await send(main.upstream, pathOf(file("photo.jpg")));
    const lastModified = up.headers.get("last-modified") as string;
    expect(lastModified).toBeTruthy();
    const ims = await same(main, pathOf(file("photo.jpg")), { "If-Modified-Since": lastModified });
    expect(ims.status).toBe(304);
    const ir = await same(main, pathOf(file("photo.jpg")), {
      Range: "bytes=0-9",
      "If-Range": lastModified,
    });
    expect(ir.status).toBe(206);
  });
});

describe("a large original over PB_THUMBS_MAX_SOURCE_PIXELS", () => {
  test("4000x2000 PNG of 24 MB: the original (first byte)", async () => {
    const up = await same(limited, `${pathOf(file("large.png"))}?thumb=100x100`, {
      Range: "bytes=0-0",
    });
    expect(up.status).toBe(206);
    expect(up.headers.get("content-disposition")).toBe(
      `inline; filename="${file("large.png").name}"`,
    );
  });
});

describe("missing records and files", () => {
  test("missing record", () =>
    same(main, `/api/files/m52/aaaaaaaaaaaaaaa/${file("notes.txt").name}`));
  test("file not in the record", () =>
    same(main, `/api/files/m52/${file("notes.txt").id}/${file("photo.png").name}`));
  test("file not on disk", () => same(main, pathOf(goneTxt)));
  test("file not on disk, with a thumb", () => same(main, `${pathOf(goneTxt)}?thumb=100x100`));
  test("missing collection", () => same(main, `/api/files/nope/${file("notes.txt").id}/x.txt`));
});

describe("protected files and file tokens", () => {
  let userFileToken = "";
  let superuserFileToken = "";
  let key = "";

  beforeAll(async () => {
    const token = async (auth: string): Promise<string> => {
      const res = await fetch(main.upstream + "/api/files/token", {
        method: "POST",
        headers: { authorization: auth },
      });
      return ((await res.json()) as { token: string }).token;
    };
    userFileToken = await token(usersToken);
    superuserFileToken = await token(superuserToken);
    key = usersFileKey(main.upstreamDir);
  });

  test("guest without a token", () => same(main, prot()));
  test("user file token", async () => {
    expect((await same(main, `${prot()}?token=${userFileToken}`)).status).toBe(200);
  });
  test("a file token from iglo.base works on both", async () => {
    const res = await fetch(main.iglo + "/api/files/token", {
      method: "POST",
      headers: { authorization: usersToken },
    });
    const { token } = (await res.json()) as { token: string };
    expect((await same(main, `${prot()}?token=${token}`)).status).toBe(200);
  });
  test("superuser file token", async () => {
    expect((await same(main, `${prot()}?token=${superuserFileToken}`)).status).toBe(200);
  });
  test("expired user file token", async () => {
    const expired = signToken(
      { id: "4q1xlclmfloku33", type: "file", collectionId: "_pb_users_auth_", exp: 1640991661 },
      key,
    );
    expect((await same(main, `${prot()}?token=${expired}`)).status).toBe(404);
  });
  test("file token of the wrong collection", async () => {
    const wrong = signToken(
      { id: "4q1xlclmfloku33", type: "file", collectionId: "v851q4r790rhknl", exp: 2524604461 },
      key,
    );
    expect((await same(main, `${prot()}?token=${wrong}`)).status).toBe(404);
  });
  test("file token with a wrong signature", async () => {
    const forged = signToken(
      { id: "4q1xlclmfloku33", type: "file", collectionId: "_pb_users_auth_", exp: 2524604461 },
      key + "x",
    );
    expect((await same(main, `${prot()}?token=${forged}`)).status).toBe(404);
  });
  test("auth token in the query", async () => {
    expect((await same(main, `${prot()}?token=${usersToken}`)).status).toBe(404);
  });
  test("user auth token in the Authorization header only", async () => {
    expect((await same(main, prot(), { Authorization: usersToken })).status).toBe(404);
  });
  test("superuser auth token in the Authorization header only", async () => {
    expect((await same(main, prot(), { Authorization: superuserToken })).status).toBe(404);
  });
  test("protected thumb with a file token", async () => {
    expect(await compareThumb(main, protectedPng, "50x50", `&token=${userFileToken}`)).toBe(
      "thumb",
    );
  });
  test("protected thumb without a token", () => same(main, `${prot()}?thumb=50x50`));
});

describe("thumb size modes", () => {
  for (const name of [
    "photo.jpg",
    "photo.png",
    "alpha.png",
    "tiny.png",
    "photo.webp",
    "alpha.webp",
    "photo.gif",
  ]) {
    for (const size of ["100x100", ...thumbSizes]) {
      test(`${name} ${size}`, async () => {
        expect(await compareThumb(main, file(name), size)).toBe("thumb");
      });
    }
    for (const size of ["33x33", "0x0", "100x100f"]) {
      test(`${name} ${size} (not listed: the original)`, async () => {
        expect(await compareThumb(main, file(name), size)).toBe("original");
      });
    }
  }

  for (const name of ["photo.bmp", "photo.tiff", "drawing.svg", "notes.txt"]) {
    test(`${name} 50x50 (not thumbed: the original)`, async () => {
      expect(await compareThumb(main, file(name), "50x50")).toBe("original");
    });
  }

  test("concurrent requests for the same new thumb", async () => {
    const s = file("photo.png");
    const path = `${pathOf(s)}?thumb=40x0`;
    const results = await Promise.all([both(main, path), both(main, path), both(main, path)]);
    for (const [up, ig] of results) {
      expect(ig.status).toBe(up.status);
      expect(servedName(ig)).toBe(servedName(up));
    }
  });
});

describe("the M0.7 compatibility set", () => {
  test("every image", async () => {
    const rows: string[] = [];
    for (const image of compat) {
      const s = file(image.name);
      const pair = s.limit !== undefined ? limited : main;
      for (const size of s.sizes ?? ["100x100", ...thumbSizes]) {
        rows.push(`${image.name} ${size} ${await compareThumb(pair, s, size)}`);
      }
    }
    expect(rows.length).toBeGreaterThan(0);
  }, 120_000);
});

describe("damaged images serve the original", () => {
  // damaged files that keep their end marker: Bun.Image decodes them where
  // Go fails (docs/perf/M0.7-thumbnails.md, the D26 hardening backlog)
  const backlog = new Set(["cut-scan-eoi.jpg", "no-iend.png"]);
  test("every damaged image", async () => {
    for (const image of edges) {
      const s = file(image.name);
      if (backlog.has(image.name)) {
        const up = await send(main.upstream, `${pathOf(s)}?thumb=50x50`);
        expect(`${image.name}: ${servedName(up)}`).toBe(`${image.name}: ${s.name}`);
        continue;
      }
      expect(`${image.name}: ${await compareThumb(main, s, "50x50")}`).toBe(
        `${image.name}: original`,
      );
    }
  }, 60_000);
});

// the thumb (and its .attrs) one server stored is copied into the
// other's storage, which then serves it as its own
async function crossCopy(from: "upstream" | "iglo", size: string): Promise<void> {
  const s = file("photo.jpg");
  const fromUrl = from === "upstream" ? main.upstream : main.iglo;
  const toUrl = from === "upstream" ? main.iglo : main.upstream;
  const fromDir = from === "upstream" ? main.upstreamDir : main.igloDir;
  const toDir = from === "upstream" ? main.igloDir : main.upstreamDir;
  const made = await send(fromUrl, `${pathOf(s)}?thumb=${size}`);
  expect(servedName(made)).toBe(`${size}_${s.name}`);
  const src = thumbFile(fromDir, s.id, s.name, size);
  const dst = thumbFile(toDir, s.id, s.name, size);
  expect(existsSync(dst)).toBe(false);
  cpSync(src, dst);
  cpSync(src + ".attrs", dst + ".attrs");
  const served = await send(toUrl, `${pathOf(s)}?thumb=${size}`);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe(made.headers.get("content-type"));
  expect(Buffer.from(served.body).equals(Buffer.from(made.body))).toBe(true);
}

describe("thumbs cached by the other server", () => {
  test("upstream's thumb served by iglo.base", () => crossCopy("upstream", "60x60"));
  test("iglo.base's thumb served by upstream", () => crossCopy("iglo", "70x70"));
});
