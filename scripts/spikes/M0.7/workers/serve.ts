// M0.7 spike: the Worker side of bench.ts. Not shipped.
//
// A job names an original on disk; the worker reads it, makes the thumb
// with its candidate and writes the thumb next to the job's `out` path.

import { writeFileSync } from "node:fs";

import { encodePng } from "@/../scripts/spikes/M0.7/png";
import type { CreateThumb } from "@/../scripts/spikes/M0.7/thumb";

declare const self: Worker;

export interface Job {
  id: number;
  input: string;
  contentType: string;
  size: string;
  maxPixels: number;
  out?: string;
}

export interface JobResult {
  id: number;
  ms: number;
  contentType?: string;
  bytes?: number;
  error?: string;
}

// a 4x4 PNG and JPEG run once so the codecs' WebAssembly is compiled
// before anything is timed
async function warm(createThumb: CreateThumb): Promise<number> {
  const started = performance.now();
  const png = encodePng({ width: 4, height: 4, pix: new Uint8Array(64).fill(200) }, 6);
  await createThumb(png, "image/png", "2x2", 1 << 20).catch(() => undefined);
  const jpeg = await new Bun.Image(png).jpeg().bytes();
  await createThumb(jpeg, "image/jpeg", "2x2", 1 << 20).catch(() => undefined);
  return performance.now() - started;
}

export function serve(createThumb: CreateThumb): void {
  self.addEventListener("message", async (event: MessageEvent<Job | "warm">) => {
    if (event.data === "warm") {
      postMessage({ warmMs: await warm(createThumb) });
      return;
    }
    const job = event.data;
    const started = performance.now();
    try {
      const input = await Bun.file(job.input).bytes();
      const thumb = await createThumb(input, job.contentType, job.size, job.maxPixels);
      const ms = performance.now() - started;
      if (job.out) {
        writeFileSync(job.out, thumb.bytes);
      }
      postMessage({
        id: job.id,
        ms,
        contentType: thumb.contentType,
        bytes: thumb.bytes.length,
      } satisfies JobResult);
    } catch (err) {
      postMessage({
        id: job.id,
        ms: performance.now() - started,
        error:
          err instanceof Error
            ? String(err)
            : `${typeof err}: ${JSON.stringify(err) ?? String(err)}`,
      } satisfies JobResult);
    }
  });
}
