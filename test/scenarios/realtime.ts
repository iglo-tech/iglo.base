// Upstream: apis/realtime_test.go
//
// Every Go test of the file, as realtime scenarios (test/realtime/scenario.ts):
// the subscription clients upstream registers and inspects in Go are SSE
// streams here, and the Go-side checks of a client's state are made
// through what the client can observe:
//
//   - "the client was removed": POST /api/realtime with its id is 404;
//   - "the client's auth is X / unset": a later subscribe without auth (or
//     with another user's token) is 403 while an auth is set, and 204 once
//     it is unset (guest -> auth upgrades are allowed);
//   - "the subscriptions were replaced": a record change on the old topic
//     no longer reaches the client;
//   - a client's IP set through a trusted proxy header (x-test-ip) becomes
//     the connection's source address (127.0.0.2): iglo.base reads the
//     trusted proxy settings in M5.7, and both servers see the socket
//     address.
//
// Dropped, with the reason:
//
//   - ExpectedEvents and the enrich hook counts (D5: no hooks); the "PB_CONNECT
//     interrupt" and "Skipping/ignoring messages" scenarios keep what is left
//     without their hooks (the connection and its cleanup);
//   - TestRealtimeCustomAuthModelDeleteEvent and
//     TestRealtimeCustomAuthModelUpdateEvent, and the "core.RecordProxy" and
//     "custom model struct" subtests of TestRealtimeRecordResolve: they save
//     Go model structs; iglo.base has no Go models (D5), and the same changes
//     through the records API are the "core.Record" cases.
//
// TestRealtimeAuthRecordDeleteEvent and TestRealtimeAuthRecordUnsetOnCollectionDelete
// trigger OnModelAfterDeleteSuccess by hand "to avoid triggering constraints
// check"; here the record and the collection are deleted through the API
// (the user's references are not required, and the collection is a new
// auth collection).

import { expect } from "bun:test";

import { clientsToken, superuserToken, usersToken } from "@test/scenarios/record-crud";
import {
  actions,
  events,
  type Observation,
  type RealtimeScenario,
  response,
  type ScenarioContext,
  settled,
} from "@test/realtime/scenario";
import type { RealtimeStream } from "@test/realtime/client";

// the fixture's users: test@example.com and test2@example.com
const user1Id = "4q1xlclmfloku33";
const user2Id = "oap640cot4yru2s";
const password = "1234567890";

// a public base collection the "old subscription" checks broadcast through
const publicCollection = "demo2";

// waits until the client was unregistered after its stream closed
async function removedAfterClose(ctx: ScenarioContext, stream: RealtimeStream): Promise<number> {
  const clientId = stream.clientId;
  stream.close();
  let status = 0;
  for (let i = 0; i < 50; i++) {
    status = (await ctx.subscribe(clientId, [])).status;
    if (status === 404) {
      break;
    }
    await Bun.sleep(20);
  }
  return status;
}

// a record created in the public collection, and whether the stream got it
async function receivesPublicCreate(
  ctx: ScenarioContext,
  stream: RealtimeStream,
): Promise<boolean> {
  const res = await ctx.api("POST", `/api/collections/${publicCollection}/records`, {
    title: "realtime",
  });
  if (res.status !== 200) {
    throw new Error(`create: ${res.status} ${res.body}`);
  }
  return (await settled(stream)).length > 0;
}

// connects, subscribes to the public collection (the "old" subscription),
// then sends the scenario's subscribe request
async function replaceSubscriptions(
  ctx: ScenarioContext,
  body: (clientId: string) => string,
  token?: string,
): Promise<Observation> {
  const stream = await ctx.open();
  const first = await ctx.subscribe(stream.clientId, [`${publicCollection}/*`]);
  const res = await ctx.subscribeRaw(body(stream.clientId), token);
  return {
    first: first.status,
    response: response(res),
    oldSubscriptionReceives: await receivesPublicCreate(ctx, stream),
  };
}

function numberedTopics(n: number): string {
  return Array.from({ length: n }, (_, i) => `"${i}"`).join(",");
}

// connect: the stream's head and first event, and the cleanup after close
async function connect(ctx: ScenarioContext, localAddress = "127.0.0.1"): Promise<Observation> {
  const stream = await ctx.open({ localAddress });
  const clientId = stream.clientId;
  return {
    status: stream.status,
    contentType: stream.headers.get("content-type"),
    cacheControl: stream.headers.get("cache-control"),
    accelBuffering: stream.headers.get("x-accel-buffering"),
    first: stream.events[0],
    // the client's IP is the connection's (RealtimeClientIPKey)
    sameIP: (await ctx.subscribe(clientId, [], undefined, localAddress)).status,
    otherIP: (
      await ctx.subscribe(
        clientId,
        [],
        undefined,
        localAddress === "127.0.0.1" ? "127.0.0.2" : "127.0.0.1",
      )
    ).status,
    afterClose: await removedAfterClose(ctx, stream),
  };
}

function checkConnect(o: Observation): void {
  expect(o.status).toBe(200);
  expect(o.contentType).toBe("text/event-stream");
  const first = o.first as { id: string; event: string; data: string };
  expect(first.event).toBe("PB_CONNECT");
  expect(first.data).toBe(`{"clientId":"${first.id}"}`);
  expect(first.id).toMatch(/^[A-Za-z0-9]{40}$/);
  expect(o.sameIP).toBe(204);
  expect(o.otherIP).toBe(400);
  // Expected the subscribers to be removed after connection close
  expect(o.afterClose).toBe(404);
}

// whether the client's auth is unset: a guest subscribe is allowed only then
async function authUnset(ctx: ScenarioContext, stream: RealtimeStream): Promise<boolean> {
  const res = await ctx.subscribe(stream.clientId, []);
  if (res.status !== 204 && res.status !== 403) {
    throw new Error(`unexpected subscribe status ${res.status}`);
  }
  return res.status === 204;
}

// a stream whose client is authenticated with token
async function authenticated(ctx: ScenarioContext, token: string): Promise<RealtimeStream> {
  const stream = await ctx.open();
  const res = await ctx.subscribe(stream.clientId, [], token);
  if (res.status !== 204) {
    throw new Error(`subscribe: ${res.status} ${res.body}`);
  }
  return stream;
}

export const realtimeScenarios: RealtimeScenario[] = [
  // ---------------------------------------------------------------
  // TestRealtimeConnect
  {
    func: "TestRealtimeConnect",
    name: "GET:/api/realtime",
    // Headers: {"x-test-ip": "127.0.0.2"} with x-test-ip as trusted proxy header
    run: (ctx) => connect(ctx, "127.0.0.2"),
    check: checkConnect,
  },
  {
    func: "TestRealtimeConnect",
    name: "PB_CONNECT interrupt",
    run: (ctx) => connect(ctx),
    check: checkConnect,
  },
  {
    func: "TestRealtimeConnect",
    name: "Skipping/ignoring messages",
    run: (ctx) => connect(ctx),
    check: checkConnect,
  },

  // ---------------------------------------------------------------
  // TestRealtimeSubscribe
  {
    func: "TestRealtimeSubscribe",
    name: "missing client",
    run: async (ctx) =>
      response(await ctx.subscribeRaw(`{"clientId":"missing","subscriptions":["test1", "test2"]}`)),
    check: (o) => {
      expect(o.status).toBe(404);
      expect((o.body as { data: unknown }).data).toEqual({});
    },
  },
  {
    func: "TestRealtimeSubscribe",
    name: "empty data",
    run: async (ctx) => response(await ctx.subscribeRaw(`{}`)),
    check: (o) => {
      expect(o.status).toBe(400);
      const data = (o.body as { data: { [key: string]: { code: string } } }).data;
      expect(data.clientId?.code).toBe("validation_required");
      expect(data).not.toHaveProperty("subscriptions");
    },
  },
  {
    func: "TestRealtimeSubscribe",
    name: "existing client with invalid subscriptions limit",
    run: async (ctx) => {
      const stream = await ctx.open();
      return response(
        await ctx.subscribeRaw(
          `{"clientId": "${stream.clientId}", "subscriptions": [${numberedTopics(1001)}]}`,
        ),
      );
    },
    check: (o) => {
      expect(o.status).toBe(400);
      const data = (o.body as { data: { [key: string]: { code: string } } }).data;
      expect(data.subscriptions?.code).toBe("validation_length_too_long");
    },
  },
  {
    func: "TestRealtimeSubscribe",
    name: "existing client with valid subscriptions limit",
    run: (ctx) =>
      replaceSubscriptions(
        ctx,
        (id) => `{"clientId": "${id}", "subscriptions": [${numberedTopics(1000)}]}`,
      ),
    check: (o) => {
      expect((o.response as Observation).status).toBe(204);
      // Expected old subscriptions to be replaced
      expect(o.oldSubscriptionReceives).toBe(false);
    },
  },
  {
    func: "TestRealtimeSubscribe",
    name: "existing client with invalid topic length",
    run: async (ctx) => {
      const stream = await ctx.open();
      return response(
        await ctx.subscribeRaw(
          `{"clientId": "${stream.clientId}", "subscriptions": ["abc", "${"a".repeat(2501)}"]}`,
        ),
      );
    },
    check: (o) => {
      expect(o.status).toBe(400);
      const data = (o.body as { data: { subscriptions: { [key: string]: { code: string } } } })
        .data;
      expect(data.subscriptions["1"]?.code).toBe("validation_length_too_long");
    },
  },
  {
    func: "TestRealtimeSubscribe",
    name: "existing client with different IP",
    run: async (ctx) => {
      // the client connected from 127.0.0.1; the request comes from 127.0.0.2
      const stream = await ctx.open();
      return response(await ctx.subscribe(stream.clientId, ["test"], undefined, "127.0.0.2"));
    },
    check: (o) => {
      expect(o.status).toBe(400);
      expect((o.body as { data: unknown }).data).toEqual({});
    },
  },
  {
    func: "TestRealtimeSubscribe",
    name: "existing client with valid topic length",
    run: (ctx) =>
      replaceSubscriptions(
        ctx,
        (id) => `{"clientId": "${id}", "subscriptions": ["abc", "${"a".repeat(2500)}"]}`,
      ),
    check: (o) => {
      expect((o.response as Observation).status).toBe(204);
      expect(o.oldSubscriptionReceives).toBe(false);
    },
  },
  {
    func: "TestRealtimeSubscribe",
    name: "existing client - empty subscriptions",
    run: (ctx) => replaceSubscriptions(ctx, (id) => `{"clientId":"${id}","subscriptions":[]}`),
    check: (o) => {
      expect((o.response as Observation).status).toBe(204);
      // Expected no subscriptions
      expect(o.oldSubscriptionReceives).toBe(false);
    },
  },
  {
    func: "TestRealtimeSubscribe",
    name: "existing client - 2 new subscriptions",
    run: (ctx) =>
      replaceSubscriptions(ctx, (id) => `{"clientId":"${id}","subscriptions":["test1", "test2"]}`),
    check: (o) => {
      expect((o.response as Observation).status).toBe(204);
      expect(o.oldSubscriptionReceives).toBe(false);
    },
  },
  {
    func: "TestRealtimeSubscribe",
    name: "existing client - guest -> authorized superuser",
    run: async (ctx) => {
      const stream = await ctx.open();
      const res = await ctx.subscribe(stream.clientId, ["test1", "test2"], superuserToken);
      return {
        response: response(res),
        // the client auth is the superuser: a regular user's token no longer matches
        asUser: (await ctx.subscribe(stream.clientId, [], usersToken)).status,
        asSuperuser: (await ctx.subscribe(stream.clientId, [], superuserToken)).status,
      };
    },
    check: (o) => {
      expect((o.response as Observation).status).toBe(204);
      expect(o.asUser).toBe(403);
      expect(o.asSuperuser).toBe(204);
    },
  },
  {
    func: "TestRealtimeSubscribe",
    name: "existing client - guest -> authorized regular auth record",
    run: async (ctx) => {
      const stream = await ctx.open();
      const res = await ctx.subscribe(stream.clientId, ["test1", "test2"], usersToken);
      return {
        response: response(res),
        asGuest: (await ctx.subscribe(stream.clientId, [])).status,
        asUser: (await ctx.subscribe(stream.clientId, [], usersToken)).status,
      };
    },
    check: (o) => {
      expect((o.response as Observation).status).toBe(204);
      expect(o.asGuest).toBe(403);
      expect(o.asUser).toBe(204);
    },
  },
  {
    func: "TestRealtimeSubscribe",
    name: "existing client - same auth",
    run: async (ctx) => {
      // the same user as the auth token
      const stream = await authenticated(ctx, usersToken);
      const res = await ctx.subscribe(stream.clientId, ["test1", "test2"], usersToken);
      return {
        response: response(res),
        // Expected auth record model
        authUnset: await authUnset(ctx, stream),
      };
    },
    check: (o) => {
      expect((o.response as Observation).status).toBe(204);
      expect(o.authUnset).toBe(false);
    },
  },
  {
    func: "TestRealtimeSubscribe",
    name: "existing client - mismatched auth",
    run: async (ctx) => {
      const stream = await authenticated(ctx, await ctx.impersonate("users", user2Id));
      const res = await ctx.subscribe(stream.clientId, ["test1", "test2"], usersToken);
      return { response: response(res), authUnset: await authUnset(ctx, stream) };
    },
    check: (o) => {
      expect((o.response as Observation).status).toBe(403);
      expect(((o.response as Observation).body as { data: unknown }).data).toEqual({});
      expect(o.authUnset).toBe(false);
    },
  },
  {
    func: "TestRealtimeSubscribe",
    name: "existing client - unauthorized client",
    run: async (ctx) => {
      const stream = await authenticated(ctx, await ctx.impersonate("users", user2Id));
      const res = await ctx.subscribe(stream.clientId, ["test1", "test2"]);
      return { response: response(res), authUnset: await authUnset(ctx, stream) };
    },
    check: (o) => {
      expect((o.response as Observation).status).toBe(403);
      expect(((o.response as Observation).body as { data: unknown }).data).toEqual({});
      expect(o.authUnset).toBe(false);
    },
  },

  // ---------------------------------------------------------------
  {
    func: "TestRealtimeAuthRecordDeleteEvent",
    name: "TestRealtimeAuthRecordDeleteEvent",
    run: async (ctx) => {
      const client1 = await authenticated(ctx, usersToken);
      const client2 = await authenticated(ctx, usersToken);
      const client3 = await authenticated(ctx, await ctx.impersonate("users", user2Id));

      const res = await ctx.api("DELETE", `/api/collections/users/records/${user1Id}`);

      return {
        delete: res.status,
        // the clients stay registered (a guest subscribe is not 404)
        client1Unset: await authUnset(ctx, client1),
        client2Unset: await authUnset(ctx, client2),
        client3Unset: await authUnset(ctx, client3),
      };
    },
    check: (o) => {
      expect(o.delete).toBe(204);
      expect(o.client1Unset).toBe(true);
      expect(o.client2Unset).toBe(true);
      // Expected the auth state to be left unchanged
      expect(o.client3Unset).toBe(false);
    },
  },
  {
    func: "TestRealtimeAuthRecordUpdateEvent",
    name: "TestRealtimeAuthRecordUpdateEvent",
    run: async (ctx) => {
      // a collection only the client's refreshed auth (its new name) may list
      await ctx.createCollection({
        name: "rt_by_name",
        type: "base",
        listRule: "@request.auth.name = 'test_new_name'",
        fields: [{ name: "title", type: "text" }],
      });
      const stream = await authenticated(ctx, usersToken);
      await ctx.subscribe(stream.clientId, ["rt_by_name/*"], usersToken);

      await ctx.api("POST", "/api/collections/rt_by_name/records", {
        id: "rtbyname0000001",
        title: "before",
      });
      const before = await settled(stream);

      const update = await ctx.api("PATCH", `/api/collections/users/records/${user1Id}`, {
        name: "test_new_name",
      });

      await ctx.api("POST", "/api/collections/rt_by_name/records", {
        id: "rtbyname0000002",
        title: "after",
      });
      const after = await settled(stream);

      return { update: update.status, before, after };
    },
    check: (o) => {
      expect(o.update).toBe(200);
      expect(o.before).toEqual([]);
      expect((o.after as unknown[]).length).toBe(1);
    },
  },
  {
    func: "TestRealtimeRecordHiddenFields",
    name: "TestRealtimeRecordHiddenFields",
    run: async (ctx) => {
      // create temp collection with hidden fields
      await ctx.createCollection({
        name: "test_realtime",
        type: "base",
        listRule: "@request.auth.id != ''",
        fields: [
          { name: "public", type: "text" },
          { name: "hidden", type: "text", hidden: true },
        ],
      });
      const testSubscription = "test_realtime/*";

      // register guest subscriber
      const guest = await ctx.open();
      await ctx.subscribe(guest.clientId, [testSubscription]);

      // register regular user subscriber
      const regular = await ctx.open();
      await ctx.subscribe(regular.clientId, [testSubscription], usersToken);

      // register superuser subscriber
      const superuser = await ctx.open();
      await ctx.subscribe(superuser.clientId, [testSubscription], superuserToken);

      // broadcast create message
      const res = await ctx.api("POST", "/api/collections/test_realtime/records", {
        id: "rthidden0000001",
        public: "test1",
        hidden: "test2",
      });

      return {
        create: res.status,
        guest: await settled(guest),
        regular: await settled(regular),
        superuser: await settled(superuser),
      };
    },
    check: (o) => {
      expect(o.create).toBe(200);
      expect(o.guest).toEqual([]);
      const regular = (o.regular as { data: string }[])[0]?.data ?? "";
      const superuser = (o.superuser as { data: string }[])[0]?.data ?? "";
      // regular message public field should exist, hidden field should NOT exist
      expect(regular).toContain(`"public":`);
      expect(regular).not.toContain(`"hidden":`);
      // superuser message public field should exist, hidden field should exist
      expect(superuser).toContain(`"public":`);
      expect(superuser).toContain(`"hidden":`);
    },
  },
  {
    func: "TestRealtimeAuthRecordUnsetOnTokenKeyRefresh",
    name: "TestRealtimeAuthRecordUnsetOnTokenKeyRefresh",
    run: async (ctx) => {
      const stream = await authenticated(ctx, usersToken);
      // a password change refreshes the tokenKey
      const update = await ctx.api("PATCH", `/api/collections/users/records/${user1Id}`, {
        password: "1234567891",
        passwordConfirm: "1234567891",
      });
      return { update: update.status, authUnset: await authUnset(ctx, stream) };
    },
    check: (o) => {
      expect(o.update).toBe(200);
      // Expected authRecord to be unset
      expect(o.authUnset).toBe(true);
    },
  },
  {
    func: "TestRealtimeAuthRecordUnsetOnCollectionSecretChange",
    name: "TestRealtimeAuthRecordUnsetOnCollectionSecretChange",
    run: async (ctx) => {
      const client1 = await authenticated(ctx, usersToken);
      const client2 = await authenticated(ctx, usersToken);
      const client3 = await authenticated(ctx, clientsToken);

      // change the secret of the users collection (should trigger unset)
      const users = await ctx.api("PATCH", "/api/collections/users", {
        authToken: { secret: "a".repeat(30) },
      });

      // change something else of the clients collection (shouldn't trigger unset)
      const clients = await ctx.api("PATCH", "/api/collections/clients", { listRule: null });

      return {
        users: users.status,
        clients: clients.status,
        client1Unset: await authUnset(ctx, client1),
        client2Unset: await authUnset(ctx, client2),
        client3Unset: await authUnset(ctx, client3),
      };
    },
    check: (o) => {
      expect(o.users).toBe(200);
      expect(o.clients).toBe(200);
      expect(o.client1Unset).toBe(true);
      expect(o.client2Unset).toBe(true);
      expect(o.client3Unset).toBe(false);
    },
  },
  {
    func: "TestRealtimeAuthRecordUnsetOnCollectionDelete",
    name: "TestRealtimeAuthRecordUnsetOnCollectionDelete",
    run: async (ctx) => {
      await ctx.createCollection({ name: "rt_members", type: "auth" });
      const created = await ctx.api("POST", "/api/collections/rt_members/records", {
        email: "member@example.com",
        password,
        passwordConfirm: password,
      });
      if (created.status !== 200) {
        throw new Error(`create member: ${created.status} ${created.body}`);
      }
      const memberToken = await ctx.authToken("rt_members", "member@example.com", password);

      const client1 = await authenticated(ctx, memberToken);
      const client2 = await authenticated(ctx, memberToken);
      const client3 = await authenticated(ctx, clientsToken);

      const res = await ctx.api("DELETE", "/api/collections/rt_members");

      return {
        delete: res.status,
        client1Unset: await authUnset(ctx, client1),
        client2Unset: await authUnset(ctx, client2),
        client3Unset: await authUnset(ctx, client3),
      };
    },
    check: (o) => {
      expect(o.delete).toBe(204);
      expect(o.client1Unset).toBe(true);
      expect(o.client2Unset).toBe(true);
      expect(o.client3Unset).toBe(false);
    },
  },
  {
    func: "TestRealtimeRecordResolve",
    name: "core.Record",
    run: async (ctx) => {
      const testCollectionName = "realtime_test_collection";
      const testRecordId = "rtresolve000001";

      // create new test collection with public read access
      await ctx.createCollection({
        name: testCollectionName,
        type: "base",
        listRule: "",
        viewRule: "",
        fields: [{ name: "created", type: "autodate", onCreate: true, onUpdate: true }],
      });

      const client0 = await ctx.open();
      await ctx.subscribe(client0.clientId, [`${testCollectionName}/*`]);
      client0.close(); // discarded
      const client1 = await ctx.open();
      await ctx.subscribe(client1.clientId, [`${testCollectionName}/*`]);
      const client2 = await ctx.open();
      await ctx.subscribe(client2.clientId, [`${testCollectionName}/${testRecordId}`]);
      const client3 = await ctx.open();
      await ctx.subscribe(client3.clientId, ["demo1/*"]);

      const target = `/api/collections/${testCollectionName}/records`;
      const create = await ctx.api("POST", target, { id: testRecordId });
      await client2.waitFor((e) => e.length >= 2);
      const update = await ctx.api("PATCH", `${target}/${testRecordId}`, {});
      await client2.waitFor((e) => e.length >= 3);
      const del = await ctx.api("DELETE", `${target}/${testRecordId}`);

      return {
        statuses: [create.status, update.status, del.status],
        client0: events(client0.events),
        client1: await settled(client1),
        client2: await settled(client2),
        client3: await settled(client3),
      };
    },
    check: (o) => {
      expect(o.statuses).toEqual([200, 200, 204]);
      expect(o.client0).toEqual([]);
      expect(actions(o.client1)).toEqual([
        "realtime_test_collection/* create rtresolve000001",
        "realtime_test_collection/* update rtresolve000001",
        "realtime_test_collection/* delete rtresolve000001",
      ]);
      expect(actions(o.client2)).toEqual([
        "realtime_test_collection/rtresolve000001 create rtresolve000001",
        "realtime_test_collection/rtresolve000001 update rtresolve000001",
        "realtime_test_collection/rtresolve000001 delete rtresolve000001",
      ]);
      expect(o.client3).toEqual([]);
    },
  },
];
