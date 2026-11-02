// BatchService of the JavaScript SDK 0.28.1 against both servers. Not part
// of `bun test`: run `bun run test:reference`.

import { describe, expect } from "bun:test";

import { sdkTest } from "@test/differential/sdk/harness";

describe("BatchService", () => {
  sdkTest("create, update, upsert, delete in one transaction", {}, async (env) => {
    const pb = env.superuser();
    await env.fails("send (disabled)", async () => {
      const batch = pb.createBatch();
      batch.collection("demo2").create({ title: "x" });
      return batch.send();
    });
    await env.step("settings.update (batch)", () =>
      pb.settings.update({ batch: { enabled: true, maxRequests: 10, timeout: 3, maxBodySize: 0 } }),
    );
    await env.step("seed", () =>
      pb.collection("demo2").create({ id: "sdkbatch0000001", title: "seed" }),
    );

    const results = await env.step("send", async () => {
      const batch = pb.createBatch();
      batch.collection("demo2").create({ id: "sdkbatch0000002", title: "created" });
      batch
        .collection("demo2")
        .update("sdkbatch0000001", { title: "updated" }, { fields: "id,title" });
      batch.collection("demo2").upsert({ id: "sdkbatch0000003", title: "upserted" });
      batch.collection("demo2").upsert({ id: "sdkbatch0000003", title: "upserted twice" });
      batch.collection("demo2").delete("sdkbatch0000002");
      return batch.send();
    });
    expect(results.length).toBe(5);
    await env.step("after", () =>
      pb.collection("demo2").getFullList({ filter: "id ~ 'sdkbatch'", sort: "id" }),
    );

    await env.fails("send (one fails: rolled back)", async () => {
      const batch = pb.createBatch();
      batch.collection("demo2").create({ id: "sdkbatch0000004", title: "will roll back" });
      batch.collection("demo1").create({ id: "!!", text: "x" });
      return batch.send();
    });
    await env.step("after the failed batch", () =>
      pb.collection("demo2").getFullList({ filter: "id ~ 'sdkbatch'", sort: "id", fields: "id" }),
    );
    await env.fails("send (empty)", () => pb.createBatch().send());
    await env.fails("send (too many)", async () => {
      const batch = pb.createBatch();
      for (let i = 0; i < 11; i++) {
        batch.collection("demo2").create({ title: `n${i}` });
      }
      return batch.send();
    });
  });

  sdkTest("files in a batch, rules and auth", {}, async (env) => {
    const pb = env.superuser();
    await env.step("settings.update (batch)", () =>
      pb.settings.update({ batch: { enabled: true, maxRequests: 20, timeout: 3, maxBodySize: 0 } }),
    );
    const results = await env.step("send (files)", async () => {
      const batch = pb.createBatch();
      batch.collection("demo3").create({
        id: "sdkbatchfile001",
        title: "with file",
        files: [new File(["batch file"], "batch.txt", { type: "text/plain" })],
      });
      batch
        .collection("demo3")
        .update("sdkbatchfile001", {
          "files+": [new File(["more"], "more.txt", { type: "text/plain" })],
        });
      return batch.send();
    });
    expect(results.length).toBe(2);
    const guest = env.client();
    await env.fails("send (guest, denied by the rule)", async () => {
      const batch = guest.createBatch();
      batch.collection("demo3").create({ title: "denied" });
      return batch.send();
    });
    await env.step("send (guest, public rule)", async () => {
      const batch = guest.createBatch();
      batch.collection("demo2").create({ title: "public" });
      return batch.send();
    });
  });
});
