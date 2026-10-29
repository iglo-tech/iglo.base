// Upstream: golang.org/x/net v0.61.0 html/token_test.go
//
// Ports the tokenizer tests that do not depend on render.go or on how an
// io.Reader chunks its input. The port reads the whole input at once, so the
// Go tests with zero-byte, one-byte or erroring readers (TestReaderEdgeCases,
// TestMaxBufferReconstruction) and the Buffered() API have no equivalent here
// and are not ported. Benchmarks are not ported.

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { lookup } from "@/tools/html/atom";
import { decodeUTF8, encodeUTF8 } from "@/tools/html/escape";
import {
  CommentToken,
  DoctypeToken,
  EOF,
  EndTagToken,
  ErrorToken,
  SelfClosingTagToken,
  StartTagToken,
  TextToken,
  type Attribute,
  type Token,
  type TokenType,
  Tokenizer,
  ErrBufferExceeded,
  tokenString,
} from "@/tools/html/token";
import { tokenTests } from "@test/tools/html/token-cases";

// newTokenizer returns a tokenizer over the UTF-8 bytes of s.
function tokenizerFor(s: string): Tokenizer {
  return new Tokenizer(encodeUTF8(s));
}

describe("TestTokenizer", () => {
  for (const tt of tokenTests) {
    test(tt.desc, () => {
      const z = tokenizerFor(tt.html);
      z.setAllowCDATA(true);
      if (tt.golden !== "") {
        for (const s of tt.golden.split("$")) {
          if (z.next() === ErrorToken) {
            throw new Error(
              `${tt.desc} token: want ${JSON.stringify(s)} got error ${z.error()?.message}`,
            );
          }
          const actual = tokenString(z.token());
          expect(actual).toBe(s);
        }
      }
      z.next();
      expect(z.error()).toBe(EOF);
    });
  }
});

test("TestMaxBuffer", () => {
  // Exceeding the maximum buffer size generates ErrBufferExceeded.
  const z = tokenizerFor("<" + "t".repeat(10));
  z.setMaxBuf(5);
  expect(z.next()).toBe(ErrorToken);
  expect(z.error()).toBe(ErrBufferExceeded);
  expect(decodeUTF8(z.rawBytes())).toBe("<tttt");
});

test("TestPassthrough", () => {
  // Accumulating the raw output for each parse event should reconstruct the
  // original input.
  for (const tt of tokenTests) {
    const z = tokenizerFor(tt.html);
    const parts: Uint8Array[] = [];
    for (;;) {
      const type = z.next();
      parts.push(z.rawBytes());
      if (type === ErrorToken) {
        break;
      }
    }
    const parsed = Buffer.concat(parts.map((p) => Buffer.from(p))).toString("utf8");
    expect(parsed, tt.desc).toBe(tt.html);
  }
});

test("TestBufAPI", () => {
  const s = "0<a>1</a>2<b>3<a>4<a>5</a>6</b>7</a>8<a/>9";
  const z = tokenizerFor(s);
  const result: Uint8Array[] = [];
  let depth = 0;
  loop: for (;;) {
    const tt = z.next();
    switch (tt) {
      case ErrorToken:
        expect(z.error()).toBe(EOF);
        break loop;
      case TextToken:
        if (depth > 0) {
          result.push(z.text());
        }
        break;
      case StartTagToken:
      case EndTagToken: {
        const [tn] = z.tagName();
        if (tn.length === 1 && tn[0] === "a".charCodeAt(0)) {
          if (tt === StartTagToken) {
            depth++;
          } else {
            depth--;
          }
        }
        break;
      }
    }
  }
  expect(decodeUTF8(Buffer.concat(result.map((r) => Buffer.from(r))))).toBe("14567");
});

