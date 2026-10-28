// Upstream: tools/types/json_raw.go
//
// The raw text is kept as it was received, byte for byte (Go keeps the
// []byte): it is never parsed, so integer-like keys keep their order and
// large numbers their digits. Bytes are converted to text the way Go reads
// them (bytesToText), so invalid UTF-8 survives as lone surrogates.

import { type JSONMarshaler, bytesToText, marshal } from "@/tools/types/go-json";

// ParseJSONRaw (parseJSONRaw) creates a new JSONRaw from the provided
// value (a JSONRaw, number, string, Uint8Array, etc.).
export function parseJSONRaw(value: unknown): JSONRaw {
  const result = new JSONRaw();
  result.scan(value);
  return result;
}

// JSONRaw defines a json value type that is safe for db read/write.
export class JSONRaw implements JSONMarshaler {
  constructor(private raw = "") {}

  // the raw text ("" for a nil/empty JSONRaw)
  bytes(): string {
    return this.raw;
  }

  // String returns the raw json text ("null" when empty).
  string(): string {
    return this.marshalJSON();
  }

  toString(): string {
    return this.string();
  }

  marshalJSON(): string {
    return this.raw.length === 0 ? "null" : this.raw;
  }

  // UnmarshalJSON stores b as it is.
  unmarshalJSON(b: string | Uint8Array | null | undefined): void {
    this.raw = b === null || b === undefined ? "" : bytesToText(b);
  }

  // Value implements the db driver Valuer: null when empty, else the text.
  value(): string | null {
    return this.raw.length === 0 ? null : this.string();
  }

  // Scan stores strings, bytes and JSONRaw values as they are and marshals
  // anything else (json.Deterministic, invalid UTF-8 replaced).
  scan(value: unknown): void {
    let data: string | undefined;
    if (value === null || value === undefined) {
      // no cast is needed
    } else if (value instanceof Uint8Array || typeof value === "string") {
      data = bytesToText(value);
    } else if (value instanceof JSONRaw) {
      data = value.raw;
    } else {
      data = marshal(value, { allowInvalidUTF8: true });
    }
    this.unmarshalJSON(data);
  }
}
