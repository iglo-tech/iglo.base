// Times ParseMultipartForm (src/server/request.ts) on three bodies: 20
// small values, 1,000 small values and one 10 MiB file. Run from the
// repository root: `nice -n 10 bun test/perf/records-write/multipart.ts`.
// docs/perf/M3.1-records-write.md has the results.

import { DefaultMaxMemory } from "@/server/buffer-with-file";
import { newTestRequest } from "@test/support/router";

const boundary = "9b3e7d1a5c8f2e6b0d4a7c1f5e8b2d6a";

function values(n: number): Uint8Array {
  let body = "";
  for (let i = 0; i < n; i++) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="field${i}"\r\n\r\nvalue ${i}\r\n`;
  }
  return new TextEncoder().encode(`${body}--${boundary}--\r\n`);
}

function file(size: number): Uint8Array {
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const out = new Uint8Array(head.length + size + tail.length);
  out.set(head);
  out.fill(0x61, head.length, head.length + size);
  out.set(tail, head.length + size);
  return out;
}

const bodies: [string, Uint8Array, number][] = [
  ["20 values", values(20), 2000],
  ["1,000 values", values(1000), 100],
  ["10 MiB file", file(10 << 20), 20],
];

for (const [name, body, iterations] of bodies) {
  const times: number[] = [];
  for (let i = 0; i < iterations + 5; i++) {
    const req = newTestRequest({
      method: "POST",
      target: "/",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const start = performance.now();
    const err = await req.parseMultipartForm(DefaultMaxMemory);
    const elapsed = performance.now() - start;
    if (err) {
      throw err;
    }
    if (i >= 5) {
      times.push(elapsed); // the first 5 are warm-up
    }
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)] as number;
  const p99 = times[Math.min(times.length - 1, Math.floor(times.length * 0.99))] as number;
  console.log(`${name}: p50 ${p50.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms`);
}