test("TestConvertNewlines", () => {
  // The tokenizer normalizes CR and CRLF in text to LF. Each input is plain
  // text, so the text tokens are the converted input.
  const testCases: Record<string, string> = {
    "Mac\rDOS\r\nUnix\n": "Mac\nDOS\nUnix\n",
    "Unix\nMac\rDOS\r\n": "Unix\nMac\nDOS\n",
    "DOS\r\nDOS\r\nDOS\r\n": "DOS\nDOS\nDOS\n",
    "": "",
    "\n": "\n",
    "\n\r": "\n\n",
    "\r": "\n",
    "\r\n": "\n",
    "\r\n\n": "\n\n",
    "\r\n\r": "\n\n",
    "\r\n\r\n": "\n\n",
    "\r\r": "\n\n",
    "\r\r\n": "\n\n",
    "\r\r\n\n": "\n\n\n",
    "\r\r\r\n": "\n\n\n",
    "\r \n": "\n \n",
    xyz: "xyz",
  };
  for (const [input, want] of Object.entries(testCases)) {
    const z = tokenizerFor(input);
    let got = "";
    for (let tt = z.next(); tt !== ErrorToken; tt = z.next()) {
      got += decodeUTF8(z.text());
    }
    expect(got, JSON.stringify(input)).toBe(want);
  }
});

test("TestSelfClosingTagValueConfusion", () => {
  const z = tokenizerFor(`<p a=/>`);
  expect(z.next()).toBe(StartTagToken);
});

test("TestUnicodeAttributeCase", () => {
  // <div a="1" A="1"> is resolved to <div a="1"> because a and A are considered
  // duplicate attribute names. Different unicode cases are not considered equal
  // though, so <div ä="1" Ä="1"> is tokenized as <div ä="1" Ä="1">.
  const f = `<div ä="1" Ä="1">`;
  const z = tokenizerFor(f);
  expect(z.next()).toBe(StartTagToken);
  const tok = z.token();
  expect(tok.attr.length).toBe(2);
  expect(tok.attr[0]!.key).toBe("ä");
  expect(tok.attr[1]!.key).toBe("Ä");
});

// The html5lib tokenizer tests (TestHTML5LibTests).

interface H5Output {
  type: TokenType;
  dataAtom: string;
  data: string;
  attr: Attribute[];
}

interface H5Test {
  description: string;
  input: string;
  inputBytes: Uint8Array;
  initialStates: string[];
  output: H5Output[];
}

// unescapeUnicode is the Go helper: each \uXXXX becomes the UTF-8-like bytes of
// that code point, without checking surrogates, so the result can be invalid UTF-8.
const unicodeRegexp = /\\u([0-9a-fA-F]{4})/g;

function encodeRawRune(n: number): number[] {
  if (n <= 0x7f) {
    return [n];
  }
  if (n <= 0x7ff) {
    return [0xc0 | (n >> 6), 0x80 | (n & 0x3f)];
  }
  if (n <= 0xffff) {
    return [0xe0 | (n >> 12), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)];
  }
  return [0xf0 | (n >> 18), 0x80 | ((n >> 12) & 0x3f), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)];
}

function unescapeUnicodeBytes(s: string): Uint8Array {
  const out: number[] = [];
  let last = 0;
  for (const m of s.matchAll(unicodeRegexp)) {
    out.push(...encodeUTF8(s.slice(last, m.index)));
    out.push(...encodeRawRune(parseInt(m[1]!, 16)));
    last = m.index + m[0].length;
  }
  out.push(...encodeUTF8(s.slice(last)));
  return Uint8Array.from(out);
}

function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const cx = x[i]!.codePointAt(0)!;
    const cy = y[i]!.codePointAt(0)!;
    if (cx !== cy) {
      return cx < cy ? -1 : 1;
    }
  }
  return x.length - y.length;
}

// sortTokenAttributes sorts each token's attributes by namespace+key+val, as the Go test does.
function sortTokenAttributes(tokens: H5Output[]): void {
  for (const token of tokens) {
    token.attr.sort((a, b) =>
      compareCodePoints(a.namespace + a.key + a.val, b.namespace + b.key + b.val),
    );
  }
}

const h5libDir = `${import.meta.dir}/testdata/html5lib-tests/tokenizer`;

