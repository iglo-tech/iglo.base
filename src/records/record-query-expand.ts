// Upstream: core/record_query_expand.go
//
// ExpandRecord and ExpandRecords are functions of the RecordsApp
// (record-query.ts). The fetch function and the back-relation lookups are
// async: outside a transaction they read through the read worker pool, as
// the records list and view handlers need. Go's map of failed expands is a
// Map in insertion order.
//
// Not ported: the log.Printf deprecation notice of the old
// `collection(field)` back-relation syntax (the syntax itself is
// supported).

import type { Collection } from "@/collections/collection-model";
import { exists, inExp, newExp } from "@/db/dbx/expression";
import { goQuote } from "@/fields/field";
import { RelationField } from "@/fields/relation";
import type { Record } from "@/records/record-model";
import {
  getCollectionByModelOrIdentifier,
  type RecordsApp,
  recordQuery,
  recordsTarget,
} from "@/records/record-query";
import { findSingleColumnUniqueIndex } from "@/tools/dbutils/index";
import { jsonEach } from "@/tools/dbutils/json";
import { toUniqueStringSlice } from "@/tools/list/list";

// maxNestedRels defines the max allowed nested relations depth
// (core/record_field_resolver_runner.go).
const maxNestedRels = 6;

// ExpandFetchFunc defines the function that is used to fetch the expanded relation records.
export type ExpandFetchFunc = (relCollection: Collection, relIds: string[]) => Promise<Record[]>;

// ExpandRecord expands the relations of a single Record model.
//
// If optFetchFunc is not set, then a default function will be used
// that returns all relation records.
//
// Returns a map with the failed expand parameters and their errors.
export function expandRecord(
  app: RecordsApp,
  record: Record,
  expands: readonly string[],
  optFetchFunc?: ExpandFetchFunc | null,
): Promise<Map<string, Error>> {
  return expandRecords(app, [record], expands, optFetchFunc);
}

// ExpandRecords expands the relations of the provided Record models list.
//
// If optFetchFunc is not set, then a default function will be used
// that returns all relation records.
//
// Returns a map with the failed expand parameters and their errors.
export async function expandRecords(
  app: RecordsApp,
  records: Record[],
  expands: readonly string[],
  optFetchFunc?: ExpandFetchFunc | null,
): Promise<Map<string, Error>> {
  const normalized = normalizeExpands(expands);

  const failed = new Map<string, Error>();

  for (const expand of normalized) {
    try {
      await expandRecordsPath(app, records, expand, optFetchFunc ?? null, 1);
    } catch (err) {
      failed.set(expand, err instanceof Error ? err : new Error(String(err)));
    }
  }

  return failed;
}

// Deprecated
const indirectExpandRegexOld = /^(\w+)\((\w+)\)$/;

const indirectExpandRegex = /^(\w+)_via_(\w+)$/;

// the default fetchFunc: all relation records (FindRecordsByIds, read
// through the async resolvers)
function defaultFetchFunc(app: RecordsApp): ExpandFetchFunc {
  return (relCollection, relIds) =>
    recordQuery(app, relCollection)
      .andWhere(inExp(relCollection.name + ".id", ...relIds))
      .allAsync<Record>(recordsTarget);
}

// Go's sql Scan of a column into a string
function scanString(v: unknown): string {
  if (v === null || v === undefined) {
    throw new Error(
      'sql: Scan error on column index 0, name "id": converting NULL to string is unsupported',
    );
  }
  if (v instanceof Uint8Array) {
    return new TextDecoder().decode(v);
  }
  return String(v);
}

