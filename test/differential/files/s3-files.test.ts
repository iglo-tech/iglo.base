// Upstream: core/field_file.go, core/record_model.go, core/collection_model.go,
// apis/file.go, core/backup_create.go and tools/filesystem with `s3.enabled`.
// Not part of `bun test`: run `bun run test:reference`.
//
// Upstream and iglo.base each store in a bucket of one versitygw, through a
// proxy that records what reaches S3 and refuses what a test asks. Every case
// of cases.ts, and the batch, delete and failure cases here, goes to both.
// After each case the responses must be equal and the two buckets must hold
// the same objects as a raw S3 read sees them: the keys, with iglo.base's ids
// and names mapped to upstream's, and the bytes, content type and metadata.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isNotFound } from "@/tools/filesystem/blob/bucket";
import { NewS3, type S3System } from "@/tools/filesystem/s3-system";
import { cases, collections, png } from "@test/differential/files/cases";
import {
  compareJSON,
  compareRes,
  multipartBody,
  Pairing,
  req,
  type Res,
  sendCase,
  type Side,
} from "@test/differential/files/record-requests";
import { ScenarioContext } from "@test/realtime/scenario";
import { eventually } from "@test/scenarios/cron";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { superuserToken } from "@test/scenarios/record-crud";
import { startServer } from "@test/support/executable";
import { type S3Proxy, startS3Proxy } from "@test/support/s3-proxy";
import { startUpstream } from "@test/support/upstream";
import { startVersitygw, testS3Credentials, type Versitygw } from "@test/support/versitygw";

const timeout = 120_000;

setDefaultTimeout(30_000);

interface Server {
  url: string;
  stop(): Promise<unknown>;
}

interface Target {
  side: Side;
  server: Server;
  dataDir: string;
  bucket: string;
  proxy: S3Proxy;
  fsys: S3System;
}

const roots: string[] = [];
const running = new Set<Server>();
const collectionIds = new Map<string, string>();
const pairing = new Pairing();
let gw: Versitygw;
let up: Target;
let ig: Target;

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-s3-files-"));
  roots.push(root);
  return root;
}

function track<T extends Server>(server: T): T {
  running.add(server);
  return server;
}

async function stop(server: Server): Promise<void> {
  running.delete(server);
  await server.stop();
}

function rawFilesystem(bucket: string): S3System {
  return NewS3(
    bucket,
    testS3Credentials.region,
    gw.endpoint,
    testS3Credentials.accessKeyId,
    testS3Credentials.secretAccessKey,
    true,
    join(tmpdir(), "iglo-base-s3-unused"),
  );
}

function s3Settings(endpoint: string, bucket: string): Record<string, unknown> {
  return {
    enabled: true,
    bucket,
    region: testS3Credentials.region,
    endpoint,
    accessKey: testS3Credentials.accessKeyId,
    secret: testS3Credentials.secretAccessKey,
    forcePathStyle: true,
  };
}

async function useS3(url: string, s3: Record<string, unknown>): Promise<void> {
  const res = await req(url, "PATCH", "/api/settings", JSON.stringify({ s3 }), "application/json");
  expect(`${res.status} ${res.text}`).toStartWith("200");
}

// -------------------------------------------------------------------
// a raw S3 read of a bucket

interface RawObject {
  contentType: string;
  metadata: string;
  bytes: Uint8Array;
}

