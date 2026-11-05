// M7.1c: Record.marshalJSON writes the record's members itself instead of
// building an object and marshaling it. The output must equal what the
// M7.1b path wrote: marshal(publicExport()) with the M7.1b writer.
// Generated records cover every field type, unicode and escapes, large and
// negative numbers, json values with odd spacing and integer-like keys,
// hidden fields, custom data, auth collections and nested expands.

import { describe, expect, test } from "bun:test";

import { newAuthCollection, newBaseCollection } from "@/collections/collection-model";
import { BoolField } from "@/fields/bool";
import { DateField } from "@/fields/date";
import { EditorField } from "@/fields/editor";
import { EmailField } from "@/fields/email";
import { FileField } from "@/fields/file";
import { GeoPointField } from "@/fields/geo-point";
import { JSONField } from "@/fields/json";
import { NumberField } from "@/fields/number";
import { RelationField } from "@/fields/relation";
import { SelectField } from "@/fields/select";
import { TextField } from "@/fields/text";
import { URLField } from "@/fields/url";
import { type Record, newRecord } from "@/records/record-model";
import { DateTime } from "@/tools/types/datetime";
import { marshal } from "@/tools/types/go-json";
import { marshal as marshalBefore } from "@test/tools/types/go-json-before-m71c";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const strings = [
  "",
  "plain",
  "Zażółć gęślą jaźń 日本語 😀",
  'quote " backslash \\ slash /',
  "ctrl \u0000\u0001\u001f\t\n\r\b\f",
  "<b>&amp;</b>",
  "sep    ",
  "lone \ud800 surrogate",
];

const jsonTexts = [
  "null",
  "123",
  "-0",
  "12345678901234567890",
  '{"b":1, "a" : [1, 2 ,3]}',
  '{"10":1,"2":2,"a":3}',
  '[ 1 , {"x" : "\\u00e9\\/"} ]',
  '"\\u0041"',
  "1.50",
  '{"a":1,"a":2}',
  '{"k":"ünï","e":"\\n\\u0001"}',
  "true",
  "",
];

function pick<T>(r: () => number, items: T[]): T {
  return items[Math.floor(r() * items.length)] as T;
}

function buildCollection(r: () => number, auth: boolean) {
  const c = auth ? newAuthCollection("things") : newBaseCollection("things");
  c.fields.add(new TextField({ name: "title" }));
  c.fields.add(new TextField({ name: "secret", hidden: r() < 0.5 }));
  c.fields.add(new NumberField({ name: "n" }));
  c.fields.add(new BoolField({ name: "flag" }));
  c.fields.add(new JSONField({ name: "meta" }));
  c.fields.add(new SelectField({ name: "tags", values: ["a", "b", "c"], maxSelect: 3 }));
  c.fields.add(new SelectField({ name: "one", values: ["a", "b", "c"], maxSelect: 1 }));
  c.fields.add(new RelationField({ name: "rel", collectionId: "x", maxSelect: 5 }));
  c.fields.add(new RelationField({ name: "rel1", collectionId: "x", maxSelect: 1 }));
  c.fields.add(new DateField({ name: "when" }));
  c.fields.add(new GeoPointField({ name: "where" }));
  c.fields.add(new EditorField({ name: "body" }));
  c.fields.add(new URLField({ name: "link" }));
  c.fields.add(new EmailField({ name: "mail" }));
  c.fields.add(new FileField({ name: "files", maxSelect: 4, maxSize: 100 }));
  return c;
}

function fill(r: () => number, rec: Record): void {
  rec.id = "rec" + Math.floor(r() * 1e6);
  rec.set("title", pick(r, strings));
  rec.set("secret", pick(r, strings));
  rec.set("n", pick(r, [0, -1, 1.5, 1e21, 1e-7, -0, 2 ** 53, 123456789.123]));
  rec.set("flag", r() < 0.5);
  rec.set("meta", pick(r, jsonTexts));
  rec.set("tags", r() < 0.5 ? [] : ["a", "c"]);
  rec.set("one", pick(r, ["", "b"]));
  rec.set("rel", r() < 0.5 ? [] : ["id1", "id2"]);
  rec.set("rel1", pick(r, ["", "id3"]));
  rec.set("when", r() < 0.5 ? "" : "2024-02-29 12:34:56.789Z");
  rec.set("where", { lon: pick(r, [0, -122.4194, 1e-7]), lat: pick(r, [0, 37.7749, -90]) });
  rec.set("body", pick(r, strings));
  rec.set("link", pick(r, ["", "https://example.com/a?b=c&d=e"]));
  rec.set("mail", pick(r, ["", "a@b.co"]));
  rec.set("files", r() < 0.5 ? [] : ["a_x1.png", "b.txt"]);
  if (r() < 0.4) {
    rec.set("custom_" + Math.floor(r() * 3), pick(r, strings));
    rec.withCustomData(true);
  }
  if (r() < 0.3) {
    rec.hide("title");
  }
  if (r() < 0.3) {
    rec.unhide("secret");
  }
  if (r() < 0.2) {
    rec.hide("expand");
  }
}