// expandRecords (unexported in Go)
//
// notes:
// - if fetchFunc is null, FindRecordsByIds will be used
// - all records are expected to be from the same collection
// - if maxNestedRels(6) is reached, the function returns ignoring the remaining expand path
async function expandRecordsPath(
  app: RecordsApp,
  records: Record[],
  expandPath: string,
  fetchFunc: ExpandFetchFunc | null,
  recursionLevel: number,
): Promise<void> {
  const fetch = fetchFunc ?? defaultFetchFunc(app);

  if (expandPath === "" || recursionLevel > maxNestedRels || records.length === 0) {
    return;
  }

  const mainCollection = (records[0] as Record).collection();

  let relField: RelationField | null;
  let relCollection: Collection;

  const dot = expandPath.indexOf(".");
  const parts = dot < 0 ? [expandPath] : [expandPath.slice(0, dot), expandPath.slice(dot + 1)];
  const part0 = parts[0] as string;

  // @todo remove the old syntax support
  const matches = part0.includes("(")
    ? indirectExpandRegexOld.exec(part0)
    : indirectExpandRegex.exec(part0);

  if (matches !== null && matches.length === 3) {
    const backName = matches[1] as string;
    const backFieldName = matches[2] as string;

    let indirectRel: Collection | null = null;
    try {
      indirectRel = getCollectionByModelOrIdentifier(app, backName);
    } catch {
      indirectRel = null;
    }
    if (indirectRel === null) {
      throw new Error(`couldn't find back-related collection ${goQuote(backName)}`);
    }

    const field = indirectRel.fields.getByName(backFieldName);
    const indirectRelField = field instanceof RelationField ? field : null;
    if (indirectRelField === null || indirectRelField.collectionId !== mainCollection.id) {
      throw new Error(
        `couldn't find back-relation field ${goQuote(backFieldName)} in collection ${goQuote(indirectRel.name)}`,
      );
    }

    // add the related id(s) as a dynamic relation field value to
    // allow further expand checks at later stage in a more unified manner
    const db = app.databases.concurrentDB();
    for (const record of records) {
      const q = db.select("id").from(indirectRel.name).limit(1000); // the limit is arbitrary chosen and may change in the future

      if (indirectRelField.isMultiple()) {
        q.andWhere(
          exists(
            newExp(`SELECT 1 FROM ${jsonEach(indirectRelField.name)} je WHERE je.value = {:id}`),
          ),
        );
      } else {
        q.andWhere(newExp("[[" + indirectRelField.name + "]] = {:id}"));
      }

      const relIds = (await q.bind({ id: record.id }).build().columnAsync()).map(scanString);

      if (relIds.length > 0) {
        record.set(part0, relIds);
      }
    }

    // indirect/back relation
    relField = new RelationField();
    relField.name = part0;
    relField.maxSelect = 2147483647;
    relField.collectionId = indirectRel.id;
    const [, ok] = findSingleColumnUniqueIndex(indirectRel.indexes, indirectRelField.name);
    if (ok) {
      relField.maxSelect = 1;
    }
    relCollection = indirectRel;
  } else {
    // direct relation
    const field = mainCollection.fields.getByName(part0);
    relField = field instanceof RelationField ? field : null;
    if (relField === null) {
      throw new Error(
        `couldn't find relation field ${goQuote(part0)} in collection ${goQuote(mainCollection.name)}`,
      );
    }

    let found: Collection | null = null;
    try {
      found = getCollectionByModelOrIdentifier(app, relField.collectionId);
    } catch {
      found = null;
    }
    if (found === null) {
      throw new Error(`couldn't find related collection ${goQuote(relField.collectionId)}`);
    }
    relCollection = found;
  }

  // ---------------------------------------------------------------

  // extract the unique ids of the relations to expand
  // (the initial size assumes that most of the relations are single and unique)
  const existsSet = new Set<string>();
  const relIds: string[] = [];
  for (const record of records) {
    for (const id of record.getStringSlice(relField.name)) {
      if (!existsSet.has(id)) {
        existsSet.add(id);
        relIds.push(id);
      }
    }
  }

  // fetch rels
  const rels = await fetch(relCollection, relIds);

  // expand nested fields
  if (parts.length > 1) {
    await expandRecordsPath(app, rels, parts[1] as string, fetchFunc, recursionLevel + 1);
  }

  // reindex with the rel id
  const indexedRels = new Map<string, Record>();
  for (const rel of rels) {
    indexedRels.set(rel.id, rel);
  }

  for (const model of records) {
    // init expand if not already
    // (this is done to ensure that the "expand" key will be returned in the response even if empty)
    const expandData = model.expand();
    if (Object.keys(expandData).length === 0) {
      model.setExpand(null);
    }

    const ids = model.getStringSlice(relField.name);

    const validRels: Record[] = [];
    for (const id of ids) {
      const rel = indexedRels.get(id);
      if (rel !== undefined) {
        validRels.push(rel);
      }
    }

    if (validRels.length === 0) {
      continue; // no valid relations
    }

    // normalize access to the previously expanded rel records (if any)
    let oldExpandedRels: Record[] = [];
    const old = Object.hasOwn(expandData, relField.name) ? expandData[relField.name] : undefined;
    if (Array.isArray(old)) {
      oldExpandedRels = old as Record[];
    } else if (old !== undefined && old !== null && typeof old === "object") {
      oldExpandedRels = [old as Record];
    }

    // merge expands
    for (const oldExpandedRel of oldExpandedRels) {
      // find a matching rel record
      for (const rel of validRels) {
        if (rel.id !== oldExpandedRel.id) {
          continue;
        }

        rel.mergeExpand(oldExpandedRel.expand());
      }
    }

    // update the expanded data
    Object.defineProperty(expandData, relField.name, {
      value: relField.isMultiple() ? validRels : validRels[0],
      enumerable: true,
      writable: true,
      configurable: true,
    });

    model.setExpand(expandData);
  }
}

// normalizeExpands normalizes expand strings and merges self containing paths
// (eg. ["a.b.c", "a.b", "   test  ", "  ", "test"] -> ["a.b.c", "test"]).
export function normalizeExpands(paths: readonly string[]): string[] {
  // normalize paths
  const normalized: string[] = [];
  for (let p of paths) {
    p = p.replaceAll(" ", ""); // replace spaces
    p = p.replace(/^\.+|\.+$/g, ""); // trim incomplete paths
    if (p !== "") {
      normalized.push(p);
    }
  }

  // merge containing paths
  const result: string[] = [];
  for (const [i, p1] of normalized.entries()) {
    let skip = false;
    for (const [j, p2] of normalized.entries()) {
      if (i === j) {
        continue;
      }
      if (p2.startsWith(p1 + ".")) {
        // skip because there is more detailed expand path
        skip = true;
        break;
      }
    }
    if (!skip) {
      result.push(p1);
    }
  }

  return toUniqueStringSlice(result);
}
