// The asynchronous forms of GenerateFromPassword and CompareHashAndPassword
// (M7.1a, D27): the same results and errors, computed on Bun's thread pool.

import { describe, expect, test } from "bun:test";

import {
  ErrMismatchedHashAndPassword,
  ErrPasswordTooLong,
  InvalidCostError,
  compareHashAndPassword,
  compareHashAndPasswordAsync,
  generateFromPassword,
  generateFromPasswordAsync,
} from "@/tools/crypto/bcrypt";
import { textToBytes } from "@/tools/types/go-json";

const bytes = (s: string) => textToBytes(s);

describe("bcrypt async", () => {
  test("hashes written by one form verify with the other", async () => {
    const pass = bytes("zażółć gęślą jaźń");
    const asyncHash = await generateFromPasswordAsync(pass, 6);
    const syncHash = generateFromPassword(pass, 6);

    expect(asyncHash.startsWith("$2a$06$")).toBe(true);
    expect(asyncHash).not.toBe(syncHash); // new salt each time
    for (const hash of [asyncHash, syncHash]) {
      expect(compareHashAndPassword(bytes(hash), pass)).toBeNull();
      expect(await compareHashAndPasswordAsync(bytes(hash), pass)).toBeNull();
      expect(await compareHashAndPasswordAsync(bytes(hash), bytes("other"))).toBe(
        ErrMismatchedHashAndPassword,
      );
    }
  });

  test("the argument and hash errors are the synchronous ones", async () => {
    await expect(generateFromPasswordAsync(bytes("a".repeat(73)), 6)).rejects.toBe(
      ErrPasswordTooLong,
    );
    await expect(generateFromPasswordAsync(bytes("a"), 40)).rejects.toBeInstanceOf(
      InvalidCostError,
    );
    const short = bytes("$2a$06$short");
    expect(await compareHashAndPasswordAsync(short, bytes("a"))).toEqual(
      compareHashAndPassword(short, bytes("a")),
    );
  });

  test("the event loop keeps running while a hash is computed", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      await Promise.all(Array.from({ length: 4 }, () => generateFromPasswordAsync(bytes("x"), 11)));
    } finally {
      clearInterval(timer);
    }
    // blocked for the whole computation (hundreds of ms), it would tick 0 or 1 times
    expect(ticks).toBeGreaterThan(10);
  });
});
