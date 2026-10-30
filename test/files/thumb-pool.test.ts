// Upstream: apis/file.go (bindFileApi's limits and fileApi.createThumb's
// singleflight + semaphore). No upstream test covers these limits
// directly; these check the thumb pool's rules with stand-in generations.

import { expect, test } from "bun:test";
import { availableParallelism } from "node:os";

import { encodePng } from "@/files/png-raw";
import { ThumbPool } from "@/files/thumb-pool";

const env =
  (values: Record<string, string>) =>
  (name: string): string =>
    values[name] ?? "";

// the rejection's message ("" when the promise resolves)
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("defaults: NumCPU + 2 workers, 60 s wait, 100 << 20 source pixels", () => {
  const pool = new ThumbPool({ getenv: env({}) });
  expect(pool.maxWorkers).toBe(availableParallelism() + 2);
  expect(pool.maxWaitMs).toBe(60_000);
  expect(pool.maxSourcePixels()).toBe(104_857_600);
  expect(pool.workers()).toBe(0); // started lazily
});

test("the environment, read as cast.ToInt64", () => {
  const pool = new ThumbPool({
    getenv: env({
      PB_THUMBS_MAX_WORKERS: "0_3",
      PB_THUMBS_MAX_WAIT: "0x_2",
      PB_THUMBS_MAX_SOURCE_PIXELS: "1000.0",
    }),
  });
  expect(pool.maxWorkers).toBe(3);
  expect(pool.maxWaitMs).toBe(2000);
  expect(pool.maxSourcePixels()).toBe(1000);

  // spf13/cast v1.10.0: strconv.ParseInt(trimDecimal(s), 0, 0); 0 (the default) when it fails
  const pixels = (value: string): number =>
    new ThumbPool({ getenv: env({ PB_THUMBS_MAX_SOURCE_PIXELS: value }) }).maxSourcePixels();
  const fallback = 100 * 2 ** 20;
  expect(pixels("")).toBe(fallback);
  expect(pixels("12")).toBe(12);
  expect(pixels("-5")).toBe(fallback);
  expect(pixels("010")).toBe(8);
  expect(pixels("08")).toBe(fallback);
  expect(pixels("0b11")).toBe(3);
  expect(pixels("1_000")).toBe(1000);
  expect(pixels("0x_3e8")).toBe(1000);
  expect(pixels("0b_1111101000")).toBe(1000);
  expect(pixels("0_1750")).toBe(1000);
  expect(pixels("0o1_750")).toBe(1000);
  expect(pixels("+1_0")).toBe(10);
  expect(pixels("1.5")).toBe(1);
  expect(pixels("1__0")).toBe(fallback);
  expect(pixels("1_")).toBe(fallback);
  expect(pixels("_1")).toBe(fallback);
  expect(pixels("0x")).toBe(fallback);
  expect(pixels("abc")).toBe(fallback);
  expect(pixels("99999999999999999999")).toBe(fallback);
});

test("a thumb path is generated once at a time; waiters share the result", async () => {
  const pool = new ThumbPool({ getenv: env({}) });
  const gate = deferred();
  let runs = 0;
  const generate = async (): Promise<void> => {
    runs++;
    await gate.promise;
    throw new Error("boom");
  };
  const a = pool.generate("x/thumbs_a.png/100x100_a.png", generate);
  const b = pool.generate("x/thumbs_a.png/100x100_a.png", generate);
  gate.resolve();
  expect(await rejection(a)).toBe("boom");
  expect(await rejection(b)).toBe("boom");
  expect(runs).toBe(1);

  // forgotten once done: a new request generates again
  await pool.generate("x/thumbs_a.png/100x100_a.png", async () => {
    runs++;
  });
  expect(runs).toBe(2);
});

test("at most PB_THUMBS_MAX_WORKERS generations at once", async () => {
  const pool = new ThumbPool({ getenv: env({ PB_THUMBS_MAX_WORKERS: "2" }) });
  const gates = [deferred(), deferred(), deferred()];
  let running = 0;
  let peak = 0;
  const started: number[] = [];
  const runs = gates.map((gate, i) =>
    pool.generate(`k${i}`, async () => {
      started.push(i);
      running++;
      peak = Math.max(peak, running);
      await gate.promise;
      running--;
    }),
  );
  await Bun.sleep(10);
  expect(started).toEqual([0, 1]);
  gates[0]?.resolve();
  await runs[0];
  await Bun.sleep(10);
  expect(started).toEqual([0, 1, 2]);
  gates[1]?.resolve();
  gates[2]?.resolve();
  await Promise.all(runs);
  expect(peak).toBe(2);
});

test("a generation that waits longer than PB_THUMBS_MAX_WAIT fails", async () => {
  const pool = new ThumbPool({
    getenv: env({ PB_THUMBS_MAX_WORKERS: "1", PB_THUMBS_MAX_WAIT: "1" }),
  });
  const gate = deferred();
  const first = pool.generate("a", () => gate.promise);
  let secondRan = false;
  const second = pool.generate("b", async () => {
    secondRan = true;
  });
  expect(await rejection(second)).toBe("context deadline exceeded");
  expect(secondRan).toBe(false);
  gate.resolve();
  await first;
  // the slot is free again
  await pool.generate("c", async () => undefined);
});

test("a PB_THUMBS_MAX_WAIT past setTimeout's range waits", async () => {
  // 10^7 s: Go waits that long; a timer of 10^10 ms would fire at once
  const pool = new ThumbPool({
    getenv: env({ PB_THUMBS_MAX_WORKERS: "1", PB_THUMBS_MAX_WAIT: "10_000_000" }),
  });
  expect(pool.maxWaitMs).toBe(10_000_000_000);
  const gate = deferred();
  const first = pool.generate("a", () => gate.promise);
  let settled = false;
  const second = pool.generate("b", async () => {});
  second.then(
    () => (settled = true),
    () => (settled = true),
  );
  await Bun.sleep(20);
  expect(settled).toBe(false);
  gate.resolve();
  await first;
  await second;
  expect(settled).toBe(true);
});

test("render runs in a worker; a closed pool refuses", async () => {
  const pool = new ThumbPool({ getenv: env({}) });
  const png = encodePng({ width: 40, height: 20, pix: new Uint8Array(40 * 20 * 4).fill(200) }, 6);
  const thumb = await pool.render(png, "image/png", { width: 10, height: 0, mode: "" });
  expect(thumb.contentType).toBe("image/png");
  // the PNG's IHDR size
  const ihdr = new DataView(thumb.bytes.buffer, thumb.bytes.byteOffset + 16, 8);
  expect([ihdr.getUint32(0), ihdr.getUint32(4)]).toEqual([10, 5]);
  expect(pool.workers()).toBe(1);

  expect(
    await rejection(
      pool.render(new Uint8Array([1, 2, 3]), "image/png", { width: 10, height: 0, mode: "" }),
    ),
  ).toContain("image headers decoding failed");

  pool.close();
  expect(pool.workers()).toBe(0);
  expect(
    await rejection(pool.render(png, "image/png", { width: 10, height: 0, mode: "" })),
  ).toContain("closed");
});
