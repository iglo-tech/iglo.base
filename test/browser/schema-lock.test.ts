// The production schema lock in the dashboard (D41, S.6): with serve --mode
// prod --schema, the collection and settings screens are read-only and say
// why; the records screens still work. The patch is ui/src/base/schemaLock.js.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import { Browser, password } from "@test/browser/support";
import { run, startServer, tempDir, type RunningServer } from "@test/support/executable";

const email = "admin@example.com";

let server: RunningServer;
let browser: Browser;
let token = "";

beforeAll(async () => {
  const root = tempDir();
  const dataDir = join(root, "pb_data");
  mkdirSync(dataDir, { recursive: true });
  const created = await run(["--dir", dataDir, "superuser", "upsert", email, password]);
  expect(created.exitCode).toBe(0);
  const schemaPath = join(root, "iglo.schema.json");
  writeFileSync(
    schemaPath,
    JSON.stringify({
      collections: { posts: { type: "base", fields: { title: { type: "text" } } } },
    }),
  );
  server = await startServer(["--mode", "prod", "--schema", schemaPath], dataDir);

  const res = await fetch(`${server.url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: email, password }),
  });
  token = ((await res.json()) as { token: string }).token;

  browser = new Browser();
  await browser.open(`${server.url}/_/#/login`);
  await browser.waitForText("Superuser login");
  await browser.fill("textbox", "Email *", email);
  await browser.fill("textbox", "Password *", password);
  await browser.click("button", "Login");
  await browser.waitForUrl("**/collections*");
});

afterAll(async () => {
  await browser?.close();
  await server?.stop();
});

test("the collections screen has no way to create or edit a collection, and says why", async () => {
  await browser.open(`${server.url}/_/#/collections`);
  await browser.waitForText("managed by the schema file");
  const text = await browser.bodyText();
  expect(text).not.toContain("New collection");
  expect(text).toContain("iglo.schema.json");
});

test("the settings screens are read-only", async () => {
  await browser.open(`${server.url}/_/#/settings`);
  await browser.waitForText("managed by the schema file");
  const state = await browser.run(
    "eval",
    `JSON.stringify({ inert: !!document.querySelector("form.application-settings-form")?.inert, forms: document.querySelectorAll(".page-content form").length })`,
  );
  const parsed = JSON.parse(JSON.parse(state) as string) as { inert: boolean; forms: number };
  expect(parsed.forms).toBeGreaterThan(0);
  expect(parsed.inert).toBe(true);
});

test("the records screens still open the record editor, on the same route", async () => {
  const posts = (await (
    await fetch(`${server.url}/api/collections/posts`, { headers: { Authorization: token } })
  ).json()) as { id: string };
  await browser.open(`${server.url}/_/#/collections?collectionId=${posts.id}`);
  await browser.waitForText("New record");
  await browser.click("button", "New record");
  // the record editor opens with its save button
  await browser.waitForText("Create");
});
