// Upstream: tools/mailer/mailer_test.go (TestAddressesToStrings,
// TestDetectReaderMimeType), with the Go standard library tables the
// message encoding depends on: mime/encodedword_test.go (TestEncodeWord,
// the UTF-8 inputs) and mime/quotedprintable/writer_test.go (TestWriter)

import { describe, expect, test } from "bun:test";

import { BEncoding, QEncoding, quotedPrintable, wordEncode } from "@/mail/go-mime";
import { addressesToStrings, detectReaderMimeType } from "@/mail/mailer";

describe("addressesToStrings", () => {
  const scenarios: [boolean, { name: string; address: string }[], string[]][] = [
    [
      true,
      [
        { name: "John Doe", address: "test1@example.com" },
        { name: "Jane Doe", address: "test2@example.com" },
      ],
      [`"John Doe" <test1@example.com>`, `"Jane Doe" <test2@example.com>`],
    ],
    [
      true,
      [
        { name: "John Doe", address: "test1@example.com" },
        { name: "", address: "test2@example.com" },
      ],
      [`"John Doe" <test1@example.com>`, `test2@example.com`],
    ],
    [
      false,
      [
        { name: "John Doe", address: "test1@example.com" },
        { name: "Jane Doe", address: "test2@example.com" },
      ],
      [`test1@example.com`, `test2@example.com`],
    ],
  ];

  for (const [withName, addresses, expected] of scenarios) {
    test(`${withName}_${JSON.stringify(addresses)}`, () => {
      expect(addressesToStrings(addresses, withName)).toEqual(expected);
    });
  }
});

test("detectReaderMimeType", async () => {
  // ensure that it is large enough to remain after the signature sniffing
  const str = "#!/bin/node\n" + "a".repeat(10000);
  const blob = new Blob([str]);

  expect(await detectReaderMimeType(blob)).toBe("text/javascript");
  expect(await blob.text()).toBe(str);
});

test("wordEncode (Go's TestEncodeWord)", () => {
  const utf8 = "utf-8";
  const iso88591 = "iso-8859-1";
  const tests: [typeof QEncoding, string, string, string][] = [
    [QEncoding, utf8, "François-Jérôme", "=?utf-8?q?Fran=C3=A7ois-J=C3=A9r=C3=B4me?="],
    [BEncoding, utf8, "Café", "=?utf-8?b?Q2Fmw6k=?="],
    [QEncoding, iso88591, "La Seleção", "=?iso-8859-1?q?La_Sele=C3=A7=C3=A3o?="],
    [QEncoding, utf8, "", ""],
    [QEncoding, utf8, "A", "A"],
    [QEncoding, iso88591, "a", "a"],
    [QEncoding, utf8, "123 456", "123 456"],
    [
      QEncoding,
      utf8,
      "\t !\"#$%&'()*+,-./ :;<>?@[\\]^_`{|}~",
      "\t !\"#$%&'()*+,-./ :;<>?@[\\]^_`{|}~",
    ],
    [QEncoding, utf8, "é".repeat(10), "=?utf-8?q?" + "=C3=A9".repeat(10) + "?="],
    [QEncoding, utf8, "é".repeat(11), "=?utf-8?q?" + "=C3=A9".repeat(10) + "?= =?utf-8?q?=C3=A9?="],
  ];
  for (const [enc, charset, src, exp] of tests) {
    expect(wordEncode(enc, charset, src)).toBe(exp);
  }

  // TestEncodedWordLength: no encoded-word is longer than 75 characters
  for (const [enc, src] of [
    [QEncoding, "à".repeat(30)],
    [QEncoding, "é".repeat(60)],
    [BEncoding, "ï".repeat(25)],
    [BEncoding, "ô".repeat(37)],
    [QEncoding, "{$firstname} Bienvendio a Apostolica, aquà inicia el camino de tu"],
  ] as const) {
    for (const word of wordEncode(enc, "utf-8", src).split(" ")) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
  }
});

test("quotedPrintable (Go's TestWriter)", () => {
  const tests: [string, string][] = [
    ["", ""],
    ["foo bar", "foo bar"],
    ["foo bar=", "foo bar=3D"],
    ["foo bar\r", "foo bar\r\n"],
    ["foo bar\r\r", "foo bar\r\n\r\n"],
    ["foo bar\n", "foo bar\r\n"],
    ["foo bar\r\n", "foo bar\r\n"],
    ["foo bar\r\r\n", "foo bar\r\n\r\n"],
    ["foo bar ", "foo bar=20"],
    ["foo bar\t", "foo bar=09"],
    ["foo bar  ", "foo bar =20"],
    ["foo bar \n", "foo bar=20\r\n"],
    ["foo bar \r", "foo bar=20\r\n"],
    ["foo bar \r\n", "foo bar=20\r\n"],
    ["foo bar  \n", "foo bar =20\r\n"],
    ["foo bar  \n ", "foo bar =20\r\n=20"],
    ["¡Hola Señor!", "=C2=A1Hola Se=C3=B1or!"],
    ["\t !\"#$%&'()*+,-./ :;<>?@[\\]^_`{|}~", "\t !\"#$%&'()*+,-./ :;<>?@[\\]^_`{|}~"],
    ["a".repeat(75), "a".repeat(75)],
    ["a".repeat(76), "a".repeat(75) + "=\r\na"],
    ["a".repeat(72) + "=", "a".repeat(72) + "=3D"],
    ["a".repeat(73) + "=", "a".repeat(73) + "=\r\n=3D"],
    ["a".repeat(74) + "=", "a".repeat(74) + "=\r\n=3D"],
    ["a".repeat(75) + "=", "a".repeat(75) + "=\r\n=3D"],
    [" ".repeat(73), " ".repeat(72) + "=20"],
    [" ".repeat(74), " ".repeat(73) + "=\r\n=20"],
    [" ".repeat(75), " ".repeat(74) + "=\r\n=20"],
    [" ".repeat(76), " ".repeat(75) + "=\r\n=20"],
    [" ".repeat(77), " ".repeat(75) + "=\r\n =20"],
  ];
  for (const [input, want] of tests) {
    expect(quotedPrintable(new TextEncoder().encode(input))).toBe(want);
  }
});