// loadH5Tests reads the tests the way h5libTest.UnmarshalJSON does.
function loadH5Tests(file: string): H5Test[] {
  const data = JSON.parse(readFileSync(`${h5libDir}/${file}`, "utf8")) as {
    tests?: {
      description: string;
      input: string;
      doubleEscaped?: boolean;
      initialStates?: string[];
      output: unknown[][];
    }[];
  };
  // xmlViolation.test has no "tests" key. Go's loader then reuses the previous file's
  // slice; here such a file has no cases.
  return (data.tests ?? []).map((tc) => {
    const doubleEscaped = tc.doubleEscaped === true;
    const inputBytes = doubleEscaped ? unescapeUnicodeBytes(tc.input) : encodeUTF8(tc.input);
    const output: H5Output[] = tc.output.map((testToken) => {
      const kind = testToken[0] as string;
      const token: H5Output = { type: 0, dataAtom: "", data: "", attr: [] };
      switch (kind) {
        case "DOCTYPE":
          token.type = DoctypeToken;
          if (testToken[1] !== null && testToken[1] !== undefined) {
            token.data = testToken[1] as string;
          }
          break;
        case "StartTag":
          token.type =
            testToken.length === 4 && testToken[3] === true ? SelfClosingTagToken : StartTagToken;
          token.data = testToken[1] as string;
          break;
        case "EndTag":
          token.type = EndTagToken;
          token.data = testToken[1] as string;
          break;
        case "Comment":
          token.type = CommentToken;
          token.data = testToken[1] as string;
          break;
        case "Character":
          token.type = TextToken;
          token.data = testToken[1] as string;
          break;
        default:
          throw new Error(`unknown token type ${kind}`);
      }

      if (doubleEscaped) {
        token.data = decodeUTF8(unescapeUnicodeBytes(token.data));
      }

      if (kind === "DOCTYPE" || kind === "StartTag" || kind === "EndTag") {
        token.dataAtom = lookup(token.data);
      }

      if ((kind === "StartTag" || kind === "EndTag") && testToken.length > 2) {
        for (const [k, v] of Object.entries(testToken[2] as Record<string, string>)) {
          token.attr.push({ namespace: "", key: k, val: v });
        }
      }
      return token;
    });
    return {
      description: tc.description,
      input: decodeUTF8(inputBytes),
      inputBytes,
      initialStates: tc.initialStates ?? [],
      output,
    };
  });
}

const h5SkipTests = new Set<string>([
  // We emit a comment token here, instead of no token. This is a specification
  // divergence that we may want to fix.
  "test1.test/Empty end tag",
  "test2.test/Empty end tag with following characters",
  "test2.test/Empty end tag with following tag",
  "test2.test/Empty end tag with following comment",
  "test2.test/Empty end tag with following end tag",
  "test3.test/</>",
  "test4.test/CR EOF after doctype name",
  "test4.test/Doctype public case-sensitivity (1)",
  "test4.test/Doctype public case-sensitivity (2)",
  "test4.test/Doctype system case-sensitivity (1)",
  "test4.test/Doctype system case-sensitivity (2)",
]);

describe("TestHTML5LibTests", () => {
  const files = readdirSync(h5libDir)
    .filter((f) => f.endsWith(".test"))
    .toSorted();
  for (const file of files) {
    for (const tc of loadH5Tests(file)) {
      const name = `${file}/${tc.description}`;
      // Go skips these cases with t.Skip: known divergences, initial states and DOCTYPE inputs.
      const skip =
        h5SkipTests.has(name) || tc.initialStates.length > 0 || tc.input.includes("<!DOCTYPE");
      (skip ? test.skip : test)(name, () => {
        const z = new Tokenizer(tc.inputBytes);
        const tokens: H5Output[] = [];
        for (;;) {
          if (z.next() === ErrorToken) {
            if (z.error() === EOF) {
              break;
            }
            throw new Error(`Error: ${z.error()?.message}`);
          }
          const t: Token = z.token();
          tokens.push({ type: t.type, dataAtom: t.dataAtom, data: t.data, attr: t.attr });
        }
        sortTokenAttributes(tokens);
        sortTokenAttributes(tc.output);
        expect(tokens, tc.input).toEqual(tc.output);
      });
    }
  }
});
