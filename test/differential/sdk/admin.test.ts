// CollectionService, SettingsService, LogService, CronService and SQLService
// of the JavaScript SDK 0.28.1 against both servers. Not part of `bun test`:
// run `bun run test:reference`.

import { generateKeyPairSync } from "node:crypto";

import { describe } from "bun:test";

import { sdkTest } from "@test/differential/sdk/harness";
import { stubLogsData } from "@test/scenarios/logs";

describe("CollectionService", () => {
  sdkTest("getFullList, getList, getOne, getFirstListItem", {}, async (env) => {
    const pb = env.superuser();
    await env.step("getFullList", () => pb.collections.getFullList({ sort: "name" }));
    await env.step("getFullList (batch, fields)", () =>
      pb.collections.getFullList({ batch: 2, sort: "name", fields: "id,name,type" }),
    );
    await env.step("getList", () =>
      pb.collections.getList(1, 3, { sort: "-name", filter: "type = 'base'", fields: "id,name" }),
    );
    await env.step("getList (skipTotal)", () =>
      pb.collections.getList(2, 2, { sort: "name", skipTotal: true, fields: "id,name" }),
    );
    await env.step("getOne (name)", () => pb.collections.getOne("demo1"));
    await env.step("getOne (id)", () => pb.collections.getOne("_pb_users_auth_"));
    await env.step("getFirstListItem", () => pb.collections.getFirstListItem("name = 'demo3'"));
    await env.fails("getOne (missing)", () => pb.collections.getOne("missing"));
    await env.fails("getFullList (guest)", () => env.client().collections.getFullList());
  });

  sdkTest("create, update, delete", {}, async (env) => {
    const pb = env.superuser();
    await env.step("create (base)", () =>
      pb.collections.create({
        name: "sdk_items",
        type: "base",
        listRule: "",
        viewRule: "",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "n", type: "number", min: 0 },
          { name: "tags", type: "select", values: ["a", "b"], maxSelect: 2 },
        ],
        indexes: ["CREATE UNIQUE INDEX `idx_sdk_items_title` ON `sdk_items` (`title`)"],
      }),
    );
    await env.step("create (auth)", () =>
      pb.collections.create({
        name: "sdk_members",
        type: "auth",
        fields: [{ name: "nick", type: "text" }],
        passwordAuth: { enabled: true, identityFields: ["email"] },
      }),
    );
    await env.step("create (view)", () =>
      pb.collections.create({
        name: "sdk_view",
        type: "view",
        listRule: "",
        viewQuery: "select id, title from sdk_items",
      }),
    );
    await env.fails("create (invalid)", () => pb.collections.create({ name: "x y", type: "base" }));
    await env.fails("create (duplicate)", () =>
      pb.collections.create({ name: "sdk_items", type: "base" }),
    );
    await env.step("update", () =>
      pb.collections.update("sdk_items", {
        createRule: "@request.auth.id != ''",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "n", type: "number", min: 0 },
          { name: "tags", type: "select", values: ["a", "b"], maxSelect: 2 },
          { name: "note", type: "editor" },
        ],
      }),
    );
    await env.step("records of the new collection", async () => {
      const rec = await pb
        .collection("sdk_items")
        .create({ id: "sdkitem00000001", title: "one", n: 2, tags: ["a"] });
      return [rec, await pb.collection("sdk_view").getFullList()];
    });
    await env.fails("update (missing)", () => pb.collections.update("missing", { name: "other" }));
    await env.step("delete", () => pb.collections.delete("sdk_view"));
    await env.fails("delete (missing)", () => pb.collections.delete("sdk_view"));
    await env.step("truncate", () => pb.collections.truncate("sdk_items"));
    await env.step("records after truncate", () => pb.collection("sdk_items").getFullList());
    await env.fails("truncate (view)", () => pb.collections.truncate("view2"));
    await env.fails("truncate (missing)", () => pb.collections.truncate("missing"));
  });

  sdkTest("import, getScaffolds, dryRunViewQuery", {}, async (env) => {
    const pb = env.superuser();
    await env.step("getScaffolds", () => pb.collections.getScaffolds());
    await env.step("dryRunViewQuery", () =>
      pb.collections.dryRunViewQuery("select id, text from demo1"),
    );
    await env.fails("dryRunViewQuery (invalid)", () =>
      pb.collections.dryRunViewQuery("select nope from demo1"),
    );
    const current = await env.step("getFullList", () =>
      pb.collections.getFullList({ sort: "name" }),
    );
    const keep = current.filter((c) => !c.system);
    await env.step("import (same)", () => pb.collections.import(keep, false));
    await env.step("import (add)", () =>
      pb.collections.import(
        [
          ...keep,
          {
            id: "sdkimported0001",
            name: "sdk_imported",
            type: "base",
            fields: [{ id: "text12345", name: "label", type: "text" }],
          } as never,
        ],
        false,
      ),
    );
    await env.step("imported", () => pb.collections.getOne("sdk_imported"));
    await env.fails("import (invalid)", () =>
      pb.collections.import([{ name: "", type: "base" } as never]),
    );
    await env.step("import (delete missing)", () =>
      pb.collections.import(
        keep.filter((c) => c.name !== "sdk_imported"),
        true,
      ),
    );
    await env.fails("import (guest)", () => env.client().collections.import([]));
  });
});

