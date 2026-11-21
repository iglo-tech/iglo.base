// JSON value types for test fixtures, request bodies and expected payloads
// (L.3, D44): a value a JSON document can hold, so a JSON object has a real
// value type instead of `unknown`. Parsed JSON stays raw text where the code
// under test keeps it raw (AGENTS.md); these types only describe the values the
// tests build and read back.

export type Json = string | number | boolean | null | Array<Json> | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };
