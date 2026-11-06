// RecordService CRUD and list helpers, HealthService, `pb.send`, `pb.filter`
// and auto-cancellation of the JavaScript SDK 0.28.1 against both servers.
// Not part of `bun test`: run `bun run test:reference`.

import { describe, expect } from "bun:test";

import { sdkTest } from "@test/differential/sdk/harness";

describe("HealthService", () => {
  sdkTest("check", {}, async (env) => {
    const pb = env.client();
    await env.step("health.check", () => pb.health.check());
    await env.step("health.check (fields)", () => pb.health.check({ fields: "code" }));
  });
});

describe("RecordService CRUD", () => {
  sdkTest("getList, getFullList, getFirstListItem, getOne", {}, async (env) => {
    const pb = env.superuser();
    const demo = pb.collection("demo1");
    await env.step("getList", () => demo.getList(1, 2, { sort: "created", expand: "rel_one" }));
    await env.step("getList (skipTotal)", () =>
      demo.getList(1, 2, { skipTotal: true, sort: "id" }),
    );
    await env.step("getList (filter, fields)", () =>
      demo.getList(1, 30, {
        filter: pb.filter("text ~ {:t} && bool = {:b}", { t: "test", b: true }),
        fields: "id,text,bool",
        sort: "-id",
      }),
    );
    await env.step("getFullList", () => demo.getFullList({ sort: "id", batch: 1 }));
    await env.step("getFullList (batch number)", () => demo.getFullList(2, { sort: "id" }));
    await env.step("getFirstListItem", () => demo.getFirstListItem('text != ""', { sort: "id" }));
    await env.fails("getFirstListItem (none)", () => demo.getFirstListItem('text = "nope-nope"'));
    await env.step("getOne", () => demo.getOne("84nmscqy84lsi1t", { expand: "rel_one,rel_many" }));
    await env.fails("getOne (missing)", () => demo.getOne("missingmissing1"));
    await env.fails("getList (bad filter)", () => demo.getList(1, 1, { filter: "nope = 1" }));
    await env.step("getList (view)", () => pb.collection("view2").getList(1, 5, { sort: "id" }));
  });

  sdkTest("query options: expand, fields, sort, filter", {}, async (env) => {
    const pb = env.superuser();
    const demo1 = pb.collection("demo1");
    await env.step("expand (nested)", () =>
      demo1.getFullList({ sort: "id", expand: "rel_one,rel_many.rel_one" }),
    );
    await env.step("expand (back-relation)", () =>
      pb.collection("demo4").getList(1, 5, { sort: "id", expand: "rel_one_cascade,self_rel_many" }),
    );
    await env.step("fields modifiers", () =>
      demo1.getList(1, 3, {
        sort: "id",
        fields: "id,text:excerpt(5,true),expand.rel_one.id",
        expand: "rel_one",
      }),
    );
    await env.step("sort (multiple, random)", () =>
      demo1.getList(1, 10, { sort: "-bool,text,@random", fields: "id" }).then((r) => r.totalItems),
    );
    await env.step("sort (@rowid)", () => demo1.getFullList({ sort: "-@rowid", fields: "id" }));
    await env.step("filter (macros, ?=)", () =>
      demo1.getFullList({
        sort: "id",
        fields: "id",
        filter: "created > @yesterday && select_many ?= 'optionB' || @request.auth.id != ''",
      }),
    );
    await env.step("filter (bound params)", () =>
      demo1.getFullList({
        sort: "id",
        fields: "id",
        filter: pb.filter("number > {:n} && datetime < {:d} && id != {:id}", {
          n: -1,
          d: new Date("2100-01-01T00:00:00Z"),
          id: "x'y",
        }),
      }),
    );
    await env.step("auth collection list (superuser)", () =>
      pb.collection("users").getList(1, 5, { sort: "id" }),
    );
    await env.step("auth collection list (guest, skipTotal)", () =>
      env.client().collection("nologin").getList(1, 5, { sort: "id", skipTotal: true }),
    );
    await env.fails("filter (invalid field)", () => demo1.getList(1, 1, { filter: "nope > 1" }));
    await env.fails("sort (invalid field)", () => demo1.getList(1, 1, { sort: "nope" }));
    await env.step("page (zero)", () => demo1.getList(0, 0, { fields: "page,perPage,totalItems" }));
  });

  sdkTest("create, update, delete, upsert-free flows", {}, async (env) => {
    const pb = env.superuser();
    const demo = pb.collection("demo2");
    const created = await env.step("create", () =>
      demo.create({ id: "sdkrecord000001", active: true, title: "created" }),
    );
    expect(created.id).toBe("sdkrecord000001");
    await env.step("create (generated id)", () => demo.create({ title: "generated" }));
    await env.fails("create (duplicate id)", () =>
      demo.create({ id: "sdkrecord000001", title: "again" }),
    );
    await env.step("update", () =>
      demo.update("sdkrecord000001", { title: "updated" }, { fields: "id,title" }),
    );
    await env.step("getOne after update", () => demo.getOne("sdkrecord000001"));
    await env.fails("update (missing)", () => demo.update("missingmissing1", { title: "x" }));
    await env.step("delete", () => demo.delete("sdkrecord000001"));
    await env.fails("delete (missing)", () => demo.delete("sdkrecord000001"));
    await env.fails("getOne (deleted)", () => demo.getOne("sdkrecord000001"));
  });

  sdkTest("file upload through create and update", {}, async (env) => {
    const pb = env.as((await import("@test/differential/sdk/harness")).usersToken, {
      id: "4q1xlclmfloku33",
      collectionName: "users",
    });
    const demo = pb.collection("demo3");
    void demo;
    const su = env.superuser();
    const rec = await env.step("create with files", () =>
      su.collection("demo3").create({
        title: "with files",
        files: [
          new File(["hello"], "hello.txt", { type: "text/plain" }),
          new File(["world"], "world.txt", { type: "text/plain" }),
        ],
      }),
    );
    await env.step("update (append file)", () =>
      su
        .collection("demo3")
        .update(rec.id, { "files+": [new File(["x"], "extra.txt", { type: "text/plain" })] }),
    );
    await env.step("update (remove file)", () =>
      su.collection("demo3").update(rec.id, { "files-": [(rec["files"] as string[])[0]] }),
    );
  });

  sdkTest("values: unicode, json, geoPoint, dates, URL-encoded ids", {}, async (env) => {
    const pb = env.superuser();
    const demo = pb.collection("demo1");
    const created = await env.step("create", () =>
      demo.create({
        id: "sdkvalues000001",
        text: 'zażółć gęślą jaźń 🚀 \u0000-free "quotes" <tag> &amp;',
        url: "https://example.com/a?b=c&d=é",
        email: "values@example.com",
        number: 12345.678,
        bool: true,
        datetime: "2030-02-03 04:05:06.789Z",
        select_many: ["optionA", "optionC"],
        json: { b: 1, a: [1, 2, { "10": "x", "2": "y" }], big: 1234567890123456 },
        point: { lon: 12.5, lat: -45.25 },
      }),
    );
    expect(created.id).toBe("sdkvalues000001");
    await env.step("getOne", () => demo.getOne("sdkvalues000001"));
    await env.step("filter (unicode, escaped quote)", () =>
      demo.getFullList({ filter: pb.filter("text ~ {:t}", { t: "gęślą" }), fields: "id" }),
    );
    await env.step("update (modifiers)", () =>
      demo.update("sdkvalues000001", {
        "number+": 1,
        "select_many+": "optionB",
        "select_many-": "optionA",
      }),
    );
    await env.fails("getOne (special characters in the id)", () => demo.getOne("a/b?c=d#e f"));
    await env.fails("getOne (encoded slash)", () => demo.getOne("..%2f.."));
    await env.fails("create (wrong types)", () =>
      demo.create({ number: "abc", bool: "maybe", email: "x", datetime: "nope" }),
    );
  });

  sdkTest("rules and errors as a guest and as a user", {}, async (env) => {
    const guest = env.client();
    await env.fails("guest list demo1", () => guest.collection("demo1").getList());
    await env.step("guest list demo2", () =>
      guest.collection("demo2").getList(1, 3, { sort: "id" }),
    );
    await env.fails("guest view users", () => guest.collection("users").getOne("4q1xlclmfloku33"));
    await env.fails("guest create invalid", () =>
      guest.collection("users").create({ email: "bad", password: "1", passwordConfirm: "2" }),
    );
    await env.fails("unknown collection", () => guest.collection("nope").getList());
  });
});

