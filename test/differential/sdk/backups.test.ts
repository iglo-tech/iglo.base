// BackupService of the JavaScript SDK 0.28.1 against both servers: create,
// upload, list, download URL, delete, restore, on the local file system and
// on the S3 test server. A zip's size and modification time differ per
// server, so lists are compared by key. Not part of `bun test`: run
// `bun run test:reference`.

import { describe, expect } from "bun:test";

import { sdkTest, type SdkEnv } from "@test/differential/sdk/harness";

const keys = (list: { key: string }[]): string[] => list.map((b) => b.key).toSorted();

async function download(env: SdkEnv, label: string, url: string): Promise<void> {
  const res = await fetch(url);
  const head = new Uint8Array(await res.arrayBuffer()).slice(0, 2);
  env.record(label, { status: res.status, type: res.headers.get("content-type"), zip: [...head] });
}

describe("BackupService", () => {
  sdkTest("create, getFullList, getDownloadURL, upload, delete", {}, async (env) => {
    const pb = env.superuser();
    await env.derived("getFullList (empty)", () => pb.backups.getFullList(), keys);
    await env.step("create", () => pb.backups.create("sdk.zip"));
    await env.fails("create (duplicate)", () => pb.backups.create("sdk.zip"));
    await env.fails("create (invalid name)", () => pb.backups.create("no-extension"));
    const list = await env.derived("getFullList", () => pb.backups.getFullList(), keys);
    expect(keys(list)).toContain("sdk.zip");

    const token = await env.step("getToken", () => pb.files.getToken());
    const url = pb.backups.getDownloadURL(token, "sdk.zip");
    env.record("download URLs", {
      url: url.replace(/token=[^&]+/, "token=<token>").replace(env.url, "<base>"),
      deprecated: pb.backups
        .getDownloadUrl(token, "a b.zip")
        .replace(token, "<token>")
        .replace(env.url, "<base>"),
    });
    await download(env, "download", url);
    // error bodies are JSON: recorded as exchanges and compared in full
    const failed = async (label: string, target: string) => {
      const res = await env.fetch(label, target.replace(env.url, ""));
      await res.arrayBuffer();
    };
    await failed("download (missing)", pb.backups.getDownloadURL(token, "missing.zip"));
    await failed("download (invalid token)", pb.backups.getDownloadURL("invalid", "sdk.zip"));

    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    await env.step("upload", () =>
      pb.backups.upload({
        file: new File([bytes as Uint8Array<ArrayBuffer>], "uploaded.zip", {
          type: "application/zip",
        }),
      }),
    );
    // the message names the file under its random stored name
    await env.failsStatus(
      "upload (not a zip)",
      () => pb.backups.upload({ file: new File(["nope"], "bad.zip", { type: "text/plain" }) }),
      (e) => ({
        status: e.status,
        code: (e.response["data"] as { file: { code: string } }).file.code,
      }),
    );
    await env.derived("getFullList (uploaded)", () => pb.backups.getFullList(), keys);
    await env.step("delete", () => pb.backups.delete("uploaded.zip"));
    await env.fails("delete (missing)", () => pb.backups.delete("uploaded.zip"));
    await env.fails("create (guest)", () => env.client().backups.create("g.zip"));
    await env.fails("getFullList (guest)", () => env.client().backups.getFullList());
  });

  sdkTest("restore", {}, async (env) => {
    const pb = env.superuser();
    await env.step("create", () => pb.backups.create("before.zip"));
    const marker = await env.step("create a record after the backup", () =>
      pb.collection("demo2").create({ id: "sdkmarker000001", title: "after" }),
    );
    await env.fails("restore (missing)", () => pb.backups.restore("missing.zip"));
    await env.step("restore", () => pb.backups.restore("before.zip"));
    // the server restarts on the restored data
    await env.until(
      async () => {
        try {
          const res = await fetch(`${env.url}/api/collections/demo2/records/${marker.id}`);
          return res.status === 404;
        } catch {
          return false;
        }
      },
      "the restart",
      20_000,
    );
    await env.step("after restore", () => pb.collection("demo2").getList(1, 5, { sort: "id" }));
    await env.derived("backups after restore", () => pb.backups.getFullList(), keys);
  });

  sdkTest("on S3", { s3: true }, async (env) => {
    const pb = env.superuser();
    const s3 = {
      enabled: true,
      endpoint: env.s3.endpoint,
      bucket: env.s3.bucket,
      region: env.s3.region,
      accessKey: env.s3.accessKey,
      secret: env.s3.secret,
      forcePathStyle: true,
    };
    await env.step("update (backups s3)", () => pb.settings.update({ backups: { s3 } }));
    await env.step("testS3", () => pb.settings.testS3("backups"));
    await env.step("create", () => pb.backups.create("s3.zip"));
    await env.derived("getFullList", () => pb.backups.getFullList(), keys);
    const token = await env.step("getToken", () => pb.files.getToken());
    await download(env, "download", pb.backups.getDownloadURL(token, "s3.zip"));
    await env.step("delete", () => pb.backups.delete("s3.zip"));
    await env.derived("getFullList (deleted)", () => pb.backups.getFullList(), keys);
  });
});
