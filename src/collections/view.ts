// Upstream: core/view.go (SaveView, CreateViewFields, DryRunView and the
// raw query to schema helpers)
//
// DeleteView is in src/db/table.ts (M0.4).
//
// Go's (value, error) results are the value, and the error is thrown,
// except CreateViewFields: upstream returns the fields it collected
// together with its error and the collection validator uses them, so
// createViewFields returns both.
//
// DryRunView and FindRecordByViewFile read through RecordQuery
// (src/records/record-query.ts).
//
// SQLite errors are converted to the Go driver's text (driver-error.ts).

import {
  type CollectionsApp,
  collectionQuery,
  fieldApp,
  findCollectionByNameOrId,
  normalizeViewQueryId,
  runInAppTransaction,
} from "@/collections/collection-query";
import { Collection, newViewCollection } from "@/collections/collection-model";
import { FieldsList, newFieldsList } from "@/collections/fields-list";
import { equalFold, toLower, trim, trimSpace } from "@/collections/go-strings";
import { withDriverErrors } from "@/collections/driver-error";
import { HashExp, inExp } from "@/db/dbx/expression";
import { deleteView, tableInfo, type TableInfoRow } from "@/db/table";
import { BoolField } from "@/fields/bool";
import { type Field, FieldNameId, goQuote, isMultiValuer } from "@/fields/field";
import { JSONField } from "@/fields/json";
import { NumberField } from "@/fields/number";
import { RelationField } from "@/fields/relation";
import { TextField } from "@/fields/text";
import { mustCompile } from "@/tools/regexp/regexp";
import { pseudorandomString, randomString } from "@/tools/security/random";
import { Tokenizer } from "@/tools/tokenizer/tokenizer";
import type { Record } from "@/records/record-model";
import {
  getCollectionByModelOrIdentifier,
  recordQuery,
  recordsTarget,
  recordTarget,
} from "@/records/record-query";
import { jsonEach } from "@/tools/dbutils/json";
import { columnify } from "@/tools/inflector/inflector";

// SaveView creates (or updates already existing) persistent SQL view.
//
// NB! Be aware that this method is vulnerable to SQL injection and
// its arguments must come only from trusted input!
export function saveView(
  app: CollectionsApp,
  dangerousViewName: string,
  dangerousSelectQuery: string,
): void {
  runInAppTransaction(app, (txApp) => {
    // delete old view (if exists)
    withDriverErrors(() => deleteView(txApp.databases, dangerousViewName));

    dangerousSelectQuery = normalizeViewSelectQuery(dangerousSelectQuery);

    // (re)create the view
    //
    // note: the query is wrapped in a secondary SELECT as a rudimentary
    // measure to discourage multiple inline sql statements execution
    const viewQuery = `CREATE VIEW {{${dangerousViewName}}} AS SELECT * FROM (${dangerousSelectQuery})`;
    withDriverErrors(() => txApp.databases.db().newQuery(viewQuery).execute());

    // fetch the view table info to ensure that the view was created
    // because missing tables or columns won't return an error
    try {
      withDriverErrors(() => tableInfo(txApp.databases, dangerousViewName));
    } catch (err) {
      // manually cleanup previously created view in case the func
      // is called in a nested transaction and the error is discarded
      try {
        deleteView(txApp.databases, dangerousViewName);
      } catch {
        // ignored, as upstream does
      }

      throw err;
    }
  });
}

// CreateViewFields creates a new FieldsList from the provided select query.
//
// There are some caveats:
// - The select query must have an "id" column.
// - Wildcard ("*") columns are not supported to avoid accidentally leaking sensitive data.
//
// Returns the fields and the error (the fields collected before it, or an
// empty list).
//
// NB! Be aware that this method is vulnerable to SQL injection and the
// "dangerousSelectQuery" argument must come only from trusted input!
export function createViewFields(
  app: CollectionsApp,
  dangerousSelectQuery: string,
): [FieldsList, Error | null] {
  const result = newFieldsList();

  let suggestedFields: Map<string, QueryField>;
  try {
    suggestedFields = parseQueryToFields(app, dangerousSelectQuery);
  } catch (err) {
    return [result, toError(err)];
  }

  // note wrap in a transaction in case the dangerousSelectQuery contains
  // multiple statements allowing us to rollback on any error
  try {
    runInAppTransaction(app, (txApp) => {
      const info = getQueryTableInfo(txApp, dangerousSelectQuery);

      let hasId = false;

      for (const row of info) {
        if (row.name === FieldNameId) {
          hasId = true;
        }

        const f = suggestedFields.get(row.name);
        const field = f !== undefined ? f.field : defaultViewField(row.name);

        result.add(field);
      }

      if (!hasId) {
        throw new Error(
          "missing required id column (you can use `(ROW_NUMBER() OVER()) as id` if you don't have one)",
        );
      }
    });
  } catch (err) {
    return [result, toError(err)];
  }

  return [result, null];
}

