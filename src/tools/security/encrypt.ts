// Upstream: tools/security/encrypt.go
//
// AES-GCM with Web Crypto: the result is base64 (StdEncoding) of
// nonce (12 bytes) || ciphertext || tag (16 bytes), as Go's gcm.Seal with
// the nonce as prefix. The key is the UTF-8 bytes of key; like Go's
// aes.NewCipher it may be 16, 24 or 32 bytes (AES-128/192/256), upstream
// uses 32 (AES-256).

import { type CipherGCM, createCipheriv } from "node:crypto";

import { StdEncoding } from "@/tools/security/base64";

const nonceSize = 12;
const tagSize = 16;

class KeySizeError extends Error {
  constructor(size: number) {
    super(`crypto/aes: invalid key size ${size}`);
    this.name = "KeySizeError";
  }
}

async function importKey(key: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(key);
  if (raw.length !== 16 && raw.length !== 24 && raw.length !== 32) {
    throw new KeySizeError(raw.length);
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

// Encrypt encrypts data with key (a valid 32 char AES key) and a random
// nonce from a secure source.
export async function encrypt(data: Uint8Array<ArrayBuffer>, key: string): Promise<string> {
  const cryptoKey = await importKey(key, "encrypt");
  const nonce = crypto.getRandomValues(new Uint8Array(nonceSize));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, data),
  );
  const out = new Uint8Array(nonceSize + sealed.length);
  out.set(nonce);
  out.set(sealed, nonceSize);
  return StdEncoding.encodeToString(out);
}

// encrypt for a synchronous caller (node:crypto's AES-GCM): the same
// output format.
export function encryptSync(data: Uint8Array, key: string): string {
  const raw = new TextEncoder().encode(key);
  if (raw.length !== 16 && raw.length !== 24 && raw.length !== 32) {
    throw new KeySizeError(raw.length);
  }
  const nonce = crypto.getRandomValues(new Uint8Array(nonceSize));
  const cipher = createCipheriv(`aes-${raw.length * 8}-gcm`, raw, nonce) as CipherGCM;
  const sealed = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  const out = new Uint8Array(nonceSize + sealed.length);
  out.set(nonce);
  out.set(sealed, nonceSize);
  return StdEncoding.encodeToString(out);
}

// Decrypt decrypts cipherText with key (a valid 32 char AES key).
export async function decrypt(cipherText: string, key: string): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await importKey(key, "decrypt");
  const cipherBytes = StdEncoding.decodeString(cipherText);
  // Go slices cipherByte[:nonceSize] without a check (a shorter input
  // panics); gcm.Open then rejects anything shorter than the tag
  if (cipherBytes.length < nonceSize + tagSize) {
    throw new Error("cipher: message authentication failed");
  }
  const nonce = cipherBytes.slice(0, nonceSize);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce },
        cryptoKey,
        cipherBytes.slice(nonceSize),
      ),
    );
  } catch (err) {
    throw new Error("cipher: message authentication failed", { cause: err });
  }
}
