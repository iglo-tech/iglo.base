// The crons page: it lists the built-in system jobs and its hint does not
// offer registering jobs with Go or JavaScript (ui/PATCHES.md, item 12).

import { afterAll, beforeAll, expect, test } from "bun:test";

import { Browser, installAndLogin, startFixture, type Fixture } from "@test/browser/support";

let fx: Fixture;
let browser: Browser;

beforeAll(async () => {
  browser = new Browser();
  fx = await startFixture();
  await installAndLogin(fx, browser);
});

afterAll(async () => {
  await browser?.close();
  await fx?.stop();
});

test("the crons page lists the system jobs and says there are no app jobs", async () => {
  await browser.open(`${fx.server.url}/_/#/settings/crons`);
  await browser.waitForText("__pbDBOptimize__");
  const text = await browser.bodyText();
  expect(text).toContain("iglo.base has no app cron jobs of its own");
  expect(text).not.toContain("registered only programmatically");
  expect(text).not.toContain("JavaScript");
});