async function bucketObjects(target: Target): Promise<Map<string, RawObject>> {
  const out = new Map<string, RawObject>();
  for (const object of await target.fsys.list("")) {
    try {
      const attrs = await target.fsys.attributes(object.key);
      out.set(object.key, {
        contentType: attrs.contentType,
        metadata: JSON.stringify([...(attrs.metadata ?? [])]),
        bytes: readFileSync(join(gw.posixRoot, target.bucket, object.key)),
      });
    } catch (err) {
      // deleted in the background since the list
      if (!isNotFound(err) && (err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
  return out;
}

function mappedKey(key: string): string {
  return key
    .split("/")
    .map((segment) => {
      // thumbs_<name>/<size>_<name>
      const [, prefix = "", name = segment] = /^(thumbs_|\d+x\d+[tbf]?_)?(.*)$/.exec(segment) ?? [];
      return prefix + (pairing.backward.get(name) ?? name);
    })
    .join("/");
}

// a thumb's bytes differ by encoder and the original's name is random
function comparable(key: string, value: string): string {
  return key.includes("/thumbs_") ? "" : value;
}

async function compareBuckets(): Promise<string[]> {
  const out: string[] = [];
  const upObjects = await bucketObjects(up);
  const igObjects = new Map([...(await bucketObjects(ig))].map(([k, v]) => [mappedKey(k), v]));
  const upKeys = [...upObjects.keys()].toSorted();
  const igKeys = [...igObjects.keys()].toSorted();
  const onlyUp = upKeys.filter((k) => !igObjects.has(k));
  const onlyIg = igKeys.filter((k) => !upObjects.has(k));
  if (onlyUp.length > 0 || onlyIg.length > 0) {
    return [`only upstream [${onlyUp.join(", ")}], only iglo.base [${onlyIg.join(", ")}]`];
  }
  for (const key of upKeys) {
    const a = upObjects.get(key) as RawObject;
    const b = igObjects.get(key) as RawObject;
    if (a.contentType !== b.contentType) {
      out.push(`${key}: content type ${a.contentType} != ${b.contentType}`);
    }
    if (a.metadata !== b.metadata && !/_[a-z0-9]{10}/.test(a.metadata)) {
      out.push(`${key}: metadata ${a.metadata} != ${b.metadata}`);
    }
    if (comparable(key, "bytes") !== "" && Buffer.compare(a.bytes, b.bytes) !== 0) {
      out.push(`${key}: bytes differ`);
    }
  }
  return out;
}

// the same request to both; the responses and the buckets must match
async function same(
  method: string,
  path: (side: Side) => string,
  body?: (side: Side) => { body: Uint8Array | string; contentType: string },
): Promise<[Res, Res]> {
  const send = (t: Target): Promise<Res> => {
    const b = body?.(t.side);
    return req(t.side.url, method, path(t.side), b?.body, b?.contentType);
  };
  const upRes = await send(up);
  const igRes = await send(ig);
  const diffs = compareRes(upRes, igRes, pairing);
  expect(diffs).toEqual([]);
  return [upRes, igRes];
}

function jsonBody(value: unknown): { body: string; contentType: string } {
  return { body: JSON.stringify(value), contentType: "application/json" };
}

type BodyPart = Parameters<typeof multipartBody>[0][number];

function formBody(parts: BodyPart[], side: Side): { body: Uint8Array; contentType: string } {
  const boundary = "s3filesboundary";
  return {
    body: multipartBody(parts, boundary, side),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

const textFile = (
  name: string,
  filename: string,
  content = "content of " + filename,
): BodyPart => ({
  name,
  filename,
  content: new TextEncoder().encode(content),
});

async function sideRecord(ref: string, res: Res, target: Target): Promise<void> {
  target.side.records.set(ref, JSON.parse(res.text) as Record<string, unknown>);
}

function recordId(side: Side, ref: string): string {
  return String(side.records.get(ref)?.["id"]);
}

async function createBoth(collection: string, ref: string, parts: BodyPart[]): Promise<void> {
  for (const t of [up, ig]) {
    const b = formBody(parts, t.side);
    const res = await req(
      t.side.url,
      "POST",
      `/api/collections/${collection}/records`,
      b.body,
      b.contentType,
    );
    expect(`${res.status} ${res.text}`).toStartWith("200");
    await sideRecord(ref, res, t);
  }
  pairing.pair(recordId(up.side, ref), recordId(ig.side, ref));
  expect(await compareBucketsPaired(ref)).toEqual([]);
}

// pairs the file names of a record created without a compared response
async function compareBucketsPaired(ref: string): Promise<string[]> {
  const a = up.side.records.get(ref) as Record<string, unknown>;
  const b = ig.side.records.get(ref) as Record<string, unknown>;
  const out: string[] = [];
  compareJSON(a, b, "$", pairing, out);
  out.push(...(await compareBuckets()));
  return out;
}

async function settledBuckets(): Promise<void> {
  let diffs = await compareBuckets();
  for (let tries = 0; diffs.length > 0 && tries < 30; tries++) {
    await Bun.sleep(100);
    diffs = await compareBuckets();
  }
  expect(diffs).toEqual([]);
}

function withRefused<T>(rule: (key: string, method: string) => boolean, fn: () => Promise<T>) {
  for (const t of [up, ig]) {
    t.proxy.refuse = (r) => rule(r.path.slice(t.bucket.length + 1), r.method);
  }
  return fn().finally(() => {
    up.proxy.refuse = null;
    ig.proxy.refuse = null;
  });
}

// the data and bucket of one server, served by the other kind
async function otherServer(from: Target, kind: "upstream" | "iglo"): Promise<Server> {
  const root = newRoot();
  const dataDir = join(root, "pb_data");
  copyDataDir(from.dataDir, dataDir);
  return track(
    kind === "upstream" ? await startUpstream({ dataDir }) : await startServer([], dataDir),
  );
}

function zipEntries(zip: string): string[] {
  const list = Bun.spawnSync(["unzip", "-Z1", zip]);
  return list.stdout
    .toString()
    .split("\n")
    .filter((n) => n !== "")
    .toSorted();
}

const batch = (
  requests: unknown[],
  files: (side: Side) => BodyPart[],
): ((side: Side) => { body: Uint8Array; contentType: string }) => {
  return (side) =>
    formBody([{ name: "@jsonPayload", value: JSON.stringify({ requests }) }, ...files(side)], side);
};
const post = (collection: string, body: unknown = {}): unknown => ({
  method: "POST",
  url: `/api/collections/${collection}/records`,
  body,
});

const thumbPuts = (t: Target, name: string): number =>
  t.proxy.requests.filter(
    (r) => r.method === "PUT" && r.path.includes(`/thumbs_${name}/`) && r.query === "",
  ).length;

function methods(requests: { method: string }[]): string[] {
  return requests.map((r) => r.method);
}

beforeAll(async () => {
  gw = await startVersitygw("upstream");
  mkdirSync(join(gw.posixRoot, "iglo"));

  const root = newRoot();
  const baseDir = join(root, "base", "pb_data");
  copyDataDir(fixtureDir, baseDir);
  const setup = track(await startUpstream({ dataDir: baseDir }));
  try {
    for (const def of collections) {
      const body = JSON.parse(JSON.stringify(def)) as { fields: Record<string, unknown>[] };
      for (const f of body.fields) {
        if (typeof f["collectionId"] === "string") {
          f["collectionId"] = collectionIds.get(f["collectionId"]);
        }
      }
      const res = await req(
        setup.url,
        "POST",
        "/api/collections",
        JSON.stringify({
          ...body,
          listRule: "",
          viewRule: "",
          createRule: "",
          updateRule: "",
          deleteRule: "",
        }),
        "application/json",
      );
      expect(`${String(def["name"])}: ${res.status}`).toBe(`${String(def["name"])}: 200`);
      collectionIds.set(def["name"] as string, (JSON.parse(res.text) as { id: string }).id);
    }
  } finally {
    await stop(setup);
  }

  const start = async (kind: "upstream" | "iglo"): Promise<Target> => {
    const dataDir = join(root, kind, "pb_data");
    copyDataDir(baseDir, dataDir);
    const server = track(
      kind === "upstream" ? await startUpstream({ dataDir }) : await startServer([], dataDir),
    );
    const proxy = startS3Proxy(gw.endpoint);
    await useS3(server.url, s3Settings(proxy.endpoint, kind));
    return {
      side: { url: server.url, records: new Map() },
      server,
      dataDir,
      bucket: kind,
      proxy,
      fsys: rawFilesystem(kind),
    };
  };
  up = await start("upstream");
  ig = await start("iglo");
}, timeout);

afterAll(async () => {
  await Promise.allSettled([...running].map((s) => s.stop()));
  up?.proxy.stop();
  ig?.proxy.stop();
  await gw?.stop();
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("record files on S3", () => {
  for (const c of cases) {
    test(c.name, async () => {
      const upRes = await sendCase(c, up.side);
      const igRes = await sendCase(c, ig.side);
      const diffs = compareRes(upRes, igRes, pairing);
      expect({ status: upRes.status, diffs }).toEqual({ status: c.status, diffs: [] });
      await settledBuckets();
    });
  }
});

describe("batch", () => {
  test("create, update with modifiers, replace and delete", async () => {
    await createBoth("fmulti", "b1", [
      textFile("docs", "first.txt"),
      textFile("docs", "second.txt"),
    ]);
    await createBoth("fmulti", "b2", [textFile("docs", "gone.txt")]);

    const [res] = await same(
      "POST",
      () => "/api/batch",
      (side) => {
        const rec = side.records.get("b1") as { docs: string[]; id: string };
        return batch(
          [
            post("fmulti", { title: "from batch" }),
            {
              method: "PATCH",
              url: `/api/collections/fmulti/records/${rec.id}`,
              body: { "docs-": [rec.docs[0]] },
            },
            {
              method: "DELETE",
              url: `/api/collections/fmulti/records/${recordId(side, "b2")}`,
            },
            post("fsingle", { title: "single" }),
          ],
          () => [
            textFile("requests.0.docs", "created1.txt"),
            textFile("requests.0.docs", "created2.txt"),
            textFile("requests.1.docs+", "appended.txt"),
            textFile("requests.1.+docs", "prepended.txt"),
            textFile("requests.3.doc", "one.txt"),
          ],
        )(side);
      },
    );
    expect(res.status).toBe(200);
    await settledBuckets();
  });

  test("upsert with a given id, then an update of the new record in one batch", async () => {
    const [res] = await same(
      "POST",
      () => "/api/batch",
      batch(
        [
          {
            method: "PUT",
            url: "/api/collections/fmulti/records",
            body: { id: "batchupsert0001" },
          },
          {
            method: "PATCH",
            url: "/api/collections/fmulti/records/batchupsert0001",
            body: { title: "updated" },
          },
          {
            method: "PUT",
            url: "/api/collections/fmulti/records",
            body: { id: "batchupsert0001" },
          },
        ],
        () => [
          textFile("requests.0.docs", "put1.txt"),
          textFile("requests.1.docs+", "patched.txt"),
          textFile("requests.2.docs+", "put2.txt"),
        ],
      ),
    );
    expect(res.status).toBe(200);
    await settledBuckets();
  });

  test("an existing record's id is not held to the current id rules", async () => {
    const id = "legacyrecord001";
    await same(
      "POST",
      () => "/api/collections",
      () =>
        jsonBody({
          name: "flegacy",
          type: "base",
          fields: [{ name: "doc", type: "file", maxSelect: 1, maxSize: 1 << 20 }],
        }),
    );
    await same(
      "POST",
      () => "/api/collections/flegacy/records",
      () => jsonBody({ id }),
    );

    const [collection] = await same("GET", () => "/api/collections/flegacy");
    const { fields } = JSON.parse(Buffer.from(collection.body).toString()) as {
      fields: { name: string }[];
    };
    const [tightened] = await same(
      "PATCH",
      () => "/api/collections/flegacy",
      () =>
        jsonBody({
          fields: fields.map((f) =>
            f.name === "id" ? { ...f, pattern: "^[0-9]+$", autogeneratePattern: "[0-9]{15}" } : f,
          ),
        }),
    );
    expect(tightened.status).toBe(200);

    const url = `/api/collections/flegacy/records/${id}`;
    for (const [method, itemUrl] of [
      ["PATCH", url],
      ["PUT", "/api/collections/flegacy/records"],
    ] as const) {
      const [res] = await same(
        "POST",
        () => "/api/batch",
        batch([{ method, url: itemUrl, body: { id } }], () => [
          textFile("requests.0.doc", `${method}.txt`),
        ]),
      );
      expect(res.status).toBe(200);
    }
    await settledBuckets();
  });

  test("a save that deletes a file broadcasts in item order", async () => {
    const ctx = new ScenarioContext(ig.side.url);
    try {
      await createBoth("fsingle", "order", [textFile("doc", "order.txt")]);
      const id = recordId(ig.side, "order");
      const stream = await ctx.open();
      await ctx.subscribe(stream.clientId, ["fsingle/*"], superuserToken);

      const url = `/api/collections/fsingle/records/${id}`;
      const res = await req(
        ig.side.url,
        "POST",
        "/api/batch",
        JSON.stringify({
          requests: [
            { method: "PATCH", url, body: { doc: null, title: "first" } },
            { method: "PATCH", url, body: { title: "second" } },
          ],
        }),
        "application/json",
      );
      expect(res.status).toBe(200);

      const titles = (await stream.settle()).flatMap((event) =>
        event.event === "fsingle/*"
          ? [(JSON.parse(event.data) as { record: { title: string } }).record.title]
          : [],
      );
      expect(titles).toEqual(["first", "second"]);
    } finally {
      ctx.close();
    }
    await same("DELETE", (side) => `/api/collections/fsingle/records/${recordId(side, "order")}`);
  });

  test("a replaced file of a single field and a file for no field store nothing", async () => {
    const [res] = await same(
      "POST",
      () => "/api/batch",
      batch([post("fsingle")], () => [
        textFile("requests.0.doc", "dropped.txt"),
        textFile("requests.0.doc", "kept.txt"),
        textFile("requests.0.nofield", "nofield.txt"),
      ]),
    );
    expect(res.status).toBe(200);
    await settledBuckets();
  });

  test("a rejected item leaves nothing, and no file over its limit reaches S3", async () => {
    const puts = ig.proxy.requests.length;
    const [res] = await same(
      "POST",
      () => "/api/batch",
      batch([post("fsingle", { title: "x" }), post("fsingle")], () => [
        textFile("requests.1.doc", "big.txt", "x".repeat(2000)),
      ]),
    );
    expect(res.status).toBe(400);
    expect(ig.proxy.requests.slice(puts).filter((r) => r.method === "PUT")).toEqual([]);
    await settledBuckets();
  });

  test("a failed later item removes the files of the earlier ones", async () => {
    const [res] = await same(
      "POST",
      () => "/api/batch",
      batch([post("fsingle"), post("fmulti"), post("freq")], () => [
        textFile("requests.0.doc", "a.txt"),
        textFile("requests.1.docs", "b.txt"),
      ]),
    );
    expect(res.status).toBe(400);
    await settledBuckets();
  });

  test("a unique index failure removes the batch's files", async () => {
    await createBoth("fmulti", "b3", [{ name: "title", value: "taken" }]);
    const [res] = await same(
      "POST",
      () => "/api/batch",
      batch([post("fsingle"), post("fmulti", { title: "taken" })], () => [
        textFile("requests.0.doc", "a.txt"),
        textFile("requests.1.docs", "b.txt"),
      ]),
    );
    expect(res.status).toBe(400);
    await settledBuckets();
  });

  test("an S3 failure part way answers as upstream and leaves nothing", async () => {
    await withRefused(
      (key, method) => method === "PUT" && key.includes("refused"),
      async () => {
        const [res] = await same(
          "POST",
          () => "/api/batch",
          batch([post("fmulti"), post("fsingle")], () => [
            textFile("requests.0.docs", "fine.txt"),
            textFile("requests.0.docs", "refused.txt"),
            textFile("requests.1.doc", "later.txt"),
          ]),
        );
        expect(res.status).toBe(400);
      },
    );
    await settledBuckets();
  });

  test("an S3 failure does not hide the validation error of an earlier item", async () => {
    await withRefused(
      (_key, method) => method === "PUT",
      async () => {
        const [res] = await same(
          "POST",
          () => "/api/batch",
          batch([post("freq"), post("fsingle")], () => [textFile("requests.1.doc", "s.txt")]),
        );
        expect(res.status).toBe(400);
      },
    );
    await settledBuckets();
  });

  test("a failed delete after the commit answers as upstream", async () => {
    await createBoth("fmulti", "b4", [textFile("docs", "stays.txt")]);
    await withRefused(
      (_key, method) => method === "DELETE",
      async () => {
        const [res] = await same(
          "POST",
          () => "/api/batch",
          (side) =>
            batch(
              [
                {
                  method: "PATCH",
                  url: `/api/collections/fmulti/records/${recordId(side, "b4")}`,
                  body: { docs: [] },
                },
              ],
              () => [],
            )(side),
        );
        expect(res.status).toBe(400);
      },
    );
    await settledBuckets();
    await same("GET", (side) => `/api/collections/fmulti/records/${recordId(side, "b4")}`);
  });
});

describe("record and collection deletes", () => {
  test("a record delete removes its files and thumbs", async () => {
    await createBoth("fmulti", "d1", [{ name: "img", filename: "a.png", content: png }]);
    for (const t of [up, ig]) {
      const rec = t.side.records.get("d1") as { id: string; img: string };
      const res = await req(
        t.side.url,
        "GET",
        `/api/files/fmulti/${rec.id}/${rec.img}?thumb=100x100`,
      );
      expect(res.status).toBe(200);
    }
    await settledBuckets();
    await same("DELETE", (side) => `/api/collections/fmulti/records/${recordId(side, "d1")}`);
    await settledBuckets();
  });

  test("replacing a file removes it and its thumbs", async () => {
    await createBoth("fmulti", "d2", [{ name: "img", filename: "a.png", content: png }]);
    for (const t of [up, ig]) {
      const rec = t.side.records.get("d2") as { id: string; img: string };
      await req(t.side.url, "GET", `/api/files/fmulti/${rec.id}/${rec.img}?thumb=100x100`);
    }
    await same(
      "PATCH",
      (side) => `/api/collections/fmulti/records/${recordId(side, "d2")}`,
      (side) => formBody([{ name: "img", filename: "b.png", content: png }], side),
    );
    await settledBuckets();
  });

  test("a cascade delete removes the related records' files", async () => {
    await createBoth("fmulti", "d3", [textFile("docs", "parent.txt")]);
    for (const t of [up, ig]) {
      const b = formBody(
        [{ name: "parent", value: recordId(t.side, "d3") }, textFile("att", "child.txt")],
        t.side,
      );
      const res = await req(
        t.side.url,
        "POST",
        "/api/collections/fchild/records",
        b.body,
        b.contentType,
      );
      expect(res.status).toBe(200);
      await sideRecord("d3child", res, t);
    }
    await compareBucketsPaired("d3child");
    await same("DELETE", (side) => `/api/collections/fmulti/records/${recordId(side, "d3")}`);
    await settledBuckets();
  });

  test("truncate and collection delete", async () => {
    const definition = {
      id: "s3deletetest001",
      name: "s3deletes",
      type: "base",
      createRule: "",
      fields: [{ name: "doc", type: "file", maxSelect: 1 }],
    };
    await same(
      "POST",
      () => "/api/collections",
      () => jsonBody(definition),
    );
    await createBoth("s3deletes", "t1", [textFile("doc", "truncated.txt")]);
    await same("DELETE", () => "/api/collections/s3deletes/truncate");
    await settledBuckets();

    await createBoth("s3deletes", "t2", [textFile("doc", "deleted.txt")]);
    await same("DELETE", () => "/api/collections/s3deletes");
    await settledBuckets();
    expect((await ig.fsys.list("s3deletetest001/")).length).toBe(0);
  });
});

describe("failures around a save", () => {
  test("a rejected validation stores nothing, and checks the record's directory", async () => {
    await settledBuckets();
    await Bun.sleep(300); // the background deletes of the cases before
    const seenUp = up.proxy.requests.length;
    const seen = ig.proxy.requests.length;
    const [res] = await same(
      "POST",
      () => "/api/collections/fsingle/records",
      (side) => formBody([textFile("doc", "big.txt", "x".repeat(2000))], side),
    );
    expect(res.status).toBe(400);
    expect(methods(ig.proxy.requests.slice(seen))).toEqual(
      methods(up.proxy.requests.slice(seenUp)),
    );
  });

  test("a failed write removes the uploads", async () => {
    await createBoth("fmulti", "f1", [{ name: "title", value: "unique title" }]);
    const [res] = await same(
      "POST",
      () => "/api/collections/fmulti/records",
      (side) =>
        formBody([{ name: "title", value: "unique title" }, textFile("docs", "x.txt")], side),
    );
    expect(res.status).toBe(400);
    await settledBuckets();
  });

  test("an S3 failure part way answers as upstream and leaves nothing", async () => {
    await withRefused(
      (key, method) => method === "PUT" && key.includes("refused"),
      async () => {
        const [res] = await same(
          "POST",
          () => "/api/collections/fmulti/records",
          (side) => formBody([textFile("docs", "fine.txt"), textFile("docs", "refused.txt")], side),
        );
        expect(res.status).toBe(400);
      },
    );
    await settledBuckets();
  });

  test("an S3 failure on an update keeps the record and its files", async () => {
    await createBoth("fmulti", "f2", [textFile("docs", "old.txt")]);
    await withRefused(
      (_key, method) => method === "PUT",
      async () => {
        const [res] = await same(
          "PATCH",
          (side) => `/api/collections/fmulti/records/${recordId(side, "f2")}`,
          (side) => formBody([textFile("docs", "new.txt")], side),
        );
        expect(res.status).toBe(400);
      },
    );
    await settledBuckets();
    await same("GET", (side) => `/api/collections/fmulti/records/${recordId(side, "f2")}`);
  });

  test("a failed delete after the commit answers as upstream and keeps the change", async () => {
    await createBoth("fmulti", "f3", [textFile("docs", "stays.txt")]);
    await withRefused(
      (_key, method) => method === "DELETE",
      async () => {
        // upstream reports the delete, though the update is committed
        const [res] = await same(
          "PATCH",
          (side) => `/api/collections/fmulti/records/${recordId(side, "f3")}`,
          () => jsonBody({ docs: [] }),
        );
        expect(res.status).toBe(400);
      },
    );
    await settledBuckets();
    const [res] = await same(
      "GET",
      (side) => `/api/collections/fmulti/records/${recordId(side, "f3")}`,
    );
    expect((JSON.parse(res.text) as { docs: string[] }).docs).toEqual([]);
  });

  test("a failed delete of a deleted record fails nothing", async () => {
    await createBoth("fmulti", "f4", [textFile("docs", "orphan.txt")]);
    await withRefused(
      (_key, method) => method === "DELETE",
      async () => {
        const [res] = await same(
          "DELETE",
          (side) => `/api/collections/fmulti/records/${recordId(side, "f4")}`,
        );
        expect(res.status).toBe(204);
        await Bun.sleep(300);
      },
    );
    await settledBuckets();
  });
});

describe("thumbs", () => {
  test("concurrent requests generate one thumb", async () => {
    await createBoth("fmulti", "th1", [{ name: "img", filename: "c.png", content: png }]);
    const results: Record<string, number> = {};
    for (const [label, t] of [
      ["upstream", up],
      ["iglo", ig],
    ] as const) {
      const rec = t.side.records.get("th1") as { id: string; img: string };
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          req(t.side.url, "GET", `/api/files/fmulti/${rec.id}/${rec.img}?thumb=100x100`),
        ),
      );
      for (const res of responses) {
        expect(res.status).toBe(200);
      }
      results[label] = thumbPuts(t, rec.img);
    }
    expect(results).toEqual({ upstream: 1, iglo: 1 });
    await settledBuckets();
  });

  test("a thumb that cannot be stored falls back to the original", async () => {
    await createBoth("fmulti", "th2", [{ name: "img", filename: "d.png", content: png }]);
    await withRefused(
      (key, method) => method === "PUT" && key.includes("/thumbs_"),
      async () => {
        for (const t of [up, ig]) {
          const rec = t.side.records.get("th2") as { id: string; img: string };
          const res = await req(
            t.side.url,
            "GET",
            `/api/files/fmulti/${rec.id}/${rec.img}?thumb=100x100`,
          );
          expect(res.status).toBe(200);
          expect(Buffer.compare(res.body, png)).toBe(0);
        }
      },
    );
    await settledBuckets();
  });
});

describe("the other server reads the objects", () => {
  for (const [kind, name] of [
    ["upstream", "iglo.base's objects served by upstream"],
    ["iglo", "upstream's objects served by iglo.base"],
  ] as const) {
    test(
      name,
      async () => {
        const from = kind === "upstream" ? ig : up;
        for (const ref of ["rt"]) {
          for (const t of [up, ig]) {
            const b = formBody(
              [
                { name: "img", filename: "rt.png", content: png },
                textFile("docs", "rt.txt"),
                textFile("docs", "rt ünï.txt"),
              ],
              t.side,
            );
            const res = await req(
              t.side.url,
              "POST",
              "/api/collections/fmulti/records",
              b.body,
              b.contentType,
            );
            expect(res.status).toBe(200);
            await sideRecord(ref, res, t);
          }
          await compareBucketsPaired(ref);
        }

        // a thumb made by the writer
        const written = from.side.records.get("rt") as { id: string; img: string; docs: string[] };
        const base = `/api/files/fmulti/${written.id}/`;
        const madeThumb = await req(from.side.url, "GET", `${base}${written.img}?thumb=100x100`);
        expect(madeThumb.status).toBe(200);

        const server = await otherServer(from, kind);
        try {
          const original = await req(from.side.url, "GET", base + written.img);
          const served = await req(server.url, "GET", base + written.img);
          expect(served.status).toBe(200);
          expect(served.contentType).toBe(original.contentType);
          expect(Buffer.compare(served.body, original.body)).toBe(0);

          // served from the object, not made again
          const thumb = await req(server.url, "GET", `${base}${written.img}?thumb=100x100`);
          expect(Buffer.compare(thumb.body, madeThumb.body)).toBe(0);

          for (const doc of written.docs) {
            const a = await req(from.side.url, "GET", base + encodeURIComponent(doc));
            const b = await req(server.url, "GET", base + encodeURIComponent(doc));
            expect(`${b.status} ${b.contentType}`).toBe(`${a.status} ${a.contentType}`);
            expect(Buffer.compare(a.body, b.body)).toBe(0);
          }

          // a new file on the other server, and a delete of the writer's
          const patch = await req(
            server.url,
            "PATCH",
            `/api/collections/fmulti/records/${written.id}`,
            JSON.stringify({ "docs-": [written.docs[0]] }),
            "application/json",
          );
          expect(patch.status).toBe(200);
          expect(
            await from.fsys.exists(
              `${collectionIds.get("fmulti")}/${written.id}/${written.docs[0]}`,
            ),
          ).toBe(false);

          const del = await req(
            server.url,
            "DELETE",
            `/api/collections/fmulti/records/${written.id}`,
          );
          expect(del.status).toBe(204);
          const prefix = `${collectionIds.get("fmulti")}/${written.id}/`;
          await eventually(async () => (await from.fsys.list(prefix)).length === 0);
          expect(await from.fsys.list(prefix)).toEqual([]);
        } finally {
          await stop(server);
        }

        // the two buckets differ by what this test removed from one
        const other = from === up ? ig : up;
        await req(
          other.side.url,
          "DELETE",
          `/api/collections/fmulti/records/${recordId(other.side, "rt")}`,
        );
        const stale = await req(
          from.side.url,
          "DELETE",
          `/api/collections/fmulti/records/${written.id}`,
        );
        expect(stale.status).toBe(204);
        await settledBuckets();
      },
      timeout,
    );
  }
});

describe("settings", () => {
  test("the storage test keeps working", async () => {
    const [res] = await same(
      "POST",
      () => "/api/settings/test/s3",
      () => jsonBody({ filesystem: "storage" }),
    );
    expect(res.status).toBe(204);
  });

  test("turning S3 off and on takes effect without a restart", async () => {
    const off = { enabled: false };
    await useS3(up.side.url, off);
    await useS3(ig.side.url, off);
    await createBoth("fsingle", "s1", [textFile("doc", "local.txt")]);
    for (const t of [up, ig]) {
      const rec = t.side.records.get("s1") as { id: string; doc: string };
      const local = join(t.dataDir, "storage", collectionIds.get("fsingle") as string, rec.id);
      expect(existsSync(join(local, rec.doc))).toBe(true);
      expect(await t.fsys.exists(`${collectionIds.get("fsingle")}/${rec.id}/${rec.doc}`)).toBe(
        false,
      );
    }

    await useS3(up.side.url, s3Settings(up.proxy.endpoint, up.bucket));
    await useS3(ig.side.url, s3Settings(ig.proxy.endpoint, ig.bucket));
    await createBoth("fsingle", "s2", [textFile("doc", "remote.txt")]);
    for (const t of [up, ig]) {
      const rec = t.side.records.get("s2") as { id: string; doc: string };
      expect(await t.fsys.exists(`${collectionIds.get("fsingle")}/${rec.id}/${rec.doc}`)).toBe(
        true,
      );
    }

    // a file stored locally is not found on S3
    const [res] = await same("GET", (side) => {
      const rec = side.records.get("s1") as { id: string; doc: string };
      return `/api/files/fsingle/${rec.id}/${rec.doc}`;
    });
    expect(res.status).toBe(404);
  });
});

describe("backups", () => {
  test(
    "a backup leaves S3 objects out, and a restore keeps serving them",
    async () => {
      await createBoth("fsingle", "bk", [textFile("doc", "kept-in-s3.txt")]);

      const entries: string[][] = [];
      for (const t of [up, ig]) {
        const res = await req(
          t.side.url,
          "POST",
          "/api/backups",
          JSON.stringify({ name: "s3files.zip" }),
          "application/json",
        );
        expect(res.status).toBe(204);
        const names = zipEntries(join(t.dataDir, "backups", "s3files.zip"));
        expect(names.filter((n) => n.includes("kept-in-s3"))).toEqual([]);
        entries.push(names.filter((n) => n.startsWith("storage/")).map(mappedKey));
      }
      expect(entries[1]?.length).toBe(entries[0]?.length);

      for (const t of [up, ig]) {
        const res = await req(t.side.url, "POST", "/api/backups/s3files.zip/restore");
        expect(res.status).toBe(204);
      }
      await Bun.sleep(1500);
      for (const t of [up, ig]) {
        // refused while the server restarts
        const ready = await eventually(() =>
          fetch(t.side.url + "/api/health").then(
            (r) => r.ok,
            () => false,
          ),
        );
        expect(ready).toBe(true);
        const rec = t.side.records.get("bk") as { id: string; doc: string };
        const res = await req(t.side.url, "GET", `/api/files/fsingle/${rec.id}/${rec.doc}`);
        expect(res.status).toBe(200);
      }
      await settledBuckets();
    },
    timeout,
  );
});

describe("copy-object", () => {
  test("a stored file copies to a new key", async () => {
    const key = "s3copy/source.txt";
    await ig.fsys.upload(new TextEncoder().encode("copied"), key);
    await ig.fsys.copy(key, "s3copy/target.txt");
    const copied = join(gw.posixRoot, ig.bucket, "s3copy", "target.txt");
    expect(readFileSync(copied, "utf8")).toBe("copied");
    await ig.fsys.deletePrefix("s3copy/");
  });
});
