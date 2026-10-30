// Upstream: plugins/jsvm/binds.go (arrayOf, DynamicModel and newDynamicModel,
// the null* helpers), with how goja hands such values to dbx's Query One,
// All and Column
//
// Upstream's queries fill the model they are given; the internal queries
// return their results. The adapters here call the internal query and fill
// the migration file's model. The model types a migration file can pass:
// a DynamicModel, a Record (with its collection or Go's zero Record), a
// Collection, and arrayOf() of these.

import { Collection } from "@/collections/collection-model";
import { HashExp } from "@/db/dbx/expression";
import type { Query, Row } from "@/db/dbx/query";
import type { SelectQuery } from "@/db/dbx/select";
import type { CustomMethod } from "@/migrations/go-class";
import { convertGoToJSName } from "@/migrations/mapper";
import { type Membrane, toInteger } from "@/migrations/membrane";
import { Record as RecordModel } from "@/records/record-model";
import { NotRecordQueryError, recordsTarget, recordTarget } from "@/records/record-query";
import { goQuote } from "@/fields/field";
import { anyType, bytesToText } from "@/tools/types/go-json";
import { scanJSONArray } from "@/tools/types/json-array";
import { scanJSONMap } from "@/tools/types/json-map";

// What a migration file's Record stands on. Go's One assigns over the given
// Record (`*v = *record`), collection included; an internal Record cannot
// change its collection, so the assignment replaces the Record held here.
export class RecordSlot {
  constructor(public record: RecordModel) {}
}

// nullString() and the others: a nullable DynamicModel shape value
export class NullShape {
  constructor(readonly kind: ShapeKind) {}
}

type ShapeKind = "string" | "int" | "float" | "bool" | "array" | "object";

interface ShapeField {
  kind: ShapeKind;
  nullable: boolean;
  // the name on the model: the mapped name of Go's exported field
  name: string;
}

type DynamicModel = Record<string, unknown>;

// Rows: the cursor over a query's rows
export class RowsCursor {
  #index = -1;
  #closed = false;

  constructor(
    private readonly rows: Row[],
    private readonly names: string[],
    private readonly fill: (dst: unknown, row: Row) => void,
  ) {}

  next(): boolean {
    this.#index++;
    return !this.#closed && this.#index < this.rows.length;
  }

  nextResultSet(): boolean {
    return false;
  }

  columns(): string[] {
    return this.names;
  }

  err(): null {
    return null;
  }

  close(): void {
    this.#closed = true;
  }

  // goja hands a JS object over as a copy
  scanMap(): void {}

  scan(args: readonly unknown[]): void {
    scanDestinations(this.names, args);
  }

