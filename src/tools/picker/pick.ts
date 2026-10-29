// Upstream: tools/picker/pick.go
//
// The data is marshaled with the Go JSON port and decoded back into plain
// JS values, as Pick does with json.Marshal and json.Unmarshal into `any`:
// objects become maps (their member order is then random in Go, and
// sorted by name here), numbers become float64.
//
// Go iterates its maps in random order and Pick changes the fields map
// while it iterates it. Here the fields are visited in insertion order,
// over a snapshot of the entries: a field path added during the visit is
// not visited again in the same loop (Go may or may not visit it; with
// paths like `a.a` that makes Go's own result random).

import { trimSpace } from "@/collections/go-strings";
import { SearchResult } from "@/search/provider";
import {
  initModifer,
  type Modifier,
  type ModifierFactoryFunc,
  Modifiers,
} from "@/tools/picker/modifiers";
import { Tokenizer } from "@/tools/tokenizer/tokenizer";
import { anyType, marshal, setOwn, unmarshal } from "@/tools/types/go-json";

export const ErrInvalidModifierData = new Error(
  "failed to apply some of the field modifiers for the provided data",
);

// a wrapped ErrInvalidModifierData (Go's fmt.Errorf("%w: %w", ...))
// PickPanic is Go's runtime panic in pickParsedFields (the item.(map[string]any)
// assertion on a non-map array item). It is never wrapped as
// InvalidModifierDataError: upstream panics there, and the panic recovery
// middleware answers 500.
export class PickPanic extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "PickPanic";
  }
}

export class InvalidModifierDataError extends Error {
  constructor(override readonly cause: unknown) {
    super(
      `${ErrInvalidModifierData.message}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "InvalidModifierDataError";
  }
}

// a decoded JSON object (Go's map[string]any)
type DataMap = { [key: string]: unknown };

// a field path and its optional modifier (Go's map[string]Modifier)
type Fields = Map<string, Modifier | null>;

// Pick converts data into a []any, map[string]any, etc. (using json marshal->unmarshal)
// containing only the fields from the parsed rawFields expression.
//
// rawFields is a comma separated string of the fields to include.
// Nested fields should be listed with dot-notation.
// Fields value modifiers are also supported using the `:modifier(args)` format (see Modifiers).
//
// In case some data fails to apply against the registered modifiers
// an InvalidModifierDataError is thrown that you can inspect and
// decide to ignore or propagate further up the execution chain.
// Other errors (an invalid rawFields expression, data that cannot be
// encoded or decoded) are thrown as they are.
//
// Example:
//
//	const data = { a: 1, b: 2, c: { c1: 11, c2: 22 } }
//	pick(data, "a,c.c1") // { a: 1, c: { c1: 11 } }
export function pick(
  data: unknown,
  rawFields: string,
  modifiers: ReadonlyMap<string, ModifierFactoryFunc> = Modifiers,
): unknown {
  const parsedFields = parseFields(rawFields, modifiers);

  // marshalize the provided data to ensure that the related json.Marshaler
  // implementations are invoked, and then convert it back to a plain
  // json value that we can further operate on.
  //
  // Note that invalid UTF8 characters are mangled for compatibility
  // with earlier versions and to prevent unnecessary causing an error.
  //
  // Duplicated keys are also enabled for just in case of old jsonv1 data
  // (new db entries are usually validated against the jsonv2 semantics).
  //
  // @todo research other approaches to avoid the double serialization
  // ---
  const encoded = marshal(data, { allowDuplicateNames: true, allowInvalidUTF8: true });

  const decoded = unmarshal(encoded, anyType, { allowDuplicateNames: true });
  // ---

  // special cases to preserve the same fields format when used with single item or search results data.
  const isSearchResult = data instanceof SearchResult;

  try {
    if (isSearchResult) {
      if (isDataMap(decoded)) {
        pickParsedFields(decoded["items"], parsedFields);
      }
    } else {
      pickParsedFields(decoded, parsedFields);
    }
  } catch (err) {
    if (err instanceof PickPanic) {
      throw err;
    }
    throw new InvalidModifierDataError(err);
  }

  return decoded;
}

function parseFields(
  rawFields: string,
  modifiers: ReadonlyMap<string, ModifierFactoryFunc>,
): Fields {
  const t = Tokenizer.fromString(rawFields);

  const fields = t.scanAll();

  const result: Fields = new Map();

  for (const f of fields) {
    const trimmed = trimSpace(f);
    const colon = trimmed.indexOf(":");

    if (colon >= 0) {
      const m = initModifer(trimmed.slice(colon + 1), modifiers);
      result.set(trimmed.slice(0, colon), m);
    } else {
      result.set(trimmed, null);
    }
  }

  return result;
}

function isDataMap(v: unknown): v is DataMap {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickParsedFields(data: unknown, fields: Fields): void {
  if (isDataMap(data)) {
    pickMapFields(data, fields);
    return;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return; // nothing to pick
    }

    if (!isDataMap(data[0])) {
      return; // for now ignore non-map values
    }

    for (const item of data) {
      // Go's item.(map[string]any) assertion panics on a non-map item
      if (!isDataMap(item)) {
        throw new PickPanic(
          `interface conversion: interface {} is ${goTypeName(item)}, not map[string]interface {}`,
        );
      }
      pickMapFields(item, fields);
    }
  }
}

function goTypeName(v: unknown): string {
  if (v === null) {
    return "nil";
  }
  switch (typeof v) {
    case "string":
      return "string";
    case "number":
      return "float64";
    case "boolean":
      return "bool";
  }
  return Array.isArray(v) ? "[]interface {}" : "map[string]interface {}";
}

function pickMapFields(data: DataMap, fields: Fields): void {
  if (fields.size === 0) {
    return; // nothing to pick
  }

  if (fields.has("*")) {
    const m = fields.get("*") ?? null;
    // append all missing root level data keys
    for (const k of Object.keys(data)) {
      let exists = false;

      for (const f of fields.keys()) {
        if ((f + ".").startsWith(k + ".")) {
          exists = true;
          break;
        }
      }

      if (!exists) {
        fields.set(k, m);
      }
    }
  }

  DataLoop: for (const k of Object.keys(data)) {
    const matchingFields: Fields = new Map();
    for (const [f, m] of fields) {
      if ((f + ".").startsWith(k + ".")) {
        matchingFields.set(f, m);
      }
    }

    if (matchingFields.size === 0) {
      delete data[k];
      continue DataLoop;
    }

    // remove the current key from the matching fields path (over a
    // snapshot: the loop changes the map)
    for (const [f, m] of Array.from(matchingFields)) {
      const remains = trimSuffix(trimPrefix(f + ".", k + "."), ".");

      // final key
      if (remains === "") {
        if (m !== null) {
          setOwn(data, k, m.modify(data[k]));
        }
        continue DataLoop;
      }

      // cleanup the old field key and continue with the rest of the field path
      matchingFields.delete(f);
      matchingFields.set(remains, m);
    }

    pickParsedFields(data[k], matchingFields);
  }
}

function trimPrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

function trimSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s.slice(0, s.length - suffix.length) : s;
}
