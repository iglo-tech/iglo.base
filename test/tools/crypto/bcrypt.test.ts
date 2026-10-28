// Upstream: golang.org/x/crypto v0.58.0 bcrypt/bcrypt_test.go

import { describe, expect, test } from "bun:test";

import {
  Cost,
  DefaultCost,
  ErrHashTooShort,
  ErrMismatchedHashAndPassword,
  ErrPasswordTooLong,
  HashVersionTooNewError,
  InvalidCostError,
  InvalidHashPrefixError,
  MinCost,
  base64Decode,
  base64Encode,
  bcrypt,
  compareHashAndPassword,
  generateFromPassword,
} from "@/tools/crypto/bcrypt";
import { CorruptInputError } from "@/tools/security/base64";
import { bytesToText, textToBytes } from "@/tools/types/go-json";

const bytes = (s: string) => textToBytes(s);
const text = (b: Uint8Array) => bytesToText(b);

describe("bcrypt", () => {
  test("TestBcryptingIsEasy", () => {
    const pass = bytes("mypassword");
    const hp = generateFromPassword(pass, MinCost); // upstream: 0 (DefaultCost)

    expect(compareHashAndPassword(bytes(hp), pass)).toBeNull();

    expect(compareHashAndPassword(bytes(hp), bytes("notthepass"))).toBe(
      ErrMismatchedHashAndPassword,
    );
  });

  test("TestBcryptingIsCorrect", () => {
    const pass = bytes("allmine");
    const salt = bytes("XajjQvNhvvRt5GSeFk1xFe");
    const expectedHash = "$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga";

    const hash = text(bcrypt(pass, 10, salt));
    expect(expectedHash.endsWith(hash)).toBe(true);

    expect(compareHashAndPassword(bytes(expectedHash), pass)).toBeNull();
    expect(Cost(bytes(expectedHash))).toBe(10);
  });

  test("TestVeryShortPasswords", () => {
    expect(() => bcrypt(bytes("k"), 10, bytes("XajjQvNhvvRt5GSeFk1xFe"))).not.toThrow();
  });

  test("TestTooLongPasswordsWork", () => {
    const salt = bytes("XajjQvNhvvRt5GSeFk1xFe");
    // One byte over the usual 56 byte limit that blowfish has
    const tooLongPass = bytes("012345678901234567890123456789012345678901234567890123456");
    const tooLongExpected = "$2a$10$XajjQvNhvvRt5GSeFk1xFe5l47dONXg781AmZtd869sO8zfsHuw7C";
    const hash = text(bcrypt(tooLongPass, 10, salt));
    expect(tooLongExpected.endsWith(hash)).toBe(true);
    expect(compareHashAndPassword(bytes(tooLongExpected), tooLongPass)).toBeNull();
  });

  test("TestInvalidHashErrors", () => {
    const invalidTests: [Error, string][] = [
      [ErrHashTooShort, "$2a$10$fooo"],
      [ErrHashTooShort, "$2a"],
      [
        new HashVersionTooNewError(0x33),
        "$3a$10$sssssssssssssssssssssshhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh",
      ],
      [
        new InvalidHashPrefixError(0x25),
        "%2a$10$sssssssssssssssssssssshhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh",
      ],
      [new InvalidCostError(32), "$2a$32$sssssssssssssssssssssshhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh"],
    ];
    for (const [expected, hash] of invalidTests) {
      expect(() => Cost(bytes(hash))).toThrow(expected);
      const err = compareHashAndPassword(bytes(hash), bytes("anything"));
      expect(err).toEqual(expected);
      expect(err?.message).toBe(expected.message);
    }
    expect(new HashVersionTooNewError(0x33).message).toBe(
      "crypto/bcrypt: bcrypt algorithm version '3' requested is newer than current version '2'",
    );
    expect(new InvalidHashPrefixError(0x25).message).toBe(
      "crypto/bcrypt: bcrypt hashes must start with '$', but hashedSecret started with '%'",
    );
  });

  test("TestUnpaddedBase64Encoding", () => {
    const original = Uint8Array.of(
      101,
      201,
      101,
      75,
      19,
      227,
      199,
      20,
      239,
      236,
      133,
      32,
      30,
      109,
      243,
      30,
    );
    const encodedOriginal = bytes("XajjQvNhvvRt5GSeFk1xFe");

    expect(base64Encode(original)).toEqual(encodedOriginal);
    expect(base64Decode(encodedOriginal)).toEqual(original);
  });

  test("TestCost", () => {
    const suffix = "XajjQvNhvvRt5GSeFk1xFe5l47dONXg781AmZtd869sO8zfsHuw7C";
    for (const vers of ["2a", "2"]) {
      for (const c of [4, 10]) {
        expect(Cost(bytes(`$${vers}$${String(c).padStart(2, "0")}$${suffix}`))).toBe(c);
      }
    }
    expect(() => Cost(bytes("$a$a$" + suffix))).toThrow(ErrHashTooShort);
  });

  test("TestCostValidationInHash", () => {
    const pass = bytes("mypassword");

    for (let c = 0; c < MinCost; c++) {
      expect(Cost(bytes(generateFromPassword(pass, c)))).toBe(DefaultCost);
    }

    expect(() => generateFromPassword(pass, 32)).toThrow(new InvalidCostError(32));
  });

  test("TestCostReturnsWithLeadingZeroes", () => {
    const hp = generateFromPassword(bytes("abcdefgh"), 7);
    expect(hp.slice(4, 7)).toBe("07$");
  });

  test("TestMinorNotRequired", () => {
    const noMinorHash = "$2$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga";
    expect(Cost(bytes(noMinorHash))).toBe(10);
    expect(compareHashAndPassword(bytes(noMinorHash), bytes("allmine"))).toBeNull();
  });

  test("TestNoSideEffectsFromCompare", () => {
    const source = bytes("passw0rd123456");
    const password = source.subarray(0, source.length - 6);
    const want = source.slice();

    const wantHash = bytes("$2a$10$LK9XRuhNxHHCvjX3tdkRKei1QiCDUKrJRhZv7WWZPuQGRUM92rOUa");
    compareHashAndPassword(wantHash, password);

    expect(source).toEqual(want);
  });

  test("TestPasswordTooLong", () => {
    expect(() => generateFromPassword(new Uint8Array(73), 1)).toThrow(ErrPasswordTooLong);
  });
});

