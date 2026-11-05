// The logs page: a request made through the API shows up in the list and its
// entry opens.

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

test("a request shows up in the logs list and its entry opens", async () => {
  const path = "/api/p5-browser-log-probe";
  expect((await fetch(`${fx.server.url}${path}`)).status).toBe(404);

  // logs are written in batches: wait until the API lists the entry
  let id = "";
  for (let i = 0; i < 40 && id === ""; i++) {
    const res = await fx.api(`/api/logs?filter=${encodeURIComponent(`data.url="${path}"`)}`);
    const items = ((await res.json()) as { items: { id: string }[] }).items;
    id = items[0]?.id ?? "";
    if (id === "") await Bun.sleep(250);
  }
  expect(id).not.toBe("");

  await browser.open(`${fx.server.url}/_/#/logs`);
  await browser.waitForText(`GET ${path}`);
  expect(await browser.bodyText()).toContain("status: 404");

  await browser.run(
    "eval",
    `[...document.querySelectorAll("tbody tr")].find((r) => r.innerText.includes(${JSON.stringify(path)})).children[2].click()`,
  );
  await browser.waitForText("Log details");
  const text = await browser.bodyText();
  expect(text).toContain(id);
  expect(text).toContain(path);
  expect(await browser.run("get", "url")).toContain(`logId=${id}`);
});
