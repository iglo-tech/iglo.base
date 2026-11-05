// M7.1c: the faster JSON writer (fast quote, no per-object copies, a
// marshaler's canonical text used as it is) writes exactly what the M7.1b
// writer wrote. The reference is a copy of that writer
// (go-json-before-m71c.ts); both are fed the same generated values and
// the same generated JSON texts, errors included.

import { describe, expect, test } from "bun:test";

import {
  isCanonicalCompactJSON,
  marshal,
  marshalPartial,
  type MarshalOptions,
} from "@/tools/types/go-json";
import { JSONRaw } from "@/tools/types/json-raw";
import {
  marshal as marshalBefore,
  marshalPartial as marshalPartialBefore,
} from "@test/tools/types/go-json-before-m71c";

// a small deterministic generator
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const optionSets: MarshalOptions[] = [
  {},
  { allowInvalidUTF8: true },
  { allowDuplicateNames: true },
  { allowDuplicateNames: true, allowInvalidUTF8: true },
  { legacy: true },
];

function outcome(fn: () => string, partial: (e: unknown) => string): string {
  try {
    return "ok:" + fn();
  } catch (err) {
    return "err:" + (err as Error).message + "|" + partial(err);
  }
}

function same(value: unknown, opts: MarshalOptions): void {
  const before = outcome(() => marshalBefore(value, opts), marshalPartialBefore);
  const after = outcome(() => marshal(value, opts), marshalPartial);
  expect(after).toBe(before);
}

const pieces = [
  "",
  "a",
  "Zażółć gęślą jaźń",
  "日本語",
  "😀 emoji",
  'quote " and \\ backslash',
  "tab\t nl\n cr\r bs\b ff\f",
  "\u0000\u0001\u001f\u007f",
  "<tag> & more",
  "line sep ",
  "lone \ud800 high",
  "lone \udc00 low",
  "/slash/",
  "￿",
  "a😀b",
];

function randomString(r: () => number): string {
  let s = "";
  const n = Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    s += pieces[Math.floor(r() * pieces.length)];
  }
  return s;
}

