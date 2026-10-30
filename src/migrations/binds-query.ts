// Upstream: plugins/jsvm/binds.go (arrayOf, DynamicModel and newDynamicModel,
// the null* helpers), with how goja hands such values to dbx's Query One,
// All and Column
//
// Upstream's queries fill the model they are given; the internal queries
// return their results. The adapters here call the internal query and fill
// the migration file's model. The model types a migration file can pass:
// a DynamicModel, a Record, a Collection, and arrayOf() of these.

import { Collection } from "@/collections/collection-model";
import { Query, type Row } from "@/db/dbx/query";
import { SelectQuery } from "@/db/dbx/select";
import { type Adapter, type Membrane, pass } from "@/migrations/membrane";
import type { Record as RecordModel } from "@/records/record-model";
import { recordsTarget, recordTarget } from "@/records/record-query";
import { goQuote } from "@/fields/field";
import { anyType, bytesToText } from "@/tools/types/go-json";
import { scanJSONArray } from "@/tools/types/json-array";
import { scanJSONMap } from "@/tools/types/json-map";

// `new Record()`: Go's zero Record. Here a Record needs its collection, so
// this holds the Record a query fills it with.
export class RecordSlot {
  record: RecordModel | null = null;
}

// nullString() and the others: a nullable DynamicModel shape value
export class NullShape {
  constructor(readonly kind: ShapeKind) {}
}

type ShapeKind = "string" | "int" | "float" | "bool" | "array" | "object";

interface ShapeField {
  kind: ShapeKind;
  nullable: boolean;
}

type DynamicModel = Record<string, unknown>;

// what makes a migration file's objects queries' models, for one context
export class QueryModels {
  readonly #shapes = new WeakMap<object, Map<string, ShapeField>>();
  readonly #arrays = new WeakMap<object, unknown>();

  constructor(private readonly m: Membrane) {}

  isDynamicModel(v: unknown): boolean {
    return typeof v === "object" && v !== null && this.#shapes.has(v);
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
      const target = this.m.targetOf(value);
      if (target instanceof NullShape) {
        fields.set(key, { kind: target.kind, nullable: true });
        model[key] = null;
        continue;
      }
      fields.set(key, { kind: kindOf(value), nullable: false });
      model[key] = value;
    }

    this.#shapes.set(model, fields);
    return model;
  }

  arrayOf(model: unknown): unknown[] {
    const array = this.m.vm.array();
    this.#arrays.set(array, model);
    return array;
  }

  adapter(): Adapter {
    return {
      get: (target, key) => {
        const q = target as SelectQuery | Query;
        switch (key) {
          case "one":
            return (dst: unknown) => this.m.guard(() => this.#one(q, dst));
          case "all":
            return (dst: unknown) => this.m.guard(() => this.#all(q, dst));
          case "column":
            return (dst: unknown) => this.m.guard(() => this.#column(q, dst));
          case "execute":
            if (q instanceof Query) {
              return () => this.m.guard(() => this.m.toVm(sqlResult(q.execute())));
            }
            return pass;
          default:
            return pass;
        }
      },
    };
  }

  #one(q: SelectQuery | Query, dst: unknown): void {
    const target = this.m.targetOf(dst);

    if (target instanceof RecordSlot) {
      target.record = q.one<RecordModel>(recordTarget);
      return;
    }

    if (target instanceof Collection) {
      q.one(target);
      return;
    }

    this.#fill(dst, q.one<Row>());
  }

  #all(q: SelectQuery | Query, dst: unknown): void {
    if (!Array.isArray(dst)) {
      throw new Error("the query destination must be an array (see arrayOf)");
    }

    const model = this.#arrays.get(dst);
    const target = this.m.targetOf(model);

    let items: unknown[];
    if (target instanceof RecordSlot) {
      items = q.all<RecordModel>(recordsTarget).map((r) => this.m.toVm(r));
    } else if (target instanceof Collection) {
      items = q.all<Collection>(() => new Collection()).map((c) => this.m.toVm(c));
    } else {
      const shape = this.#shapeOf(model);
      items = q.all<Row>().map((row) => {
        const item = shape === undefined ? this.m.vm.object() : this.#copyModel(model as object);
        this.#fill(item, row);
        return item;
      });
    }

    dst.length = 0;
    dst.push(...items);
  }

  #column(q: SelectQuery | Query, dst: unknown): void {
    if (!Array.isArray(dst)) {
      throw new Error("the query destination must be an array (see arrayOf)");
    }

    const model = this.#arrays.get(dst);
    const column = q.column<unknown>();
    const items =
      model === undefined
        ? column
        : column.map((v) => scanValue(v, { kind: kindOf(model), nullable: false }, "", 0, this.m));

    dst.length = 0;
    dst.push(...items);
  }

  #shapeOf(model: unknown): Map<string, ShapeField> | undefined {
    return typeof model === "object" && model !== null ? this.#shapes.get(model) : undefined;
  }

  #copyModel(model: object): DynamicModel {
    const copy = this.m.vm.object();
    Object.assign(copy, model);
    this.#shapes.set(copy, this.#shapeOf(model) as Map<string, ShapeField>);
    return copy;
  }

  // scans a row into a model, by the model's shape; a plain object takes
  // the row as it is
  #fill(dst: unknown, row: Row): void {
    if (typeof dst !== "object" || dst === null) {
      throw new Error("the query destination must be a model");
    }
    const shape = this.#shapeOf(dst);

    for (const [i, [column, value]] of Object.entries(row).entries()) {
      if (shape === undefined) {
        (dst as DynamicModel)[column] = this.m.toVm(value);
        continue;
      }
      const field = shape.get(column);
      if (field !== undefined) {
        (dst as DynamicModel)[column] = scanValue(value, field, column, i, this.m);
      }
    }
  }
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
