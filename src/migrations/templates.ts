// Upstream: plugins/migratecmd/templates.go (the JS templates only: the
// prebuilt binary's TemplateLang is always JS, so the Go templates are not
// ported)
//
// The collections are serialized by their own marshalJSON (which hides the
// secrets) and decoded into plain values, as toMap does. The values are
// written with the object keys sorted and without HTML escaping, as
// marhshalWithoutEscape does.

import type { Collection } from "@/collections/collection-model";
import { goQuote } from "@/fields/field";

// note: this usually should be configurable similar to the jsvm plugin,
// but for simplicity is static as users can easily change the
// reference path if they use custom dirs structure
const jsTypesDirective = `/// <reference path="../pb_data/types.d.ts" />\n`;

export const ErrEmptyTemplate = new Error("empty template");

type JSONObject = Record<string, unknown>;

export function jsBlankTemplate(): string {
  return (
    jsTypesDirective +
    `migrate((app) => {
  // add up queries...
}, (app) => {
  // add down queries...
})
`
  );
}

export function jsSnapshotTemplate(collections: readonly Collection[]): string {
  // unset timestamp fields
  const collectionsData = collections.map((c) => templateData(c));

  const jsonData = marshalWithoutEscape(collectionsData, "  ", "  ");

  return (
    jsTypesDirective +
    `migrate((app) => {
  const snapshot = ${jsonData};

  return app.importCollections(snapshot, false);
}, (app) => {
  return null;
})
`
  );
}

export function jsCreateTemplate(collection: Collection): string {
  // unset timestamp fields
  const jsonData = marshalWithoutEscape(templateData(collection), "  ", "  ");

  return (
    jsTypesDirective +
    `migrate((app) => {
  const collection = new Collection(${jsonData});

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId(${goQuote(collection.id)});

  return app.delete(collection);
})
`
  );
}

export function jsDeleteTemplate(collection: Collection): string {
  // unset timestamp fields
  const jsonData = marshalWithoutEscape(templateData(collection), "  ", "  ");

  return (
    jsTypesDirective +
    `migrate((app) => {
  const collection = app.findCollectionByNameOrId(${goQuote(collection.id)});

  return app.delete(collection);
}, (app) => {
  const collection = new Collection(${jsonData});

  return app.save(collection);
})
`
  );
}

export function jsDiffTemplate(newC: Collection | null, old: Collection | null): string {
  if (newC === null && old === null) {
    throw new Error("the diff template require at least one of the collection to be non-nil");
  }

  if (newC === null) {
    return jsDeleteTemplate(old as Collection);
  }

  if (old === null) {
    return jsCreateTemplate(newC);
  }

  const upParts: string[] = [];
  const downParts: string[] = [];
  const varName = "collection";

  const newMap = toMap(newC);
  const oldMap = toMap(old);

  // non-fields
  // -----------------------------------------------------------------

  const upDiff = diffMaps(oldMap, newMap, "fields", "created", "updated");
  if (Object.keys(upDiff).length > 0) {
    const downDiff = diffMaps(newMap, oldMap, "fields", "created", "updated");

    const rawUpDiff = marshalWithoutEscape(upDiff, "  ", "  ");
    const rawDownDiff = marshalWithoutEscape(downDiff, "  ", "  ");

    upParts.push("// update collection data");
    upParts.push(`unmarshal(${rawUpDiff}, ${varName})\n`);
    // ---
    downParts.push("// update collection data");
    downParts.push(`unmarshal(${rawDownDiff}, ${varName})\n`);
  }

  // fields
  // -----------------------------------------------------------------

  const oldFieldsSlice = oldMap.fields as unknown[];
  const newFieldsSlice = newMap.fields as unknown[];
  const oldFields = old.fields.toArray();
  const newFields = newC.fields.toArray();

  // deleted fields
  for (const [i, oldField] of oldFields.entries()) {
    if (newC.fields.getById(oldField.getId()) !== null) {
      continue; // exist
    }

    const rawOldField = marshalWithoutEscape(oldFieldsSlice[i], "  ", "  ");

    upParts.push("// remove field");
    upParts.push(`${varName}.fields.removeById(${goQuote(oldField.getId())})\n`);

    downParts.push("// add field");
    downParts.push(`${varName}.fields.addAt(${i}, new Field(${rawOldField}))\n`);
  }

  // created fields
  for (const [i, newField] of newFields.entries()) {
    if (old.fields.getById(newField.getId()) !== null) {
      continue; // exist
    }

    const rawNewField = marshalWithoutEscape(newFieldsSlice[i], "  ", "  ");

    upParts.push("// add field");
    upParts.push(`${varName}.fields.addAt(${i}, new Field(${rawNewField}))\n`);

    downParts.push("// remove field");
    downParts.push(`${varName}.fields.removeById(${goQuote(newField.getId())})\n`);
  }

  // modified fields
  // (note currently ignoring order-only changes as it comes with too many edge-cases)
  for (const [i, newField] of newFields.entries()) {
    const rawNewField = marshalWithoutEscape(newFieldsSlice[i], "  ", "  ");

    const oldFieldIndex = oldFields.findIndex((f) => f.getId() === newField.getId());
    if (oldFieldIndex === -1) {
      continue; // new field
    }

    const rawOldField = marshalWithoutEscape(oldFieldsSlice[oldFieldIndex], "  ", "  ");
    if (rawNewField === rawOldField) {
      continue; // no change
    }

    upParts.push("// update field");
    upParts.push(`${varName}.fields.addAt(${i}, new Field(${rawNewField}))\n`);

    downParts.push("// update field");
    downParts.push(`${varName}.fields.addAt(${oldFieldIndex}, new Field(${rawOldField}))\n`);
  }

  // -----------------------------------------------------------------

  if (upParts.length === 0 && downParts.length === 0) {
    throw ErrEmptyTemplate;
  }

  const up = upParts.join("\n  ");
  const down = downParts.join("\n  ");

  return (
    jsTypesDirective +
    `migrate((app) => {
  const collection = app.findCollectionByNameOrId(${goQuote(old.id)})

  ${up.trim()}

  return app.save(collection)
}, (app) => {
  const collection = app.findCollectionByNameOrId(${goQuote(newC.id)})

  ${down.trim()}

  return app.save(collection)
})
`
  );
}