function randomJSONText(r: () => number, depth = 0): string {
  const ws = () => (r() < 0.25 ? [" ", "\n", "\t", "  "][Math.floor(r() * 4)]! : "");
  const kind = Math.floor(r() * (depth > 3 ? 6 : 8));
  switch (kind) {
    case 0:
      return "null";
    case 1:
      return r() < 0.5 ? "true" : "false";
    case 2:
      return [
        "0",
        "-0",
        "1",
        "-12",
        "3.5",
        "1e5",
        "1E+5",
        "1.5e-7",
        "12345678901234567890",
        "-9223372036854775808",
        "0.1",
        "01",
        "1.",
        "-",
        ".5",
      ][Math.floor(r() * 15)]!;
    case 3:
    case 4:
    case 5: {
      const raw = randomString(r);
      switch (Math.floor(r() * 5)) {
        case 0:
          return JSON.stringify(raw);
        case 1:
          // escapes in the other spellings
          return JSON.stringify(raw)
            .replaceAll("/", "\\/")
            .replaceAll("é", "\\u00e9")
            .replaceAll("\\n", "\\u000A");
        case 2:
          return '"' + raw.replaceAll('"', "").replaceAll("\\", "") + '"';
        case 3:
          return '"\\u001F\\u001f\\u0007\\u007f\\u00e9\\ud83d\\ude00\\ud800"';
        default:
          return JSON.stringify(raw);
      }
    }
    case 6: {
      const n = Math.floor(r() * 4);
      const items: string[] = [];
      for (let i = 0; i < n; i++) {
        items.push(ws() + randomJSONText(r, depth + 1) + ws());
      }
      return "[" + ws() + items.join(",") + "]";
    }
    default: {
      const n = Math.floor(r() * 4);
      const items: string[] = [];
      const names = ["a", "b", "1", "10", "2", "a", "é", "😀", "\\u0041", "\\/"];
      for (let i = 0; i < n; i++) {
        const name =
          r() < 0.7
            ? names[Math.floor(r() * names.length)]!
            : // oxlint-disable-next-line no-control-regex
              randomString(r).replace(/["\\\u0000-\u001f]/g, "");
        items.push(
          ws() + '"' + name + '"' + ws() + ":" + ws() + randomJSONText(r, depth + 1) + ws(),
        );
      }
      return "{" + ws() + items.join(",") + "}";
    }
  }
}

function mutate(r: () => number, s: string): string {
  if (s.length === 0 || r() < 0.5) {
    return s;
  }
  const i = Math.floor(r() * s.length);
  switch (Math.floor(r() * 4)) {
    case 0:
      return s.slice(0, i) + s.slice(i + 1);
    case 1:
      return (
        s.slice(0, i) +
        ["{", "}", "[", "]", ",", ":", '"', "\\", " ", "0", "-"][Math.floor(r() * 11)] +
        s.slice(i)
      );
    case 2:
      return s.slice(0, i);
    default:
      return s + [" ", ",", "x", "]"][Math.floor(r() * 4)];
  }
}

describe("a marshaler's text", () => {
  test("is written as the M7.1b writer wrote it (generated texts, all option sets)", () => {
    const r = rng(7);
    let accepted = 0;
    for (let i = 0; i < 6000; i++) {
      const text = mutate(r, randomJSONText(r));
      for (const opts of optionSets) {
        same({ k: new JSONRaw(text), list: [new JSONRaw(text)] }, opts);
      }
      if (isCanonicalCompactJSON(text)) {
        accepted++;
        // the fast check only accepts text the reformatting leaves alone
        expect(marshalBefore(new JSONRaw(text), { allowDuplicateNames: true })).toBe(text);
      }
    }
    expect(accepted).toBeGreaterThan(500);
  });

  test("canonical text is recognized", () => {
    for (const text of [
      "null",
      "0",
      "-1.5e3",
      '"a"',
      '"\\u0001\\"\\\\\\n"',
      '"日本語😀"',
      '{"a":[1,2,{"b":null}],"c":"d"}',
      "[]",
      "{}",
      '{"b":1,"a":2,"a":3}',
    ]) {
      expect(isCanonicalCompactJSON(text)).toBe(true);
    }
    for (const text of [
      "",
      " 1",
      "1 ",
      '{"a": 1}',
      "[1, 2]",
      '"\\/"',
      '"\\u00e9"',
      '"\\u001F"',
      '"\\u0008"',
      '"\\ud800"',
      '"\ud800"',
      "01",
      "1.",
      "-",
      "[1,]",
      "{,}",
      '{"a"}',
      "nul",
      "1e",
    ]) {
      expect(isCanonicalCompactJSON(text)).toBe(false);
    }
  });
});

function randomValue(r: () => number, depth = 0): unknown {
  const kind = Math.floor(r() * (depth > 3 ? 8 : 11));
  switch (kind) {
    case 0:
      return null;
    case 1:
      return undefined;
    case 2:
      return r() < 0.5;
    case 3:
      return [0, -0, 1, -1, 1.5, 1e21, 1e-7, 123456789012345680000, 2 ** 53, -(2 ** 53)][
        Math.floor(r() * 10)
      ];
    case 4:
      return [0n, 12345678901234567890n, -9223372036854775808n][Math.floor(r() * 3)];
    case 5:
    case 6:
      return randomString(r);
    case 7:
      return new JSONRaw(r() < 0.5 ? randomJSONText(r) : "");
    case 8: {
      const n = Math.floor(r() * 4);
      return Array.from({ length: n }, () => randomValue(r, depth + 1));
    }
    case 9: {
      const o: Record<string, unknown> = {};
      const n = Math.floor(r() * 6);
      const names = ["id", "b", "a", "10", "2", "é", "😀", "", "x y", '"', "__proto__", ""];
      for (let i = 0; i < n; i++) {
        const name = r() < 0.8 ? names[Math.floor(r() * names.length)]! : randomString(r);
        Object.defineProperty(o, name, {
          value: randomValue(r, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return o;
    }
    default: {
      const m = new Map<string, unknown>();
      const n = Math.floor(r() * 5);
      for (let i = 0; i < n; i++) {
        m.set(randomString(r), randomValue(r, depth + 1));
      }
      return m;
    }
  }
}

describe("values", () => {
  test("are written as the M7.1b writer wrote them (generated values, all option sets)", () => {
    const r = rng(11);
    for (let i = 0; i < 4000; i++) {
      const value = randomValue(r);
      for (const opts of optionSets) {
        same(value, opts);
      }
    }
  });
});
