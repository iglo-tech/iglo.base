// Upstream: tools/types/json_map.go and json_array.go
//
// The named JSON types as a migration file holds them. goja sees a Go map
// with methods as an object of its methods: `dst.meta.get("a")`, never
// `dst.meta.a`. A JSONArray is an array with its methods. The value stays
// one of these classes in a DynamicModel, so its methods and its SQL value
// stay with it; an internal module gets its plain data (Membrane.toHost).

import { type GoType, anyType } from "@/tools/types/go-json";
import {
  jsonArrayMarshalJSON,
  jsonArrayString,
  jsonArrayValue,
  scanJSONArray,
} from "@/tools/types/json-array";
import {
  type JSONMap,
  jsonMapGet,
  jsonMapMarshalJSON,
  jsonMapSet,
  jsonMapString,
  jsonMapValue,
  scanJSONMap,
} from "@/tools/types/json-map";

export class GoJSONMap {
  constructor(public data: JSONMap<unknown> = {}) {}

  get(key: string): unknown {
    return jsonMapGet(this.data, key) ?? null;
  }

  set(key: string, value: unknown): void {
    jsonMapSet(this.data, key, value);
  }

  marshalJSON(): string {
    return jsonMapMarshalJSON(this.data);
  }

  string(): string {
    return jsonMapString(this.data);
  }

  toString(): string {
    return this.string();
  }

  value(): string {
    return jsonMapValue(this.data);
  }

  // json.Unmarshal keeps the members of an existing map
  scan(value: unknown): void {
    this.data = scanJSONMap(value, anyType, this.data);
  }
}

export class GoJSONArray {
  // the slice is holder[key]: a struct's field, or a value of its own (of)
  constructor(
    private readonly holder: Record<string, unknown>,
    private readonly key: string,
    readonly elem: GoType = anyType,
  ) {}

  static of(items: unknown[], elem: GoType = anyType): GoJSONArray {
    return new GoJSONArray({ items }, "items", elem);
  }

  get items(): unknown[] {
    return (this.holder[this.key] ?? []) as unknown[];
  }

  set items(next: unknown[]) {
    this.holder[this.key] = next;
  }

  marshalJSON(): string {
    return jsonArrayMarshalJSON(this.items);
  }

  string(): string {
    return jsonArrayString(this.items);
  }

  value(): string {
    return jsonArrayValue(this.items);
  }

  scan(value: unknown): void {
    try {
      this.items = scanJSONArray(value, this.elem);
    } catch (err) {
      this.items = [];
      throw err;
    }
  }
}