// the collection data of a create, delete and snapshot template
function templateData(collection: Collection): JSONObject {
  const data = toMap(collection);
  delete data.created;
  delete data.updated;
  const oauth2 = data.oauth2;
  if (typeof oauth2 === "object" && oauth2 !== null) {
    delete (oauth2 as JSONObject).providers;
  }
  return data;
}

function toMap(c: Collection): JSONObject {
  return JSON.parse(c.marshalJSON()) as JSONObject;
}

function diffMaps(old: JSONObject, newMap: JSONObject, ...excludeKeys: string[]): JSONObject {
  const diff: JSONObject = {};

  for (const [k, vNew] of Object.entries(newMap)) {
    if (excludeKeys.includes(k)) {
      continue;
    }

    if (!Object.hasOwn(old, k)) {
      // new field
      diff[k] = vNew;
      continue;
    }

    const vOld = old[k];

    // compare the serialized version of the values in case of slice or other custom type
    if (marshalWithoutEscape(vOld, "", "") !== marshalWithoutEscape(vNew, "", "")) {
      // if both are maps add recursively only the changed fields
      if (isObject(vOld) && isObject(vNew)) {
        const subDiff = diffMaps(vOld, vNew);
        if (Object.keys(subDiff).length > 0) {
          diff[k] = subDiff;
        }
      } else {
        diff[k] = vNew;
      }
    }
  }

  // unset missing fields
  for (const k of Object.keys(old)) {
    if (Object.hasOwn(diff, k) || excludeKeys.includes(k)) {
      continue; // already added
    }

    if (!Object.hasOwn(newMap, k)) {
      diff[k] = null;
    }
  }

  return diff;
}

function isObject(v: unknown): v is JSONObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// json.Marshal with jsontext.WithIndentPrefix, jsontext.WithIndent and
// json.Deterministic: object keys sorted, the first line without the prefix.
function marshalWithoutEscape(v: unknown, prefix: string, indent: string): string {
  const pretty = indent !== "";

  const write = (value: unknown, lead: string): string => {
    const inner = lead + indent;
    const open = pretty ? `\n${inner}` : "";
    const close = pretty ? `\n${lead}` : "";
    const separator = pretty ? `,\n${inner}` : ",";

    if (Array.isArray(value)) {
      if (value.length === 0) {
        return "[]";
      }
      return `[${open}${value.map((item) => write(item, inner)).join(separator)}${close}]`;
    }

    if (isObject(value)) {
      const keys = Object.keys(value).toSorted();
      if (keys.length === 0) {
        return "{}";
      }
      const members = keys.map(
        (k) => `${JSON.stringify(k)}:${pretty ? " " : ""}${write(value[k], inner)}`,
      );
      return `{${open}${members.join(separator)}${close}}`;
    }

    return JSON.stringify(value);
  };

  return write(v, prefix);
}
