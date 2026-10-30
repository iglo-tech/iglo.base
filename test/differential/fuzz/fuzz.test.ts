// The filter fuzzer against the reference PocketBase v0.41.0 binary. Not part
// of `bun test`: run `bun run test:reference`. The fixed suite, then a short
// run with a fixed seed; `bun run fuzz:filters` runs the long ones.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  classifySort,
  compareOutcomes,
  type Comparison,
  type ListBody,
  type Outcome,
  requestPath,
  runCase,
  type Send,
  sender,
  type SortClass,
  sortText,
} from "@test/differential/fuzz/compare";
import { printFilter } from "@test/differential/fuzz/filter-ast";
import { type FuzzCase, generateCase } from "@test/differential/fuzz/generate";
import type { Model } from "@test/differential/fuzz/model";
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

const classify = (collection: string, sort: string | null): SortClass =>
  classifySort(servers.model, collection, sort);

const compare = (c: FuzzCase, up: Outcome, ig: Outcome, send?: Send): Promise<Comparison> =>
  compareOutcomes(servers.model, c, up, ig, send ?? sender(servers, c));

function requests(model: Model): string[] {
  return Array.from({ length: 1000 }, (_, n) => {
    const c = generateCase(model, 1001, n);
    return `${c.who} ${requestPath(c)}`;
  });
}

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

  test("independently prepared fixtures give the same requests", async () => {
    const other = await startFuzzServers();
    try {
      expect(requests(other.model)).toEqual(requests(servers.model));
      expect([...other.model.collections.values()]).toEqual([
        ...servers.model.collections.values(),
      ]);
    } finally {
      await other.stop();
    }
  }, 120_000);
});

describe("sort classification", () => {
  test("reads the text that was sent, from either field", () => {
    const base = toCase({ name: "", collection: "fuzz_items", who: "guest" });
    expect(classify("fuzz_items", sortText({ ...base, rawSort: "id" }))).toBe("total");
    expect(classify("fuzz_items", sortText({ ...base, sort: ["id"] }))).toBe("total");
    expect(classify("fuzz_items", sortText({ ...base, sort: ["text", "-id"] }))).toBe("total");
    expect(classify("fuzz_items", sortText(base))).toBe("own-row");
  });

  test("a term before the id decides", () => {
    expect(classify("demo4", "-@rowid,title")).toBe("total");
    expect(classify("demo4", "title,+id")).toBe("total");
    expect(classify("demo4", "title")).toBe("own-row");
    expect(classify("demo4", "id:lower")).toBe("own-row");
    expect(classify("fuzz_items", "tag.name,id")).toBe("total");
    expect(classify("fuzz_items", "json.a.b.0,point.lat")).toBe("own-row");
    expect(classify("fuzz_items", "tags:length,many")).toBe("own-row");
    expect(classify("fuzz_items", "tags.name,id")).toBe("multi-row");
    expect(classify("fuzz_items", "many:each,id")).toBe("multi-row");
    expect(classify("fuzz_items", "tag.fuzz_items_via_tag.text,id")).toBe("multi-row");
    expect(classify("fuzz_tags", "fuzz_items_via_tag.text,id")).toBe("multi-row");
  });

  test("ambiguity survives the whole path", () => {
    for (const [n, sort] of [
      [3572, "rel_one_no_cascade,self_rel_one.demo4_via_self_rel_many.rel_many_no_cascade,@rowid"],
      [3345, "rel_one.rel_many:each,-id"],
    ] as const) {
      const c = generateCase(servers.model, 1001, n);
      expect(sortText(c)).toBe(sort);
      expect(classify(c.collection, sort)).toBe("multi-row");
    }
  });
});

const list = (ids: string[], totalItems = ids.length, page = 1, perPage = 30): Outcome => ({
  status: 200,
  body: { page, perPage, totalItems, totalPages: 1, items: ids.map((id) => ({ id })) },
});

const errorOutcome = (message: string): Outcome => ({ status: 400, body: { message } });

// the answer of a real server with one list replaced by another
function replaced(body: unknown, ids: string[]): Outcome {
  return { status: 200, body: { ...(body as object), items: ids.map((id) => ({ id })) } };
}

