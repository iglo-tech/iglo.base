// M0.8 spike 1: multipart record create near the 32 MiB default body
// limit, iglo.base against upstream PocketBase v0.41.0. Not shipped; needs
// `bun run upstream:prepare`. Report: docs/perf/M0.8-multipart.md.
//
//   nice -n 10 bun scripts/spikes/M0.8/multipart.ts [--only file,small,...]
//
// Builds one pb_data through upstream's API with two collections (create
// rule ""): `notes` (a text field; body limit 32 MiB) and `uploads` (a text
// field and a file field with maxSize 32 MiB, maxSelect 1; body limit
// 32 + 32 MiB). For each case, server and concurrency, a fresh server
// process serves a copy of that pb_data, gets one small warm-up create,
// then the case's requests over raw sockets (n requests in flight). The
// server's VmHWM after the run is its peak resident memory; a 20 ms VmRSS
// sampler cross-checks it and stops the run when MemAvailable drops below
// 1.5 GiB.

import { cpSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  apiClient,
  guardMemory,
  hostFacts,
  percentile,
  procStats,
  sampler,
  spikeRoot,
  startIgloServer,
  startUpstreamServer,
  upsertSuperuser,
  type Server,
} from "@/../scripts/spikes/M0.8/common";

const { values } = parseArgs({ options: { only: { type: "string", default: "" } } });
const only = values.only === "" ? undefined : new Set(values.only.split(","));

const MiB = 1 << 20;
const boundary = "----m08spikeboundary7MA4YWxkTrZu0gW";

interface Part {
  name: string;
  filename?: string;
  data: Uint8Array;
}

