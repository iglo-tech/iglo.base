// Integers outside Number.MAX_SAFE_INTEGER survive a load and save through
// the db layer (src/db/dbx/rows.ts): SQLite stores a scalar JSON number in
// a JSON column as INTEGER, and the reference PocketBase v0.41.0 binary
// reads the exact value back after iglo.base saved the row with an
// unrelated change. Not part of `bun test`: run `bun run test:reference`.

import { afterAll, beforeAll, expect, test } from "bun:test";

import { Databases } from "@/db/base";
import { HashExp } from "@/db/dbx/expression";
import type { Params, Row } from "@/db/dbx/query";
import { modelQuery, saveNoValidate } from "@/db/db";
import { BaseModel } from "@/db/model";
import {
  copyFixture,
  serveUpstream,
  superuserToken,
  upstreamSQL,
  type FixtureCopy,
} from "@test/differential/db/fixture";

const recordId = "84nmscqy84lsi1t";

class Demo1 extends BaseModel {
  text = "";
  json: unknown = null;

  tableName(): string {
    return "demo1";
  }

  override dbColumns(): Params {
    return { ...super.dbColumns(), text: this.text, json: this.json };
  }

  override dbScan(row: Row): void {
    super.dbScan(row);
    if ("text" in row) this.text = String(row.text);
    if ("json" in row) this.json = row.json;
  }
}

let copy: FixtureCopy;
let loaded: unknown;

beforeAll(() => {
  copy = copyFixture();
  const app = Databases.open({ dataDir: copy.dataDir });
  try {
    app
      .db()
      .update("demo1", { json: "9007199254740993" }, new HashExp({ id: recordId }))
      .execute();

    const m = new Demo1();
    modelQuery(app, m)
      .andWhere(new HashExp({ id: recordId }))
      .limit(1)
      .one(m);
    loaded = m.json;
    m.text = "saved by iglo.base";
    saveNoValidate(app, m);
  } finally {
    app.close();
  }
});

afterAll(() => {
  copy?.remove();
});

test("the loaded value is the exact integer", () => {
  expect(loaded).toBe(9007199254740993n);
});

test("the reference binary reads the exact value back", async () => {
  const server = await serveUpstream(copy);
  try {
    expect(
      await upstreamSQL(
        server,
        `SELECT json, typeof(json), text FROM demo1 WHERE id = '${recordId}'`,
      ),
    ).toEqual([["9007199254740993", "integer", "saved by iglo.base"]]);

    const res = await fetch(`${server.url}/api/collections/demo1/records/${recordId}`, {
      headers: { Authorization: superuserToken },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"json":9007199254740993');
  } finally {
    await server.stop();
  }
});
