// The multipart spill (src/server/multipart.ts, D27) through the server:
// file data past 16 MiB per request goes to a temporary file in TMPDIR,
// the record stores the spilled part from it, and the file is gone when
// the request ends, also when the request fails.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { superuserToken } from "@test/scenarios/record-crud";
import { startServer, type RunningServer } from "@test/support/executable";

const MiB = 1 << 20;
const boundary = "spillboundary";

let root: string;
let dataDir: string;
let tmp: string;
let server: RunningServer;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-spill-"));
  dataDir = join(root, "pb_data");
  tmp = join(root, "tmp");
  mkdirSync(tmp);
  copyDataDir(fixtureDir, dataDir);
  server = await startServer([], dataDir, "127.0.0.1", undefined, { TMPDIR: tmp });
});

afterAll(async () => {
  await server.stop();
  rmSync(root, { recursive: true, force: true });
});

function body(files: Uint8Array[], extra = ""): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [i, f] of files.entries()) {
    chunks.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file_many"; filename="f${i}.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      f,
      enc.encode("\r\n"),
    );
  }
  chunks.push(enc.encode(`${extra}--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

test("a spilled file part is stored, and the temporary file removed", async () => {
  // four 5 MiB files: the first three fit in the 16 MiB, the fourth spills
  const files = [0x41, 0x42, 0x43, 0x44].map((b) => new Uint8Array(5 * MiB - 100).fill(b));
  const res = await fetch(`${server.url}/api/collections/demo1/records`, {
    method: "POST",
    headers: {
      authorization: superuserToken,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    body: body(
      files,
      `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nspill\r\n`,
    ),
  });
  const record = (await res.json()) as { id: string; collectionId: string; file_many: string[] };
  expect(res.status).toBe(200);
  expect(record.file_many.length).toBe(4);
  for (const [i, name] of record.file_many.entries()) {
    const stored = readFileSync(join(dataDir, "storage", record.collectionId, record.id, name));
    expect(Buffer.compare(stored, files[i] as Uint8Array)).toBe(0);
  }
  expect(readdirSync(tmp)).toEqual([]);
});

test("the temporary file is removed when the request fails", async () => {
  // a failed save (a plain new file name is refused)
  const files = [0x41, 0x42, 0x43, 0x44].map((b) => new Uint8Array(5 * MiB - 100).fill(b));
  const res = await fetch(`${server.url}/api/collections/demo1/records`, {
    method: "POST",
    headers: {
      authorization: superuserToken,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    body: body(
      files,
      `--${boundary}\r\nContent-Disposition: form-data; name="file_one"\r\n\r\nmissing_abcdefghij.txt\r\n`,
    ),
  });
  expect(res.status).toBe(400);
  expect(readdirSync(tmp)).toEqual([]);
});