describe("SettingsService", () => {
  sdkTest("getAll, update", {}, async (env) => {
    const pb = env.superuser();
    await env.step("getAll", () => pb.settings.getAll());
    await env.step("getAll (fields)", () => pb.settings.getAll({ fields: "meta,logs" }));
    await env.step("update", () =>
      pb.settings.update({
        meta: { appName: "sdk-suite", appURL: "https://sdk.example.com" },
        logs: { maxDays: 3, minLevel: 0, logIP: false },
      }),
    );
    await env.step("getAll after update", () => pb.settings.getAll());
    await env.fails("update (invalid)", () => pb.settings.update({ meta: { appName: "" } }));
    await env.fails("getAll (guest)", () => env.client().settings.getAll());
  });

  sdkTest("testEmail", { smtp: true }, async (env) => {
    const pb = env.superuser();
    for (const template of ["verification", "password-reset", "email-change"]) {
      const since = Date.now();
      await env.step(`testEmail ${template}`, () =>
        pb.settings.testEmail("users", "to@example.com", template),
      );
      await env.mail(`${template} mail`, "to@example.com", since);
    }
    await env.fails("testEmail (invalid template)", () =>
      pb.settings.testEmail("users", "to@example.com", "nope"),
    );
    await env.fails("testEmail (invalid email)", () =>
      pb.settings.testEmail("users", "nope", "verification"),
    );
  });

  sdkTest("testS3", { s3: true }, async (env) => {
    const pb = env.superuser();
    await env.fails("testS3 (disabled)", () => pb.settings.testS3());
    await env.fails("testS3 (backups, disabled)", () => pb.settings.testS3("backups"));
    const s3 = {
      enabled: true,
      endpoint: env.s3.endpoint,
      bucket: env.s3.bucket,
      region: env.s3.region,
      accessKey: env.s3.accessKey,
      secret: env.s3.secret,
      forcePathStyle: true,
    };
    await env.step("update (s3)", () => pb.settings.update({ s3, backups: { s3 } }));
    await env.step("testS3 (storage)", () => pb.settings.testS3("storage"));
    await env.step("testS3 (default)", () => pb.settings.testS3());
    await env.step("testS3 (backups)", () => pb.settings.testS3("backups"));
    await env.fails("testS3 (unknown)", () => pb.settings.testS3("nope"));
    await env.step("update (bad secret)", () =>
      pb.settings.update({ s3: { ...s3, secret: "wrong-secret-value" } }),
    );
    await env.failsStatus("testS3 (bad secret)", () => pb.settings.testS3("storage"));
  });

  sdkTest("generateAppleClientSecret", {}, async (env) => {
    const pb = env.superuser();
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    await env.step("generateAppleClientSecret", () =>
      pb.settings.generateAppleClientSecret(
        "com.example.app",
        "TEAM123456",
        "KEY1234567",
        pem,
        3600,
      ),
    );
    await env.fails("generateAppleClientSecret (bad key)", () =>
      pb.settings.generateAppleClientSecret(
        "com.example.app",
        "TEAM123456",
        "KEY1234567",
        "not a key",
        3600,
      ),
    );
    await env.fails("generateAppleClientSecret (guest)", () =>
      env.client().settings.generateAppleClientSecret("a", "b", "c", pem, 1),
    );
  });
});

describe("LogService, CronService, SQLService", () => {
  sdkTest("logs", { prepare: ({ dataDir }) => stubLogsData(dataDir) }, async (env) => {
    const pb = env.superuser();
    // the two stubbed logs are the only ones older than this; the servers'
    // own request logs are written asynchronously and differ in count
    const old = { filter: 'created < "2023-01-01"' };
    await env.step("getList", () => pb.logs.getList(1, 10, { ...old, sort: "-created" }));
    await env.step("getOne", () => pb.logs.getOne("873f2133-9f38-44fb-bf82-c8f53b310d91"));
    await env.fails("getOne (missing)", () => pb.logs.getOne("missingmissing1"));
    await env.step("getStats", () => pb.logs.getStats(old));
    await env.fails("getList (guest)", () => env.client().logs.getList());
    await env.step("truncate", () => pb.logs.truncate());
    await env.step("getList after truncate", () => pb.logs.getList(1, 10, old));
  });

  sdkTest("crons", {}, async (env) => {
    const pb = env.superuser();
    const list = await env.step("getFullList", () => pb.crons.getFullList());
    env.record("job ids", list.map((j) => j.id).toSorted());
    await env.step("run", () => pb.crons.run("__pbLogsCleanup__"));
    await env.fails("run (missing)", () => pb.crons.run("missing"));
    await env.fails("getFullList (guest)", () => env.client().crons.getFullList());
  });

  sdkTest("sql", {}, async (env) => {
    const pb = env.superuser();
    await env.step("run (select)", () =>
      pb.sql.run("select id, email from _superusers order by id"),
    );
    await env.step("run (empty)", () => pb.sql.run("select id from demo1 where 1 = 0"));
    await env.fails("run (invalid)", () => pb.sql.run("select nope from"));
    await env.fails("run (guest)", () => env.client().sql.run("select 1"));
  });
});
