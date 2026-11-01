// Upstream: apis/backup.go, core/backup_create.go, core/backup_restore.go,
// forms/test_s3_filesystem.go and tools/filesystem/internal/s3blob, with
// backups.s3 enabled. The two servers run against versitygw, and against a
// scripted S3 that records what reaches it and answers what a test asks.
// Not part of `bun test`: run `bun run test:reference`.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NewS3 } from "@/tools/filesystem/s3-system";
import { snapshot } from "@test/differential/backups/snapshot";
import { eventually, superuserToken } from "@test/scenarios/cron";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { freePort, startServer, tempDir } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";
import { startVersitygw, testS3Credentials, type Versitygw } from "@test/support/versitygw";

const timeout = 120_000;

const asSuperuser = { Authorization: superuserToken };

type Kind = "upstream" | "iglo";

interface Server {
  url: string;
  dataDir: string;
  stop(): Promise<unknown>;
}

const roots: string[] = [];

async function start(kind: Kind): Promise<Server> {
  const root = tempDir();
  roots.push(root);
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  writeFileSync(join(dataDir, "notes.txt"), "kept");
  const aux = new Database(join(dataDir, "auxiliary.db"));
  aux.run(
    `INSERT INTO _logs (id, level, message, data, created)
     VALUES ('backuplog000000', 0, 'kept', '{}', ?)`,
    // upstream's settings reload deletes logs past logs.maxDays
    [new Date().toISOString().replace("T", " ")],
  );
  aux.close();
  return kind === "upstream"
    ? startUpstream({ dataDir })
    : startServer([], dataDir).then((s) => ({ ...s, dataDir }));
}

interface S3Target {
  endpoint: string;
  bucket: string;
  secret?: string;
}

function s3Settings(target: S3Target | null): Record<string, unknown> {
  return target === null
    ? { enabled: false }
    : {
        enabled: true,
        bucket: target.bucket,
        region: testS3Credentials.region,
        endpoint: target.endpoint,
        accessKey: testS3Credentials.accessKeyId,
        secret: target.secret ?? testS3Credentials.secretAccessKey,
        forcePathStyle: true,
      };
}

