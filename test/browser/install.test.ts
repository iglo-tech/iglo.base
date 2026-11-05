// The dashboard installer: the printed link creates the first superuser and
// lands on Collections (ui/src/auth/pageInstaller.js).

import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  Browser,
  installerLink,
  password,
  startFixture,
  type Fixture,
} from "@test/browser/support";

let fx: Fixture;
let browser: Browser;

beforeAll(async () => {
  browser = new Browser();
  fx = await startFixture();
});

afterAll(async () => {
  await browser?.close();
  await fx?.stop();
});

test("the installer link creates the first superuser and lands on Collections", async () => {
  const link = await installerLink(fx.server);
  await browser.open(link);
  await browser.waitForText("Setup your iglo.base instance");

  await browser.fill("textbox", "Email *", "admin@example.com");
  await browser.fill("textbox", "Password *", password);
  await browser.fill("textbox", "Password confirm *", password);
  await browser.click("button", "Create superuser and login");
  await browser.waitForUrl("**/#/collections*");

  await browser.waitForText("New collection");
  const text = await browser.bodyText();
  expect(text).toContain("iglo.base");
  expect(text).not.toContain("PocketBase");

  // the API agrees: the new superuser can sign in
  const auth = await fetch(`${fx.server.url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: "admin@example.com", password }),
  });
  expect(auth.status).toBe(200);
});
