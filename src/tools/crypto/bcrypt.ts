// Upstream: golang.org/x/crypto v0.58.0 bcrypt/bcrypt.go and
// bcrypt/base64.go
//
// Hashes are computed with Bun.password (bcrypt). Go's bcrypt writes
// "$2a$" hashes and its CompareHashAndPassword accepts any hash it can
// parse: a version byte up to '2' with an optional minor byte, two cost
// digits, a 22 character salt and at least the 31 character hash (bytes
// after it are ignored). The version is not part of the computation for
// passwords of at most 72 bytes, so a hash is parsed here as Go parses it
// and verified by Bun.password in its canonical "$2b$" form. Bun.password
// pre-hashes passwords over 72 bytes, so the password is truncated to 72
// bytes first, as Go's key schedule does.
//
// Go decodes the salt with encoding/base64, which skips '\r' and '\n', so
// a salt with them decodes to fewer than 16 bytes (or fails). Bun.password
// cannot compute such a hash; it is verified with Go's own computation,
// bcrypt() and expensiveBlowfishSetup() on the Blowfish port
// (src/tools/crypto/blowfish.ts), and compared in constant time.

import { goQuote } from "@/fields/field";
import { ExpandKey, NewSaltedCipher, type Cipher } from "@/tools/crypto/blowfish";
import { Encoding } from "@/tools/security/base64";
import { constantTimeCompare } from "@/tools/security/crypto";
import { bytesToText, textToBytes } from "@/tools/types/go-json";

export const MinCost = 4; // the minimum allowable cost as passed in to GenerateFromPassword
export const MaxCost = 31; // the maximum allowable cost as passed in to GenerateFromPassword
export const DefaultCost = 10; // the cost that will actually be set if a cost below MinCost is passed into GenerateFromPassword

// The error returned from CompareHashAndPassword when a password and hash
// do not match.
export const ErrMismatchedHashAndPassword = new Error(
  "crypto/bcrypt: hashedPassword is not the hash of the given password",
);

// The error returned from CompareHashAndPassword when a hash is too short
// to be a bcrypt hash.
export const ErrHashTooShort = new Error(
  "crypto/bcrypt: hashedSecret too short to be a bcrypted password",
);

// The error returned from CompareHashAndPassword when a hash was created
// with a bcrypt algorithm newer than this implementation.
export class HashVersionTooNewError extends Error {
  constructor(readonly version: number) {
    super(
      `crypto/bcrypt: bcrypt algorithm version '${String.fromCharCode(version)}' requested is newer than current version '2'`,
    );
  }
}

// The error returned from CompareHashAndPassword when a hash starts with
// something other than '$'
export class InvalidHashPrefixError extends Error {
  constructor(readonly prefix: number) {
    super(
      `crypto/bcrypt: bcrypt hashes must start with '$', but hashedSecret started with '${String.fromCharCode(prefix)}'`,
    );
  }
}

export class InvalidCostError extends Error {
  constructor(readonly cost: number | bigint) {
    super(`crypto/bcrypt: cost ${cost} is outside allowed inclusive range ${MinCost}..${MaxCost}`);
  }
}

const majorVersion = 0x32; // '2'
const maxCryptedHashSize = 23;
const encodedSaltSize = 22;
const encodedHashSize = 31;
const minHashSize = 59;
const maxKeySize = 72;

// magicCipherData is an IV for the 64 Blowfish encryption calls in
// bcrypt(). It's the string "OrpheanBeholderScryDoubt" in big-endian bytes.
const magicCipherData = textToBytes("OrpheanBeholderScryDoubt");

interface Hashed {
  hash: Uint8Array;
  salt: Uint8Array;
  cost: number; // allowed range is MinCost to MaxCost
  major: number;
  minor: number;
}

// ErrPasswordTooLong is returned when the password passed to
// GenerateFromPassword is too long (i.e. > 72 bytes).
export const ErrPasswordTooLong = new Error("bcrypt: password length exceeds 72 bytes");

// GenerateFromPassword returns the bcrypt hash of the password at the
// given cost. If the cost given is less than MinCost, the cost will be set
// to DefaultCost, instead. GenerateFromPassword does not accept passwords
// longer than 72 bytes, which is the longest password bcrypt will operate
// on. Throws the error.
export function generateFromPassword(password: Uint8Array, cost: number | bigint): string {
  if (password.length > maxKeySize) {
    throw ErrPasswordTooLong;
  }
  if (cost < MinCost) {
    cost = DefaultCost;
  }
  checkCost(cost);

  const hash = Bun.password.hashSync(bunPassword(password), {
    algorithm: "bcrypt",
    cost: Number(cost),
  });

  // Bun writes "$2b$"; the computation is the same, Go writes "$2a$"
  return "$2a$" + hash.slice("$2b$".length);
}

// CompareHashAndPassword compares a bcrypt hashed password with its
// possible plaintext equivalent. Returns null on success, or an error on
// failure.
export function compareHashAndPassword(
  hashedPassword: Uint8Array,
  password: Uint8Array,
): Error | null {
  let p: Hashed;
  try {
    p = newFromHash(hashedPassword);
  } catch (err) {
    return err as Error;
  }

  // a salt with bytes outside the alphabet ('\r', '\n' or invalid data):
  // Go's computation
  const salt = canonicalBase64(p.salt);
  if (salt === null) {
    let otherHash: Uint8Array;
    try {
      otherHash = bcrypt(password, p.cost, p.salt);
    } catch (err) {
      return err as Error;
    }

    const otherP: Hashed = { ...p, hash: otherHash };
    if (constantTimeCompare(hashBytes(p), hashBytes(otherP))) {
      return null;
    }
    return ErrMismatchedHashAndPassword;
  }

  // Go compares the whole hashes, which differ only in the encoded hash:
  // the computed one is always 31 canonical characters, the stored one is
  // cut or zero padded to 31 bytes.
  const stored = p.hash.subarray(0, encodedHashSize);
  if (stored.length < encodedHashSize || canonicalBase64(stored) !== bytesToText(stored)) {
    return ErrMismatchedHashAndPassword;
  }

  const canonical = `$2b$${String(p.cost).padStart(2, "0")}$${salt}${bytesToText(stored)}`;
  let ok = false;
  try {
    ok = Bun.password.verifySync(bunPassword(password), canonical, "bcrypt");
  } catch {
    // not the hash of the password
  }

  return ok ? null : ErrMismatchedHashAndPassword;
}

// Cost returns the hashing cost used to create the given hashed password.
// Throws the error.
export function Cost(hashedPassword: Uint8Array): number {
  return newFromHash(hashedPassword).cost;
}

// Bun.password's input for the bcrypt key: at most 72 bytes (Go's key
// schedule uses no more; Bun.password pre-hashes longer ones), and the
// empty password as one NUL byte (bcrypt appends a NUL to the key, so the
// two have the same key schedule; Bun.password refuses an empty one).
function bunPassword(password: Uint8Array): Uint8Array {
  if (password.length === 0) {
    return Uint8Array.of(0);
  }
  return password.subarray(0, maxKeySize);
}

function newFromHash(hashedSecret: Uint8Array): Hashed {
  if (hashedSecret.length < minHashSize) {
    throw ErrHashTooShort;
  }

  // decodeVersion
  if (hashedSecret[0] !== 0x24) {
    throw new InvalidHashPrefixError(hashedSecret[0] as number);
  }
  if ((hashedSecret[1] as number) > majorVersion) {
    throw new HashVersionTooNewError(hashedSecret[1] as number);
  }
  const major = hashedSecret[1] as number;
  let minor = 0;
  let n = 3;
  if (hashedSecret[2] !== 0x24) {
    minor = hashedSecret[2] as number;
    n++;
  }

  // decodeCost
  const cost = atoi(hashedSecret.subarray(n, n + 2));
  checkCost(cost);
  n += 3;

  return {
    salt: hashedSecret.slice(n, n + encodedSaltSize),
    hash: hashedSecret.slice(n + encodedSaltSize),
    cost,
    major,
    minor,
  };
}

