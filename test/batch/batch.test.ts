// Upstream: apis/batch.go, the parts that the HTTP scenarios and the
// differential suite cannot reach: the deadline with an injected clock (D28,
// never sleeping; upstream's "transaction timeout" scenario delays items with
// a hook), the uploads' temporary files and the order of file deletes.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newRouter } from "@/apis/base";
import { findCollectionByNameOrId } from "@/collections/collection-query";
import { saveCollection } from "@/collections/collection-save";
import type { FileField } from "@/fields/file";
import { findRecordById } from "@/records/record-query";

import { openFixtureApp, type TestApp } from "@test/app/app";
import { superuserToken } from "@test/scenarios/record-crud";
import { serveTest } from "@test/support/router";

let now = new Date("2030-01-01T00:00:00Z");
// how much each read of the clock moves it
let tick = 0;
let app: TestApp;

beforeAll(async () => {
  const clock = {
    now: (): Date => {
      const current = now;
      now = new Date(now.getTime() + tick);
      return current;
    },
  };
  app = await openFixtureApp({ clock, readWorkers: 2 });
  app.settings.Batch.Enabled = true;
  app.settings.Batch.MaxRequests = 50;
  app.settings.Batch.Timeout = 1;

  const demo3 = findCollectionByNameOrId(app, "demo3");
  (demo3.fields.getByName("files") as FileField).maxSize = 64 << 20;
  saveCollection(app, demo3);
});

afterAll(() => app.cleanup());

beforeEach(() => {
  tick = 0;
});

function postBatch(body: string | Uint8Array, headers: Record<string, string> = {}) {
  return serveTest(newRouter(app).buildMux(), {
    method: "POST",
    target: "/api/batch",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

const create = (title: string): object => ({
  method: "POST",
  url: "/api/collections/demo2/records",
  body: { title },
});

function getRecords(target: string) {
  return serveTest(newRouter(app).buildMux(), {
    method: "GET",
    target,
    headers: { Authorization: superuserToken },
  });
}

async function titleCount(title: string): Promise<number> {
  const filter = encodeURIComponent(`title = "${title}"`);
  const res = await getRecords(`/api/collections/demo2/records?filter=${filter}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { totalItems: number }).totalItems;
}

const timeoutBody = `{"data":{},"message":"Batch transaction failed.","status":400}`;

test("a batch inside its deadline commits", async () => {
  const res = await postBatch(JSON.stringify({ requests: [create("in_time")] }));
  expect(res.status).toBe(200);
  expect(await titleCount("in_time")).toBe(1);
});

test("a batch past its deadline between items rolls back", async () => {
  tick = 200; // the clock is read per item, so a later item passes the second of the deadline
  const res = await postBatch(
    JSON.stringify({
      requests: Array.from({ length: 40 }, (_, i) => create(`past_deadline${i}`)),
    }),
  );
  tick = 0;
  expect(res.status).toBe(400);
  expect(await res.text()).toBe(timeoutBody);
  expect(await titleCount("past_deadline0")).toBe(0);
});

test("a batch past its deadline after the last item does not commit", async () => {
  tick = 10_000;
  const res = await postBatch(JSON.stringify({ requests: [create("late_commit")] }));
  tick = 0;
  expect(res.status).toBe(400);
  expect(await res.text()).toBe(timeoutBody);
  expect(await titleCount("late_commit")).toBe(0);
});

// a multipart batch with one file of the given size for the first item
function multipartBatch(requests: object[], size: number): { body: Uint8Array; type: string } {
  const boundary = "batchboundary0123456789";
  const head =
    `--${boundary}\r\nContent-Disposition: form-data; name="@jsonPayload"\r\n\r\n` +
    JSON.stringify({ requests }) +
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="requests.0.files"; filename="large.txt"\r\n` +
    `Content-Type: text/plain\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const encoder = new TextEncoder();
  const body = Buffer.concat([
    encoder.encode(head),
    new Uint8Array(size).fill(0x61),
    encoder.encode(tail),
  ]);
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

// what the body and the multipart form spilled in the temp directory
const spilled = (): string[] =>
  readdirSync(tmpdir()).filter(
    (n) => n.startsWith("multipart-") || n.startsWith("pb_buffer_file_"),
  );

const largeFile = 40 << 20; // over the 32 MiB kept in memory

test("uploads spill to temporary files that are gone after the request", async () => {
  const before = spilled();
  const { body, type } = multipartBatch(
    [
      {
        method: "POST",
        url: "/api/collections/demo3/records",
        body: { title: "spilled" },
      },
    ],
    largeFile,
  );
  const res = await postBatch(body, { "content-type": type, Authorization: superuserToken });
  expect(res.status).toBe(200);
  const [item] = (await res.json()) as { body: { id: string; files: string[] } }[];
  const collection = findCollectionByNameOrId(app, "demo3");
  const stored = join(app.dataDir, "storage", collection.id, item?.body.id ?? "");
  expect(item?.body.files).toHaveLength(1);
  expect(Bun.file(join(stored, item?.body.files[0] ?? "")).size).toBe(largeFile);
  expect(spilled()).toEqual(before);
});

test("a failed batch removes its uploads and temporary files", async () => {
  const before = spilled();
  const collection = findCollectionByNameOrId(app, "demo3");
  const dir = join(app.dataDir, "storage", collection.id);
  const records = readdirSync(dir).toSorted();
  const { body, type } = multipartBatch(
    [
      {
        method: "POST",
        url: "/api/collections/demo3/records",
        body: { title: "rolled back" },
      },
      { method: "PATCH", url: "/api/collections/demo3/records/missing", body: {} },
    ],
    largeFile,
  );
  const res = await postBatch(body, { "content-type": type, Authorization: superuserToken });
  expect(res.status).toBe(400);
  expect(spilled()).toEqual(before);
  expect(readdirSync(dir).toSorted()).toEqual(records);
});

test("a removed file stays until the batch commits", async () => {
  const collection = findCollectionByNameOrId(app, "demo3");
  const record = findRecordById(app, collection, "lcl9d87w22ml6jy");
  const name = record.getStringSlice("files")[0] as string;
  const path = join(app.dataDir, "storage", collection.id, record.id, name);
  expect(existsSync(path)).toBe(true);

  const removal = {
    method: "PATCH",
    url: `/api/collections/demo3/records/${record.id}`,
    body: { "files-": name },
  };
  const failed = await postBatch(
    JSON.stringify({
      requests: [
        removal,
        { method: "POST", url: "/api/collections/demo2/records", body: { title: "" } },
      ],
    }),
    { Authorization: superuserToken },
  );
  expect(failed.status).toBe(400);
  expect(existsSync(path)).toBe(true);
  const stored = await getRecords(`/api/collections/demo3/records/${record.id}`);
  expect(((await stored.json()) as { files: string[] }).files).toContain(name);

  const committed = await postBatch(JSON.stringify({ requests: [removal] }), {
    Authorization: superuserToken,
  });
  expect(committed.status).toBe(200);
  expect(existsSync(path)).toBe(false);
});