  scanStruct(dst: unknown): void {
    this.fill(dst, this.rows[this.#index] as Row);
  }
}

// Go's Scan needs pointers, which a migration file cannot make
function scanDestinations(names: readonly string[], args: readonly unknown[]): void {
  if (args.length !== names.length) {
    throw new Error(
      `sql: expected ${names.length} destination arguments in Scan, not ${args.length}`,
    );
  }
  throw new Error(
    `sql: Scan error on column index 0, name ${goQuote(names[0] ?? "")}: destination not a pointer`,
  );
}

function invalidVariable(reason: string): Error {
  return new Error(`Invalid variable type: ${reason}`);
}

const encodeGoJSON = (v: unknown): string => JSON.stringify(v);

// what makes a migration file's objects queries' models, for one context
export class QueryModels {
  readonly #shapes = new WeakMap<object, Map<string, ShapeField>>();
  readonly #arrays = new WeakMap<object, unknown>();

  constructor(
    private readonly m: Membrane,
    private readonly blank: WeakSet<object>,
  ) {}

  isDynamicModel(v: unknown): boolean {
    return typeof v === "object" && v !== null && this.#shapes.has(v);
  }

  isArrayOf(v: unknown): boolean {
    return typeof v === "object" && v !== null && this.#arrays.has(v);
  }

  modelOf(v: unknown): unknown {
    return this.#arrays.get(v as object);
  }

  // newDynamicModel
  newDynamicModel(shape: unknown): DynamicModel {
    if (typeof shape !== "object" || shape === null || Object.keys(shape).length === 0) {
      throw new Error("[DynamicModel] missing shape data");
    }

    const fields = new Map<string, ShapeField>();
    const model = this.m.vm.object();

    for (const key of Object.keys(shape).toSorted()) {
      const value = (shape as Record<string, unknown>)[key];
      const name = convertGoToJSName(key.slice(0, 1).toUpperCase() + key.slice(1));
      const target = this.m.targetOf(value);
      if (target instanceof NullShape) {
        fields.set(key, { kind: target.kind, nullable: true, name });
        model[name] = null;
        continue;
      }
      fields.set(key, { kind: kindOf(value), nullable: false, name });
      model[name] = value;
    }

    return this.#seal(model, fields);
  }

  // A Go struct: only its fields, each with its Go type.
  #seal(model: DynamicModel, fields: Map<string, ShapeField>): DynamicModel {
    const proxy = new Proxy(model, {
      set: (t, key, value) => {
        const field = [...fields.values()].find((f) => f.name === key);
        if (field === undefined) {
          return false;
        }
        t[key as string] = assignShape(value, field);
        return true;
      },
    });
    this.#shapes.set(proxy, fields);
    return proxy;
  }

  arrayOf(model: unknown): unknown[] {
    const array = this.m.vm.array();
    this.#arrays.set(array, model);
    return array;
  }

  // what json.Unmarshal does with a value for a model
  unmarshalModel(dst: unknown, decoded: unknown, path: string): void {
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new Error(`json: cannot unmarshal JSON value into Go struct within "${path}"`);
    }
    const shape = this.#shapeOf(dst) as Map<string, ShapeField>;
    for (const [column, field] of shape) {
      if (Object.hasOwn(decoded, column)) {
        const value = (decoded as Record<string, unknown>)[column];
        (dst as DynamicModel)[field.name] = jsonShape(value, field, `${path}/${column}`);
      }
    }
  }

  // json.Unmarshal into an arrayOf() of models or of a primitive; newItem
  // makes a model from an item's JSON
  unmarshalArray(dst: unknown[], decoded: unknown, newItem: (raw: string) => unknown): void {
    if (!Array.isArray(decoded)) {
      throw new Error(`json: cannot unmarshal JSON ${jsonKindOf(decoded)} into Go slice`);
    }
    const model = this.modelOf(dst);
    const items = decoded.map((item: unknown, i) => {
      if (typeof model !== "object" || model === null) {
        const field = { kind: kindOf(model), nullable: false, name: "" };
        return jsonShape(item, field, `/${i}`);
      }
      if (this.isDynamicModel(model)) {
        const copy = this.#copyModel(model);
        this.unmarshalModel(copy, item, `/${i}`);
        return copy;
      }
      return newItem(encodeGoJSON(item));
    });
    replaceItems(dst, items);
  }

  // the methods of a Query that fill the model they are given
  queryMethods(): Record<string, CustomMethod> {
    return {
      ...this.#executors(),
      execute: (q: Query) => this.m.toVm(sqlResult(q.execute())),
    };
  }

  selectMethods(): Record<string, CustomMethod> {
    return {
      ...this.#executors(),
      model: (q: SelectQuery, args) => {
        this.#model(q, args[0], args[1]);
      },
    };
  }