// bcrypt returns the 31 character encoded hash of the password with the
// encoded salt, computed as Go does. Exported for the tests that check it
// against Go's vectors and Bun.password. Throws the salt's base64 error.
export function bcrypt(password: Uint8Array, cost: number, salt: Uint8Array): Uint8Array {
  const cipherData = magicCipherData.slice();

  const c = expensiveBlowfishSetup(password, cost, salt);

  for (let i = 0; i < 24; i += 8) {
    const block = cipherData.subarray(i, i + 8);
    for (let j = 0; j < 64; j++) {
      c.encrypt(block, block);
    }
  }

  // Bug compatibility with C bcrypt implementations. We only encode 23 of
  // the 24 bytes encrypted.
  return base64Encode(cipherData.subarray(0, maxCryptedHashSize));
}

function expensiveBlowfishSetup(key: Uint8Array, cost: number, salt: Uint8Array): Cipher {
  const csalt = base64Decode(salt);

  // Bug compatibility with C bcrypt implementations. They use the trailing
  // NULL in the key string during expansion.
  const ckey = new Uint8Array(key.length + 1);
  ckey.set(key);

  const c = NewSaltedCipher(ckey, csalt);

  const rounds = 2 ** cost;
  for (let i = 0; i < rounds; i++) {
    ExpandKey(ckey, c);
    ExpandKey(csalt, c);
  }

  return c;
}

// (*hashed).Hash
function hashBytes(p: Hashed): Uint8Array {
  const arr = new Uint8Array(60);
  arr[0] = 0x24;
  arr[1] = p.major;
  let n = 2;
  if (p.minor !== 0) {
    arr[2] = p.minor;
    n = 3;
  }
  arr[n] = 0x24;
  n++;
  const cost = String(p.cost).padStart(2, "0");
  arr[n] = cost.charCodeAt(0);
  arr[n + 1] = cost.charCodeAt(1);
  n += 2;
  arr[n] = 0x24;
  n++;
  arr.set(p.salt.subarray(0, arr.length - n), n);
  n += encodedSaltSize;
  arr.set(p.hash.subarray(0, arr.length - n), n);
  n += encodedHashSize;
  return arr.subarray(0, n);
}

function checkCost(cost: number | bigint): void {
  if (cost < MinCost || cost > MaxCost) {
    throw new InvalidCostError(cost);
  }
}

// strconv.Atoi of a two byte string: an optional sign and decimal digits
function atoi(s: Uint8Array): number {
  let i = 0;
  let neg = false;
  if (s[0] === 0x2b || s[0] === 0x2d) {
    neg = s[0] === 0x2d;
    i++;
  }
  let n = 0;
  if (i >= s.length) {
    throw atoiSyntaxError(s);
  }
  for (; i < s.length; i++) {
    const c = s[i] as number;
    if (c < 0x30 || c > 0x39) {
      throw atoiSyntaxError(s);
    }
    n = n * 10 + (c - 0x30);
  }
  return neg ? -n : n;
}

function atoiSyntaxError(s: Uint8Array): Error {
  return new Error(`strconv.Atoi: parsing ${goQuote(bytesToText(s))}: invalid syntax`);
}

// ---------------------------------------------------------------------
// base64.go

const alphabet = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const bcEncoding = new Encoding(alphabet, true);

// Exported for Go's TestUnpaddedBase64Encoding.
export function base64Encode(src: Uint8Array): Uint8Array {
  const dst = bcEncoding.encodeToString(src).replace(/=+$/, "");
  return Uint8Array.from(dst, (c) => c.charCodeAt(0));
}

// Exported for Go's TestUnpaddedBase64Encoding. Throws CorruptInputError.
export function base64Decode(src: Uint8Array): Uint8Array {
  const numOfEquals = 4 - (src.length % 4);
  // the bytes as Latin-1 characters: each is one input byte
  const text = String.fromCharCode(...src) + "=".repeat(numOfEquals);
  return bcEncoding.decodeString(text);
}

const decodeMap = new Int8Array(256).fill(-1);
for (const [i, ch] of [...alphabet].entries()) {
  decodeMap[ch.charCodeAt(0)] = i;
}

// The canonical encoding of the unpadded bcrypt base64 text src: the
// bytes it decodes to (bits past the last whole byte are dropped, as Go's
// non-strict decoder does) encoded again. Null when src has a byte that is
// not in the alphabet.
function canonicalBase64(src: Uint8Array): string | null {
  for (const c of src) {
    if ((decodeMap[c] as number) < 0) {
      return null;
    }
  }
  return bytesToText(base64Encode(base64Decode(src)));
}
