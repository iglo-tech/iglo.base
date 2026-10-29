// Upstream: apis/installer.go: the installer link of a fresh pb_data and the
// first superuser created with its token, as the dashboard's installer page
// does (ui/src/auth/pageInstaller.js), through the compiled executable.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { startServer, tempDir } from "@test/support/executable";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";

const installerLink = /\n(http:\/\/127\.0\.0\.1:\d+)\/_\/#\/pbinstall\/([\w-]+\.[\w-]+\.[\w-]+)\n/;

function payload(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("installer", () => {
  test("a fresh pb_data prints the installer link; its token creates the first superuser", async () => {
    const dataDir = join(tempDir(), "pb_data");
    const server = await startServer([], dataDir);
    let token: string;
    try {
      const output = await server.waitForOutput("superuser upsert EMAIL PASS)\n\n");
      const match = installerLink.exec(output);
      expect(match?.[1]).toBe(server.url);
      token = match?.[2] ?? "";
      expect(output).toContain(
        "\n(!) Launch the URL below in the browser if it hasn't been open already to create your first superuser account:\n",
      );
      expect(output).toMatch(
        /\n\(you can also create your first superuser by running: \S+ superuser upsert EMAIL PASS\)\n\n$/,
      );

      const claims = payload(token);
      expect(Object.keys(claims).toSorted()).toEqual([
        "collectionId",
        "exp",
        "id",
        "refreshable",
        "type",
      ]);
      expect(claims.type).toBe("auth");
      expect(claims.refreshable).toBe(false);
      expect(claims.collectionId).toBe("pbc_3142635823");
      const ttl = Number(claims.exp) - Date.now() / 1000;
      expect(ttl).toBeGreaterThan(29 * 60);
      expect(ttl).toBeLessThanOrEqual(30 * 60 + 1);

      // the installer page's requests
      const create = await fetch(`${server.url}/api/collections/_superusers/records`, {
        method: "POST",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "first@example.com",
          password: "1234567890",
          passwordConfirm: "1234567890",
        }),
      });
      expect(create.status).toBe(200);
      const login = await fetch(`${server.url}/api/collections/_superusers/auth-with-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity: "first@example.com", password: "1234567890" }),
      });
      expect(login.status).toBe(200);
      const { token: authToken } = (await login.json()) as { token: string };

      // the installer placeholder is gone
      const list = await fetch(`${server.url}/api/collections/_superusers/records?fields=email`, {
        headers: { Authorization: authToken },
      });
      expect(((await list.json()) as { items: unknown[] }).items).toEqual([
        { email: "first@example.com" },
      ]);

      // the installer token stops working with its record: a guest request
      const again = await fetch(`${server.url}/api/collections/_superusers/records`, {
        headers: { Authorization: token },
      });
      expect(again.status).toBe(403);
    } finally {
      await server.stop();
    }

    // with a superuser, no installer on the next start
    // (serve runs the installer before it waits for the stop signal, so its
    // output is complete when the server stops)
    const restarted = await startServer([], dataDir);
    const result = await restarted.stop();
    expect(result.stdout).not.toContain("pbinstall");
    expect(result.stdout).not.toContain("superuser upsert");
  });

  test("the installer reuses its placeholder on the next start", async () => {
    const dataDir = join(tempDir(), "pb_data");
    const first = await startServer([], dataDir);
    const firstToken = installerLink.exec(await first.waitForOutput("EMAIL PASS)\n\n"))?.[2] ?? "";
    await first.stop();
    const second = await startServer([], dataDir);
    const secondToken =
      installerLink.exec(await second.waitForOutput("EMAIL PASS)\n\n"))?.[2] ?? "";
    await second.stop();
    expect(payload(secondToken).id).toBe(payload(firstToken).id);
  });

  test("pb_data with superusers: no installer", async () => {
    const dataDir = join(tempDir(), "pb_data");
    copyDataDir(fixtureDir, dataDir);
    const server = await startServer([], dataDir);
    const result = await server.stop();
    expect(result.stdout).toMatch(/> Dashboard: http:\/\/127\.0\.0\.1:\d+\/_\/\n/);
    expect(result.stdout).not.toContain("pbinstall");
  });
});
