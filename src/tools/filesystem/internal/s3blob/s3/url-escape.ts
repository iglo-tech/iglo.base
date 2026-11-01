// Upstream: Go's url.PathEscape and url.PathUnescape, which the driver's
// metadata and CopyObject's header go through.

import { bytesToText, textToBytes } from "@/tools/types/go-json";

const pathSafe = /^[A-Za-z0-9\-_.~$&+=:@]$/;

// url.PathEscape
export function urlPathEscape(s: string): string {
  let out = "";
  for (const c of textToBytes(s)) {
    const ch = String.fromCharCode(c);
    out += pathSafe.test(ch) ? ch : "%" + c.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

// urlUnescape reverses URLEscape using url.PathUnescape. If the unescape
// returns an error, it returns s.
export function urlUnescape(s: string): string {
  const bytes: number[] = [];
  const input = textToBytes(s);
  for (let i = 0; i < input.length; i++) {
    const c = input[i] as number;
    if (c !== 0x25) {
      bytes.push(c);
      continue;
    }
    const hex = String.fromCharCode(input[i + 1] ?? 0, input[i + 2] ?? 0);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
      return s;
    }
    bytes.push(Number.parseInt(hex, 16));
    i += 2;
  }
  return bytesToText(new Uint8Array(bytes));
}