function outcome(fn: () => string): string {
  try {
    return "ok:" + fn();
  } catch (err) {
    return "err:" + (err as Error).message;
  }
}

function reference(rec: Record): string {
  return marshalBefore(rec.publicExport(), {
    allowDuplicateNames: true,
    allowInvalidUTF8: true,
  });
}

describe("Record.marshalJSON", () => {
  test("equals the M7.1b writer's output over generated records", () => {
    const r = rng(2024);
    for (let i = 0; i < 600; i++) {
      const auth = r() < 0.3;
      const rec = newRecord(buildCollection(r, auth));
      fill(r, rec);
      if (auth) {
        rec.ignoreEmailVisibility(r() < 0.5);
      }
      if (r() < 0.6) {
        const expand: { [key: string]: unknown } = {};
        const inner = newRecord(buildCollection(r, false));
        fill(r, inner);
        expand["rel1"] = inner;
        const items: Record[] = [];
        for (let j = 0; j < Math.floor(r() * 3); j++) {
          const it = newRecord(buildCollection(r, false));
          fill(r, it);
          if (r() < 0.5) {
            const deeper = newRecord(buildCollection(r, false));
            fill(r, deeper);
            it.setExpand({ rel: [deeper], é: deeper });
          }
          items.push(it);
        }
        expand["rel"] = items;
        rec.setExpand(expand);
      }
      const out = rec.marshalJSON();
      expect(out).toBe(reference(rec));
      // and as a part of a larger value
      for (const opts of [{ allowDuplicateNames: true }, {}, { allowInvalidUTF8: true }]) {
        expect(outcome(() => marshal({ rec }, opts))).toBe(
          outcome(() => marshalBefore({ rec }, opts)),
        );
      }
    }
  });

  test("a changed field list is not written from a stale layout", () => {
    const c = buildCollection(rng(1), false);
    const rec = newRecord(c);
    fill(rng(2), rec);
    expect(rec.marshalJSON()).toBe(reference(rec));
    // rename, hide, add, remove, reorder, helper names, names that need escapes
    const title = c.fields.getByName("title") as TextField;
    title.name = "zzz";
    expect(rec.marshalJSON()).toBe(reference(rec));
    title.hidden = true;
    expect(rec.marshalJSON()).toBe(reference(rec));
    title.hidden = false;
    c.fields.add(new TextField({ name: "added" }));
    rec.set("added", "x");
    expect(rec.marshalJSON()).toBe(reference(rec));
    c.fields.removeByName("added");
    expect(rec.marshalJSON()).toBe(reference(rec));
    for (const name of [
      "expand",
      "collectionId",
      'q"uote',
      "tab\t",
      "\u{1f600}",
      "\ue000",
      "id2",
    ]) {
      const f = new TextField({ name });
      c.fields.add(f);
      rec.set(name, "v" + name);
      expect(rec.marshalJSON()).toBe(reference(rec));
      c.fields.removeByName(name);
      expect(rec.marshalJSON()).toBe(reference(rec));
    }
  });

  test("members are sorted by their UTF-8 bytes, duplicates after invalid UTF-8 kept", () => {
    const c = newBaseCollection("t");
    c.fields.add(new TextField({ name: "b" }));
    const rec = newRecord(c);
    rec.id = "x";
    rec.set("a\ud800", 1);
    rec.set("a\ud801", 2);
    rec.set("", 3);
    rec.set("\u{1f600}", 4);
    rec.withCustomData(true);
    expect(rec.marshalJSON()).toBe(reference(rec));
    expect(DateTime.fromDate(new Date(0)).toString()).toBeTypeOf("string");
  });
});