  #executors(): Record<string, CustomMethod> {
    return {
      one: (q: SelectQuery | Query, args) => {
        this.#one(q, args[0]);
      },
      all: (q: SelectQuery | Query, args) => {
        this.#all(q, args[0]);
      },
      column: (q: SelectQuery | Query, args) => {
        this.#column(q, args[0]);
      },
      row: (q: SelectQuery | Query, args) => {
        const rows = q.rows();
        try {
          scanDestinations(rows.columns(), args);
        } finally {
          rows.close();
        }
      },
      rows: (q: SelectQuery | Query) => {
        const rows = q.rows();
        const names = rows.columns();
        return this.m.toVm(
          new RowsCursor(rows.all(), names, (dst, row) => {
            this.#fill(dst, row);
          }),
        );
      },
    };
  }

  #one(q: SelectQuery | Query, dst: unknown): void {
    const slot = this.m.boxOf(dst);

    if (slot instanceof RecordSlot) {
      this.#hydrate(q, dst as object, slot);
      return;
    }

    const target = this.m.targetOf(dst);
    if (target instanceof Collection) {
      q.one(target);
      return;
    }

    if (!this.isDynamicModel(dst)) {
      throw invalidVariable("must be a NullStringMap");
    }
    this.#fill(dst, q.one<Row>());
  }

  // A record query assigns its Record over the destination. Any other
  // query scans the columns of the struct: a Record has only its id.
  #hydrate(q: SelectQuery | Query, dst: object, slot: RecordSlot): void {
    let record: RecordModel;
    try {
      record = q.one<RecordModel>(recordTarget);
    } catch (err) {
      if (!(err instanceof NotRecordQueryError)) {
        throw err;
      }
      const row = q.one<Row>();
      slot.record.id = String(row.id ?? "");
      slot.record.postScan();
      return;
    }
    this.blank.delete(slot.record);
    slot.record = record;
    this.m.register(record, dst, slot);
  }

  // SelectQuery.Model: the row with the primary key
  #model(q: SelectQuery, pk: unknown, dst: unknown): void {
    const target = this.m.targetOf(dst);
    if (target instanceof Collection) {
      q.model(this.m.toHost(pk), target);
      return;
    }
    if (target instanceof RecordModel && q.info().from.length === 0) {
      q.from(target.tableName());
    }
    q.andWhere(new HashExp({ id: this.m.toHost(pk) }));
    this.#one(q, dst);
  }

  #all(q: SelectQuery | Query, dst: unknown): void {
    if (!this.isArrayOf(dst)) {
      throw invalidVariable("must be a pointer");
    }

    const array = dst as unknown[];
    const model = this.modelOf(dst);
    const target = this.m.targetOf(model);

    let items: unknown[];
    if (target instanceof RecordModel) {
      items = q.all<RecordModel>(recordsTarget).map((r) => this.m.toVm(r));
    } else if (target instanceof Collection) {
      items = q.all<Collection>(() => new Collection()).map((c) => this.m.toVm(c));
    } else if (this.isDynamicModel(model)) {
      items = q.all<Row>().map((row) => {
        const item = this.#copyModel(model as object);
        this.#fill(item, row);
        return item;
      });
    } else {
      throw invalidVariable("must be a slice of struct or NullStringMap");
    }

    replaceItems(array, items);
  }

  #column(q: SelectQuery | Query, dst: unknown): void {
    if (!this.isArrayOf(dst)) {
      throw invalidVariable("must be a pointer to a slice");
    }

    const array = dst as unknown[];
    const model = this.modelOf(dst);
    const field = { kind: kindOf(model), nullable: false, name: "" };
    const items = q.column<unknown>().map((v) => scanValue(v, field, "", 0, this.m));

    replaceItems(array, items);
  }

  #shapeOf(model: unknown): Map<string, ShapeField> | undefined {
    return typeof model === "object" && model !== null ? this.#shapes.get(model) : undefined;
  }

  #copyModel(model: object): DynamicModel {
    const copy = this.m.vm.object();
    Object.assign(copy, model);
    return this.#seal(copy, this.#shapeOf(model) as Map<string, ShapeField>);
  }

  // scans a row into a model, by the model's shape
  #fill(dst: unknown, row: Row): void {
    const shape = this.#shapeOf(dst);
    if (shape === undefined) {
      throw invalidVariable("must be a NullStringMap");
    }

    for (const [i, [column, value]] of Object.entries(row).entries()) {
      const field = shape.get(column);
      if (field !== undefined) {
        (dst as DynamicModel)[field.name] = scanValue(value, field, column, i, this.m);
      }
    }
  }
}