export interface DryRunViewResult {
  fields: FieldsList;
  sample: Record[];
}

// DryRunView executes the provided query by creating a temporary view
// collection and returning a sample of the resulting query records (if valid).
//
// The same caveats from CreateViewFields apply here too.
//
// NB! Be aware that this method is vulnerable to SQL injection and the
// "dangerousSelectQuery" argument must come only from trusted input!
export function dryRunView(
  app: CollectionsApp,
  dangerousSelectQuery: string,
  sampleSize: number,
): DryRunViewResult {
  dangerousSelectQuery = normalizeViewSelectQuery(dangerousSelectQuery);

  const [fields, fieldsErr] = createViewFields(app, dangerousSelectQuery);
  if (fieldsErr !== null) {
    throw fieldsErr;
  }

  const tempName = "temp_view_" + randomString(5);
  const tempCollection = newViewCollection(tempName);
  tempCollection.fields = fields;

  // validate generated view fields
  const fApp = fieldApp(app);
  for (const [i, f] of fields.toArray().entries()) {
    const err = f.validateSettings(fApp, tempCollection);
    if (err !== null) {
      throw new Error(`invalid field ${goQuote(f.getName())} (${i}): ${err.message}`, {
        cause: err,
      });
    }
  }

  // apply the same normalization as in the collection view query
  try {
    dangerousSelectQuery = normalizeViewQueryId(app, dangerousSelectQuery);
  } catch (err) {
    throw wrapError("failed to normalize view query id", err);
  }

  let records: Record[];
  try {
    records = recordQuery(app, tempCollection)
      // note: the query is wrapped in a secondary SELECT as a rudimentary
      // measure to discourage multiple inline sql statements execution
      .from("(SELECT * FROM (" + dangerousSelectQuery + ")) as " + tempName)
      .limit(sampleSize)
      .all<Record>(recordsTarget);
  } catch (err) {
    throw wrapError("failed to retrieve query records", err);
  }

  // warn for possible empty or duplicated record ids found in the sample
  // (it is not intended for security and it is here to quickly provide a
  // helpful error message without doing multiple query executions)
  const ids = new Set<string>();
  for (const r of records) {
    if (r.id === "") {
      throw new Error("the query could return records with empty or invalid ids");
    }

    if (ids.has(r.id)) {
      throw new Error("the query could return records with non-unique ids");
    }

    ids.add(r.id);
  }

  return { fields, sample: records };
}

// FindRecordByViewFile returns the original Record of the provided view collection file.
export function findRecordByViewFile(
  app: CollectionsApp,
  viewCollectionModelOrIdentifier: Collection | string,
  fileFieldName: string,
  filename: string,
): Record {
  let view = getCollectionByModelOrIdentifier(app, viewCollectionModelOrIdentifier);

  if (!view.isView()) {
    throw new Error("not a view collection");
  }

  const findFirstNonViewQueryFileField = (level: number): QueryField => {
    // check the level depth to prevent infinite circular recursion
    // (the limit is arbitrary and may change in the future)
    if (level > 5) {
      throw new Error("reached the max recursion level of view collection file field queries");
    }

    const queryFields = parseQueryToFields(app, view.viewQuery);

    for (const item of queryFields.values()) {
      if (
        item.collection === null ||
        item.original === null ||
        item.field.getName() !== fileFieldName
      ) {
        continue;
      }

      if (item.collection.isView()) {
        view = item.collection;
        fileFieldName = item.original.getName();
        return findFirstNonViewQueryFileField(level + 1);
      }

      return item;
    }

    throw new Error("no query file field found");
  };

  const qf = findFirstNonViewQueryFileField(1);
  const original = qf.original as Field;

  const cleanFieldName = columnify(original.getName());

  const query = recordQuery(app, qf.collection).limit(1);

  if (!isMultiValuer(original) || !original.isMultiple()) {
    query.andWhere(new HashExp({ [cleanFieldName]: filename }));
  } else {
    query.innerJoin(
      `${jsonEach(cleanFieldName)} as {{_je_file}}`,
      new HashExp({ "_je_file.value": filename }),
    );
  }

  return query.one<Record>(recordTarget);
}

