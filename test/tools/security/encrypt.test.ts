// Upstream: tools/security/encrypt_test.go

import { describe, expect, test } from "bun:test";

import { StdEncoding } from "@/tools/security/base64";
import { decrypt, encrypt } from "@/tools/security/encrypt";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("Encrypt", () => {
  const scenarios: [string, string, boolean][] = [
    ["", "", true],
    ["123", "test", true], // key must be valid 32 char aes string
    ["123", "abcdabcdabcdabcdabcdabcdabcdabcd", false],
  ];

  scenarios.forEach(([data, key, expectError], i) => {
    test(`${i}_${data}`, async () => {
      let result = "";
      let hasErr = false;
      try {
        result = await encrypt(encoder.encode(data), key);
      } catch {
        hasErr = true;
      }
      expect(hasErr).toBe(expectError);
      if (hasErr) {
        expect(result).toBe("");
        return;
      }

      // try to decrypt
      expect(decoder.decode(await decrypt(result, key))).toBe(data);
    });
  });

  test("base64 of a 12 byte nonce, the ciphertext and a 16 byte tag", async () => {
    const result = await encrypt(encoder.encode("123"), "abcdabcdabcdabcdabcdabcdabcdabcd");
    expect(StdEncoding.decodeString(result).length).toBe(12 + 3 + 16);
    // a fresh nonce each time
    expect(await encrypt(encoder.encode("123"), "abcdabcdabcdabcdabcdabcdabcdabcd")).not.toBe(
      result,
    );
  });
});

describe("Decrypt", () => {
  const scenarios: [string, string, boolean, string][] = [
    ["", "", true, ""],
    ["123", "test", true, ""], // key must be valid 32 char aes string
    ["8kcEqilvvYKYcfnSr0aSC54gmnQCsB02SaB8ATlnA==", "abcdabcdabcdabcdabcdabcdabcdabcd", true, ""], // illegal base64 encoded cipherText
    [
      "8kcEqilvv+YKYcfnSr0aSC54gmnQCsB02SaB8ATlnA==",
      "abcdabcdabcdabcdabcdabcdabcdabcd",
      false,
      "123",
    ],
  ];

  scenarios.forEach(([cipher, key, expectError, expectedData], i) => {
    test(`${i}_${key}`, async () => {
      let result = new Uint8Array();
      let hasErr = false;
      try {
        result = await decrypt(cipher, key);
      } catch {
        hasErr = true;
      }
      expect(hasErr).toBe(expectError);
      if (!hasErr) {
        expect(decoder.decode(result)).toBe(expectedData);
      }
    });
  });

  // Not in upstream's tests.
  const more: [string, string][] = [
    ["tampered ciphertext", "8kcEqilvv+YKYcfnTr0aSC54gmnQCsB02SaB8ATlnA=="],
    ["shorter than nonce and tag", "AAAA"],
    ["missing padding", "8kcEqilvv+YKYcfnSr0aSC54gmnQCsB02SaB8ATlnA"],
    ["url alphabet", "8kcEqilvv-YKYcfnSr0aSC54gmnQCsB02SaB8ATlnA=="],
  ];

  for (const [name, cipher] of more) {
    test(name, async () => {
      await expect(decrypt(cipher, "abcdabcdabcdabcdabcdabcdabcdabcd")).rejects.toThrow();
    });
  }

  test("non-zero trailing bits are ignored, as Go's non-strict decoder does", async () => {
    const result = await decrypt(
      "8kcEqilvv+YKYcfnSr0aSC54gmnQCsB02SaB8ATlnB==",
      "abcdabcdabcdabcdabcdabcdabcdabcd",
    );
    expect(decoder.decode(result)).toBe("123");
  });

  test("newlines in the base64 text are skipped, as Go does", async () => {
    const result = await decrypt(
      "8kcEqilvv+YKYcfn\r\nSr0aSC54gmnQCsB02SaB8ATlnA==\n",
      "abcdabcdabcdabcdabcdabcdabcdabcd",
    );
    expect(decoder.decode(result)).toBe("123");
  });
});