// Go's CompareHashAndPassword on hashes Go does not write: the version
// and the cost are parsed loosely, bytes after the 31 hash characters are
// ignored, and the password is cut at 72 bytes.
describe("bcrypt: Go's parsing", () => {
  const salt = "XajjQvNhvvRt5GSeFk1xFe";
  const hash = "yqRrsxkhBkUiQeg0dt.wU1qD4aFDcga"; // "allmine" at cost 10

  const scenarios: [string, string, Error | null][] = [
    ["$2a$10$" + salt + hash, "allmine", null],
    ["$2b$10$" + salt + hash, "allmine", null],
    ["$2y$10$" + salt + hash, "allmine", null],
    ["$2x$10$" + salt + hash, "allmine", null],
    ["$1a$10$" + salt + hash, "allmine", null],
    // "+9" is cost 9 (strconv.Atoi), parsed and computed
    ["$2a$+9$" + salt + hash, "allmine", ErrMismatchedHashAndPassword],
    ["$2a!10!" + salt + hash, "allmine", null],
    ["$2a$10$" + salt + hash + "trailing", "allmine", null],
    ["$2a$10$" + salt + hash.slice(0, 30) + "b", "allmine", ErrMismatchedHashAndPassword],
    ["$2a$10$" + salt.slice(0, 21) + "f" + hash, "allmine", null], // the same salt bytes
    ["$2a$10$" + salt.slice(0, 21) + "=" + hash, "allmine", new Error("")],
    // 59 bytes: parsed, the hash is zero padded
    ["$2a$10$" + salt + hash.slice(0, 30), "allmine", ErrMismatchedHashAndPassword],
    ["$2$10$" + salt + hash.slice(0, 30), "allmine", ErrHashTooShort],
    ["$2a$10$" + salt + hash, "allmine2", ErrMismatchedHashAndPassword],
    ["$2a$1x$" + salt + hash, "allmine", new Error(`strconv.Atoi: parsing "1x": invalid syntax`)],
    ["$2a$-4$" + salt + hash, "allmine", new InvalidCostError(-4)],
  ];

  for (const [i, [h, pass, expected]] of scenarios.entries()) {
    test(`${i} ${h}`, () => {
      const err = compareHashAndPassword(bytes(h), bytes(pass));
      if (expected === null) {
        expect(err).toBeNull();
      } else if (expected.message === "") {
        expect(err).not.toBeNull();
      } else {
        expect(err?.message).toBe(expected.message);
      }
    });
  }

  test("passwords are cut at 72 bytes, the empty one is a NUL byte", () => {
    // crypt_blowfish's test vectors (Openwall)
    const p72 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const h72 = "$2a$05$abcdefghijklmnopqrstuu5s2v8.iXieOjg/.AySBTTZIIVFJeBui";
    expect(compareHashAndPassword(bytes(h72), bytes(p72))).toBeNull();
    expect(
      compareHashAndPassword(bytes(h72), bytes(p72 + "chars after 72 are ignored")),
    ).toBeNull();

    const hEmpty = "$2a$05$CCCCCCCCCCCCCCCCCCCCC.7uG0VCzI2bS7j6ymqJi9CdcdxiRTWNy";
    expect(compareHashAndPassword(bytes(hEmpty), new Uint8Array(0))).toBeNull();
    expect(compareHashAndPassword(bytes(hEmpty), Uint8Array.of(0))).toBeNull();
    expect(compareHashAndPassword(bytes(hEmpty), bytes("x"))).toBe(ErrMismatchedHashAndPassword);

    const h8bit = "$2a$05$/OK.fbVrR/bpIqNJ5ianF.Sa7shbm4.OzKpvFnX1pQLmQW96oUlCq";
    expect(compareHashAndPassword(bytes(h8bit), Uint8Array.of(0xa3))).toBeNull();
  });
});

