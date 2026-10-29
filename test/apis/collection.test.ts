// Upstream: apis/collection.go (collectionUpdate and the collection body
// binding) with registerSettingsHooks (core/settings_model.go): the rate
// limit rule relabel after a collection rename, on plain and encrypted
// settings, and form-encoded collection bodies. The same requests are
// compared with upstream in test/differential/collections/api.test.ts;
// these run in plain `bun test` too.

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newRouter } from "@/apis/base";

import { openFixtureApp, type TestApp } from "@test/app/app";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { superuserToken } from "@test/scenarios/record-crud";
import { serveTest } from "@test/support/router";

const key = "abcdabcdabcdabcdabcdabcdabcdabcd";
const apps: TestApp[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.cleanup();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function open(dataDir: string, encrypted: boolean): Promise<TestApp> {
  const app = await openFixtureApp({
    dataDir,
    encryptionEnv: encrypted ? "TEST_KEY" : "",
    getenv: (name) => (encrypted && name === "TEST_KEY" ? key : ""),
  });
  apps.push(app);
  return app;
}

function fixtureCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-collection-api-"));
  roots.push(root);
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  return dataDir;
}

async function call(
  app: TestApp,
  method: string,
  target: string,
  body?: string,
  contentType = "application/json",
): Promise<{ status: number; json: { [key: string]: unknown } }> {
  const res = await serveTest(newRouter(app).buildMux(), {
    method,
    target,
    body,
    headers: { Authorization: superuserToken, "Content-Type": contentType },
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? {} : JSON.parse(text) };
}

function labels(settings: { [key: string]: unknown }): string[] {
  const rateLimits = settings["rateLimits"] as { rules: { label: string }[] };
  return rateLimits.rules.map((r) => r.label);
}

for (const encrypted of [false, true]) {
  test(`a rename relabels the rate limit rules (${encrypted ? "encrypted" : "plain"} settings)`, async () => {
    const dataDir = fixtureCopy();
    const app = await open(dataDir, encrypted);

    const rules = ["demo2:create", "demo22:list", "*:create", "/api/demo2", "demo2:list"];
    const set = await call(
      app,
      "PATCH",
      "/api/settings",
      JSON.stringify({
        rateLimits: { rules: rules.map((label) => ({ label, maxRequests: 1000, duration: 1 })) },
      }),
    );
    expect(set).toMatchObject({ status: 200 });

    expect(
      (await call(app, "PATCH", "/api/collections/demo2", `{"name":"demo2_new"}`)).status,
    ).toBe(200);
    const expected = [
      "demo2_new:create",
      "demo22:list",
      "*:create",
      "/api/demo2",
      "demo2_new:list",
    ];
    expect(labels((await call(app, "GET", "/api/settings")).json)).toEqual(expected);

    // a failed rename changes nothing
    expect(
      (await call(app, "PATCH", "/api/collections/demo2_new", `{"name":"users"}`)).status,
    ).toBe(400);

    // the stored row has the relabeled rules: a new app on the same pb_data loads them
    await app.cleanup();
    apps.splice(apps.indexOf(app), 1);
    const db = new Database(join(dataDir, "data.db"), { readonly: true });
    const row = db
      .query("SELECT typeof(value) AS type FROM _params WHERE id = 'settings'")
      .get() as {
      type: string;
    };
    db.close();
    expect(row.type).toBe(encrypted ? "text" : "blob");
    const reopened = await open(dataDir, encrypted);
    expect(labels((await call(reopened, "GET", "/api/settings")).json)).toEqual(expected);
  });
}

test("form-encoded bodies bind the top-level members, then @jsonPayload", async () => {
  const app = await open(fixtureCopy(), false);

  const created = await call(
    app,
    "POST",
    "/api/collections",
    "name=form_created&type=base&viewRule=id%3D''&indexes=CREATE+INDEX+idx_form+ON+form_created+(id)",
    "application/x-www-form-urlencoded",
  );
  expect(created.status).toBe(200);
  // the unsent rules are allocated as "" (UnmarshalRequestData)
  expect(created.json).toMatchObject({
    name: "form_created",
    listRule: "",
    viewRule: "id=''",
    createRule: "",
    indexes: ["CREATE INDEX idx_form ON form_created (id)"],
  });

  const multipart =
    "--X\r\nContent-Disposition: form-data; name=\"listRule\"\r\n\r\nid='x'\r\n" +
    '--X\r\nContent-Disposition: form-data; name="@jsonPayload"\r\n\r\n' +
    '{"name":"mp_created","viewRule":null,"fields":[{"name":"t","type":"text"}]}\r\n--X--\r\n';
  const mp = await call(
    app,
    "POST",
    "/api/collections",
    multipart,
    "multipart/form-data; boundary=X",
  );
  expect(mp.status).toBe(200);
  expect(mp.json).toMatchObject({ name: "mp_created", listRule: "id='x'", viewRule: null });
  expect((mp.json["fields"] as { name: string }[]).map((f) => f.name)).toContain("t");
});
