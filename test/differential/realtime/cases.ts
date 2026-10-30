// Realtime differential cases beyond upstream's tests: what the JS and Dart
// SDKs do with /api/realtime (connect, subscribe with `?options=`, record
// changes through the records API) and what each subscriber receives, byte
// for byte (the `fields` cases compare parsed JSON: upstream's picked maps
// have a random key order). Records get fixed ids so both servers' messages
// match; client ids and timestamps are normalized.
//
// Not covered here, with the reason: the password reset and verification
// confirm flows (not ported yet, M4.x; they save records through the same
// record save path covered below), batch (out of scope), the OAuth2
// redirect subscriber (M4.5).

import { expect } from "bun:test";

import { superuserToken, usersToken } from "@test/scenarios/record-crud";
import type { RealtimeStream } from "@test/realtime/client";
import {
  events,
  type Observation,
  type RealtimeScenario,
  response,
  type ScenarioContext,
  settled,
} from "@test/realtime/scenario";

const user1Id = "4q1xlclmfloku33";
const user2Id = "oap640cot4yru2s";

// `topic?options=…` as the SDKs send it
function topic(name: string, options: { query?: object; headers?: object }): string {
  return `${name}?options=${encodeURIComponent(JSON.stringify(options))}`;
}

// rt_posts: public list and view rules, a hidden field and an owner relation
async function createPosts(ctx: ScenarioContext, rules: object = {}): Promise<string> {
  return ctx.createCollection({
    name: "rt_posts",
    type: "base",
    listRule: "",
    viewRule: "",
    fields: [
      { name: "title", type: "text" },
      { name: "secret", type: "text", hidden: true },
      { name: "owner", type: "relation", collectionId: "_pb_users_auth_", maxSelect: 1 },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    ...rules,
  });
}

async function post(
  ctx: ScenarioContext,
  id: string,
  data: object = {},
  collection = "rt_posts",
): Promise<Observation> {
  return response(
    await ctx.api("POST", `/api/collections/${collection}/records`, { id, title: id, ...data }),
  );
}

// a stream subscribed to topics (as token's auth; a guest without)
async function subscribed(
  ctx: ScenarioContext,
  topics: string[],
  token?: string,
): Promise<RealtimeStream> {
  const stream = await ctx.open();
  const res = await ctx.subscribe(stream.clientId, topics, token);
  if (res.status !== 204) {
    throw new Error(`subscribe ${JSON.stringify(topics)}: ${res.status} ${res.body}`);
  }
  return stream;
}

// the events of every stream once they settled
async function all(streams: { [name: string]: RealtimeStream }): Promise<Observation> {
  const out: Observation = {};
  for (const [name, stream] of Object.entries(streams)) {
    out[name] = await settled(stream);
  }
  return out;
}

function count(o: Observation, name: string): number {
  return (o[name] as unknown[]).length;
}

export const realtimeCases: RealtimeScenario[] = [
  {
    func: "differential",
    name: "connect: status, headers and PB_CONNECT",
    run: async (ctx) => {
      const stream = await ctx.open();
      return {
        status: stream.status,
        headers: Object.fromEntries(
          ["content-type", "cache-control", "x-accel-buffering"].map((h) => [
            h,
            stream.headers.get(h),
          ]),
        ),
        // the raw first event: `id:<clientId>\nevent:PB_CONNECT\ndata:{"clientId":"…"}`
        first: stream.events[0],
      };
    },
  },
  {
    func: "differential",
    name: "subscribe, replace and unsubscribe topics",
    run: async (ctx) => {
      await createPosts(ctx);
      const stream = await subscribed(ctx, ["rt_posts/*"]);
      const steps: Observation[] = [];
      steps.push(await post(ctx, "rtreplace000001"));
      await stream.waitFor((e) => e.length >= 2);
      // replace with another topic
      steps.push(response(await ctx.subscribe(stream.clientId, ["demo2/*"])));
      steps.push(await post(ctx, "rtreplace000002"));
      steps.push(await post(ctx, "rtreplace000003", {}, "demo2"));
      await stream.waitFor((e) => e.length >= 3);
      // unsubscribe all
      steps.push(response(await ctx.subscribe(stream.clientId, [])));
      steps.push(await post(ctx, "rtreplace000004", {}, "demo2"));
      // no subscriptions key at all
      steps.push(response(await ctx.subscribeRaw(`{"clientId":"${stream.clientId}"}`)));
      return { steps, events: await settled(stream) };
    },
    check: (o) => expect((o.events as unknown[]).length).toBe(2),
  },
  {
    func: "differential",
    name: "create, update and delete on <collection>/*",
    run: async (ctx) => {
      await createPosts(ctx);
      const stream = await subscribed(ctx, ["rt_posts/*"]);
      const create = await post(ctx, "rtcrud000000001", { secret: "s" });
      await stream.waitFor((e) => e.length >= 2);
      const update = response(
        await ctx.api("PATCH", "/api/collections/rt_posts/records/rtcrud000000001", {
          title: "changed",
        }),
      );
      await stream.waitFor((e) => e.length >= 3);
      const del = response(
        await ctx.api("DELETE", "/api/collections/rt_posts/records/rtcrud000000001"),
      );
      return { create, update, del, events: await settled(stream) };
    },
    check: (o) => expect((o.events as unknown[]).length).toBe(3),
  },
  {
    func: "differential",
    name: "<collection>/<id>, collection id and the deprecated topic without /*",
    run: async (ctx) => {
      const postsId = await createPosts(ctx);
      const byId = await subscribed(ctx, ["rt_posts/rttopics0000001"]);
      const otherId = await subscribed(ctx, ["rt_posts/rttopics0000002"]);
      const byCollectionId = await subscribed(ctx, [`${postsId}/*`]);
      const deprecated = await subscribed(ctx, ["rt_posts"]);
      await post(ctx, "rttopics0000001");
      return all({ byId, otherId, byCollectionId, deprecated });
    },
    check: (o) => {
      expect(count(o, "byId")).toBe(1);
      expect(count(o, "otherId")).toBe(0);
      expect(count(o, "byCollectionId")).toBe(1);
      expect(count(o, "deprecated")).toBe(1);
    },
  },
  {
    func: "differential",
    name: "options query filter",
    run: async (ctx) => {
      await createPosts(ctx);
      const filtered = await subscribed(ctx, [
        topic("rt_posts/*", { query: { filter: "title = 'rtfilter0000002'" } }),
      ]);
      // raw (not URL-encoded) options, as in upstream's own tests
      const raw = await subscribed(ctx, [`rt_posts/*?options={"query":{"filter":"title='x'"}}`]);
      await post(ctx, "rtfilter0000001");
      await post(ctx, "rtfilter0000002");
      await post(ctx, "x", { id: "rtfilter0000003", title: "x" });
      return all({ filtered, raw });
    },
    check: (o) => {
      expect(count(o, "filtered")).toBe(1);
      expect(count(o, "raw")).toBe(1);
    },
  },
  {
    func: "differential",
    name: "options filter with @request or @collection fields: superusers only",
    run: async (ctx) => {
      await createPosts(ctx);
      const filter = "@request.auth.id != '' || @collection.demo2.id != ''";
      const user = await subscribed(ctx, [topic("rt_posts/*", { query: { filter } })], usersToken);
      const superuser = await subscribed(
        ctx,
        [topic("rt_posts/*", { query: { filter } })],
        superuserToken,
      );
      await post(ctx, "rtsufilter00001");
      return all({ user, superuser });
    },
    check: (o) => {
      expect(count(o, "user")).toBe(0);
      expect(count(o, "superuser")).toBe(1);
    },
  },
  {
    func: "differential",
    name: "options headers and @request.context in the list rule",
    run: async (ctx) => {
      await createPosts(ctx, {
        listRule: '@request.headers.x_token = "abc" && @request.context = "realtime"',
      });
      const match = await subscribed(ctx, [topic("rt_posts/*", { headers: { "X-Token": "abc" } })]);
      const wrong = await subscribed(ctx, [topic("rt_posts/*", { headers: { "X-Token": "no" } })]);
      const none = await subscribed(ctx, ["rt_posts/*"]);
      // a number header value is cast to a string
      const numeric = await subscribed(ctx, [topic("rt_posts/*", { headers: { x_token: 1 } })]);
      await post(ctx, "rtheaders000001");
      return all({ match, wrong, none, numeric });
    },
    check: (o) => {
      expect(count(o, "match")).toBe(1);
      expect(count(o, "wrong")).toBe(0);
      expect(count(o, "none")).toBe(0);
    },
  },
  {
    func: "differential",
    name: "list rule null: superusers only",
    run: async (ctx) => {
      await createPosts(ctx, { listRule: null, viewRule: null });
      const guest = await subscribed(ctx, ["rt_posts/*", "rt_posts/rtnull000000001"]);
      const user = await subscribed(ctx, ["rt_posts/*"], usersToken);
      const superuser = await subscribed(ctx, ["rt_posts/*"], superuserToken);
      await post(ctx, "rtnull000000001", { secret: "hidden for all but superusers" });
      return all({ guest, user, superuser });
    },
    check: (o) => {
      expect(count(o, "guest")).toBe(0);
      expect(count(o, "user")).toBe(0);
      expect(count(o, "superuser")).toBe(1);
    },
  },
  {
    func: "differential",
    name: "auth-dependent list rule: the owner only",
    run: async (ctx) => {
      await createPosts(ctx, { listRule: "owner = @request.auth.id" });
      const owner = await subscribed(ctx, ["rt_posts/*"], usersToken);
      const other = await subscribed(ctx, ["rt_posts/*"], await ctx.impersonate("users", user2Id));
      const guest = await subscribed(ctx, ["rt_posts/*"]);
      await post(ctx, "rtowner00000001", { owner: user1Id });
      await post(ctx, "rtowner00000002", { owner: user2Id });
      return all({ owner, other, guest });
    },
    check: (o) => {
      expect(count(o, "owner")).toBe(1);
      expect(count(o, "other")).toBe(1);
      expect(count(o, "guest")).toBe(0);
    },
  },
  {
    func: "differential",
    name: "the list rule for /*, the view rule for /<id>",
    run: async (ctx) => {
      await createPosts(ctx, { listRule: null, viewRule: "" });
      const list = await subscribed(ctx, ["rt_posts/*"]);
      const view = await subscribed(ctx, ["rt_posts/rtviewrule00001"]);
      await post(ctx, "rtviewrule00001");
      return all({ list, view });
    },
    check: (o) => {
      expect(count(o, "list")).toBe(0);
      expect(count(o, "view")).toBe(1);
    },
  },
  {
    func: "differential",
    name: "expand in options, with the relation's view rule",
    run: async (ctx) => {
      await createPosts(ctx);
      const expand = topic("rt_posts/*", { query: { expand: "owner" } });
      const owner = await subscribed(ctx, [expand], usersToken);
      const guest = await subscribed(ctx, [expand]);
      const superuser = await subscribed(ctx, [expand], superuserToken);
      await post(ctx, "rtexpand0000001", { owner: user1Id });
      return all({ owner, guest, superuser });
    },
    check: (o) => {
      expect(JSON.stringify(o.owner)).toContain(`\\"expand\\":{\\"owner\\":{`);
      // the guest may not view the owner: an empty expand
      expect(JSON.stringify(o.guest)).toContain(`\\"expand\\":{}`);
    },
  },
  {
    func: "differential",
    name: "fields in options",
    unorderedData: true,
    run: async (ctx) => {
      await createPosts(ctx);
      const picked = await subscribed(ctx, [
        topic("rt_posts/*", {
          query: { fields: "id,title:excerpt(4,true),expand.owner.name", expand: "owner" },
        }),
      ]);
      const superuser = await subscribed(
        ctx,
        [
          topic("rt_posts/*", {
            query: { fields: "id,secret,expand.owner.email", expand: "owner" },
          }),
        ],
        superuserToken,
      );
      // an invalid fields value: the whole record
      const invalid = await subscribed(ctx, [topic("rt_posts/*", { query: { fields: "id,(" } })]);
      await post(ctx, "rtfields0000001", { title: "a longer title", secret: "s", owner: user1Id });
      return all({ picked, superuser, invalid });
    },
  },
  {
    func: "differential",
    name: "auth record: email visibility for the owner, others and superusers",
    run: async (ctx) => {
      const owner = await subscribed(ctx, [`users/${user1Id}`], usersToken);
      const other = await subscribed(
        ctx,
        [`users/${user1Id}`],
        await ctx.impersonate("users", user2Id),
      );
      const superuser = await subscribed(ctx, ["users/*"], superuserToken);
      const update = response(
        await ctx.api("PATCH", `/api/collections/users/records/${user1Id}`, { name: "renamed" }),
      );
      return { update, ...(await all({ owner, other, superuser })) };
    },
    check: (o) => {
      expect(JSON.stringify(o.owner)).toContain("test@example.com");
      expect(count(o, "other")).toBe(0);
      expect(JSON.stringify(o.superuser)).toContain("test@example.com");
    },
  },
  {
    func: "differential",
    name: "auth record: the manage rule shows the email",
    run: async (ctx) => {
      const manager = await subscribed(ctx, ["nologin/*"], usersToken);
      const guest = await subscribed(ctx, ["nologin/*"]);
      const update = response(
        await ctx.api("PATCH", "/api/collections/nologin/records/dc49k6jgejn40h3", {
          name: "renamed",
        }),
      );
      return { update, ...(await all({ manager, guest })) };
    },
    check: (o) => {
      expect(JSON.stringify(o.manager)).toContain("test@example.com");
      expect(JSON.stringify(o.guest)).not.toContain("test@example.com");
    },
  },
  {
    func: "differential",
    name: "an auth record's own update reaches it with the refreshed auth",
    run: async (ctx) => {
      // the rule reads the subscriber's auth record as it is after the update
      await createPosts(ctx, { listRule: "@request.auth.name = 'renamed'" });
      const stream = await subscribed(ctx, ["rt_posts/*", `users/${user1Id}`], usersToken);
      await post(ctx, "rtrefresh000001");
      const update = response(
        await ctx.api(
          "PATCH",
          `/api/collections/users/records/${user1Id}`,
          { name: "renamed" },
          usersToken,
        ),
      );
      await stream.waitFor((e) => e.length >= 2);
      await post(ctx, "rtrefresh000002");
      return { update, events: await settled(stream) };
    },
    check: (o) => expect((o.events as unknown[]).length).toBe(2),
  },
  {
    func: "differential",
    name: "two clients with different auths on one topic",
    run: async (ctx) => {
      await createPosts(ctx, { listRule: "@request.auth.id != ''" });
      const user = await subscribed(ctx, ["rt_posts/*"], usersToken);
      const guest = await subscribed(ctx, ["rt_posts/*"]);
      const superuser = await subscribed(ctx, ["rt_posts/*"], superuserToken);
      await post(ctx, "rtauths00000001", { secret: "s" });
      return all({ user, guest, superuser });
    },
    check: (o) => {
      expect(count(o, "user")).toBe(1);
      expect(count(o, "guest")).toBe(0);
      expect(count(o, "superuser")).toBe(1);
    },
  },
  {
    func: "differential",
    name: "delete: the message carries the record as it was",
    run: async (ctx) => {
      // the rule depends on the record itself: it still holds at the delete
      await createPosts(ctx, { listRule: "title = 'visible'" });
      const stream = await subscribed(
        ctx,
        [topic("rt_posts/*", { query: { expand: "owner" } })],
        superuserToken,
      );
      const guest = await subscribed(ctx, ["rt_posts/*"]);
      await post(ctx, "rtdelete0000001", { title: "visible", owner: user1Id });
      await stream.waitFor((e) => e.length >= 2);
      const del = response(
        await ctx.api("DELETE", "/api/collections/rt_posts/records/rtdelete0000001"),
      );
      return { del, ...(await all({ stream, guest })) };
    },
    check: (o) => {
      expect(count(o, "stream")).toBe(2);
      expect(count(o, "guest")).toBe(2);
    },
  },
  {
    func: "differential",
    name: "a delete that rolls back broadcasts nothing",
    run: async (ctx) => {
      const postsId = await createPosts(ctx);
      await ctx.createCollection({
        name: "rt_children",
        type: "base",
        listRule: "",
        viewRule: "",
        fields: [
          {
            name: "parent",
            type: "relation",
            collectionId: postsId,
            maxSelect: 1,
            required: true,
          },
        ],
      });
      await post(ctx, "rtrollback00001");
      const child = response(
        await ctx.api("POST", "/api/collections/rt_children/records", {
          id: "rtrollbackchild",
          parent: "rtrollback00001",
        }),
      );
      const posts = await subscribed(ctx, ["rt_posts/*"]);
      const children = await subscribed(ctx, ["rt_children/*"]);
      // the required reference fails the delete after the row was deleted
      // inside the transaction
      const del = response(
        await ctx.api("DELETE", "/api/collections/rt_posts/records/rtrollback00001"),
      );
      return { child, del, ...(await all({ posts, children })) };
    },
    check: (o) => {
      expect((o.del as Observation).status).toBe(400);
      expect(count(o, "posts")).toBe(0);
      expect(count(o, "children")).toBe(0);
    },
  },
  {
    func: "differential",
    name: "a cascade delete broadcasts the deleted references",
    run: async (ctx) => {
      const postsId = await createPosts(ctx);
      await ctx.createCollection({
        name: "rt_comments",
        type: "base",
        listRule: "",
        viewRule: "",
        fields: [
          { name: "text", type: "text" },
          {
            name: "post",
            type: "relation",
            collectionId: postsId,
            maxSelect: 1,
            cascadeDelete: true,
          },
        ],
      });
      await post(ctx, "rtcascade000001");
      for (const id of ["rtcascadechild1", "rtcascadechild2"]) {
        await ctx.api("POST", "/api/collections/rt_comments/records", {
          id,
          text: id,
          post: "rtcascade000001",
        });
      }
      const posts = await subscribed(ctx, ["rt_posts/*"]);
      const comments = await subscribed(ctx, ["rt_comments/*"]);
      // the expand of a cascade-deleted record is read inside the delete
      const expanded = await subscribed(ctx, [
        topic("rt_comments/*", { query: { expand: "post" } }),
      ]);
      const del = response(
        await ctx.api("DELETE", "/api/collections/rt_posts/records/rtcascade000001"),
      );
      // upstream sends each dry cached message from its own goroutine: the
      // order of the two cascaded deletes is not defined there
      const observed = await all({ posts, comments, expanded });
      for (const name of ["comments", "expanded"]) {
        observed[name] = (observed[name] as { data: string }[]).toSorted((a, b) =>
          a.data < b.data ? -1 : 1,
        );
      }
      return { del, ...observed };
    },
    check: (o) => {
      expect((o.del as Observation).status).toBe(204);
      expect(count(o, "posts")).toBe(1);
      expect(count(o, "comments")).toBe(2);
    },
  },
  {
    func: "differential",
    name: "view collections get no record events",
    run: async (ctx) => {
      await createPosts(ctx);
      await ctx.createCollection({
        name: "rt_posts_view",
        type: "view",
        listRule: "",
        viewRule: "",
        viewQuery: "SELECT id, title FROM rt_posts",
      });
      const view = await subscribed(ctx, ["rt_posts_view/*", "view2/*"]);
      await post(ctx, "rtview000000001");
      return all({ view });
    },
    check: (o) => expect(count(o, "view")).toBe(0),
  },
  {
    func: "differential",
    name: "invalid options are ignored",
    run: async (ctx) => {
      await createPosts(ctx, { listRule: "@request.query.a = ''" });
      const stream = await subscribed(ctx, [
        "rt_posts/*?options={invalid",
        `rt_posts/*?options=${encodeURIComponent(`{"query":"not an object"}`)}`,
        `rt_posts/*?options=${encodeURIComponent(`{"Query":{"a":"1"}}`)}`,
      ]);
      await post(ctx, "rtinvalid000001");
      return {
        events: (await settled(stream)).toSorted((a, b) =>
          String(a.event) < String(b.event) ? -1 : 1,
        ),
      };
    },
  },
  {
    func: "differential",
    name: "query values of other types are cast to strings",
    run: async (ctx) => {
      await createPosts(ctx, {
        listRule: "@request.query.n = '1.5' && @request.query.b = 'true' && @request.query.z = ''",
      });
      const stream = await subscribed(ctx, [
        topic("rt_posts/*", { query: { n: 1.5, b: true, z: null } }),
      ]);
      await post(ctx, "rtcast000000001");
      return { events: await settled(stream) };
    },
    check: (o) => expect((o.events as unknown[]).length).toBe(1),
  },
  {
    func: "differential",
    name: "subscribe validation: topics count and length in runes",
    run: async (ctx) => {
      const stream = await ctx.open();
      return {
        // 2500 two-byte characters are 2500 runes
        runes: response(await ctx.subscribe(stream.clientId, ["é".repeat(2500)])),
        tooLong: response(await ctx.subscribe(stream.clientId, ["é".repeat(2501)])),
        tooMany: response(
          await ctx.subscribe(
            stream.clientId,
            Array.from({ length: 1001 }, (_, i) => `t${i}`),
          ),
        ),
        longId: response(await ctx.subscribe("a".repeat(256), [])),
        wrongType: response(await ctx.subscribeRaw(`{"clientId":1,"subscriptions":"x"}`)),
        invalidJson: response(await ctx.subscribeRaw(`{"clientId":`)),
      };
    },
  },
  {
    func: "differential",
    name: "a client of another connection is not found after it closed",
    run: async (ctx) => {
      const stream = await ctx.open();
      const id = stream.clientId;
      stream.close();
      let status = 0;
      for (let i = 0; i < 50 && status !== 404; i++) {
        status = (await ctx.subscribe(id, [])).status;
        await Bun.sleep(20);
      }
      return { status, response: response(await ctx.subscribe(id, [])) };
    },
    check: (o) => expect(o.status).toBe(404),
  },
  {
    func: "differential",
    name: "auth record delete: its clients lose the auth, not the subscription",
    run: async (ctx) => {
      await createPosts(ctx);
      const stream = await subscribed(ctx, ["rt_posts/*"], usersToken);
      const del = response(await ctx.api("DELETE", `/api/collections/users/records/${user1Id}`));
      await post(ctx, "rtauthdel000001");
      return {
        del,
        events: await settled(stream),
        guest: response(await ctx.subscribe(stream.clientId, ["rt_posts/*"])),
      };
    },
    check: (o) => expect((o.events as unknown[]).length).toBe(1),
  },
  {
    func: "differential",
    name: "a superuser subscriber gets the hidden fields of auth records",
    run: async (ctx) => {
      const superuser = await subscribed(ctx, ["clients/*"], superuserToken);
      const update = response(
        await ctx.api("PATCH", "/api/collections/clients/records/gk390qegs4y47wn", {
          name: "renamed",
        }),
      );
      return { update, ...(await all({ superuser })) };
    },
  },
  {
    func: "differential",
    name: "a user delete updates the records that reference it",
    run: async (ctx) => {
      // deleting a user removes it from demo1.rel_many (a save inside the
      // delete transaction)
      const demo1 = await subscribed(ctx, ["demo1/*"], superuserToken);
      const del = response(await ctx.api("DELETE", `/api/collections/users/records/${user2Id}`));
      return { del, demo1: events(await demo1.settle()) };
    },
  },
];
