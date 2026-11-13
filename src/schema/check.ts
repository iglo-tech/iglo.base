// The checks of an apply that read the data (D40, S.3). Not an upstream
// file.
//
// The record check runs the field validators that the records API runs on
// save (the fields' validateValue, with the record save's field app) over
// every record of a collection, for the fields the apply added or changed.
// Relation targets are checked by those validators too. Unique indexes are
// not checked here: SQLite enforces them when the index is created, and the
// apply reports that failure as a problem.
//
// The counts are for the plan: the rows of a table, the non-empty values of a
// field (what removing it would lose), and the rows that hold more values than
// a lowered maxSelect allows.

import type { Collection } from "@/collections/collection-model";
import type { CollectionsApp } from "@/collections/collection-query";
import type { Databases } from "@/db/base";
import { newExp } from "@/db/dbx/expression";
import { hasTable } from "@/db/table";
import type { Record } from "@/records/record-model";
import { recordQuery, recordsTarget } from "@/records/record-query";
import { interceptorApp } from "@/records/record-save";
import type { Problem } from "@/schema/report";
import type { Error as ValidationError } from "@/validation/error";
import type { SchemaField } from "@/schema/types";

// the records read per query of the check (the cursor is the record id)
const batchSize = 500;

// how many example ids a problem lists
export const exampleLimit = 5;

// the rows of a table (0 when the table does not exist)
export function countRows(db: Databases, tableName: string): number {
  if (!hasTable(db, tableName)) {
    return 0;
  }
  const [count] = db.db().newQuery(`SELECT COUNT(*) FROM {{${tableName}}}`).row();
  return Number(count ?? 0);
}

// The SQL condition of an empty value of a field: what upstream stores when
// the field is not set. NULL is empty for every type; the empty string for
// text-like fields (and single select, file and relation); 0 for a number or a
// bool; an empty list for a multi-value select, file or relation ("[]"); and
// for json, the empty string, null and an empty list.
export function emptyValueCondition(field: SchemaField): string {
  const column = `[[${field.name}]]`;
  const isNull = `${column} IS NULL`;
  if (field.type === "number" || field.type === "bool") {
    return `${isNull} OR ${column} = 0`;
  }
  if (field.type === "json") {
    return `${isNull} OR ${column} IN ('', 'null', '[]')`;
  }
  if (maxSelectOf(field) > 1 && multiValueTypes.has(field.type)) {
    return `${isNull} OR ${column} IN ('', '[]')`;
  }
  return `${isNull} OR ${column} = ''`;
}

// the types whose maxSelect makes them lists of values
export const multiValueTypes: ReadonlySet<string> = new Set(["select", "file", "relation"]);

// the maximum number of values of a select, file or relation (1 when unset)
export function maxSelectOf(field: SchemaField): number {
  return Math.max(1, Number(field.options.maxSelect ?? 1));
}

// the rows whose value of the field is not empty (see emptyValueCondition)
export function countValues(db: Databases, tableName: string, field: SchemaField): number {
  if (!hasTable(db, tableName)) {
    return 0;
  }
  const [count] = db
    .db()
    .newQuery(`SELECT COUNT(*) FROM {{${tableName}}} WHERE NOT (${emptyValueCondition(field)})`)
    .row();
  return Number(count ?? 0);
}

// the rows that hold more values in a multi-value column than max: the values
// of a list column are a JSON array; any other value holds none
export function countBeyondMax(
  db: Databases,
  tableName: string,
  column: string,
  max: number,
): number {
  if (!hasTable(db, tableName)) {
    return 0;
  }
  const size = `CASE WHEN json_valid([[${column}]]) THEN json_array_length([[${column}]]) ELSE 0 END`;
  const [count] = db
    .db()
    .newQuery(`SELECT COUNT(*) FROM {{${tableName}}} WHERE ${size} > ${Math.trunc(max)}`)
    .row();
  return Number(count ?? 0);
}

// The wording of a failure, by the validator's code. A required value reads
// "required ... empty", as the issue's example reads.
function failureWording(err: ValidationError): { what: string; tail: string; next: string } {
  if (err.code() === "validation_required") {
    return {
      what: "required",
      tail: "empty",
      next: "Add a migration that fills it, or make the field optional.",
    };
  }
  return {
    what: err.message.replace(/\.$/, ""),
    tail: "fail the check",
    next: "Fix those records (a migration can), or change the field in the schema file.",
  };
}

interface Failure {
  what: string;
  tail: string;
  next: string;
  count: number;
  examples: string[];
}

// The problems of the records of one collection, for the given fields of its
// final schema: one problem per field and failure.
export function recordProblems(
  app: CollectionsApp,
  collection: Collection,
  fieldNames: readonly string[],
): Problem[] {
  const fields = fieldNames
    .map((name) => collection.fields.getByName(name))
    .filter((field) => field !== null);
  if (fields.length === 0) {
    return [];
  }

  const fieldApp = interceptorApp(app);
  // field name -> failure text -> failure
  const failures = new Map<string, Map<string, Failure>>();
  for (const field of fields) {
    failures.set(field.getName(), new Map());
  }

  let last = "";
  for (;;) {
    let query = recordQuery(app, collection);
    if (last !== "") {
      query = query.andWhere(newExp("[[id]] > {:last}", { last }));
    }
    const records = query.orderBy("id ASC").limit(batchSize).all<Record>(recordsTarget);
    if (records.length === 0) {
      break;
    }
    for (const record of records) {
      last = record.id;
      for (const field of fields) {
        const err = field.validateValue(fieldApp, record);
        if (err === null) {
          continue;
        }
        // the validators return the validation errors (code and message)
        const wording = failureWording(err as ValidationError);
        const byWhat = failures.get(field.getName()) as Map<string, Failure>;
        let failure = byWhat.get(wording.what);
        if (failure === undefined) {
          failure = { ...wording, count: 0, examples: [] };
          byWhat.set(wording.what, failure);
        }
        failure.count++;
        if (failure.examples.length < exampleLimit) {
          failure.examples.push(record.id);
        }
      }
    }
  }

  const problems: Problem[] = [];
  for (const [fieldName, byWhat] of failures) {
    for (const failure of byWhat.values()) {
      problems.push({
        where: `${collection.name}.${fieldName}`,
        message: `${failure.what}, ${failure.count} records ${failure.tail}`,
        examples: failure.examples,
        next: failure.next,
      });
    }
  }
  return problems;
}
