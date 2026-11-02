// FileService of the JavaScript SDK 0.28.1 against both servers: getURL
// (plain, thumb, download, token), getToken and protected files, and the
// downloads those URLs serve. Not part of `bun test`: run
// `bun run test:reference`.

import { describe, expect } from "bun:test";

import { sdkTest } from "@test/differential/sdk/harness";

const pngFile = "300_1SEi6Q6U72.png"; // users 4q1xlclmfloku33's avatar

describe("FileService", () => {
  sdkTest("getURL, getUrl, getToken and downloads", {}, async (env) => {
    const pb = env.superuser();
    const user = await env.step("getOne user", () =>
      pb.collection("users").getOne("4q1xlclmfloku33"),
    );
    expect(user["avatar"]).toBe(pngFile);
    const demo = await env.step("getOne demo1", () =>
      pb.collection("demo1").getOne("84nmscqy84lsi1t"),
    );

    const urls = {
      plain: pb.files.getURL(user, user["avatar"]),
      deprecated: pb.files.getUrl(user, user["avatar"]),
      thumb: pb.files.getURL(user, user["avatar"], { thumb: "70x50" }),
      download: pb.files.getURL(user, user["avatar"], { download: true }),
      token: pb.files.getURL(user, user["avatar"], { token: "abc" }),
      client: pb.getFileUrl(user, user["avatar"]),
      empty: pb.files.getURL(user, ""),
      protectedFile: pb.files.getURL(demo, demo["file_one"]),
    };
    env.record("urls", urls);
    const path = (u: string) => u.replace(env.url, "");

    const download = async (label: string, url: string, init: RequestInit = {}) => {
      const res = await env.fetch(label, path(url), init);
      return { status: res.status, bytes: (await res.arrayBuffer()).byteLength };
    };
    expect((await download("original", urls.plain)).status).toBe(200);
    await download("download=true", urls.download);
    await download("thumb 70x50", urls.thumb);
    for (const thumb of ["70x50t", "70x50b", "70x50f", "0x50", "70x0", "100x100"]) {
      await download(`thumb ${thumb}`, pb.files.getURL(user, user["avatar"], { thumb }));
    }
    await download("missing file", pb.files.getURL(user, "missing.png"));
    await download("range", urls.plain, { headers: { Range: "bytes=0-9" } });

    // a protected file: denied without a token, served with one
    await download("protected (guest)", urls.protectedFile);
    const guestToken = await env.fails("getToken (guest)", () => env.client().files.getToken());
    expect(guestToken.status).toBe(401);
    const token = await env.step("getToken", () => pb.files.getToken());
    await download("protected (token)", pb.files.getURL(demo, demo["file_one"], { token }));
    await download(
      "protected (invalid token)",
      pb.files.getURL(demo, demo["file_one"], { token: "invalid" }),
    );
    await env.step("getToken (user)", () =>
      env
        .as(
          "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.ZT3F0Z3iM-xbGgSG3LEKiEzHrPHr8t8IuHLZGGNuxLo",
          { id: "4q1xlclmfloku33", collectionName: "users" },
        )
        .files.getToken(),
    );
  });

  sdkTest("uploads: create, update and read back", {}, async (env) => {
    const pb = env.superuser();
    const created = await env.step("create (File and Blob)", () =>
      pb.collection("demo3").create({
        title: "uploads",
        files: [
          new File(["plain text"], "note.txt", { type: "text/plain" }),
          new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "tiny.png", { type: "image/png" }),
        ],
      }),
    );
    const names = created["files"] as string[];
    for (const name of names) {
      const res = await env.fetch(
        `download ${name.replace(/_[a-z0-9]{10}(\.[a-z]+)$/, "$1")}`,
        `/api/files/demo3/${created.id}/${name}`,
        {
          headers: { Authorization: pb.authStore.token },
        },
      );
      await res.arrayBuffer();
    }
    await env.step("update (replace)", () =>
      pb
        .collection("demo3")
        .update(created.id, { files: [new File(["new"], "new.txt", { type: "text/plain" })] }),
    );
    await env.step("update (clear)", () =>
      pb.collection("demo3").update(created.id, { files: [] }),
    );
    await env.fails("create (too large)", () =>
      pb
        .collection("demo3")
        .create({
          title: "big",
          files: [new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.bin")],
        }),
    );
  });
});
