// M7.1c: the request log export (row text, data JSON, truncation, time) equals
// the M7.1b export over a corpus of generated logs.

import { expect, test } from "bun:test";

import type { Log } from "@/logs/batch-handler";
import { logDBExport } from "@/logs/log-model";
import { logDBExport as logDBExportBefore } from "@test/logs/log-model-before-m71c";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const texts = [
  "",
  "GET /api/health",
  "Zażółć 日本語 😀",
  'quote " \\ \n\t\u0001',
  "lone \ud800 surrogate",
  "x".repeat(200),
  "é".repeat(3000),
  "日".repeat(3000),
  "😀".repeat(2200),
];

const times = [
  0,
  1700000000123,
  -30610224000000,
  -30610224000001,
  253402300799999,
  253402300800000,
  -62167219200000,
  8.64e15,
  Number.NaN,
];

function attrValue(r: () => number, depth: number): unknown {
  const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)] as T;
  switch (Math.floor(r() * (depth > 2 ? 6 : 9))) {
    case 0:
      return null;
    case 1:
      return r() < 0.5;
    case 2:
      return pick([0, -0, 200, 0.123456, 1e21, -5e-7, 2 ** 53]);
    case 3:
    case 4:
      return pick(texts);
    case 5:
      return undefined;
    case 6:
      return [attrValue(r, depth + 1), attrValue(r, depth + 1)];
    default: {
      const o = Object.create(null) as { [key: string]: unknown };
      for (let i = 0; i < 4; i++) {
        o[pick(["a", "b", "10", "2", "é", "😀", "x y", '"', "__proto__"])] = attrValue(
          r,
          depth + 1,
        );
      }
      return o;
    }
  }
}

test("logDBExport equals the M7.1b export", () => {
  const r = rng(99);
  for (let i = 0; i < 3000; i++) {
    const data = Object.create(null) as { [key: string]: unknown };
    const n = Math.floor(r() * 12);
    for (let j = 0; j < n; j++) {
      const key = ["type", "execTime", "url", "method", "status", "userAgent", "auth", "k" + j][
        Math.floor(r() * 8)
      ] as string;
      data[key] = attrValue(r, 0);
    }
    const log: Log = {
      time: new Date(times[Math.floor(r() * times.length)] as number),
      level: Math.floor(r() * 5) * 4 - 4,
      message: texts[Math.floor(r() * texts.length)] as string,
      data,
    };
    for (const max of [0, 50, 200, 5000, 16384]) {
      const run = (f: typeof logDBExport): string => {
        try {
          return JSON.stringify(f("id", log, max));
        } catch (err) {
          return "err:" + (err as Error).message;
        }
      };
      expect(run(logDBExport)).toBe(run(logDBExportBefore));
    }
  }
});
