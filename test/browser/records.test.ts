// A collection-and-record round trip in the dashboard, each result checked
// through the API: create a base collection, create a record with a file,
// edit it, see it in the list, delete it.

import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  Browser,
  installAndLogin,
  startFixture,
  writeTempFile,
  type Fixture,
} from "@test/browser/support";

interface Record {
  id: string;
  text: string;
  number: number;
  bool: boolean;
  file: string;
}

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

async function listRecords(): Promise<Record[]> {
  const res = await fx.api("/api/collections/posts/records");
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: Record[] }).items;
}

test("create a collection and a record with a file, edit it, list it, delete it", async () => {
  // collection with text, number, bool and file fields (default field names)
  await browser.open(`${fx.server.url}/_/#/collections`);
  await browser.click("button", "New collection");
  await browser.fill("textbox", "Name *", "posts");
  for (const type of ["Plain text", "Number", "Bool", "File"]) {
    await browser.click("button", "New field");
    await browser.click("button", type);
  }
  await browser.click("button", "Create");
  await browser.waitForUrl("**collection=posts*");
  await browser.waitForText("Successfully created collection");

  const col = await fx.api("/api/collections/posts");
  expect(col.status).toBe(200);
  const fields = ((await col.json()) as { fields: { name: string; type: string }[] }).fields;
  expect(
    fields
      .filter((f) => !["id", "created", "updated"].includes(f.name))
      .map((f) => `${f.name}:${f.type}`),
  ).toEqual(["text:text", "number:number", "bool:bool", "file:file"]);

  // a record with a file
  const upload = writeTempFile("note.txt", "hello dashboard\n");
  await browser.click("button", "New record");
  await browser.fill("textbox", "text", "first post");
  await browser.fill("spinbutton", "number", "42");
  await browser.run("check", await browser.ref("checkbox", "bool"));
  await browser.run("upload", "input[type=file]", upload);
  await browser.click("button", "Create");
  await browser.waitForText("Successfully created posts");

  let items = await listRecords();
  expect(items).toHaveLength(1);
  const created = items[0]!;
  expect(created).toMatchObject({ text: "first post", number: 42, bool: true });
  expect(created.file).toMatch(/^note_\w+\.txt$/);
  const fileRes = await fx.api(`/api/files/posts/${created.id}/${created.file}`);
  expect(await fileRes.text()).toBe("hello dashboard\n");

  // the list shows it
  await browser.waitForText("first post");
  const rows = JSON.parse(
    await browser.run("eval", "document.querySelector('tbody').innerHTML"),
  ) as string;
  expect(rows).toContain(created.file);

  // edit
  await browser.run("click", "tbody tr:nth-child(1) td:nth-child(3)");
  await browser.waitForText("Edit posts record");
  await browser.fill("textbox", "text", "first post edited");
  await browser.click("button", "Save changes");
  await browser.waitForText("Successfully updated posts");
  items = await listRecords();
  expect(items[0]).toMatchObject({ id: created.id, text: "first post edited", number: 42 });
  await browser.waitForText("first post edited");

  // delete (saving closes the panel; open the record again)
  await browser.run("click", "tbody tr:nth-child(1) td:nth-child(3)");
  await browser.waitForText("Edit posts record");
  await browser.click("button", "More options");
  await browser.click("button", "Delete");
  await browser.click("button", "Delete record");
  await browser.waitForText("Successfully deleted record");
  expect(await listRecords()).toHaveLength(0);
  expect((await fx.api(`/api/files/posts/${created.id}/${created.file}`)).status).toBe(404);
  await browser.waitForText("No records found");
});