// -------------------------------------------------------------------
// Raw query to schema helpers
// -------------------------------------------------------------------

// loosely normalizes the specified view query and warn against multiple inline statements
// (the check is not perfect and it is NOT intended as a security measure; it is done primarily to provide a helpful error message)
export function normalizeViewSelectQuery(dangerousSelectQuery: string): string {
  dangerousSelectQuery = trim(trimSpace(dangerousSelectQuery), ";");

  const tk = Tokenizer.fromString(dangerousSelectQuery);
  tk.setSeparators(";");
  let queryParts: string[];
  try {
    queryParts = tk.scanAll();
  } catch {
    queryParts = []; // the scan error is ignored upstream
  }
  if (queryParts.length > 1) {
    throw new Error("multiple statements are not supported");
  }

  return dangerousSelectQuery;
}

export interface QueryField {
  // field is the final resolved field.
  field: Field;

  // collection refers to the original field's collection model.
  // It could be null if the found query field is not from a collection
  collection: Collection | null;

  // original is the original found collection field.
  // It could be null if the found query field is not from a collection
  original: Field | null;
}

export function defaultViewField(name: string): Field {
  if (name === FieldNameId) {
    return defaultViewIdField();
  }

  return new JSONField({
    name,
    maxSize: 1, // unused for views
  });
}

export function defaultViewIdField(): Field {
  return new TextField({
    name: FieldNameId,
    system: true,
    required: true,
    primaryKey: true,
    pattern: `^[a-z0-9]+$`,
  });
}

const castRegex = mustCompile(String.raw`(?is)^cast\s*\(.*\s+as\s+(\w+)\s*\)$`);

export function parseQueryToFields(
  app: CollectionsApp,
  selectQuery: string,
): Map<string, QueryField> {
  const p = new IdentifiersParser();
  p.parse(selectQuery);

  const collections = findCollectionsByIdentifiers(app, p.tables);

  const result = new Map<string, QueryField>();

  const mainTable: Identifier = p.tables[0] ?? { original: "", alias: "" };

  const set = (alias: string, field: Field, collection: Collection | null = null) => {
    result.set(alias, { field, collection, original: null });
  };

  for (const col of p.columns) {
    // note: it should be safe to use the already parsed alias as there
    // is no valid SQL where * column can be aliased to something else
    if (col.alias === "*") {
      throw new Error(
        "wildcard columns (*) are not supported - manually type the collection field names you want the view query to have",
      );
    }

    const colLower = toLower(col.original);

    // pk (always assume text field for now)
    if (col.alias === FieldNameId) {
      set(col.alias, defaultViewIdField());
      continue;
    }

    // numeric aggregations
    if (colLower.startsWith("count(")) {
      set(col.alias, new NumberField({ name: col.alias, onlyInt: true }));
      continue;
    }
    if (colLower.startsWith("total(")) {
      set(col.alias, new NumberField({ name: col.alias }));
      continue;
    }

    const castMatch = castRegex.findStringSubmatch(colLower);

    // casts
    if (castMatch !== null && castMatch.length === 2) {
      let field: Field | null = null;
      switch (castMatch[1]) {
        case "real":
        case "decimal":
        case "numeric":
          field = new NumberField({ name: col.alias });
          break;
        case "int":
        case "integer":
          field = new NumberField({ name: col.alias, onlyInt: true });
          break;
        case "text":
          field = new TextField({ name: col.alias });
          break;
        case "boolean":
        case "bool":
          field = new BoolField({ name: col.alias });
          break;
      }
      if (field !== null) {
        set(col.alias, field);
        continue;
      }
    }

    const parts = col.original.split(".");

    let fieldName: string;
    let collection: Collection | null;

    if (parts.length === 2) {
      fieldName = parts[1] as string;
      collection = collections.get(parts[0] as string) ?? null;
    } else {
      fieldName = parts[0] as string;
      collection = collections.get(mainTable.alias) ?? null;
    }

    // fallback to the default field
    if (collection === null) {
      set(col.alias, defaultViewField(col.alias));
      continue;
    }

    // find the first field by name (case insensitive)
    let field: Field | null = null;
    for (const f of collection.fields) {
      if (equalFold(f.getName(), fieldName)) {
        field = f;
        break;
      }
    }

    // fallback to the default field
    if (field === null) {
      set(col.alias, defaultViewField(col.alias), collection);
      continue;
    }

    // convert to relation since it is an id reference
    if (equalFold(fieldName, FieldNameId)) {
      set(
        col.alias,
        new RelationField({
          name: col.alias,
          maxSelect: 1,
          collectionId: collection.id,
        }),
        collection,
      );
      continue;
    }

    // we fetch a brand new collection object to avoid using reflection
    // or having a dedicated Clone method for each field type
    const tempCollection = findCollectionByNameOrId(app, collection.id);

    const clone = tempCollection.fields.getById(field.getId());
    if (clone === null) {
      throw new Error(
        `missing expected field ${goQuote(field.getName())} (${goQuote(field.getId())}) in collection ${goQuote(tempCollection.name)}`,
      );
    }
    // set new random id to prevent duplications if the same field is aliased multiple times
    clone.setId("_clone_" + pseudorandomString(4));
    clone.setName(col.alias);

    result.set(col.alias, { original: field, field: clone, collection });
  }

  return result;
}

function findCollectionsByIdentifiers(
  app: CollectionsApp,
  tables: readonly Identifier[],
): Map<string, Collection> {
  const names: unknown[] = [];

  for (const table of tables) {
    if (table.alias.includes("(")) {
      continue; // skip expressions
    }
    names.push(table.original);
  }

  const result = new Map<string, Collection>();

  if (names.length === 0) {
    return result;
  }

  const collections = withDriverErrors(() =>
    collectionQuery(app)
      .andWhere(inExp("name", ...names))
      .all<Collection>(() => new Collection()),
  );

  for (const table of tables) {
    for (const collection of collections) {
      if (collection.name === table.original) {
        result.set(table.alias, collection);
      }
    }
  }

  return result;
}

export function getQueryTableInfo(app: CollectionsApp, selectQuery: string): TableInfoRow[] {
  const tempView = "_temp_" + pseudorandomString(6);

  let info: TableInfoRow[] = [];

  runInAppTransaction(app, (txApp) => {
    // create a temp view with the provided query
    saveView(txApp, tempView, selectQuery);

    // extract the generated view table info
    const errs: unknown[] = [];
    try {
      info = withDriverErrors(() => tableInfo(txApp.databases, tempView));
    } catch (err) {
      errs.push(err);
    }
    try {
      withDriverErrors(() => deleteView(txApp.databases, tempView));
    } catch (err) {
      errs.push(err);
    }
    if (errs.length > 0) {
      throw joinErrors(errs);
    }
  });

  return info;
}

// -------------------------------------------------------------------
// Raw query identifiers parser
// -------------------------------------------------------------------

const joinReplaceRegex = mustCompile(
  String.raw`(?im)\s+(full\s+outer\s+join|left\s+outer\s+join|right\s+outer\s+join|full\s+join|cross\s+join|inner\s+join|outer\s+join|left\s+join|right\s+join|join)\s+?`,
);
const discardReplaceRegex = mustCompile(
  String.raw`(?im)\s+(where|group\s+by|having|order|limit|with)\s+?`,
);
const commentsReplaceRegex = mustCompile(String.raw`(?m)(\/\*[\s\S]*?\*\/)|(--.+$)`);

export interface Identifier {
  original: string;
  alias: string;
}

export class IdentifiersParser {
  columns: Identifier[] = [];
  tables: Identifier[] = [];

  parse(selectQuery: string): void {
    let str = trim(trimSpace(selectQuery), ";");
    str = commentsReplaceRegex.replaceAllString(str, " ");
    str = joinReplaceRegex.replaceAllString(str, " __pb_join__ ");
    str = discardReplaceRegex.replaceAllString(str, " __pb_discard__ ");

    const tk = Tokenizer.fromString(str);
    tk.setSeparators(",", " ", "\n", "\t");
    tk.keepSeparator(true);

    let skip = false;
    let partType = "";
    let activeBuilder: { s: string } | null = null;
    const selectParts = { s: "" };
    const fromParts = { s: "" };
    const joinParts = { s: "" };

    for (;;) {
      const token = tk.scan();
      if (token === null) {
        break;
      }

      const trimmed = toLower(trimSpace(token));

      switch (trimmed) {
        case "select":
          skip = false;
          partType = "select";
          activeBuilder = selectParts;
          break;
        case "distinct":
          continue; // ignore as it is not important for the identifiers parsing
        case "from":
          skip = false;
          partType = "from";
          activeBuilder = fromParts;
          break;
        case "__pb_join__":
          skip = false;

          // the previous part was also a join
          if (partType === "join") {
            joinParts.s += ",";
          }

          partType = "join";
          activeBuilder = joinParts;
          break;
        case "__pb_discard__":
          // skip following tokens
          skip = true;
          break;
        default: {
          const isJoin = partType === "join";

          if (isJoin && trimmed === "on") {
            skip = true;
          }

          if (!skip && activeBuilder !== null) {
            activeBuilder.s += " ";
            activeBuilder.s += token;
          }
        }
      }
    }

    const selects = extractIdentifiers(selectParts.s);
    const froms = extractIdentifiers(fromParts.s);
    const joins = extractIdentifiers(joinParts.s);

    this.columns = selects;
    this.tables = froms;
    this.tables.push(...joins);
  }
}

function extractIdentifiers(rawExpression: string): Identifier[] {
  const rawTk = Tokenizer.fromString(rawExpression);
  rawTk.setSeparators(",");

  const rawIdentifiers = rawTk.scanAll();

  const result: Identifier[] = [];

  for (const rawIdentifier of rawIdentifiers) {
    const tk = Tokenizer.fromString(rawIdentifier);
    tk.setSeparators(" ", "\n", "\t");

    const parts = tk.scanAll();

    result.push(identifierFromParts(parts));
  }

  return result;
}

function identifierFromParts(parts: readonly string[]): Identifier {
  const result: Identifier = { original: "", alias: "" };

  switch (parts.length) {
    case 3:
      if (!equalFold(parts[1] as string, "as")) {
        throw new Error(`invalid identifier part - expected "as", got ${parts[1]}`);
      }

      result.original = parts[0] as string;
      result.alias = parts[2] as string;
      break;
    case 2:
      result.original = parts[0] as string;
      result.alias = parts[1] as string;
      break;
    case 1: {
      const subParts = (parts[0] as string).split(".");
      result.original = parts[0] as string;
      result.alias = subParts[subParts.length - 1] as string;
      break;
    }
    default:
      throw new Error(`invalid identifier parts [${parts.join(" ")}]`);
  }

  result.original = trimRawIdentifier(result.original);

  // we trim the single quote even though it is not a valid column quote character
  // because SQLite allows it if the context expects an identifier and not string literal
  // (https://www.sqlite.org/lang_keywords.html)
  result.alias = trimRawIdentifier(result.alias, "'");

  return result;
}

function trimRawIdentifier(rawIdentifier: string, ...extraTrimChars: string[]): string {
  let trimChars = '`"[];';
  if (extraTrimChars.length > 0) {
    trimChars += extraTrimChars.join("");
  }

  const parts = rawIdentifier.split(".");

  for (let i = 0; i < parts.length; i++) {
    parts[i] = trim(parts[i] as string, trimChars);
  }

  return parts.join(".");
}

// -------------------------------------------------------------------

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// fmt.Errorf("<prefix>: %w", err)
export function wrapError(prefix: string, err: unknown): Error {
  const e = toError(err);
  return new Error(`${prefix}: ${e.message}`, { cause: e });
}

// errors.Join: the messages separated by newlines
export function joinErrors(errs: readonly unknown[]): Error {
  const list = errs.map(toError);
  if (list.length === 1) {
    return list[0] as Error;
  }
  return new AggregateError(list, list.map((e) => e.message).join("\n"));
}