function multipart(parts: Part[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    const disp =
      p.filename === undefined
        ? `form-data; name="${p.name}"`
        : `form-data; name="${p.name}"; filename="${p.filename}"`;
    const type = p.filename === undefined ? "" : "Content-Type: application/octet-stream\r\n";
    chunks.push(
      enc.encode(`--${boundary}\r\nContent-Disposition: ${disp}\r\n${type}\r\n`),
      p.data,
      enc.encode("\r\n"),
    );
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function filled(size: number, byte: number): Uint8Array {
  return new Uint8Array(size).fill(byte);
}

interface RawResult {
  status: number;
  body: string;
  ms: number;
  // body bytes written when the first response byte arrived
  sentAtResponse: number;
  bodyBytes: number;
  // body bytes written in all, and the response bytes received
  sent: number;
  received: number;
  error?: string;
}

// One HTTP/1.1 request over a new socket. The body is written in 64 KiB
// slices (chunked encoding when `chunked`), waiting for the socket to
// drain; writing stops once the response starts or the socket closes.
function rawRequest(
  port: number,
  path: string,
  body: Uint8Array,
  chunked: boolean,
): Promise<RawResult> {
  return new Promise((resolveResult) => {
    const started = performance.now();
    const socket = connect({ host: "127.0.0.1", port });
    let sent = 0;
    let sentAtResponse = -1;
    let response = Buffer.alloc(0);
    let finished = false;
    const finish = (error?: string): void => {
      if (finished) {
        return;
      }
      finished = true;
      socket.destroy();
      const text = response.toString("latin1");
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
      const at = text.indexOf("\r\n\r\n");
      resolveResult({
        status,
        body: at >= 0 ? text.slice(at + 4, at + 4 + 300) : "",
        ms: performance.now() - started,
        sentAtResponse: sentAtResponse < 0 ? sent : sentAtResponse,
        bodyBytes: body.length,
        sent,
        received: response.length,
        ...(error === undefined ? {} : { error }),
      });
    };
    const timer = setTimeout(() => finish("timeout"), 120_000);
    socket.on("data", (d: Buffer) => {
      if (sentAtResponse < 0) {
        sentAtResponse = sent;
      }
      response = Buffer.concat([response, d]);
      const text = response.toString("latin1");
      const at = text.indexOf("\r\n\r\n");
      if (at >= 0) {
        const len = Number(/\r\ncontent-length: *(\d+)/i.exec(text.slice(0, at))?.[1] ?? -1);
        if (len >= 0 && response.length >= at + 4 + len) {
          clearTimeout(timer);
          finish();
        }
      }
    });
    socket.on("error", (e) => {
      clearTimeout(timer);
      finish(e.message.split(" ")[0]);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      finish();
    });
    socket.on("connect", async () => {
      const head =
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Content-Type: multipart/form-data; boundary=${boundary}\r\n` +
        (chunked ? "Transfer-Encoding: chunked\r\n" : `Content-Length: ${body.length}\r\n`) +
        "\r\n";
      socket.write(head);
      const slice = 64 * 1024;
      for (let off = 0; off < body.length; off += slice) {
        if (finished || sentAtResponse >= 0) {
          return;
        }
        const part = body.subarray(off, Math.min(off + slice, body.length));
        // one write per slice: a short-circuited write would break the framing
        socket.write(
          chunked
            ? Buffer.concat([
                Buffer.from(`${part.length.toString(16)}\r\n`),
                part,
                Buffer.from("\r\n"),
              ])
            : part,
        );
        sent += part.length;
        // let the response (if any) be read before the next slice, also
        // when the server keeps accepting the body
        await new Promise((r) => setImmediate(r));
        // checked after the yield: a "drain" during it is not missed
        if (socket.writableNeedDrain && !finished) {
          await new Promise<void>((r) => {
            const done = (): void => {
              socket.off("drain", done);
              socket.off("close", done);
              r();
            };
            socket.on("drain", done);
            socket.on("close", done);
          });
        }
      }
      if (chunked && !finished && sentAtResponse < 0) {
        socket.write("0\r\n\r\n");
      }
    });
  });
}

interface Case {
  name: string;
  description: string;
  collection: string;
  // built when the case runs, so that only one body is in memory
  body: () => Uint8Array;
  chunked: boolean;
  // sequential requests at concurrency 1; rounds of n at concurrency n
  repeat: number;
  concurrency?: number[];
}

function cases(): Case[] {
  const title: Part = { name: "title", data: new TextEncoder().encode("spike") };
  const small = (count: number, size: number): Part[] => [
    title,
    ...Array.from({ length: count }, (_, i) => ({
      name: `x${i}`,
      data: filled(size, 0x61 + (i % 26)),
    })),
  ];
  const overLimit = (): Uint8Array =>
    multipart([
      title,
      { name: "doc", filename: "over.bin", data: filled(32 * MiB + 64 * 1024, 0x5a) },
    ]);
  return [
    {
      name: "file",
      description: "one 31.9 MiB file part (`uploads`, limit 64 MiB)",
      collection: "uploads",
      body: () =>
        multipart([
          title,
          { name: "doc", filename: "big.bin", data: filled(Math.round(31.9 * MiB), 0x42) },
        ]),
      chunked: false,
      repeat: 3,
    },
    {
      name: "small",
      description: "999 parts: title and 998 values of 24 KiB, 23.4 MiB (`notes`)",
      collection: "notes",
      body: () => multipart(small(998, 24 * 1024)),
      chunked: false,
      repeat: 3,
    },
    {
      name: "small-cap",
      description:
        "999 parts: title and 998 values of 32,000 bytes, 30.5 MiB, over Go's 26 MiB value cap (`notes`)",
      collection: "notes",
      body: () => multipart(small(998, 32_000)),
      chunked: false,
      repeat: 3,
    },
    {
      name: "over-cl",
      description: "32 MiB + 64 KiB file part, Content-Length (`notes`, limit 32 MiB)",
      collection: "notes",
      body: overLimit,
      chunked: false,
      repeat: 3,
    },
    {
      name: "over-chunked",
      description: "32 MiB + 64 KiB file part, chunked, no Content-Length (`notes`)",
      collection: "notes",
      body: overLimit,
      chunked: true,
      repeat: 3,
    },
    {
      name: "over-chunked-96",
      description: "96 MiB file part, chunked, no Content-Length (`notes`)",
      collection: "notes",
      body: () =>
        multipart([title, { name: "doc", filename: "huge.bin", data: filled(96 * MiB, 0x5a) }]),
      chunked: true,
      repeat: 2,
    },
    {
      name: "over-cl-96",
      description: "96 MiB file part, Content-Length (`notes`, limit 32 MiB)",
      collection: "notes",
      body: () =>
        multipart([title, { name: "doc", filename: "huge.bin", data: filled(96 * MiB, 0x5a) }]),
      chunked: false,
      repeat: 2,
    },
    {
      name: "file-160",
      description: "one 160 MiB file part (`bigfiles`, maxSize 256 MiB, limit 288 MiB)",
      collection: "bigfiles",
      body: () =>
        multipart([title, { name: "doc", filename: "big.bin", data: filled(160 * MiB, 0x42) }]),
      chunked: false,
      repeat: 1,
      concurrency: [1],
    },
  ];
}

async function build(dataDir: string, root: string): Promise<void> {
  await upsertSuperuser(dataDir, root, "spike@example.com", "1234567890");
  const server = await startUpstreamServer(dataDir, root);
  try {
    const api = apiClient(server.url);
    await api.loginSuperuser("spike@example.com", "1234567890");
    await api.must("POST", "/api/collections", {
      name: "notes",
      type: "base",
      createRule: "",
      fields: [{ name: "title", type: "text" }],
    });
    await api.must("POST", "/api/collections", {
      name: "uploads",
      type: "base",
      createRule: "",
      fields: [
        { name: "title", type: "text" },
        { name: "doc", type: "file", maxSize: 32 * MiB, maxSelect: 1 },
      ],
    });
    await api.must("POST", "/api/collections", {
      name: "bigfiles",
      type: "base",
      createRule: "",
      fields: [
        { name: "title", type: "text" },
        { name: "doc", type: "file", maxSize: 256 * MiB, maxSelect: 1 },
      ],
    });
  } finally {
    await server.stop();
  }
}

const spike = spikeRoot("m08-multipart");
try {
  console.log(hostFacts());
  const dataDir = join(spike.root, "pb_data");
  await build(dataDir, spike.root);
  const rows: string[] = [];
  const details: string[] = [];

  const sizes: string[] = [];
  for (const c of cases()) {
    if (only && !only.has(c.name)) {
      continue;
    }
    const body = c.body();
    sizes.push(`${c.name}: ${c.description}, ${(body.length / MiB).toFixed(2)} MiB`);
    for (const target of ["upstream", "iglo.base"] as const) {
      for (const concurrency of c.concurrency ?? [1, 8]) {
        guardMemory(2500);
        const copy = join(spike.root, `${target}-${c.name}-${concurrency}`, "pb_data");
        cpSync(dataDir, copy, { recursive: true });
        const server: Server =
          target === "upstream"
            ? await startUpstreamServer(copy, spike.root)
            : await startIgloServer(copy, spike.root);
        let sample: ReturnType<typeof sampler> | undefined;
        try {
          const path = `/api/collections/${c.collection}/records`;
          const warm = await rawRequest(
            server.port,
            path,
            multipart([{ name: "title", data: new Uint8Array([0x77]) }]),
            false,
          );
          const base = procStats(server.pid);
          // on low memory: kill the server, which ends the requests in flight,
          // and start no further round
          sample = sampler(server.pid, () => process.kill(server.pid, "SIGKILL"));
          const results: RawResult[] = [];
          const rounds = concurrency === 1 ? c.repeat : Math.max(1, c.repeat - 1);
          for (let r = 0; r < rounds && !sample.lowMem; r++) {
            const batch = await Promise.all(
              Array.from({ length: concurrency }, () =>
                rawRequest(server.port, path, body, c.chunked),
              ),
            );
            results.push(...batch);
          }
          if (sample.lowMem) {
            throw new Error(
              `MemAvailable dropped below 1.5 GiB during ${c.name} ${target} c=${concurrency}`,
            );
          }
          await Bun.sleep(200);
          const s = sample.stop();
          const end = procStats(server.pid);
          const ms = results.map((r) => r.ms).toSorted((a, b) => a - b);
          const statuses = [
            ...new Set(results.map((r) => r.status + (r.error ? `/${r.error}` : ""))),
          ].join(",");
          const sentMiB = Math.max(...results.map((r) => r.sentAtResponse)) / MiB;
          rows.push(
            `| ${c.name} | ${target} | ${concurrency} | ${statuses} | ${base.rssMiB.toFixed(0)} | ${end.hwmMiB.toFixed(0)} (${s.peakMiB.toFixed(0)}) | ${(end.hwmMiB - base.rssMiB).toFixed(0)} | ${percentile(ms, 0.5).toFixed(0)} / ${(ms.at(-1) ?? 0).toFixed(0)} | ${sentMiB.toFixed(1)} of ${(body.length / MiB).toFixed(1)} |`,
          );
          details.push(
            `${c.name} ${target} c=${concurrency} warm=${warm.status}: ${results[0]?.body ?? ""}`,
          );
          for (const r of results.filter((x) => x.error !== undefined)) {
            details.push(
              `  ${r.error}: ${r.sent} of ${r.bodyBytes} body bytes written, ${r.received} response bytes, status ${r.status}`,
            );
          }
          if (s.lowMem) {
            throw new Error(
              `MemAvailable dropped below 1.5 GiB during ${c.name} ${target} c=${concurrency}`,
            );
          }
        } finally {
          sample?.stop();
          await server.stop();
        }
      }
    }
  }

  console.log(
    "\n| Case | Server | In flight | Status | RSS before (MiB) | Peak RSS, VmHWM (sampled) | Peak - before | ms p50 / max | Body MiB sent when the response began |",
  );
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const row of rows) {
    console.log(row);
  }
  console.log("");
  for (const d of details) {
    console.log(d);
  }
  for (const line of sizes) {
    console.log(line);
  }
} finally {
  spike.cleanup();
}
