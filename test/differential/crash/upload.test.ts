// Crash and restart (M5.9): SIGKILL during a large multipart upload, with the
// files on the local disk and in S3 (versitygw). The same upload is killed on
// upstream, whose leftovers are the reference. Not part of `bun test`: run
// `bun run test:reference`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

import {
  api,
  demo1,
  freshDataDir,
  launch,
  orphans,
  patchSettings,
  s3Settings,
  verifyAfterKill,
  waitFor,
  walk,
  type Kind,
  type Target,
} from "@test/differential/crash/harness";
import { superuserToken } from "@test/scenarios/cron";
import { startVersitygw, type Versitygw } from "@test/support/versitygw";

const timeout = 120_000;
const roots: string[] = [];
let gw: Versitygw;

beforeAll(async () => {
  gw = await startVersitygw();
});

afterAll(async () => {
  await gw.stop();
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const bodySize = 4 * 1024 * 1024;
const boundary = "----crashtestboundary";

// the multipart request of a record with one large file
function uploadRequest(): { head: string; body: Buffer } {
  const file = Buffer.alloc(bodySize);
  for (let i = 0; i < file.length; i += 4) {
    file.writeUInt32LE((i * 2654435761) >>> 0, i);
  }
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nupload\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file_many"; filename="big.bin"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const head =
    `POST /api/collections/${demo1}/records HTTP/1.1\r\nHost: localhost\r\n` +
    `Authorization: ${superuserToken}\r\n` +
    `Content-Type: multipart/form-data; boundary=${boundary}\r\n` +
    `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
  return { head, body };
}

interface Upload {
  // resolves when `bytes` of the body are written to the socket
  sent: Promise<void>;
  // the status line of the answer, if one came
  answer: Promise<string>;
}

// Sends the request from a raw socket, so the test knows how many bytes of
// the body the server was given when it kills it.
function startUpload(url: string, bytes: number): Upload {
  const { head, body } = uploadRequest();
  const port = Number(new URL(url).port);
  const socket = connect(port, "127.0.0.1");
  let reply = "";
  const answer = new Promise<string>((resolve) => {
    socket.on("data", (d) => {
      reply += d.toString("latin1");
      if (reply.includes("\r\n")) {
        resolve(reply.slice(0, reply.indexOf("\r\n")));
      }
    });
    socket.on("close", () => resolve(reply.slice(0, reply.indexOf("\r\n") + 1 || 0)));
    socket.on("error", () => resolve(""));
  });
  const sent = new Promise<void>((resolve) => {
    socket.on("connect", () => {
      void (async () => {
        const all = Buffer.concat([Buffer.from(head), body]);
        const limit = Math.min(all.length, head.length + bytes);
        for (let at = 0; at < limit; at += 65536) {
          await new Promise<void>((done) =>
            socket.write(all.subarray(at, Math.min(at + 65536, limit)), () => done()),
          );
        }
        resolve();
      })();
    });
    socket.on("error", () => resolve());
  });
  return { sent, answer };
}

type Storage = "local" | "s3";
type Point = "partial-body" | "stored" | "answered";

const points: Point[] = ["partial-body", "stored", "answered"];

// Runs the upload against a server of kind and kills it at the point.
async function crashedUpload(kind: Kind, storage: Storage, point: Point): Promise<string> {
  const { root, dataDir } = freshDataDir();
  roots.push(root);
  const server: Target = await launch(kind, dataDir);
  if (storage === "s3") {
    await patchSettings(server, { s3: s3Settings(gw) });
  }
  const collection = (await (await api(server, "GET", `/api/collections/${demo1}`)).json()) as {
    id: string;
  };
  const objects = (): string[] =>
    storage === "s3"
      ? walk(join(gw.posixRoot, gw.bucket)).filter((p) => /big/.test(p))
      : walk(join(dataDir, "storage", collection.id)).filter((p) => /big/.test(p));

  const upload = startUpload(server.url, point === "partial-body" ? bodySize / 2 : bodySize + 1024);
  await upload.sent;
  if (point === "stored") {
    // the file is in the storage, the answer is not out yet
    await waitFor("the stored file", () => objects().length > 0 || undefined, 20_000).catch(
      () => undefined,
    );
  } else if (point === "answered") {
    expect(await upload.answer).toStartWith("HTTP/1.1 200");
  }
  await server.kill();
  await upload.answer;
  return dataDir;
}

for (const storage of ["local", "s3"] as const) {
  describe(`crash: upload to ${storage} storage`, () => {
    for (const point of points) {
      test(
        `a kill at ${point}`,
        async () => {
          const dataDir = await crashedUpload("iglo", storage, point);
          const outcome = await verifyAfterKill(dataDir, { skipFixtureFiles: storage === "s3" });
          const big = outcome.records.filter((r) => String(r["text"]) === "upload");
          if (point === "answered") {
            expect(big).toHaveLength(1);
          }
          if (point === "partial-body") {
            // the server never had the whole request
            expect(big).toHaveLength(0);
          }
          expect(big.length).toBeLessThanOrEqual(1);
          // the temp files of the spill are gone after the start
          expect(outcome.leftovers.filter((p) => p.startsWith(".pb_temp_to_delete/"))).toEqual([]);

          // upstream killed at the same point is the reference for what stays
          // in the storage without a record
          const refDir = await crashedUpload("upstream", storage, point);
          const ref = await verifyAfterKill(refDir, { skipFixtureFiles: storage === "s3" });
          const mine = storage === "local" ? orphans(dataDir, outcome.records) : [];
          const theirs = storage === "local" ? orphans(refDir, ref.records) : [];
          if (mine.length > 0 || theirs.length > 0) {
            console.warn(`orphans after a kill at ${point} (${storage}):`, { mine, theirs });
          }
          expect(mine.length).toBeLessThanOrEqual(theirs.length + (point === "stored" ? 1 : 0));
        },
        timeout,
      );
    }
  });
}