describe("Client", () => {
  sdkTest("send, filter, buildURL, autoCancellation", {}, async (env) => {
    const pb = env.superuser();
    await env.step("send GET", () =>
      pb.send("/api/health", { method: "GET", query: { fields: "code" } }),
    );
    await env.step("send POST", () =>
      pb.send("/api/collections/demo2/records", {
        method: "POST",
        body: { title: "from send" },
        fields: "title",
      } as never),
    );
    await env.fails("send 404", () => pb.send("/api/nope", {}));
    env.record("filter", {
      a: pb.filter("a = {:a} && b = {:b} && c = {:c} && d = {:d} && e = {:e}", {
        a: "it's",
        b: 12,
        c: true,
        d: null,
        e: new Date("2024-01-02T03:04:05.678Z"),
      }),
      object: pb.filter("x = {:o}", { o: { k: "v'w" } }),
      missing: pb.filter("x = {:none}", {}),
    });
    env.record("urls", {
      build: pb.buildURL("/api/x?y=1").replace(env.url, ""),
      file: pb.files
        .getURL({ id: "rid", collectionId: "cid", collectionName: "cn" }, "a b.png", {
          thumb: "100x100",
        })
        .replace(env.url, ""),
    });

    // auto-cancellation: the first of two identical concurrent requests aborts
    await env.step("autocancel", async () => {
      const first = pb
        .collection("demo2")
        .getList(1, 1)
        .catch((e: unknown) => e);
      const second = pb
        .collection("demo2")
        .getList(1, 1)
        .catch((e: unknown) => e);
      return { first: await first, second: Object.keys((await second) as object) };
    });
    pb.autoCancellation(false);
    await env.step("no autocancel", async () => {
      const [a, b] = await Promise.all([
        pb.collection("demo2").getList(1, 1),
        pb.collection("demo2").getList(1, 1),
      ]);
      return [a.totalItems, b.totalItems];
    });
  });
});