// not in Go's tests: Go's computation (bcrypt()) against Bun.password,
// which computes and verifies every hash with a 16 byte salt
describe("bcrypt: Go's computation and Bun.password", () => {
  const passwords = [
    bytes("password"),
    bytes("pässwörd"),
    new Uint8Array(0),
    Uint8Array.of(0xa3, 0xff, 0x80),
    bytes("x".repeat(56)),
    bytes("0123456789".repeat(7) + "ab"), // 72 bytes
  ];

  for (const [i, pass] of passwords.entries()) {
    test(`${i}: ${pass.length} bytes at cost 4`, () => {
      const hash = generateFromPassword(pass, 4);
      expect(hash).toMatch(/^\$2a\$04\$/);
      const salt = bytes(hash.slice(7, 29));
      expect(text(bcrypt(pass, 4, salt))).toBe(hash.slice(29));
    });
  }

  test("passwords over 72 bytes use their first 72", () => {
    const pass = bytes("0123456789".repeat(8));
    const hash = generateFromPassword(pass.subarray(0, 72), 4);
    const salt = bytes(hash.slice(7, 29));
    expect(text(bcrypt(pass, 4, salt))).toBe(hash.slice(29));
    expect(compareHashAndPassword(bytes(hash), pass)).toBeNull();
  });
});

// not in Go's tests: salts with '\r' or '\n', which Go's base64 decoder
// skips. A salt with a multiple of 4 plus 2 alphabet characters decodes to
// fewer than 16 bytes and is computed by bcrypt(); other counts fail to
// decode.
describe("bcrypt: salts with CR or LF", () => {
  // verified with upstream PocketBase v0.41.0 (Go's bcrypt)
  const goHash = "$2a$04$" + ".".repeat(18) + "\n".repeat(4) + "a0F5K/0ysQILL30JqYxI1CinCna9k0.";

  test("Go's short salt hash", () => {
    expect(compareHashAndPassword(bytes(goHash), bytes("short-salt-password"))).toBeNull();
    expect(compareHashAndPassword(bytes(goHash), bytes("short-salt-password2"))).toBe(
      ErrMismatchedHashAndPassword,
    );
    // bytes after the 31 hash characters are ignored
    expect(
      compareHashAndPassword(bytes(goHash + "trailing"), bytes("short-salt-password")),
    ).toBeNull();
    // the last hash character must be canonical
    expect(
      compareHashAndPassword(bytes(goHash.slice(0, -1) + "/"), bytes("short-salt-password")),
    ).toBe(ErrMismatchedHashAndPassword);
  });

  test("the salt decodes to fewer bytes", () => {
    expect(base64Decode(bytes(".".repeat(18) + "\n".repeat(4)))).toEqual(new Uint8Array(13));
    expect(base64Decode(bytes("\r\nABCDEFGHIJ\r\nKLMN\r\n\r\n"))).toEqual(
      base64Decode(bytes("ABCDEFGHIJKLMN" + "\n".repeat(8))),
    );
    expect(base64Decode(bytes("\r\nABCDEFGHIJ\r\nKLMN\r\n\r\n")).length).toBe(10);
    expect(base64Decode(bytes("ab\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n")).length).toBe(1);
  });

  const scenarios: [string, string][] = [
    ["\r\nABCDEFGHIJ\r\nKLMN\r\n\r\n", "crlf-password"], // 14 characters: 10 bytes
    ["\n".repeat(20) + "ab", "one-byte-salt"], // 1 byte
    ["abcdef" + "\r".repeat(16), ""], // 4 bytes, the empty password
  ];
  for (const [salt, pass] of scenarios) {
    test(JSON.stringify(salt), () => {
      const hash = "$2a$05$" + salt + text(bcrypt(bytes(pass), 5, bytes(salt)));
      expect(compareHashAndPassword(bytes(hash), bytes(pass))).toBeNull();
      expect(compareHashAndPassword(bytes(hash), bytes(pass + "x"))).toBe(
        ErrMismatchedHashAndPassword,
      );
      // another version byte is part of the compared hash on both sides
      expect(compareHashAndPassword(bytes("$2b" + hash.slice(3)), bytes(pass))).toBeNull();
    });
  }

  // Go's base64 errors (the salt with "==" appended)
  const invalid: [string, number][] = [
    ["abcdefghijklmnopqrst\r\n", 22], // 20 characters: '=' at a quantum start
    ["abcdefghijklmnopqrs\r\n\r", 23], // 19: trailing garbage after one '='
    ["abcdefghijklmnopqrstu\n", 22], // 21: one character before '='
    ["\n".repeat(22), 22],
    ["abcdefghijklmnopqrstu$", 21], // not in the alphabet
  ];
  for (const [salt, offset] of invalid) {
    test(`invalid ${JSON.stringify(salt)}`, () => {
      const hash = "$2a$04$" + salt + "a0F5K/0ysQILL30JqYxI1CinCna9k0.";
      const err = compareHashAndPassword(bytes(hash), bytes("x"));
      expect(err).toBeInstanceOf(CorruptInputError);
      expect(err?.message).toBe(`illegal base64 data at input byte ${offset}`);
    });
  }
});
