// Upstream: tools/search/token_functions_test.go

import { describe, expect, test } from "bun:test";

import {
  type Token,
  TokenFunction,
  TokenIdentifier,
  TokenNumber,
  TokenText,
  TokenWS,
} from "@/search/fexpr/scanner";
import type { ResolverResult } from "@/search/simple-field-resolver";
import { NullFallbackDisabled, NullFallbackEnforced } from "@/search/simple-field-resolver";
import {
  type ArgTokenResolverFunc,
  TokenFunctions,
  type TokenFunction as TokenFunctionResolver,
} from "@/search/token-functions";
import { pseudorandomString } from "@/tools/security/random";

import { compareResults, createTestDB, tok } from "@test/search/support";

interface Scenario {
  name: string;
  args: Token[];
  resolver: ArgTokenResolverFunc;
  result: ResolverResult | null;
  expectErr: boolean;
}

interface ExecScenario {
  name: string;
  coords: [string, string, string, string]; // [lonA, latA, lonB, latB]
  expected: string;
}

// Go's TokenFunctions[name] lookup with the registration check
function registered(name: string): TokenFunctionResolver {
  const fn = TokenFunctions.get(name);
  if (fn === undefined) {
    throw new Error(`Expected ${name} token function to be registered.`);
  }
  return fn;
}

const baseTokenResolver: ArgTokenResolverFunc = (t) => {
  const placeholder = "t" + pseudorandomString(5);
  return { identifier: "{:" + placeholder + "}", params: { [placeholder]: t.literal } };
};

const errorTokenResolver: ArgTokenResolverFunc = () => {
  throw new Error("test");
};

function runScenario(s: Scenario, fn: TokenFunctionResolver): void {
  let result: ResolverResult | null = null;
  let err: unknown;
  try {
    result = fn(s.resolver, ...s.args);
  } catch (e) {
    err = e;
  }
  expect(err !== undefined).toBe(s.expectErr);
  compareResults(s.result, result);
}

function coordToken(literal: string) {
  return tok(literal, TokenNumber);
}

describe("TestTokenFunctionsGeoDistance", () => {
  const fn = registered("geoDistance");

  test("geoDistance token function is registered", () => {
    expect(TokenFunctions.has("geoDistance")).toBe(true);
  });

  const scenarios: Scenario[] = [
    {
      name: "no args",
      args: [],
      resolver: baseTokenResolver,
      result: null,
      expectErr: true,
    },
    {
      name: "< 4 args",
      args: [coordToken("1"), coordToken("2"), coordToken("3")],
      resolver: baseTokenResolver,
      result: null,
      expectErr: true,
    },
    {
      name: "> 4 args",
      args: [coordToken("1"), coordToken("2"), coordToken("3"), coordToken("4"), coordToken("5")],
      resolver: baseTokenResolver,
      result: null,
      expectErr: true,
    },
    {
      name: "unsupported function argument",
      args: [tok("1", TokenFunction), coordToken("2"), coordToken("3"), coordToken("4")],
      resolver: baseTokenResolver,
      result: null,
      expectErr: true,
    },
    {
      name: "unsupported text argument",
      args: [tok("1", TokenText), coordToken("2"), coordToken("3"), coordToken("4")],
      resolver: baseTokenResolver,
      result: null,
      expectErr: true,
    },
    {
      name: "4 valid arguments but with resolver error",
      args: [coordToken("1"), coordToken("2"), coordToken("3"), coordToken("4")],
      resolver: errorTokenResolver,
      result: null,
      expectErr: true,
    },
    {
      name: "4 valid arguments",
      args: [coordToken("1"), coordToken("2"), coordToken("3"), coordToken("4")],
      resolver: baseTokenResolver,
      result: {
        nullFallback: NullFallbackDisabled,
        identifier: `(6371 * acos(min(1, max(-1, cos(radians({:latA})) * cos(radians({:latB})) * cos(radians({:lonB}) - radians({:lonA})) + sin(radians({:latA})) * sin(radians({:latB}))))))`,
        params: {
          lonA: 1,
          latA: 2,
          lonB: 3,
          latB: 4,
        },
      },
      expectErr: false,
    },
    {
      name: "mixed arguments",
      args: [
        tok("null", TokenIdentifier),
        coordToken("2"),
        tok("false", TokenIdentifier),
        coordToken("4"),
      ],
      resolver: baseTokenResolver,
      result: {
        nullFallback: NullFallbackDisabled,
        identifier: `(6371 * acos(min(1, max(-1, cos(radians({:latA})) * cos(radians({:latB})) * cos(radians({:lonB}) - radians({:lonA})) + sin(radians({:latA})) * sin(radians({:latB}))))))`,
        params: {
          lonA: "null",
          latA: 2,
          lonB: false,
          latB: 4,
        },
      },
      expectErr: false,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      runScenario(s, fn);
    });
  }
});