async function patchSettings(server: Server, body: unknown): Promise<void> {
  const res = await fetch(`${server.url}/api/settings`, {
    method: "PATCH",
    headers: { ...asSuperuser, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(`${res.status} ${await res.text()}`).toStartWith("200");
}

function useBackupsS3(server: Server, target: S3Target | null): Promise<void> {
  return patchSettings(server, { backups: { s3: s3Settings(target) } });
}

interface Answer {
  status: number;
  body: string;
  headers?: Record<string, string | null>;
}

function normalize(text: string): string {
  return (
    text
      .replace(/127\.0\.0\.1:\d+/g, "S3")
      .replace(/pb_settings_test_[A-Za-z0-9]+/g, "pb_settings_test_X")
      .replace(/<RequestId>[^<]*<\/RequestId>/g, "<RequestId/>")
      .replace(/<HostId>[^<]*<\/HostId>/g, "<HostId/>")
      // versitygw's signature error tells the date and the signature
      .replace(
        /<(StringToSign|SignatureProvided|StringToSignBytes|CanonicalRequest|CanonicalRequestBytes)>[^<]*<\/\1>/g,
        "<$1/>",
      )
  );
}

const compared = [
  "Accept-Ranges",
  "Cache-Control",
  "Content-Disposition",
  "Content-Length",
  "Content-Range",
  "Content-Security-Policy",
  "Content-Type",
  "Last-Modified",
];

async function call(
  server: Server,
  method: string,
  path: string,
  init: {
    body?: FormData | string;
    json?: unknown;
    headers?: Record<string, string>;
    auth?: boolean;
  } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.auth !== false) {
    Object.assign(headers, asSuperuser);
  }
  let body = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(server.url + path, { method, headers, body: body ?? null });
  const out: Answer = {
    status: res.status,
    body: normalize(await res.text()),
    headers: {},
  };
  for (const name of compared) {
    (out.headers as Record<string, string | null>)[name] = res.headers.get(name);
  }
  return out;
}

// Only the status and body: the error responses' other headers are not S3's.
function plain(a: Answer): Answer {
  return { status: a.status, body: a.body };
}

async function fileToken(server: Server): Promise<string> {
  const res = await fetch(`${server.url}/api/files/token`, {
    method: "POST",
    headers: asSuperuser,
  });
  return ((await res.json()) as { token: string }).token;
}

async function download(
  server: Server,
  key: string,
  headers?: Record<string, string>,
): Promise<Answer> {
  const token = await fileToken(server);
  return call(server, "GET", `/api/backups/${encodeURIComponent(key)}?token=${token}`, {
    auth: false,
    headers: headers ?? {},
  });
}

async function downloadBytes(server: Server, key: string): Promise<Uint8Array> {
  const token = await fileToken(server);
  const res = await fetch(`${server.url}/api/backups/${encodeURIComponent(key)}?token=${token}`);
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

function uploadForm(name: string, zip: Uint8Array): FormData {
  const form = new FormData();
  form.set("file", new File([zip as Uint8Array<ArrayBuffer>], name, { type: "application/zip" }));
  return form;
}

function upload(server: Server, name: string, zip: Uint8Array): Promise<Answer> {
  return call(server, "POST", "/api/backups/upload", { body: uploadForm(name, zip) });
}

async function canBackup(server: Server): Promise<boolean> {
  const res = await fetch(`${server.url}/api/health`, { headers: asSuperuser });
  const body = (await res.json()) as { data: { canBackup: boolean } };
  return body.data.canBackup;
}

function tempFiles(server: Server): string[] {
  try {
    return readdirSync(join(server.dataDir, ".pb_temp_to_delete"));
  } catch {
    return [];
  }
}

// the object as a raw S3 read sees it
async function rawHead(s3: Versitygw, key: string): Promise<Record<string, string>> {
  const url = s3.client.file(key).presign({ method: "HEAD" });
  const res = await fetch(url, { method: "HEAD" });
  expect(res.status).toBe(200);
  const out: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    if (name === "content-type" || name.startsWith("x-amz-meta-")) {
      out[name] = value;
    }
  });
  return out;
}

function bucketFiles(s3: Versitygw): string[] {
  return readdirSync(join(s3.posixRoot, s3.bucket), { recursive: true, encoding: "utf8" })
    .filter((f) => !f.startsWith(".sgwtmp"))
    .toSorted();
}

let upstream: Server;
let iglo: Server;
let emptyZip: Uint8Array;

beforeAll(async () => {
  [upstream, iglo] = await Promise.all([start("upstream"), start("iglo")]);
  // a real zip (the mime check reads its head) with the size of an empty one
  emptyZip = new Uint8Array(22);
  emptyZip.set([0x50, 0x4b, 0x05, 0x06]);
}, timeout);

afterAll(async () => {
  await Promise.all([upstream?.stop(), iglo?.stop()]);
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

// the same steps on both servers, each with its own bucket
async function bothServers(
  steps: (server: Server, s3: Versitygw) => Promise<unknown>,
): Promise<void> {
  const [gwUp, gwIg] = await Promise.all([startVersitygw(), startVersitygw()]);
  try {
    await useBackupsS3(upstream, gwUp);
    await useBackupsS3(iglo, gwIg);
    const [a, b] = await Promise.all([steps(upstream, gwUp), steps(iglo, gwIg)]);
    expect(b).toEqual(a);
  } finally {
    await useBackupsS3(upstream, null);
    await useBackupsS3(iglo, null);
    await Promise.all([gwUp.stop(), gwIg.stop()]);
  }
}

function listBody(a: Answer): { status: number; body: unknown } {
  const list = JSON.parse(a.body) as { key: string; size: number; modified: string }[];
  return {
    status: a.status,
    body: list.map((o) => ({
      key: o.key,
      size: typeof o.size,
      modified: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(o.modified),
    })),
  };
}

describe("the backup endpoints with backups.s3 enabled", () => {
  test(
    "list, create, upload, download, delete",
    async () => {
      await bothServers(async (server, s3) => {
        const out: unknown[] = [];
        out.push(listBody(await call(server, "GET", "/api/backups")));
        out.push(plain(await call(server, "POST", "/api/backups", { json: { name: "a.zip" } })));
        out.push(plain(await call(server, "POST", "/api/backups", { json: { name: "a.zip" } })));
        out.push(plain(await call(server, "POST", "/api/backups", { json: { name: "A b.zip" } })));
        out.push(await rawHead(s3, "a.zip"));

        const name = "kopia zapasowa żółć+1.zip";
        out.push(plain(await upload(server, name, emptyZip)));
        out.push(plain(await upload(server, name, emptyZip)));
        out.push(await rawHead(s3, name));
        out.push(bucketFiles(s3));
        out.push(listBody(await call(server, "GET", "/api/backups")));

        const whole = await download(server, name);
        delete whole.headers?.["Last-Modified"];
        out.push(whole);
        const ranged = await download(server, name, { Range: "bytes=2-5" });
        delete ranged.headers?.["Last-Modified"];
        out.push(ranged);
        const unsatisfiable = await download(server, name, { Range: "bytes=100-" });
        delete unsatisfiable.headers?.["Last-Modified"];
        out.push(unsatisfiable);
        const notModified = await download(server, name, {
          "If-Modified-Since": new Date(Date.now() + 3_600_000).toUTCString(),
        });
        out.push(notModified.status);

        const key = encodeURIComponent(name);
        out.push(plain(await download(server, "missing.zip")));
        out.push(plain(await call(server, "DELETE", "/api/backups/missing.zip")));
        out.push(plain(await call(server, "POST", "/api/backups/missing.zip/restore")));
        out.push(plain(await call(server, "DELETE", `/api/backups/${key}`)));
        out.push(bucketFiles(s3));
        out.push(tempFiles(server));
        return out;
      });
    },
    timeout,
  );

  test(
    "a multi-range download answers with the file's ranges",
    async () => {
      await bothServers(async (server) => {
        await upload(server, "r.zip", emptyZip);
        const res = await download(server, "r.zip", { Range: "bytes=0-1,4-5" });
        const type = res.headers?.["Content-Type"] ?? "";
        const boundary = type.split("boundary=")[1] ?? "";
        return {
          status: res.status,
          type: type.split(";")[0],
          length: res.headers?.["Content-Length"],
          body: res.body.replaceAll(boundary, "B"),
        };
      });
    },
    timeout,
  );

  test(
    "a key past one S3 list page, and __pbAutoBackup__ prunes across pages",
    async () => {
      await bothServers(async (server, s3) => {
        await patchSettings(server, { backups: { cron: "0 3 * * *", cronMaxKeep: 2 } });
        const dir = join(s3.posixRoot, s3.bucket);
        const count = 1003;
        for (let i = 0; i < count; i++) {
          const path = join(dir, `@auto_pb_backup_old_${String(i).padStart(4, "0")}.zip`);
          writeFileSync(path, "x");
          utimesSync(path, 1_600_000_000 + i, 1_600_000_000 + i);
        }
        writeFileSync(join(dir, "manual.zip"), "x");

        const before = await call(server, "GET", "/api/backups");
        const listed = (JSON.parse(before.body) as { key: string }[]).length;

        const res = await call(server, "POST", "/api/crons/__pbAutoBackup__");
        const done = await eventually(() => bucketFiles(s3).length === 3);
        await patchSettings(server, { backups: { cron: "", cronMaxKeep: 0 } });

        const left = bucketFiles(s3).map((f) =>
          f.replace(/^@auto_pb_backup_(?!old).*_\d{14}\.zip$/, "@auto_new"),
        );
        return { status: res.status, listed, done, left, can: await canBackup(server) };
      });
    },
    timeout,
  );
});

function kept(logs: unknown[]): unknown[] {
  return logs.filter((l) => (l as { id: string }).id === "backuplog000000");
}

describe("a backup restored by the other server, through S3", () => {
  for (const [from, to] of [
    ["iglo", "upstream"],
    ["upstream", "iglo"],
  ] as const) {
    test(
      `made by ${from}, restored by ${to}`,
      async () => {
        const source = await start(from);
        const target = await start(to);
        const s3 = await startVersitygw();
        try {
          await useBackupsS3(source, s3);
          await useBackupsS3(target, s3);
          const res = await call(source, "POST", "/api/backups", { json: { name: "cross.zip" } });
          expect(res.status).toBe(204);
          await source.stop();
          const expected = snapshot(source.dataDir);

          const list = await call(target, "GET", "/api/backups");
          expect((JSON.parse(list.body) as { key: string }[]).map((b) => b.key)).toEqual([
            "cross.zip",
          ]);
          const zip = await downloadBytes(target, "cross.zip");
          expect(Buffer.compare(zip, await s3.client.file("cross.zip").bytes())).toBe(0);

          // a superuser created here must be gone after the restart
          const created = await call(target, "POST", "/api/collections/_superusers/records", {
            json: {
              email: "marker@example.com",
              password: "1234567890",
              passwordConfirm: "1234567890",
            },
          });
          expect(created.status).toBe(200);
          const { id } = JSON.parse(created.body) as { id: string };

          const restore = await call(target, "POST", "/api/backups/cross.zip/restore");
          expect(restore.status).toBe(204);
          const restarted = await eventually(async () => {
            try {
              const r = await fetch(`${target.url}/api/collections/_superusers/records/${id}`, {
                headers: asSuperuser,
              });
              return r.status === 404;
            } catch {
              return false; // the server is between the two images
            }
          });
          expect(restarted).toBe(true);
          await target.stop();

          const actual = snapshot(target.dataDir);
          expect(actual.data).toEqual(expected.data);
          expect(actual.storage).toEqual(expected.storage);
          expect(kept(actual.logs)).toEqual(kept(expected.logs));
          expect(kept(actual.logs)).toHaveLength(1);
          expect(readFileSync(join(target.dataDir, "notes.txt"), "utf8")).toBe("kept");
        } finally {
          await Promise.allSettled([source.stop(), target.stop()]);
          await s3.stop();
        }
      },
      timeout,
    );
  }
});

// -------------------------------------------------------------------
// the scripted S3

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

type Script = (req: Request, url: URL) => Response | null;

class ScriptedS3 {
  readonly seen: Seen[] = [];
  script: Script = () => null;
  readonly #objects = new Map<string, { body: Uint8Array; headers: Headers }>();
  readonly #server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 60,
    fetch: (req) => this.#handle(req),
  });

  get endpoint(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  stop(): void {
    void this.#server.stop(true);
  }

  async #handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const bytes = new Uint8Array(await req.arrayBuffer());
    const isPart = url.searchParams.has("partNumber");
    this.seen.push({
      method: req.method,
      url: url.pathname + url.search.replace(/uploadId=[^&]*/, "uploadId=U"),
      headers: Object.fromEntries(
        [...req.headers]
          .filter(
            ([k]) =>
              k === "content-type" ||
              k === "accept-encoding" ||
              k === "cache-control" ||
              k.startsWith("x-amz-") ||
              k === "range",
          )
          .filter(([k]) => k !== "x-amz-date"),
      ),
      body: isPart
        ? `${bytes.length} bytes`
        : new TextDecoder().decode(bytes).replace(/&#34;[0-9a-f]+&#34;/g, "ETAG"),
    });

    const scripted = this.script(req, url);
    if (scripted !== null) {
      return scripted;
    }

    const key = url.pathname;
    if (req.method === "GET" && url.searchParams.has("list-type")) {
      const items = [...this.#objects.entries()]
        .map(
          ([k, o]) =>
            `<Contents><Key>${k.split("/").slice(2).join("/")}</Key><LastModified>2026-01-02T03:04:05.678Z</LastModified><Size>${o.body.length}</Size><ETag>&quot;abc&quot;</ETag></Contents>`,
        )
        .join("");
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${items}</ListBucketResult>`,
      );
    }
    if (req.method === "POST" && url.searchParams.has("uploads")) {
      return new Response(
        "<InitiateMultipartUploadResult><UploadId>up/1 2</UploadId></InitiateMultipartUploadResult>",
      );
    }
    if (req.method === "POST") {
      return new Response("<CompleteMultipartUploadResult/>");
    }
    if (req.method === "PUT") {
      if (isPart) {
        const n = url.searchParams.get("partNumber");
        return new Response(null, { headers: { ETag: `"${String(n).padStart(32, "0")}"` } });
      }
      this.#objects.set(key, { body: bytes, headers: new Headers(req.headers) });
      return new Response(null);
    }
    if (req.method === "DELETE") {
      this.#objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const object = this.#objects.get(key);
    if (object === undefined) {
      return new Response(req.method === "HEAD" ? null : "<Error><Code>NoSuchKey</Code></Error>", {
        status: 404,
      });
    }
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.get("Range") ?? "");
    const first = Number(range?.[1] ?? 0);
    const end = range?.[2] ? Number(range[2]) + 1 : object.body.length;
    return new Response(req.method === "HEAD" ? null : object.body.slice(first, end), {
      status: range ? 206 : 200,
      headers: {
        "Content-Type": object.headers.get("Content-Type") ?? "",
        "Content-Length": String(end - first),
        "Last-Modified": "Fri, 02 Jan 2026 03:04:05 GMT",
        ...(range ? { "Content-Range": `bytes ${first}-${end - 1}/${object.body.length}` } : {}),
      },
    });
  }
}

// a zip head and padding: the mime check reads only the head
function largeZip(size: number): Uint8Array {
  const zip = new Uint8Array(size);
  zip.set([0x50, 0x4b, 0x05, 0x06]);
  return zip;
}

const xmlDenied =
  "<?xml version='1.0' encoding='UTF-8'?>\n<Error><Code>AccessDenied</Code><Message>Denied &amp; logged</Message><RequestId>r1</RequestId></Error>";

async function allEndpoints(server: Server, s3: ScriptedS3): Promise<unknown[]> {
  const out: unknown[] = [];
  out.push(plain(await call(server, "GET", "/api/backups")));
  out.push(plain(await call(server, "POST", "/api/backups", { json: {} })));
  out.push(plain(await call(server, "POST", "/api/backups", { json: { name: "n.zip" } })));
  out.push(plain(await upload(server, "u.zip", emptyZip)));
  out.push(plain(await download(server, "d.zip")));
  out.push(plain(await call(server, "DELETE", "/api/backups/d.zip")));
  out.push(plain(await call(server, "POST", "/api/backups/d.zip/restore")));
  out.push(
    plain(await call(server, "POST", "/api/settings/test/s3", { json: { filesystem: "backups" } })),
  );
  out.push(await canBackup(server));
  out.push(tempFiles(server));
  out.push(s3.seen.length > 0);
  s3.seen.length = 0;
  return out;
}

async function bothAgainst(
  script: Script,
  steps: (server: Server, s3: ScriptedS3) => Promise<unknown>,
): Promise<void> {
  const results: unknown[] = [];
  for (const server of [upstream, iglo]) {
    const s3 = new ScriptedS3();
    s3.script = script;
    try {
      await useBackupsS3(server, { endpoint: s3.endpoint, bucket: "b" });
      results.push(await steps(server, s3));
    } finally {
      await useBackupsS3(server, null);
      s3.stop();
    }
  }
  expect(results[1]).toEqual(results[0]);
}

describe("what reaches S3", () => {
  test(
    "the requests of a small and a multipart upload, list, restore check and delete",
    async () => {
      await bothAgainst(
        () => null,
        async (server, s3) => {
          await upload(server, "small z.zip", emptyZip);
          await upload(server, "big.zip", largeZip((6 << 20) * 2 + 5));
          await upload(server, "exact.zip", largeZip(6 << 20));
          await call(server, "GET", "/api/backups");
          await call(server, "DELETE", "/api/backups/small%20z.zip");
          return s3.seen
            .toSorted((a, b) => `${a.url}${a.method}`.localeCompare(`${b.url}${b.method}`))
            .map((r) => ({
              ...r,
              headers: {
                ...r.headers,
                authorization: undefined,
              },
            }));
        },
      );
    },
    timeout,
  );
});

function failAt(match: (url: URL, req: Request) => boolean): Script {
  return (req, url) => (match(url, req) ? new Response(xmlDenied, { status: 403 }) : null);
}

// the object is there, and reading it is refused
function denyDownload(req: Request, url: URL): Response | null {
  if (req.method === "HEAD") {
    return new Response(null, { headers: { "Content-Length": "22" } });
  }
  return url.searchParams.has("list-type") ? null : new Response(xmlDenied, { status: 403 });
}

describe("a refusing S3", () => {
  const cases: [string, Script][] = [
    ["403 with an XML error", () => new Response(xmlDenied, { status: 403 })],
    [
      "404 on everything",
      () => new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 }),
    ],
    ["500 with a text body", () => new Response("Service Unavailable", { status: 500 })],
    ["503 with an empty body", () => new Response(null, { status: 503 })],
    [
      "500 with an unbalanced XML body",
      () => new Response("<Error><Code>x</Error>", { status: 500 }),
    ],
    ["502 with another root", () => new Response("<html></html>", { status: 502 })],
    [
      "200 with an empty list body",
      (req, url) =>
        url.searchParams.has("list-type")
          ? new Response("")
          : new Response(xmlDenied, { status: 403 }),
    ],
  ];

  for (const [name, script] of cases) {
    test(
      name,
      async () => {
        await bothAgainst(script, allEndpoints);
      },
      timeout,
    );
  }

  test(
    "nothing listening",
    async () => {
      const port = await freePort();
      const results: unknown[] = [];
      for (const server of [upstream, iglo]) {
        await useBackupsS3(server, { endpoint: `http://127.0.0.1:${port}`, bucket: "b" });
        const seen = new ScriptedS3();
        seen.seen.push({ method: "", url: "", headers: {}, body: "" });
        results.push(await allEndpoints(server, seen));
        seen.stop();
        await useBackupsS3(server, null);
      }
      expect(results[1]).toEqual(results[0]);
    },
    timeout,
  );

  test(
    "a multipart upload that fails on a part or at the end is aborted",
    async () => {
      for (const script of [
        failAt((url) => url.searchParams.get("partNumber") === "2"),
        failAt((url, req) => req.method === "POST" && url.searchParams.has("uploadId")),
        failAt((url) => url.searchParams.has("uploads")),
      ]) {
        await bothAgainst(script, async (server, s3) => {
          const res = await upload(server, "big.zip", largeZip((6 << 20) * 3));
          return {
            res: plain(res),
            aborted: s3.seen.filter((r) => r.method === "DELETE").length,
            can: await canBackup(server),
            temp: tempFiles(server),
          };
        });
      }
    },
    timeout,
  );

  test(
    "a restore whose download fails changes nothing",
    async () => {
      await bothAgainst(denyDownload, async (server) => {
        const res = await call(server, "POST", "/api/backups/x.zip/restore");
        await Bun.sleep(1500);
        const ready = await eventually(() => canBackup(server));
        return { res: plain(res), ready, temp: tempFiles(server) };
      });
    },
    timeout,
  );
});

function testS3(server: Server, filesystem: unknown): Promise<Answer> {
  return call(server, "POST", "/api/settings/test/s3", { json: { filesystem } }).then(plain);
}

describe("POST /api/settings/test/s3", () => {
  test(
    "not enabled, an unknown filesystem, success and bad credentials on both filesystems",
    async () => {
      const results: unknown[] = [];
      for (const server of [upstream, iglo]) {
        const s3 = await startVersitygw();
        const out: unknown[] = [];
        try {
          out.push(await testS3(server, "storage"), await testS3(server, "backups"));
          out.push(await testS3(server, "other"), await testS3(server, ""));

          await patchSettings(server, {
            backups: { s3: s3Settings(s3) },
            s3: s3Settings(s3),
          });
          out.push(await testS3(server, "storage"), await testS3(server, "backups"));
          out.push(bucketFiles(s3));

          const bad = { endpoint: s3.endpoint, bucket: s3.bucket, secret: "wrong-secret" };
          await patchSettings(server, { backups: { s3: s3Settings(bad) }, s3: s3Settings(bad) });
          out.push(await testS3(server, "storage"), await testS3(server, "backups"));
          out.push(bucketFiles(s3));

          const missing = { endpoint: s3.endpoint, bucket: "no-such-bucket" };
          await patchSettings(server, { backups: { s3: s3Settings(missing) } });
          out.push(await testS3(server, "backups"));
        } finally {
          await patchSettings(server, { backups: { s3: s3Settings(null) }, s3: s3Settings(null) });
          await s3.stop();
        }
        results.push(out);
      }
      expect(results[1]).toEqual(results[0]);
    },
    timeout,
  );

  test(
    "a bad secret on the backup endpoints, as versitygw refuses it",
    async () => {
      const results: unknown[] = [];
      for (const server of [upstream, iglo]) {
        const s3 = await startVersitygw();
        try {
          await useBackupsS3(server, {
            endpoint: s3.endpoint,
            bucket: s3.bucket,
            secret: "wrong-secret",
          });
          results.push(await allEndpoints(server, { seen: [{}] } as unknown as ScriptedS3));
        } finally {
          await useBackupsS3(server, null);
          await s3.stop();
        }
      }
      expect(results[1]).toEqual(results[0]);
    },
    timeout,
  );
});

describe("forcePathStyle false", () => {
  test(
    "the virtual host style request reaches the bucket, signed for its host",
    async () => {
      const s3 = await startVersitygw("iglo-vhost", undefined, "s3.test");
      const realFetch = globalThis.fetch;
      // *.s3.test resolves nowhere: the connection goes to versitygw, the URL
      // and Host header stay the client's
      const hosts: string[] = [];
      globalThis.fetch = ((input: string, init: RequestInit) => {
        const url = new URL(input);
        hosts.push(url.host);
        return realFetch(new URL(url.pathname + url.search, s3.endpoint).href, init);
      }) as typeof fetch;
      try {
        const port = new URL(s3.endpoint).port;
        const fsys = NewS3(
          s3.bucket,
          testS3Credentials.region,
          `http://s3.test:${port}`,
          testS3Credentials.accessKeyId,
          testS3Credentials.secretAccessKey,
          false,
          tempDir(),
        );
        await fsys.upload(new TextEncoder().encode("hello"), "dir/a b.txt");
        expect((await fsys.list("dir/")).map((o) => o.key)).toEqual(["dir/a b.txt"]);
        expect(await fsys.exists("dir/a b.txt")).toBe(true);
        expect(await fsys.deletePrefix("dir/")).toEqual([]);
        expect(new Set(hosts)).toEqual(new Set([`iglo-vhost.s3.test:${port}`]));
      } finally {
        globalThis.fetch = realFetch;
        await s3.stop();
      }
    },
    timeout,
  );
});

describe("the temp directory of a failed backup", () => {
  test(
    "a failed create leaves nothing and clears the active flag",
    async () => {
      await bothAgainst(
        (req) =>
          req.method === "PUT" || req.method === "POST"
            ? new Response(xmlDenied, { status: 403 })
            : null,
        async (server) => {
          const res = await call(server, "POST", "/api/backups", { json: { name: "f.zip" } });
          mkdirSync(join(server.dataDir, ".pb_temp_to_delete"), { recursive: true });
          return { res: plain(res), can: await canBackup(server), temp: tempFiles(server) };
        },
      );
    },
    timeout,
  );
});