describe("comparison", () => {
  test("a total order compares ids in order", async () => {
    const c = toCase({ name: "", collection: "demo2", who: "guest", sort: "id" });
    expect((await compare(c, list(["a", "b"]), list(["a", "b"]))).difference).toBeNull();
    expect((await compare(c, list(["a", "b"]), list(["b", "a"]))).difference?.kind).toBe("ids");
  });

  test("a superuser page in place of a guest page is a difference", async () => {
    const c = toCase({
      name: "",
      collection: "fuzz_tags",
      who: "guest",
      sort: "name",
      params: { perPage: "1", skipTotal: "1" },
    });
    const send = sender(servers, c);
    const [up, ig] = await send(requestPath(c));
    expect((await compare(c, up, ig, send)).difference).toBeNull();
    const superuser: FuzzCase = {
      ...c,
      who: "superuser",
      filter: { k: "raw", text: `name = "hidden"` },
    };
    const [, leak] = await sender(servers, superuser)(requestPath(superuser));
    expect((await compare(c, up, leak, send)).difference?.kind).toBe("id-set");
  });

  test("a sort=-id answer in place of sort=id is a difference", async () => {
    const c = toCase({
      name: "",
      collection: "fuzz_items",
      who: "guest",
      sort: "id",
      params: { perPage: "1" },
    });
    const send = sender(servers, c);
    const [up] = await send(requestPath(c));
    const reversed = { ...c, rawSort: "-id" };
    const [, ig] = await send(requestPath(reversed));
    expect((await compare(c, up, ig, send)).difference?.kind).toBe("ids");
  });

  describe("records that tie", () => {
    // weights -1, 0, 0, 1, 1.5, 100: the second and third tie
    const c = toCase({
      name: "",
      collection: "fuzz_tags",
      who: "superuser",
      sort: "weight",
      params: { perPage: "1", page: "2" },
    });
    const tied = ["fuzztag00000003", "fuzztag00000005"];

    test("either order of the tie passes", async () => {
      const send = sender(servers, c);
      const [up, ig] = await send(requestPath(c));
      const other = tied.find((id) => id !== (up.body as ListBody).items[0]?.id) as string;
      const result = await compare(c, up, replaced(ig.body, [other]), send);
      expect(result).toEqual({ comparedAs: "set and id order", difference: null });
    });

    test("a record from another place does not", async () => {
      const send = sender(servers, c);
      const [up, ig] = await send(requestPath(c));
      const result = await compare(c, up, replaced(ig.body, ["fuzztag00000000"]), send);
      expect(result.difference?.kind).toBe("ids");
    });

    test("a reversed full list is a difference", async () => {
      const whole = toCase({ name: "", collection: "fuzz_tags", who: "superuser", sort: "weight" });
      const send = sender(servers, whole);
      const [up, ig] = await send(requestPath(whole));
      const backwards = (ig.body as ListBody).items.map((item) => item.id).toReversed();
      const result = await compare(whole, up, replaced(ig.body, backwards), send);
      expect(result.difference?.kind).toBe("ids");
    });

    test("no sort at all compares the full result by id", async () => {
      const none = toCase({ name: "", collection: "fuzz_tags", who: "superuser" });
      const send = sender(servers, none);
      const [up, ig] = await send(requestPath(none));
      const backwards = (ig.body as ListBody).items.map((item) => item.id).toReversed();
      const result = await compare(none, up, replaced(ig.body, backwards), send);
      expect(result).toEqual({ comparedAs: "set and id order", difference: null });
    });
  });

  describe("a sort through a multi-row join", () => {
    const c = toCase({
      name: "",
      collection: "fuzz_items",
      who: "superuser",
      sort: "tags.name",
      params: { perPage: "2" },
    });

    test("any page from the full set passes, only as a set", async () => {
      const send = sender(servers, c);
      const [up, ig] = await send(requestPath(c));
      const other = replaced(ig.body, ["fuzzitem0000029", "fuzzitem0000028"]);
      expect(await compare(c, up, other, send)).toEqual({
        comparedAs: "set only",
        difference: null,
      });
    });

    test("a record outside the full set does not", async () => {
      const send = sender(servers, c);
      const [up, ig] = await send(requestPath(c));
      const result = await compare(c, up, replaced(ig.body, ["fuzzitem0000000", "x"]), send);
      expect(result.difference?.kind).toBe("id-set");
    });

    test("two full sets must match", async () => {
      const sameOnPage: Send = async (path) => {
        const [up, ig] = await sender(servers, c)(path);
        const body = ig.body as ListBody;
        return [
          up,
          replaced(
            body,
            body.items.slice(1).map((item) => item.id),
          ),
        ];
      };
      const [up, ig] = await sender(servers, c)(requestPath(c));
      const result = await compare(c, up, ig, sameOnPage);
      expect(result.difference).not.toBeNull();
    });
  });

  describe("a filter that reads the page size", () => {
    const nameIsHidden = `@request.query.perPage = "1" && name != "hidden"`;

    test("a legitimate tie order passes", async () => {
      const c = toCase({
        name: "",
        collection: "fuzz_items",
        who: "superuser",
        filter: `@request.query.perPage = "1"`,
        params: { perPage: "1" },
      });
      const send = sender(servers, c);
      const [up, ig] = await send(requestPath(c));
      const result = await compare(c, up, ig, send);
      expect(result).toEqual({ comparedAs: "set and id order", difference: null });
    });

    test("a record outside the result is caught", async () => {
      const fixedCase: FixedCase = {
        name: "",
        collection: "fuzz_tags",
        who: "superuser",
        sort: "name",
        filter: nameIsHidden,
        params: { perPage: "1", skipTotal: "1" },
      };
      const c = toCase(fixedCase);
      const other = toCase({ ...fixedCase, filter: `name = "hidden"` });
      const send = sender(servers, c);
      const [up] = await send(requestPath(c));
      const [wrong] = await send(requestPath(other));
      const result = await compare(c, up, wrong, send);
      expect(result.difference?.kind).toBe("id-set");
    });

    test("a page that holds every match in the wrong order is caught", async () => {
      const fixedCase: FixedCase = {
        name: "",
        collection: "fuzz_tags",
        who: "superuser",
        sort: "weight",
        filter: `@request.query.perPage = "30"`,
        params: { perPage: "30" },
      };
      const c = toCase(fixedCase);
      const other = toCase({ ...fixedCase, sort: "-weight" });
      const send = sender(servers, c);
      const [up] = await send(requestPath(c));
      const [wrong] = await send(requestPath(other));
      const result = await compare(c, up, wrong, send);
      expect(result.difference?.kind).toBe("ids");
    });
  });

  describe("a case no companion can check is not a pass", () => {
    test("a result over one page", async () => {
      const c = toCase({
        name: "",
        collection: "fuzz_items",
        who: "guest",
        params: { perPage: "1" },
      });
      const items = Array.from({ length: 1000 }, (_, i) => `r${i}`);
      const send: Send = async () => [list(items, 1200), list(items, 1200)];
      const result = await compare(c, list(["a"], 1200), list(["a"], 1200), send);
      expect(result.difference?.kind).toBe("uncompared");
    });

    test("eight sort terms leave no room for an id", async () => {
      const sort = Array.from({ length: 8 }, () => "weight").join(",");
      const c = toCase({ name: "", collection: "fuzz_tags", who: "superuser", sort });
      const send = sender(servers, c);
      const [up, ig] = await send(requestPath(c));
      const result = await compare(c, up, ig, send);
      expect(result).toEqual({
        comparedAs: "set only: no room for an id sort key",
        difference: null,
      });
    });
  });

  test("status, page fields and error bodies count", async () => {
    const c = toCase({ name: "", collection: "demo2", who: "guest", sort: "id" });
    const kind = async (up: Outcome, ig: Outcome): Promise<string | undefined> =>
      (await compare(c, up, ig)).difference?.kind;
    expect(await kind(list(["a"]), errorOutcome("x"))).toBe("status");
    expect(await kind(list(["a"]), list(["a"], 2))).toBe("page-fields");
    expect(await kind(errorOutcome("x"), errorOutcome("x"))).toBeUndefined();
    expect(await kind(errorOutcome("x"), errorOutcome("y"))).toBe("error-body");
  });
});

describe("shrinker", () => {
  test("keeps only what the difference needs", async () => {
    const c: FuzzCase = {
      ...toCase({ name: "", collection: "demo2", who: "guest" }),
      params: { perPage: "2", page: "1" },
      sort: ["id"],
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
    for (const as of ["error body", "exact order", "set and id order", "set only"]) {
      expect(report.compared.get(as) ?? 0).toBeGreaterThan(0);
    }
    expect(report.invalid).toBeGreaterThan(shortRunCases / 20);
  }, 60_000);
});
