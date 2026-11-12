// The indexes upstream keeps on an auth collection by itself (D40). Not an
// upstream file; the rule is upstream's core/collection_model.go
// initTokenKeyField and initEmailField.
//
// On every save of an auth collection upstream adds a unique index on
// `tokenKey`, and one on `email` with `WHERE email != ''`, unless a
// single-column unique index on that column exists (dbutils
// FindSingleColumnUniqueIndex). That check looks at the column, not the
// name. The name upstream gives the index is `idx_<field>_<id>` (fieldIndexName,
// at most 64 bytes), and older databases hold other names with the id in them
// (`_<id>_tokenKey_idx`, from v0.23). The file would hold those ids, so it
// leaves the indexes out, whatever their names.
//
// The description holds no implied index either. The apply restores a missing
// one through the collection save, as upstream does, and keeps an existing one
// under the name it has. The reader does not add them back: it cannot name
// them without the collection id.
//
// An index is implied only when it is the one upstream writes: unique, on the
// one column (`tokenKey` or `email`, same case), with no COLLATE and no sort
// order, on the collection's own table, and with the WHERE clause upstream
// gives (none for tokenKey; `email` != '' for email). Quotes and spaces in the
// WHERE clause do not count: upstream's older releases wrote `email` without
// backticks. Any other index on these columns is an explicit index, and the
// file lists it as stored: a COLLATE NOCASE email index is how an app makes
// login case-insensitive, so it must not be dropped. A non-partial unique
// index on email stays explicit too: upstream would not add its own, but a
// fresh database built from the file would get the partial one.

import { parseIndex } from "@/tools/dbutils/index";

// upstream's implied indexes: the column, and the WHERE clause without its
// quotes and spaces (initTokenKeyField: none; initEmailField: email != '')
const impliedIndexes: readonly { column: string; where: string }[] = [
  { column: "tokenKey", where: "" },
  { column: "email", where: "email!=''" },
];

// Whether a statement of a collection is an index upstream creates by
// itself. Only auth collections have them.
export function isImpliedIndex(
  statement: string,
  collection: { name: string; type: string },
): boolean {
  if (collection.type !== "auth") {
    return false;
  }
  const index = parseIndex(statement);
  if (!index.unique || index.columns.length !== 1 || index.tableName !== collection.name) {
    return false;
  }
  const column = index.columns[0];
  if (column === undefined || column.collate !== "" || column.sort !== "") {
    return false;
  }
  const rule = impliedIndexes.find((item) => item.column === column.name);
  return rule !== undefined && index.where.replace(/[`"\s]/g, "") === rule.where;
}

// The statements of a collection that the description holds: all of them,
// without the implied ones.
export function explicitIndexes(
  statements: readonly string[],
  collection: { name: string; type: string },
): string[] {
  return statements.filter((statement) => !isImpliedIndex(statement, collection));
}
