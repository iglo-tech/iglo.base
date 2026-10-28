// Upstream: golang.org/x/crypto v0.58.0 blowfish/cipher.go and
// blowfish/block.go
//
// Bruce Schneier's Blowfish cipher, used only by the bcrypt port
// (src/tools/crypto/bcrypt.ts) for the hashes Bun.password cannot verify.
// Go's uint32 arithmetic is done in Uint32Arrays and with `>>> 0`; Go's
// 16 unrolled rounds are a loop.

import { p, s0, s1, s2, s3 } from "@/tools/crypto/blowfish-const";

// The Blowfish block size in bytes.
export const BlockSize = 8;

export class KeySizeError extends Error {
  constructor(readonly size: number) {
    super(`crypto/blowfish: invalid key size ${size}`);
  }
}

// A Cipher is an instance of Blowfish encryption using a particular key.
export class Cipher {
  readonly p = new Uint32Array(18);
  readonly s0 = new Uint32Array(256);
  readonly s1 = new Uint32Array(256);
  readonly s2 = new Uint32Array(256);
  readonly s3 = new Uint32Array(256);

  // BlockSize returns the Blowfish block size, 8 bytes.
  blockSize(): number {
    return BlockSize;
  }

  // Encrypt encrypts the 8-byte buffer src using the key k and stores the
  // result in dst.
  encrypt(dst: Uint8Array, src: Uint8Array): void {
    const lr = Uint32Array.of(readWord(src, 0), readWord(src, 4));
    encryptBlock(lr, this);
    writeWord(dst, 0, lr[0] as number);
    writeWord(dst, 4, lr[1] as number);
  }

  // Decrypt decrypts the 8-byte buffer src using the key k and stores the
  // result in dst.
  decrypt(dst: Uint8Array, src: Uint8Array): void {
    const lr = Uint32Array.of(readWord(src, 0), readWord(src, 4));
    decryptBlock(lr, this);
    writeWord(dst, 0, lr[0] as number);
    writeWord(dst, 4, lr[1] as number);
  }
}

// NewCipher creates and returns a Cipher. The key argument should be the
// Blowfish key, from 1 to 56 bytes. Throws KeySizeError.
export function NewCipher(key: Uint8Array): Cipher {
  const k = key.length;
  if (k < 1 || k > 56) {
    throw new KeySizeError(k);
  }
  const result = new Cipher();
  initCipher(result);
  ExpandKey(key, result);
  return result;
}

// NewSaltedCipher creates a returns a Cipher that folds a salt into its
// key schedule. For bcrypt compatibility, the key can be over 56 bytes.
// Throws KeySizeError.
export function NewSaltedCipher(key: Uint8Array, salt: Uint8Array): Cipher {
  if (salt.length === 0) {
    return NewCipher(key);
  }
  const k = key.length;
  if (k < 1) {
    throw new KeySizeError(k);
  }
  const result = new Cipher();
  initCipher(result);
  expandKeyWithSalt(key, salt, result);
  return result;
}

function initCipher(c: Cipher): void {
  c.p.set(p);
  c.s0.set(s0);
  c.s1.set(s1);
  c.s2.set(s2);
  c.s3.set(s3);
}

function readWord(b: Uint8Array, i: number): number {
  return (
    (((b[i] as number) << 24) |
      ((b[i + 1] as number) << 16) |
      ((b[i + 2] as number) << 8) |
      (b[i + 3] as number)) >>>
    0
  );
}

function writeWord(b: Uint8Array, i: number, w: number): void {
  b[i] = w >>> 24;
  b[i + 1] = w >>> 16;
  b[i + 2] = w >>> 8;
  b[i + 3] = w;
}

// ---------------------------------------------------------------------
// block.go

// getNextWord returns the next big-endian uint32 value from the byte
// slice at the given position in a circular manner, updating the position
// (pos[0]).
function getNextWord(b: Uint8Array, pos: [number]): number {
  let w = 0;
  let j = pos[0];
  for (let i = 0; i < 4; i++) {
    w = ((w << 8) | (b[j] as number)) >>> 0;
    j++;
    if (j >= b.length) {
      j = 0;
    }
  }
  pos[0] = j;
  return w;
}

// ExpandKey performs a key expansion on the given *Cipher. Specifically,
// it performs the Blowfish algorithm's key schedule which sets up the
// *Cipher's pi and substitution tables for calls to Encrypt. This is used,
// primarily, by the bcrypt package to reuse the Blowfish key schedule
// during its set up.
export function ExpandKey(key: Uint8Array, c: Cipher): void {
  const pos: [number] = [0];
  for (let i = 0; i < 18; i++) {
    c.p[i] = (c.p[i] as number) ^ getNextWord(key, pos);
  }

  const lr = new Uint32Array(2);
  for (const t of [c.p, c.s0, c.s1, c.s2, c.s3]) {
    for (let i = 0; i < t.length; i += 2) {
      encryptBlock(lr, c);
      t[i] = lr[0] as number;
      t[i + 1] = lr[1] as number;
    }
  }
}

// This is similar to ExpandKey, but folds the salt during the key
// schedule.
function expandKeyWithSalt(key: Uint8Array, salt: Uint8Array, c: Cipher): void {
  const pos: [number] = [0];
  for (let i = 0; i < 18; i++) {
    c.p[i] = (c.p[i] as number) ^ getNextWord(key, pos);
  }

  pos[0] = 0;
  const lr = new Uint32Array(2);
  for (const t of [c.p, c.s0, c.s1, c.s2, c.s3]) {
    for (let i = 0; i < t.length; i += 2) {
      lr[0] = (lr[0] as number) ^ getNextWord(salt, pos);
      lr[1] = (lr[1] as number) ^ getNextWord(salt, pos);
      encryptBlock(lr, c);
      t[i] = lr[0] as number;
      t[i + 1] = lr[1] as number;
    }
  }
}

// Go's F: ((s0[a] + s1[b]) ^ s2[c]) + s3[d], in uint32 arithmetic (the
// caller's xor truncates the sum).
function f(c: Cipher, x: number): number {
  return (
    (((c.s0[x >>> 24] as number) + (c.s1[(x >>> 16) & 0xff] as number)) ^
      (c.s2[(x >>> 8) & 0xff] as number)) +
    (c.s3[x & 0xff] as number)
  );
}

// encryptBlock encrypts lr ([l, r]) in place.
function encryptBlock(lr: Uint32Array, c: Cipher): void {
  let xl = (lr[0] as number) ^ (c.p[0] as number);
  let xr = lr[1] as number;
  for (let i = 1; i <= 16; i += 2) {
    xr ^= f(c, xl) ^ (c.p[i] as number);
    xl ^= f(c, xr) ^ (c.p[i + 1] as number);
  }
  xr ^= c.p[17] as number;
  lr[0] = xr;
  lr[1] = xl;
}

// decryptBlock decrypts lr ([l, r]) in place.
function decryptBlock(lr: Uint32Array, c: Cipher): void {
  let xl = (lr[0] as number) ^ (c.p[17] as number);
  let xr = lr[1] as number;
  for (let i = 16; i >= 1; i -= 2) {
    xr ^= f(c, xl) ^ (c.p[i] as number);
    xl ^= f(c, xr) ^ (c.p[i - 1] as number);
  }
  xr ^= c.p[0] as number;
  lr[0] = xr;
  lr[1] = xl;
}
