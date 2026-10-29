// Upstream: tools/filesystem/internal/fileblob/attrs.go (largely copied
// there from gocloud.dev/blob/fileblob, Apache License 2.0, Copyright 2018
// The Go Cloud Development Kit Authors)
//
// The sidecar is written as upstream's encoding/json/v2 MarshalWrite
// writes the xattrs struct: the struct fields in order, no spaces, no
// trailing newline, strings escaped as json/v2 does (only `"`, `\` and
// control characters; `<`, `>`, `&`, U+2028 and U+2029 stay as they are),
// a nil metadata map as `{}` (json/v2's nil map), the MD5 bytes as standard base64. A string
// that is not valid UTF-8 fails the write, as json/v2 does. Metadata keys
// are written in sorted order (upstream writes at most one key).
//
// The sidecar is read as json/v2 UnmarshalRead reads it into the struct:
// the names match exactly, unknown names are skipped, `null` leaves the
// zero value, and anything else of the wrong type (or invalid JSON, or
// invalid UTF-8) is an error.

import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

import { textToBytes } from "@/tools/types/go-json";

export const attrsExt = ".attrs";

export const errAttrsExt = new Error(`file extension ${JSON.stringify(attrsExt)} is reserved`);

// xattrs stores extended attributes for an object. The format is like
// filesystem extended attributes, see
// https://www.freedesktop.org/wiki/CommonExtendedAttributes.
export interface xattrs {
  cacheControl: string; // user.cache_control
  contentDisposition: string; // user.content_disposition
  contentEncoding: string; // user.content_encoding
  contentLanguage: string; // user.content_language
  contentType: string; // user.content_type
  metadata: Map<string, string> | null; // user.metadata
  md5: Uint8Array | null; // md5
}

export function emptyAttrs(): xattrs {
  return {
    cacheControl: "",
    contentDisposition: "",
    contentEncoding: "",
    contentLanguage: "",
    contentType: "",
    metadata: null,
    md5: null,
  };
}

// setAttrs creates a "path.attrs" file along with blob to store the
// attributes, it uses JSON format. Throws the create, marshal or write
// error (a marshal or write error removes the file).
export function setAttrs(path: string, xa: xattrs): void {
  const name = path + attrsExt;
  const fd = openSync(name, "w", 0o666);

  try {
    const data = marshalAttrs(xa);
    let off = 0;
    while (off < data.length) {
      off += writeSync(fd, data, off, data.length - off);
    }
  } catch (err) {
    try {
      closeSync(fd);
    } finally {
      rmSync(name, { force: true });
    }
    throw err;
  }

  closeSync(fd);
}

// getAttrs looks at the "path.attrs" file to retrieve the attributes and
// decodes them into a xattrs struct. It doesn't fail when there is no such
// .attrs file.
export function getAttrs(path: string): xattrs {
  let data: Uint8Array;
  try {
    data = readFileSync(path + attrsExt);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      // Handle gracefully for non-existent .attr files.
      return { ...emptyAttrs(), contentType: "application/octet-stream" };
    }
    throw err;
  }

  return unmarshalAttrs(data);
}

// -------------------------------------------------------------------
// json/v2

const encoder = new TextEncoder();

export function marshalAttrs(xa: xattrs): Uint8Array {
  let out = "{";
  out += `"user.cache_control":${quote(xa.cacheControl)}`;
  out += `,"user.content_disposition":${quote(xa.contentDisposition)}`;
  out += `,"user.content_encoding":${quote(xa.contentEncoding)}`;
  out += `,"user.content_language":${quote(xa.contentLanguage)}`;
  out += `,"user.content_type":${quote(xa.contentType)}`;
  out += ',"user.metadata":';
  const metadata = xa.metadata ?? new Map<string, string>();
  const keys = [...metadata.keys()].toSorted(compareBytes);
  out += "{" + keys.map((k) => `${quote(k)}:${quote(metadata.get(k) ?? "")}`).join(",") + "}";
  // a nil []byte is "" in json/v2
  out += `,"md5":"${xa.md5 === null ? "" : Buffer.from(xa.md5).toString("base64")}"`;
  out += "}";
  return encoder.encode(out);
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(textToBytes(a)), Buffer.from(textToBytes(b)));
}

const hex = "0123456789abcdef";

// jsonwire.AppendQuote with json/v2's default options
export function quote(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s.slice(i, i + 2);
        i++;
        continue;
      }
      throw invalidUTF8();
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      throw invalidUTF8();
    }
    switch (c) {
      case 0x22:
        out += '\\"';
        continue;
      case 0x5c:
        out += "\\\\";
        continue;
      case 0x08:
        out += "\\b";
        continue;
      case 0x09:
        out += "\\t";
        continue;
      case 0x0a:
        out += "\\n";
        continue;
      case 0x0c:
        out += "\\f";
        continue;
      case 0x0d:
        out += "\\r";
        continue;
    }
    if (c < 0x20) {
      out += "\\u00" + hex.charAt(c >> 4) + hex.charAt(c & 0xf);
      continue;
    }
    out += s.charAt(i);
  }
  return out + '"';
}

function invalidUTF8(): Error {
  return new Error("json: cannot marshal string: invalid UTF-8");
}

export function unmarshalAttrs(data: Uint8Array): xattrs {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw new Error("jsontext: invalid UTF-8");
  }
  const raw: unknown = JSON.parse(text);
  if (raw === null) {
    return emptyAttrs();
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("json: cannot unmarshal into Go value of type fileblob.xattrs");
  }

  const xa = emptyAttrs();
  const obj = raw as Record<string, unknown>;
  const str = (name: string): string | undefined => {
    if (!Object.hasOwn(obj, name) || obj[name] === null) {
      return undefined;
    }
    const v = obj[name];
    if (typeof v !== "string") {
      throw new Error(`json: cannot unmarshal into Go struct field xattrs.${name} of type string`);
    }
    return v;
  };
  xa.cacheControl = str("user.cache_control") ?? "";
  xa.contentDisposition = str("user.content_disposition") ?? "";
  xa.contentEncoding = str("user.content_encoding") ?? "";
  xa.contentLanguage = str("user.content_language") ?? "";
  xa.contentType = str("user.content_type") ?? "";

  const md = obj["user.metadata"];
  if (Object.hasOwn(obj, "user.metadata") && md !== null) {
    if (typeof md !== "object" || Array.isArray(md)) {
      throw new Error("json: cannot unmarshal into Go struct field xattrs.user.metadata");
    }
    xa.metadata = new Map();
    for (const [k, v] of Object.entries(md as Record<string, unknown>)) {
      if (v === null) {
        xa.metadata.set(k, "");
        continue;
      }
      if (typeof v !== "string") {
        throw new Error("json: cannot unmarshal into Go struct field xattrs.user.metadata");
      }
      xa.metadata.set(k, v);
    }
  }

  const md5 = str("md5");
  if (md5 !== undefined) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(md5)) {
      throw new Error(
        "json: cannot unmarshal into Go struct field xattrs.md5: illegal base64 data",
      );
    }
    xa.md5 = new Uint8Array(Buffer.from(md5, "base64"));
  }

  return xa;
}
