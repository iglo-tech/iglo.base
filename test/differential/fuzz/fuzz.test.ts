// The filter fuzzer against the reference PocketBase v0.41.0 binary. Not part
// of `bun test`: run `bun run test:reference`. The fixed suite, then a short
// run with a fixed seed; `bun run fuzz:filters` runs the long ones.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  compareOutcomes,
  type Outcome,
  requestPath,
  runCase,
} from "@test/differential/fuzz/compare";
import { printFilter } from "@test/differential/fuzz/filter-ast";
import { type FuzzCase, generateCase } from "@test/differential/fuzz/generate";
import { boundaries, type FixedCase, fixed, toCase } from "@test/differential/fuzz/regressions";
import { formatFailure, runFuzz } from "@test/differential/fuzz/run";
import { type FuzzServers, startFuzzServers } from "@test/differential/fuzz/servers";
import { shrinkCase } from "@test/differential/fuzz/shrink";

const shortRunSeed = 20261030;
const shortRunCases = 500;

let servers: FuzzServers;

beforeAll(async () => {
  servers = await startFuzzServers();
}, 120_000);

afterAll(async () => {
  await servers?.stop();
});

describe("fixed suite", () => {
  const statuses = new Map<string, number>();
  for (const c of [...fixed, ...boundaries] as FixedCase[]) {
    test(c.name, async () => {
      const result = await runCase(servers, toCase(c));
      statuses.set(c.name, result.up?.status ?? 0);
      expect(result.difference).toBeNull();
    });
  }

  test("the limits are on both sides of the boundary", () => {
    expect(statuses.get("200 expressions")).toBe(200);
    expect(statuses.get("201 expressions")).toBe(400);
    expect(statuses.get("3,500 characters")).toBe(200);
    expect(statuses.get("3,501 characters")).toBe(400);
    expect(statuses.get("8 sort expressions")).toBe(200);
    expect(statuses.get("9 sort expressions")).toBe(400);
  });
});

describe("generator", () => {
  test("the same seed and case number give the same case", () => {
    for (let n = 0; n < 200; n++) {
      const a = generateCase(servers.model, 7, n);
      const b = generateCase(servers.model, 7, n);
      expect(requestPath(a)).toBe(requestPath(b));
      expect(a.who).toBe(b.who);
    }
    const urls = new Set<string>();
    for (let n = 0; n < 200; n++) {
      urls.add(requestPath(generateCase(servers.model, 8, n)));
    }
    expect(urls.size).toBeGreaterThan(190);
  });
});

const list = (ids: string[], totalItems = ids.length, page = 1, perPage = 30): Outcome => ({
  status: 200,
  body: { page, perPage, totalItems, totalPages: 1, items: ids.map((id) => ({ id })) },
});

const errorOutcome = (message: string): Outcome => ({ status: 400, body: { message } });

describe("comparison", () => {
  const c = toCase({ name: "", collection: "demo2", who: "guest" });
  const unordered: FuzzCase = { ...c, sort: null };
  const ordered: FuzzCase = {
    ...c,
    sort: [{ text: "id", multiRow: false, unique: true }],
  };

  test("a total order compares ids in order", () => {
    expect(compareOutcomes(ordered, list(["a", "b"]), list(["a", "b"]))).toBeNull();
    expect(compareOutcomes(ordered, list(["a", "b"]), list(["b", "a"]))?.kind).toBe("ids");
  });

  test("an ambiguous order compares sets, and sizes for a partial page", () => {
    expect(compareOutcomes(unordered, list(["a", "b"]), list(["b", "a"]))).toBeNull();
    expect(compareOutcomes(unordered, list(["a", "b"]), list(["a", "c"]))?.kind).toBe("id-set");
    expect(compareOutcomes(unordered, list(["a"], 5), list(["b"], 5))).toBeNull();
    expect(compareOutcomes(unordered, list(["a"], 5), list(["a", "b"], 5))?.kind).toBe("page-size");
  });

  test("status, page fields and error bodies count", () => {
    expect(compareOutcomes(ordered, list(["a"]), errorOutcome("x"))?.kind).toBe("status");
    expect(compareOutcomes(ordered, list(["a"]), list(["a"], 2))?.kind).toBe("page-fields");
    expect(compareOutcomes(ordered, errorOutcome("x"), errorOutcome("x"))).toBeNull();
    expect(compareOutcomes(ordered, errorOutcome("x"), errorOutcome("y"))?.kind).toBe("error-body");
  });
});

describe("shrinker", () => {
  test("keeps only what the difference needs", async () => {
    const c: FuzzCase = {
      ...toCase({ name: "", collection: "demo2", who: "guest" }),
      params: { perPage: "2", page: "1" },
      sort: [{ text: "id", multiRow: false, unique: true }],
      filter: {
        k: "join",
        op: "&&",
        gap: " ",
        items: [
          { k: "cond", left: "a", op: "=", right: "1", gap: " " },
          {
            k: "paren",
            inner: {
              k: "join",
              op: "||",
              gap: " ",
              items: [
                { k: "cond", left: "b", op: "?=", right: `"needle"`, gap: " " },
                { k: "cond", left: "c", op: "=", right: "2", gap: " " },
              ],
            },
          },
        ],
      },
    };
    const shrunk = await shrinkCase(c, async (candidate) =>
      candidate.filter === null ? false : printFilter(candidate.filter).includes("?="),
    );
    expect(shrunk.filter === null ? "" : printFilter(shrunk.filter)).toBe("b ?= 1");
    expect(shrunk.params).toEqual({});
    expect(shrunk.sort).toBeNull();
  });
});

describe("short run", () => {
  test(`${shortRunCases} cases`, async () => {
    const report = await runFuzz(servers, { seed: shortRunSeed, cases: shortRunCases });
    expect(report.failures.map(formatFailure)).toEqual([]);
    expect(report.excluded.size).toBe(0);
    // the run reaches every form of the brief
    for (const tag of [
      "any-of",
      "back-relation",
      "relation-single",
      "relation-multiple",
      "modifier:each",
      "modifier:length",
      "modifier:lower",
      "@request.auth",
      "@collection",
      "collection-alias",
      "macro",
      "geoDistance",
      "strftime",
      "like",
      "escapes",
      "sort-rowid",
      "sort-multi",
    ]) {
      expect(report.tags.get(tag) ?? 0).toBeGreaterThan(0);
    }
    expect(report.statuses.get("200") ?? 0).toBeGreaterThan(shortRunCases / 2);
    expect(report.nonEmpty).toBeGreaterThan(shortRunCases / 5);
    expect(report.who.size).toBe(5);
    expect(report.invalid).toBeGreaterThan(shortRunCases / 20);
  }, 60_000);
});