describe("TestTokenFunctionsGeoDistanceExec", () => {
  const fn = registered("geoDistance");

  const scenarios: ExecScenario[] = [
    {
      name: "distinct points",
      coords: ["23.23033854945808", "42.713146090563384", "23.44920680886216", "42.7078484153991"],
      expected: "17.89",
    },
    {
      name: "identical points (rounding check with 8 lat)",
      // 8 is an example latitude where rounding happens to result in > 1.0
      coords: ["0", "8", "0", "8"],
      expected: "0.00",
    },
    {
      name: "identical points (rounding check with 45 lat)",
      // 45 is an example latitude where rounding happens to result in > 1.0
      coords: ["0", "45", "0", "45"],
      expected: "0.00",
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const [lonA, latA, lonB, latB] = s.coords;
      const result = fn(
        baseTokenResolver,
        coordToken(lonA),
        coordToken(latA),
        coordToken(lonB),
        coordToken(latB),
      );

      const testDB = createTestDB();
      try {
        const column = testDB.db
          .newQuery("select " + result.identifier)
          .bind(result.params ?? {})
          .column<number>();

        expect(column.length).toBe(1);
        expect(column[0]?.toFixed(2)).toBe(s.expected);
      } finally {
        testDB.close();
      }
    });
  }
});

describe("TestTokenFunctionsStrftime", () => {
  const fn = registered("strftime");

  test("strftime token function is registered", () => {
    expect(TokenFunctions.has("strftime")).toBe(true);
  });

  const scenarios: Scenario[] = [
    {
      name: "no args",
      args: [],
      resolver: baseTokenResolver,
      result: null,
      expectErr: true,
    },

    // format arg
    // -----------------------------------------------------------
    {
      name: "(format arg) invalid token type function",
      args: [tok("abc", TokenFunction)],
      resolver: baseTokenResolver,
      result: null,
      expectErr: true,
    },
    {
      name: "(format arg) invalid token type ws",
      args: [tok("abc", TokenWS)],
      resolver: baseTokenResolver,
      result: null,
      expectErr: true,
    },
    {
      name: "(format arg) invalid token type number",
      args: [tok("abc", TokenNumber)],
      resolver: baseTokenResolver,
      result: null,
      expectErr: true,
    },
    {
      name: "(format arg) invalid token type identifier",
      args: [tok("abc", TokenIdentifier)],
      resolver: baseTokenResolver,
      result: null,
      expectErr: true,
    },
    {
      name: "(format arg) valid token type text",
      args: [tok("abc", TokenText)],
      resolver: baseTokenResolver,
      result: {
        nullFallback: NullFallbackEnforced,
        identifier: `strftime({:format})`,
        params: { format: "abc" },
      },
      expectErr: false,
    },

    // format + time-value args
    // -----------------------------------------------------------
    {
      name: "(format arg) invalid token type function",
      args: [tok("1", TokenText), tok("2", TokenFunction)],
      resolver: baseTokenResolver,
      result: null,
      expectErr: true,
    },
    {
      name: "(format arg) invalid token type ws",
      args: [tok("1", TokenText), tok("2", TokenWS)],
      resolver: baseTokenResolver,
      result: null,
      expectErr: true,
    },
    {
      name: "(format arg) valid token type number",
      args: [tok("1", TokenText), tok("2", TokenNumber)],
      resolver: baseTokenResolver,
      result: {
        nullFallback: NullFallbackEnforced,
        identifier: `strftime({:format},{:time})`,
        params: { format: "1", time: "2" },
      },
      expectErr: false,
    },
    {
      name: "(format arg) valid token type identifier",
      args: [tok("1", TokenText), tok("2", TokenIdentifier)],
      resolver: baseTokenResolver,
      result: {
        nullFallback: NullFallbackEnforced,
        identifier: `strftime({:format},{:time})`,
        params: { format: "1", time: "2" },
      },
      expectErr: false,
    },
    {
      name: "(format arg) valid token type text",
      args: [tok("1", TokenText), tok("2", TokenText)],
      resolver: baseTokenResolver,
      result: {
        nullFallback: NullFallbackEnforced,
        identifier: `strftime({:format},{:time})`,
        params: { format: "1", time: "2" },
      },
      expectErr: false,
    },

    // format + time-value + modifier args
    // -----------------------------------------------------------
    {
      name: "(modifiers arg) invalid token type function",
      args: [
        tok("1", TokenText), // valid format
        tok("2", TokenText), // valid time-value
        tok("3", TokenText), // valid modifier
        tok("4", TokenFunction),
      ],
      resolver: baseTokenResolver,
      result: null,
      expectErr: true,
    },
    {
      name: "(modifiers arg) invalid token type ws",
      args: [
        tok("1", TokenText), // valid format
        tok("2", TokenText), // valid time-value
        tok("3", TokenText), // valid modifier
        tok("4", TokenWS),
      ],
      resolver: baseTokenResolver,
      result: null,
      expectErr: true,
    },
    {
      name: "(modifiers arg) valid token type number",
      args: [
        tok("1", TokenText), // valid format
        tok("2", TokenText), // valid time-value
        tok("3", TokenText), // valid modifier
        tok("4", TokenNumber),
      ],
      resolver: baseTokenResolver,
      result: null,
      expectErr: true,
    },
    {
      name: "(modifiers arg) valid token type identifier",
      args: [
        tok("1", TokenText), // valid format
        tok("2", TokenText), // valid time-value
        tok("3", TokenText), // valid modifier
        tok("4", TokenIdentifier),
      ],
      resolver: baseTokenResolver,
      result: null,
      expectErr: true,
    },
    {
      name: "(modifiers arg) valid token type text",
      args: [
        tok("1", TokenText), // valid format
        tok("2", TokenText), // valid time-value
        tok("3", TokenText), // valid modifier
        tok("4", TokenText), // valid modifier
      ],
      resolver: baseTokenResolver,
      result: {
        nullFallback: NullFallbackEnforced,
        identifier: `strftime({:format},{:time},{:m1},{:m2})`,
        params: { format: "1", time: "2", m1: "3", m2: "4" },
      },
      expectErr: false,
    },

    // -----------------------------------------------------------

    {
      name: "= 10 args limit",
      args: [
        tok("1", TokenText),
        tok("2", TokenText),
        tok("3", TokenText),
        tok("4", TokenText),
        tok("5", TokenText),
        tok("6", TokenText),
        tok("7", TokenText),
        tok("8", TokenText),
        tok("9", TokenText),
        tok("10", TokenText),
      ],
      resolver: baseTokenResolver,
      result: {
        nullFallback: NullFallbackEnforced,
        identifier: `strftime({:format},{:time},{:m1},{:m2},{:m3},{:m4},{:m5},{:m6},{:m7},{:m8})`,
        params: {
          format: "1",
          time: "2",
          m1: "3",
          m2: "4",
          m3: "5",
          m4: "6",
          m5: "7",
          m6: "8",
          m7: "9",
          m8: "10",
        },
      },
      expectErr: false,
    },
    {
      name: "> 10 args limit",
      args: [
        tok("1", TokenText),
        tok("2", TokenText),
        tok("3", TokenText),
        tok("4", TokenText),
        tok("5", TokenText),
        tok("6", TokenText),
        tok("7", TokenText),
        tok("8", TokenText),
        tok("9", TokenText),
        tok("10", TokenText),
        tok("11", TokenText),
      ],
      resolver: baseTokenResolver,
      result: null,
      expectErr: true,
    },
    {
      name: "valid arguments but with resolver error",
      args: [tok("1", TokenText), tok("2", TokenText), tok("3", TokenText)],
      resolver: errorTokenResolver,
      result: null,
      expectErr: true,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      runScenario(s, fn);
    });
  }
});

describe("TestTokenFunctionsStrftimeExec", () => {
  const fn = registered("strftime");

  test("strftime evaluates to 2027-06 in the database", () => {
    const result = fn(
      baseTokenResolver,
      tok("%Y-%m", TokenText),
      tok("2026-01-02 01:02:03.456Z", TokenText),
      tok("+1 years", TokenText),
      tok("+5 months", TokenText),
    );

    const testDB = createTestDB();
    try {
      const column = testDB.db
        .newQuery("select " + result.identifier)
        .bind(result.params ?? {})
        .column<string>();

      expect(column.length).toBe(1);
      expect(column[0]).toBe("2027-06");
    } finally {
      testDB.close();
    }
  });
});
