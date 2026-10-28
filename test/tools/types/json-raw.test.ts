// Upstream: tools/types/json_raw_test.go
//
// Go's invalid UTF-8 byte "\xc3" is a lone surrogate in a JS string.

import { describe, expect, test } from "bun:test";

import { JSONRaw, parseJSONRaw } from "@/tools/types/json-raw";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("ParseJSONRaw", () => {
  const scenarios: [unknown, boolean, string][] = [
    [null, false, `null`],
    [``, false, `null`],
    [new Uint8Array(), false, `null`],
    [new JSONRaw(), false, `null`],
    [`{}`, false, `{}`],
    [`[]`, false, `[]`],
    [123, false, `123`],
    [`""`, false, `""`],
    [`test`, false, `test`],
    [`{"invalid"`, false, `{"invalid"`], // treated as a byte casted string
    [`{"test":1}`, false, `{"test":1}`],
    [bytes(`[1,2,3]`), false, `[1,2,3]`],
    [[1, 2, 3], false, `[1,2,3]`],
    [{ test: 1 }, false, `{"test":1}`],
  ];

  scenarios.forEach(([value, expectError, expectJSON], i) => {
    test(`${i}_${String(value)}`, () => {
      let raw = new JSONRaw();
      let hasErr = false;
      try {
        raw = parseJSONRaw(value);
      } catch {
        hasErr = true;
      }
      expect(hasErr).toBe(expectError);
      expect(raw.marshalJSON()).toBe(expectJSON);
    });
  });
});

describe("JSONRawString", () => {
  const scenarios: [JSONRaw, string][] = [
    [new JSONRaw(), `null`],
    [new JSONRaw(""), `null`],
    [new JSONRaw(`123`), `123`],
    [new JSONRaw(`{"demo":123}`), `{"demo":123}`],
  ];

  scenarios.forEach(([json, expected], i) => {
    test(`${i}_${expected}`, () => {
      expect(json.string()).toBe(expected);
    });
  });
});

describe("JSONRawMarshalJSON", () => {
  const scenarios: [JSONRaw, string][] = [
    [new JSONRaw(), `null`],
    [new JSONRaw(""), `null`],
    [new JSONRaw(`123`), `123`],
    [new JSONRaw(`{"demo":123}`), `{"demo":123}`],
  ];

  scenarios.forEach(([json, expected], i) => {
    test(`${i}_${expected}`, () => {
      expect(json.marshalJSON()).toBe(expected);
    });
  });
});

describe("JSONRawUnmarshalJSON", () => {
  const scenarios: [Uint8Array | null, string][] = [
    [null, `null`],
    [new Uint8Array([0, 1, 2]), "\x00\x01\x02"],
    [bytes("123"), "123"],
    [bytes("test"), "test"],
    [bytes(`{"test":123}`), `{"test":123}`],
  ];

  scenarios.forEach(([json, expectString], i) => {
    test(`${i}_${expectString}`, () => {
      const raw = new JSONRaw();
      raw.unmarshalJSON(json);
      expect(raw.string()).toBe(expectString);
    });
  });
});

describe("JSONRawValue", () => {
  const scenarios: [JSONRaw, string | null][] = [
    [new JSONRaw(), null],
    [new JSONRaw(""), null],
    [new JSONRaw(``), null],
    [new JSONRaw(`test`), `test`],
  ];

  scenarios.forEach(([json, expected], i) => {
    test(`${i}_${json.bytes()}`, () => {
      expect(json.value()).toBe(expected);
    });
  });
});

describe("JSONRawScan", () => {
  const scenarios: [unknown, boolean, string][] = [
    [null, false, `null`],
    [``, false, `null`],
    [new Uint8Array(), false, `null`],
    [new JSONRaw(), false, `null`],
    [new JSONRaw(`test`), false, `test`],
    [`{}`, false, `{}`],
    [`[]`, false, `[]`],
    [123, false, `123`],
    [`""`, false, `""`],
    [`test`, false, `test`],
    [`{"invalid"`, false, `{"invalid"`], // treated as a byte casted string
    [`{"test":1}`, false, `{"test":1}`],
    [bytes(`[1,2,3]`), false, `[1,2,3]`],
    [[1, 2, 3], false, `[1,2,3]`],
    [{ test: "a\ud800" /* invalid utf8 char to test mangling */ }, false, `{"test":"a\ufffd"}`],
  ];

  scenarios.forEach(([value, expectError, expectJSON], i) => {
    test(`${i}_${String(value)}`, () => {
      const raw = new JSONRaw();
      let hasErr = false;
      try {
        raw.scan(value);
      } catch {
        hasErr = true;
      }
      expect(hasErr).toBe(expectError);
      expect(raw.marshalJSON()).toBe(expectJSON);
    });
  });
});

// Not in upstream's tests: the raw text survives byte for byte.
describe("JSONRaw round trip", () => {
  const scenarios: [string, string][] = [
    ["integer-like keys out of order", `{"2":"b","1":"a","10":"c"}`],
    ["integers above 2^53", `{"big":9007199254740993,"bigger":123456789012345678901234567890}`],
    ["unusual whitespace", ` {\t"a" :\r\n [ 1 , 2 ]\n} `],
    ["escapes kept as written", `{"s":"\\u0041\\/\\u00e9\\ud83d\\ude00<>&\\u2028"}`],
    ["number forms", `[1.0,1e2,-0,0.10,1E+2]`],
    ["duplicate names", `{"a":1,"a":2}`],
    ["not json", `{"invalid"`],
  ];

  for (const [name, text] of scenarios) {
    test(name, () => {
      expect(parseJSONRaw(text).string()).toBe(text);
      expect(parseJSONRaw(bytes(text)).string()).toBe(text);
      expect(parseJSONRaw(text).value()).toBe(text);
    });
  }

  test("invalid UTF-8 bytes stay distinguishable", () => {
    const raw = parseJSONRaw(new Uint8Array([0x22, 0xff, 0x22]));
    expect(raw.bytes()).toBe('"\udcff"');
  });
});