function replaceItems(array: unknown[], items: readonly unknown[]): void {
  array.length = 0;
  for (const item of items) {
    array.push(item);
  }
}

// goja's assignment to a struct field of a DynamicModel
function assignShape(value: unknown, field: ShapeField): unknown {
  if (value === null || value === undefined) {
    return field.nullable ? null : zeroOfKind(field.kind);
  }
  switch (field.kind) {
    case "string":
      return String(value);
    case "int":
      return toInteger(value);
    case "float":
      return Number(value);
    case "bool":
      return Boolean(value);
    default:
      return value;
  }
}

function zeroOfKind(kind: ShapeKind): unknown {
  switch (kind) {
    case "string":
      return "";
    case "bool":
      return false;
    case "int":
    case "float":
      return 0;
    default:
      return null;
  }
}

const goTypeOfKind: Readonly<Record<ShapeKind, string>> = {
  string: "string",
  int: "int64",
  float: "float64",
  bool: "bool",
  array: "types.JSONArray[interface {}]",
  object: "types.JSONMap[interface {}]",
};

const jsonKindOf = (v: unknown): string => {
  if (Array.isArray(v)) {
    return "array";
  }
  return typeof v === "object" ? "object" : typeof v;
};

// json.Unmarshal of a value into a field of a DynamicModel
function jsonShape(value: unknown, field: ShapeField, path: string): unknown {
  if (value === null) {
    return field.nullable ? null : zeroOfKind(field.kind);
  }
  const fits = {
    string: typeof value === "string",
    int: typeof value === "number" && Number.isInteger(value),
    float: typeof value === "number",
    bool: typeof value === "boolean",
    array: Array.isArray(value),
    object: jsonKindOf(value) === "object",
  }[field.kind];
  if (!fits) {
    throw new Error(
      `json: cannot unmarshal JSON ${jsonKindOf(value)} into Go ${goTypeOfKind[field.kind]} within "${path}"`,
    );
  }
  return value;
}

function kindOf(value: unknown): ShapeKind {
  if (typeof value === "string") {
    return "string";
  }
  if (typeof value === "boolean") {
    return "bool";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) && !Object.is(value, -0) ? "int" : "float";
  }
  return Array.isArray(value) ? "array" : "object";
}

// database/sql's convertAssign for the types a DynamicModel has
function scanValue(
  raw: unknown,
  field: ShapeField,
  column: string,
  index: number,
  m: Membrane,
): unknown {
  const scanError = (reason: string): Error =>
    new Error(`sql: Scan error on column index ${index}, name ${goQuote(column)}: ${reason}`);
  const fail = (from: string, to: string): Error => scanError(`converting ${from} to ${to}`);

  const value = raw instanceof Uint8Array ? bytesToText(raw) : raw;

  if (value === null || value === undefined) {
    if (field.nullable) {
      return null;
    }
    switch (field.kind) {
      case "array":
        return m.vm.array();
      case "object":
        return m.vm.object();
      default:
        throw fail("NULL", field.kind);
    }
  }

  switch (field.kind) {
    case "string":
      return String(value);
    case "bool":
      return value === true || value === 1 || value === "1" || value === "true";
    case "int": {
      const n = Number(value);
      if (!Number.isInteger(n)) {
        throw fail(String(value), "int64");
      }
      return n;
    }
    case "float": {
      const n = Number(value);
      if (Number.isNaN(n)) {
        throw fail(String(value), "float64");
      }
      return n;
    }
    case "array":
      try {
        return m.toVmJSON(scanJSONArray(value, anyType));
      } catch (err) {
        throw scanError((err as Error).message);
      }
    case "object":
      try {
        return m.toVmJSON(scanJSONMap(value));
      } catch (err) {
        throw scanError((err as Error).message);
      }
  }
}

// sql.Result
function sqlResult(result: { rowsAffected: number; lastInsertId: number | bigint }): {
  rowsAffected(): number;
  lastInsertId(): number;
} {
  return {
    rowsAffected: () => result.rowsAffected,
    lastInsertId: () => Number(result.lastInsertId),
  };
}
