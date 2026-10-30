// What a batch sends to realtime subscribers, against the reference
// PocketBase v0.41.0 binary: nothing for a failed batch, and after a commit
// the same messages, byte for byte. Each case runs on its own fixture copy per
// server (test/realtime/run.ts). Not part of `bun test`: run
// `bun run test:reference`.
//
// Upstream broadcasts in the order of the transaction's OnComplete calls, but
// sends each message from its own goroutine, so a client's order changes from
// run to run; the messages are compared sorted. iglo.base sends them in the
// OnComplete order (`order`).

import { describe, expect, test } from "bun:test";

import { observe } from "@test/realtime/run";
import {
  actions,
  normalize,
  type Observation,
  type RealtimeScenario,
  response,
  type ScenarioContext,
  settled,
} from "@test/realtime/scenario";
import { startServer } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

const id = (name: string): string => name.padEnd(15, "0");

async function createCollections(ctx: ScenarioContext): Promise<void> {
  const publicRules = {
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
  };
  const parents = await ctx.createCollection({
    name: "rt_parents",
    ...publicRules,
    fields: [{ name: "title", type: "text", required: true }],
  });
  await ctx.createCollection({
    name: "rt_children",
    ...publicRules,
    fields: [
      { name: "title", type: "text" },
      {
        name: "parent",
        type: "relation",
        collectionId: parents,
        maxSelect: 1,
        cascadeDelete: true,
      },
    ],
  });
}

const parent = (name: string, title = name): object => ({
  method: "POST",
  url: "/api/collections/rt_parents/records",
  body: { id: id(name), title },
});
const child = (name: string, parentName: string): object => ({
  method: "POST",
  url: "/api/collections/rt_children/records",
  body: { id: id(name), title: name, parent: id(parentName) },
});
const patchParent = (name: string, title: string): object => ({
  method: "PATCH",
  url: `/api/collections/rt_parents/records/${id(name)}`,
  body: { title },
});
const deleteParent = (name: string): object => ({
  method: "DELETE",
  url: `/api/collections/rt_parents/records/${id(name)}`,
});

async function batch(ctx: ScenarioContext, requests: object[]): Promise<Observation> {
  return response(await ctx.api("POST", "/api/batch", { requests }, ""));
}

function scenario(
  name: string,
  topics: string[],
  run: (ctx: ScenarioContext) => Promise<Observation>,
): RealtimeScenario {
  return {
    func: "differential",
    name,
    run: async (ctx) => {
      await createCollections(ctx);
      const stream = await ctx.open();
      const subscribed = await ctx.subscribe(stream.clientId, topics);
      if (subscribed.status !== 204) {
        throw new Error(`subscribe: ${subscribed.status} ${subscribed.body}`);
      }
      const result = await run(ctx);
      return { result, events: await settled(stream) };
    },
  };
}

const allRecords = ["rt_parents/*", "rt_children/*"];

// the events of an observation in a stable order
function sorted(o: Observation): Observation {
  const events = o["events"] as Observation[];
  return {
    ...o,
    events: events.toSorted((a, b) => (a["data"] as string).localeCompare(b["data"] as string)),
  };
}

const scenarios: (RealtimeScenario & { order?: string[] })[] = [
  {
    ...scenario("create, update and delete in order", allRecords, (ctx) =>
      batch(ctx, [
        parent("a"),
        parent("b"),
        patchParent("a", "a2"),
        child("c", "a"),
        deleteParent("b"),
      ]),
    ),
    order: [
      `rt_parents/* create ${id("a")}`,
      `rt_parents/* create ${id("b")}`,
      `rt_parents/* update ${id("a")}`,
      `rt_children/* create ${id("c")}`,
      `rt_parents/* delete ${id("b")}`,
    ],
  },
  {
    ...scenario("several updates of one record, then its delete", allRecords, (ctx) =>
      batch(ctx, [parent("a"), patchParent("a", "a2"), patchParent("a", "a3"), deleteParent("a")]),
    ),
    order: [
      `rt_parents/* create ${id("a")}`,
      `rt_parents/* update ${id("a")}`,
      `rt_parents/* update ${id("a")}`,
      `rt_parents/* delete ${id("a")}`,
    ],
  },
  scenario("a cascade delete", allRecords, async (ctx) => {
    await batch(ctx, [parent("a"), child("c", "a"), child("d", "a")]);
    return batch(ctx, [deleteParent("a")]);
  }),
  scenario("a failed batch sends nothing", allRecords, async (ctx) => {
    await batch(ctx, [parent("a")]);
    const failed = await batch(ctx, [
      parent("b"),
      patchParent("a", "changed"),
      deleteParent("a"),
      parent("c", ""),
    ]);
    // the stream still works, and this is its next message
    const after = await batch(ctx, [parent("d")]);
    return { failed, after };
  }),
  scenario(
    "subscription options on an item's record",
    [
      `rt_children/*?options=${encodeURIComponent(JSON.stringify({ query: { expand: "parent" } }))}`,
    ],
    (ctx) => batch(ctx, [parent("a"), child("c", "a")]),
  ),
];

describe("POST /api/batch realtime", () => {
  for (const s of scenarios) {
    test(
      s.name,
      async () => {
        const [upstream, igloBase] = await Promise.all([
          observe(s, (dataDir) => startUpstream({ dataDir })),
          observe(s, (dataDir) => startServer([], dataDir)),
        ]);
        expect(normalize(sorted(igloBase), false)).toBe(normalize(sorted(upstream), false));
        if (s.order !== undefined) {
          expect(actions(igloBase["events"])).toEqual(s.order);
        }
      },
      60_000,
    );
  }
});
