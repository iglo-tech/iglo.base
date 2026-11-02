// RealtimeService and RecordService.subscribe/unsubscribe of the JavaScript
// SDK 0.28.1 against both servers, through a test-only EventSource on fetch
// (test/support/event-source.ts; Bun has none). Each write is awaited and
// its events waited for before the next one, so event order is the writes'
// order on both servers. Not part of `bun test`: run `bun run test:reference`.

import { describe, expect } from "bun:test";

import { sdkTest, sortedKeys, type SdkEnv } from "@test/differential/sdk/harness";

// waits until the list has n entries
async function waitFor(env: SdkEnv, list: unknown[], n: number): Promise<void> {
  await env.until(() => list.length >= n, `${n} realtime events`);
}

describe("realtime", () => {
  sdkTest("record subscriptions: *, id, options, unsubscribe", {}, async (env) => {
    const admin = env.superuser();
    const watcher = env.client();
    const all: unknown[] = [];
    const one: unknown[] = [];
    const picked: unknown[] = [];

    const unsubAll = await env.step("subscribe *", () =>
      watcher.collection("demo2").subscribe("*", (e) => all.push(e)),
    );
    env.record("isConnected", watcher.realtime.isConnected);
    await env.step("subscribe (id)", () =>
      watcher.collection("demo2").subscribe("sdkrealtime0001", (e) => one.push(e)),
    );
    await env.step("subscribe (fields, query)", () =>
      watcher.collection("demo2").subscribe("sdkrealtime0002", (e) => picked.push(e), {
        fields: "id,title",
        query: { custom: "1" },
        headers: { "X-Custom": "1" },
      }),
    );

    await env.step("create 1", () =>
      admin.collection("demo2").create({ id: "sdkrealtime0001", title: "one" }),
    );
    await waitFor(env, all, 1);
    await waitFor(env, one, 1);
    await env.step("create 2", () =>
      admin.collection("demo2").create({ id: "sdkrealtime0002", title: "two", active: true }),
    );
    await waitFor(env, all, 2);
    await waitFor(env, picked, 1);
    await env.step("update 1", () =>
      admin.collection("demo2").update("sdkrealtime0001", { title: "one!" }),
    );
    await waitFor(env, all, 3);
    await waitFor(env, one, 2);
    await env.step("update 2", () =>
      admin.collection("demo2").update("sdkrealtime0002", { title: "two!" }),
    );
    await waitFor(env, all, 4);
    await waitFor(env, picked, 2);
    await env.step("delete 1", () => admin.collection("demo2").delete("sdkrealtime0001"));
    await waitFor(env, all, 5);
    await waitFor(env, one, 3);

    env.record("events (*)", all);
    env.record("events (id)", one);
    env.record("events (fields)", sortedKeys(picked));

    // unsubscribing one topic leaves the others
    await env.step("unsubscribe (id)", () =>
      watcher.collection("demo2").unsubscribe("sdkrealtime0002"),
    );
    await env.step("update 2 again", () =>
      admin.collection("demo2").update("sdkrealtime0002", { title: "two!!" }),
    );
    await waitFor(env, all, 6);
    expect(picked.length).toBe(2);
    await env.step("unsubscribe (function)", () => unsubAll());
    await env.step("create 3", () =>
      admin.collection("demo2").create({ id: "sdkrealtime0003", title: "three" }),
    );
    await Bun.sleep(300);
    env.record("counts", { all: all.length, one: one.length, picked: picked.length });
    await env.step("unsubscribe (all)", () => watcher.collection("demo2").unsubscribe());
    env.record("isConnected after", watcher.realtime.isConnected);
  });

  sdkTest("rules, auth, expand and filter", {}, async (env) => {
    const admin = env.superuser();
    const guest = env.client();
    const guestEvents: unknown[] = [];
    const adminEvents: unknown[] = [];
    const expanded: unknown[] = [];
    const filtered: unknown[] = [];

    const watcher = env.superuser();
    await env.step("subscribe demo3 (guest)", () =>
      guest.collection("demo3").subscribe("*", (e) => guestEvents.push(e)),
    );
    await env.step("subscribe demo3 (superuser)", () =>
      watcher.collection("demo3").subscribe("*", (e) => adminEvents.push(e)),
    );
    await env.step("subscribe demo1 (expand)", () =>
      watcher.collection("demo1").subscribe("*", (e) => expanded.push(e), { expand: "rel_one" }),
    );
    await env.step("subscribe demo2 (filter)", () =>
      watcher
        .collection("demo2")
        .subscribe("*", (e) => filtered.push(e), { filter: "title = 'match'" }),
    );

    await env.step("create demo3", () =>
      admin.collection("demo3").create({ id: "sdkrealtime0011", title: "private" }),
    );
    await waitFor(env, adminEvents, 1);
    await env.step("create demo1", () =>
      admin
        .collection("demo1")
        .create({ id: "sdkrealtime0012", text: "t", rel_one: "84nmscqy84lsi1t" }),
    );
    await waitFor(env, expanded, 1);
    await env.step("create demo2 (no match)", () =>
      admin.collection("demo2").create({ id: "sdkrealtime0013", title: "other" }),
    );
    await env.step("create demo2 (match)", () =>
      admin.collection("demo2").create({ id: "sdkrealtime0014", title: "match" }),
    );
    await waitFor(env, filtered, 1);
    await Bun.sleep(300);
    env.record("events", { guest: guestEvents, admin: adminEvents, expanded, filtered });
    await env.step("unsubscribeByPrefix", () => watcher.realtime.unsubscribeByPrefix("demo1"));
    await env.step("create demo1 again", () =>
      admin.collection("demo1").create({ id: "sdkrealtime0015", text: "t2" }),
    );
    await Bun.sleep(300);
    env.record("expanded after", expanded.length);
    await watcher.realtime.unsubscribe();
    await guest.realtime.unsubscribe();
  });

  sdkTest("RealtimeService topics, listeners and auth change", {}, async (env) => {
    const admin = env.superuser();
    const pb = env.client();
    const topic: unknown[] = [];
    const listener = (e: unknown) => topic.push(e);
    env.record("isConnected before", pb.realtime.isConnected);
    await env.step("subscribe (custom topic)", () =>
      pb.realtime.subscribe("custom_topic", listener),
    );
    env.record("isConnected", pb.realtime.isConnected);
    await env.step("subscribe (record topic)", () =>
      pb.realtime.subscribe("demo2/sdkrealtime0021", listener),
    );
    await env.step("create", () =>
      admin.collection("demo2").create({ id: "sdkrealtime0021", title: "topic" }),
    );
    await waitFor(env, topic, 1);
    env.record("events", topic);
    await env.step("unsubscribeByTopicAndListener", () =>
      pb.realtime.unsubscribeByTopicAndListener("demo2/sdkrealtime0021", listener),
    );
    await env.step("update", () =>
      admin.collection("demo2").update("sdkrealtime0021", { title: "topic!" }),
    );
    await Bun.sleep(300);
    env.record("events after unsubscribe", topic.length);
    // signing in re-sends the subscriptions with the new auth
    await env.step("authWithPassword", () =>
      pb.collection("_superusers").authWithPassword("test@example.com", "1234567890"),
    );
    await env.step("unsubscribe", () => pb.realtime.unsubscribe());
    env.record("isConnected after", pb.realtime.isConnected);
  });
});
