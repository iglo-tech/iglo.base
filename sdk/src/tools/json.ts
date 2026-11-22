// JSON value types for SDK internals (L.3, D44): a value a JSON document can hold, so a parsed
// or wire JSON object has a real value type instead of `unknown`. Type-only module; it adds no
// runtime code and is not re-exported from the package entry points.

export type Json = string | number | boolean | null | Array<Json> | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };
