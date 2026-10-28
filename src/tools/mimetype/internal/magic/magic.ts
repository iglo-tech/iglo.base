// Upstream: gabriel-vasile/mimetype v1.4.15 internal/magic/magic.go.
//
// Package magic holds the matching functions used to find MIME types.
//
// The matchers keep their Go names (Zip, HTML, ...) for side-by-side review.

import { equal, hasPrefix, index } from "@/tools/mimetype/go-bytes";
import { Bytes, byteIsWS } from "@/tools/mimetype/internal/scan/bytes";

// Detector receiveѕ the raw data of a file and returns whether the data
// meets any conditions. The limit parameter is an upper limit to the number
// of bytes received and is used to tell if the byte slice represents the
// whole file or is just the header of a file: len(raw) < limit or len(raw)>limit.
export type Detector = (raw: Uint8Array, limit: number) => boolean;

export interface xmlSig {
  // the local name of the root tag
  localName: Uint8Array;
  // the namespace of the XML document
  xmlns: Uint8Array;
}

// offset returns true if the provided signature can be
// found at offset in the raw input.
export function offset(raw: Uint8Array, sig: Uint8Array, off: number): boolean {
  return raw.length > off && hasPrefix(raw.subarray(off), sig);
}

// ciPrefix is like prefix but the check is case insensitive.
export function ciPrefix(raw: Uint8Array, ...sigs: Uint8Array[]): boolean {
  for (const s of sigs) {
    if (ciCheck(s, raw)) {
      return true;
    }
  }
  return false;
}
function ciCheck(sig: Uint8Array, raw: Uint8Array): boolean {
  if (raw.length < sig.length + 1) {
    return false;
  }
  // perform case insensitive check
  for (let i = 0; i < sig.length; i++) {
    const b = sig[i] as number;
    let db = raw[i] as number;
    if (0x41 <= b && b <= 0x5a) {
      db &= 0xdf;
    }
    if (b !== db) {
      return false;
    }
  }

  return true;
}

// xml returns true if any of the provided XML signatures matches the raw input.
export function xml(raw: Uint8Array, ...sigs: xmlSig[]): boolean {
  const b = new Bytes(raw);
  b.trimLWS();
  if (b.length === 0) {
    return false;
  }
  for (const s of sigs) {
    if (xmlCheck(s, b.b)) {
      return true;
    }
  }
  return false;
}
function xmlCheck(sig: xmlSig, raw: Uint8Array): boolean {
  raw = raw.subarray(0, Math.min(raw.length, 512));

  if (sig.localName.length === 0) {
    return index(raw, sig.xmlns) > 0;
  }
  if (sig.xmlns.length === 0) {
    return index(raw, sig.localName) > 0;
  }

  const localNameIndex = index(raw, sig.localName);
  return localNameIndex !== -1 && localNameIndex < index(raw, sig.xmlns);
}

const utf8BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

// markup returns true is any of the HTML signatures matches the raw input.
export function markup(raw: Uint8Array, ...sigs: Uint8Array[]): boolean {
  const b = new Bytes(raw);
  if (hasPrefix(b.b, utf8BOM)) {
    // We skip the UTF-8 BOM if present to ensure we correctly
    // process any leading whitespace. The presence of the BOM
    // is taken into account during charset detection in charset.go.
    b.advance(3);
  }
  b.trimLWS();
  if (b.length === 0) {
    return false;
  }
  for (const s of sigs) {
    if (markupCheck(s, b.b)) {
      return true;
    }
  }
  return false;
}
function markupCheck(sig: Uint8Array, raw: Uint8Array): boolean {
  if (raw.length < sig.length + 1) {
    return false;
  }

  // perform case insensitive check
  for (let i = 0; i < sig.length; i++) {
    const b = sig[i] as number;
    let db = raw[i] as number;
    if (0x41 <= b && b <= 0x5a) {
      db &= 0xdf;
    }
    if (b !== db) {
      return false;
    }
  }
  // Next byte must be space or right angle bracket.
  const db = raw[sig.length] as number;
  if (!byteIsWS(db) && db !== 0x3e) {
    return false;
  }

  return true;
}

// ftyp returns true if any of the FTYP signatures matches the raw input.
export function ftyp(raw: Uint8Array, ...sigs: Uint8Array[]): boolean {
  if (raw.length < 12) {
    return false;
  }
  for (const s of sigs) {
    if (equal(raw.subarray(8, 12), s)) {
      return true;
    }
  }
  return false;
}

export interface shebangSig {
  sig: Uint8Array;
  flag: number;
}

// A valid shebang starts with the "#!" characters,
// followed by any number of spaces,
// followed by the path to the interpreter,
// and, optionally, followed by the arguments for the interpreter.
//
// Ex:
//
//	#! /usr/bin/env php
//
// /usr/bin/env is the interpreter, php is the first and only argument.
export function shebang(raw: Uint8Array, ...sigs: shebangSig[]): boolean {
  const b = new Bytes(raw);
  const line = b.line();
  if (line.length < 2 || line.b[0] !== 0x23 || line.b[1] !== 0x21) {
    return false;
  }
  line.b = line.b.subarray(2);
  line.trimLWS();
  for (const s of sigs) {
    if (line.match(s.sig, s.flag) !== -1) {
      return true;
    }
  }
  return false;
}
