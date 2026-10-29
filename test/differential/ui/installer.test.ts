// Differential case for the installer (apis/installer.go, apis/serve.go's
// banner): a fresh pb_data on the reference PocketBase v0.41.0 binary and on
// the compiled iglo.base executable. The banner and installer output match
// with the port, time, token and executable path normalized; the token has
// the same claims; it creates the first superuser through the same request
// on both; and the pb_data iglo.base leaves is opened by upstream with the
// same superusers. Not part of `bun test`: run `bun run test:reference`.

import { expect, test } from "bun:test";
import { join } from "node:path";

import { startServer, tempDir } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

function normalize(output: string, url: string): string {
  return output
    .replaceAll(url, "URL")
    .replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} /gm, "TIME ")
    .replace(/pbinstall\/[\w-]+\.[\w-]+\.[\w-]+/, "pbinstall/TOKEN")
    .replace(/running: \S+ superuser upsert/, "running: BIN superuser upsert");
}

function claims(output: string): Record<string, unknown> {
  const token = /pbinstall\/([\w-]+\.[\w-]+\.[\w-]+)/.exec(output)?.[1] ?? "";
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
}

async function install(url: string, output: string): Promise<unknown> {
  const token = /pbinstall\/([\w-]+\.[\w-]+\.[\w-]+)/.exec(output)?.[1] ?? "";
  const res = await fetch(`${url}/api/collections/_superusers/records`, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "first@example.com",
      password: "1234567890",
      passwordConfirm: "1234567890",
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return {
    status: res.status,
    keys: Object.keys(body).toSorted(),
    email: body.email,
    collectionName: body.collectionName,
  };
}

// the superusers' emails, through upstream's API
async function superusers(url: string): Promise<unknown> {
  const login = await fetch(`${url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "first@example.com", password: "1234567890" }),
  });
  const { token } = (await login.json()) as { token: string };
  const res = await fetch(`${url}/api/collections/_superusers/records?fields=email&sort=email`, {
    headers: { Authorization: token },
  });
  return ((await res.json()) as { items: unknown[] }).items;
}

test("fresh pb_data: banner, installer link and the first superuser", async () => {
  const upstream = await startUpstream();
  const igloDataDir = join(tempDir(), "pb_data");
  const iglo = await startServer([], igloDataDir);
  try {
    const igloOutput = await iglo.waitForOutput("superuser upsert EMAIL PASS)\n\n");
    const upstreamOutput = upstream.output();

    expect(normalize(igloOutput, iglo.url)).toBe(normalize(upstreamOutput, upstream.url));
    expect(normalize(igloOutput, iglo.url)).toContain("> Dashboard: URL/_/\n");

    const want = claims(upstreamOutput);
    const got = claims(igloOutput);
    expect(Object.keys(got).toSorted()).toEqual(Object.keys(want).toSorted());
    expect(got.collectionId).toBe(want.collectionId);
    expect(got.type).toBe(want.type);
    expect(got.refreshable).toBe(want.refreshable);
    expect(Math.abs(Number(got.exp) - Number(want.exp))).toBeLessThan(60);

    expect(await install(iglo.url, igloOutput)).toEqual(
      await install(upstream.url, upstreamOutput),
    );
    expect(await superusers(upstream.url)).toEqual([{ email: "first@example.com" }]);
  } finally {
    await Promise.all([upstream.stop(), iglo.stop()]);
  }

  // upstream opens iglo.base's pb_data: the same superusers, no installer
  const reopened = await startUpstream({ dataDir: igloDataDir });
  try {
    expect(await superusers(reopened.url)).toEqual([{ email: "first@example.com" }]);
    expect(reopened.output()).not.toContain("pbinstall");
  } finally {
    await reopened.stop();
  }
}, 60_000);
