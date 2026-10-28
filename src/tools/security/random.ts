// Upstream: tools/security/random.go
//
// Like Go, the alphabet is indexed by byte: a multi-byte UTF-8 character in
// it contributes its bytes, not the character (callers use ASCII).

const defaultRandomAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// RandomString generates a cryptographically random string of length
// characters matching [A-Za-z0-9]+ (transparent to URL-encoding).
export function randomString(length: number): string {
  return randomStringWithAlphabet(length, defaultRandomAlphabet);
}

// RandomStringWithAlphabet generates a cryptographically random string of
// length characters from alphabet, each uniformly chosen (crypto/rand.Int
// rejects out of range samples the same way).
export function randomStringWithAlphabet(length: number, alphabet: string): string {
  const chars = encoder.encode(alphabet);
  const b = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    b[i] = chars[secureIntN(chars.length)] as number;
  }
  return decoder.decode(b);
}

// PseudorandomString generates a pseudorandom string of length characters
// matching [A-Za-z0-9]+. Use RandomString for a cryptographically random
// one.
export function pseudorandomString(length: number): string {
  return pseudorandomStringWithAlphabet(length, defaultRandomAlphabet);
}

// PseudorandomStringWithAlphabet generates a pseudorandom string of length
// characters from alphabet (math/rand/v2 in Go; Math.random here).
export function pseudorandomStringWithAlphabet(length: number, alphabet: string): string {
  const chars = encoder.encode(alphabet);
  const b = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    b[i] = chars[Math.floor(Math.random() * chars.length)] as number;
  }
  return decoder.decode(b);
}

// a uniform integer in [0, max) from crypto.getRandomValues, by rejection
// sampling over the smallest power-of-two range that holds max
export function secureIntN(max: number): number {
  if (max <= 0) {
    throw new Error("crypto/rand: argument to Int is <= 0");
  }
  if (max === 1) {
    return 0;
  }
  const bits = 32 - Math.clz32(max - 1);
  const mask = bits === 32 ? 0xffffffff : (1 << bits) - 1;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const n = (buf[0] as number) & mask;
    if (n < max) {
      return n;
    }
  }
}
