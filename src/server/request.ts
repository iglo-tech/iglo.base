// Upstream: the parts of Go's net/http Request and net/url that
// tools/router uses: URL path and query (url.ParseQuery), Host, RemoteAddr,
// TLS, ContentLength, PathValue/SetPathValue, ParseForm and
// ParseMultipartForm (request.go).
//
// The body is wrapped in a RereadableReadCloser by the router, so it can be
// read more than once (BindBody, RequestInfo, form parsing).

import { readAll, type RereadableReadCloser } from "@/server/rereadable-read-closer";
import { unescapeBytes } from "@/server/mux";

export type Values = Map<string, string[]>;

export interface MultipartForm {
  value: Values;
  file: Map<string, File[]>;
}

export interface HttpRequestInit {
  method: string;
  host: string;
  // the escaped request path (r.URL.EscapedPath())
  escapedPath: string;
  rawQuery: string;
  headers: Headers;
  body: RereadableReadCloser;
  // -1 when unknown (chunked)
  contentLength: number;
  // "ip:port" of the client
  remoteAddr: string;
  tls: boolean;
}

// maxFormSize: the urlencoded body limit of ParseForm (10 MB)
const maxFormSize = 10 << 20;

export class HttpRequest {
  method: string;
  host: string;
  readonly escapedPath: string;
  // the unescaped path (r.URL.Path)
  readonly path: string;
  rawQuery: string;
  readonly headers: Headers;
  body: RereadableReadCloser;
  readonly contentLength: number;
  readonly remoteAddr: string;
  readonly tls: boolean;

  // the mux pattern that matched the request
  pattern = "";
  #pathValues = new Map<string, string>();

  form: Values | undefined;
  postForm: Values | undefined;
  multipartForm: MultipartForm | undefined;

  constructor(init: HttpRequestInit) {
    this.method = init.method;
    this.host = init.host;
    this.escapedPath = init.escapedPath;
    this.path = unescapeBytes(init.escapedPath) ?? init.escapedPath;
    this.rawQuery = init.rawQuery;
    this.headers = init.headers;
    this.body = init.body;
    this.contentLength = init.contentLength;
    this.remoteAddr = init.remoteAddr;
    this.tls = init.tls;
  }

  // PathValue returns the value for the named path wildcard in the mux
  // pattern that matched the request, or "".
  pathValue(name: string): string {
    return this.#pathValues.get(name) ?? "";
  }

  // SetPathValue sets name to value, so that subsequent calls to
  // pathValue(name) return value.
  setPathValue(name: string, value: string): void {
    this.#pathValues.set(name, value);
  }

  // URL.Query: the parsed query values (malformed pairs are dropped).
  query(): Values {
    return parseQuery(this.rawQuery).values;
  }

  // ParseForm populates form and postForm: for POST, PUT and PATCH requests
  // it reads an application/x-www-form-urlencoded body, and it adds the URL
  // query values after the body values. It returns the first parse error.
  async parseForm(): Promise<Error | undefined> {
    let err: Error | undefined;
    if (this.postForm === undefined) {
      if (this.method === "POST" || this.method === "PUT" || this.method === "PATCH") {
        const result = await this.#parsePostForm();
        this.postForm = result.values;
        err = result.err;
      }
      this.postForm ??= new Map();
    }
    if (this.form === undefined) {
      if (this.postForm.size > 0) {
        this.form = copyValues(new Map(), this.postForm);
      }
      const parsed = parseQuery(this.rawQuery);
      err ??= parsed.err;
      if (this.form === undefined) {
        this.form = parsed.values;
      } else {
        copyValues(this.form, parsed.values);
      }
    }
    return err;
  }

  async #parsePostForm(): Promise<{ values: Values | undefined; err: Error | undefined }> {
    let ct = this.headers.get("Content-Type") ?? "";
    // RFC 7231, section 3.1.1.5 - empty type MAY be treated as application/octet-stream
    if (ct === "") {
      ct = "application/octet-stream";
    }
    const parsedType = parseMediaType(ct);
    if ("err" in parsedType) {
      return { values: undefined, err: parsedType.err };
    }
    if (parsedType.mediaType !== "application/x-www-form-urlencoded") {
      // multipart/form-data is handled by parseMultipartForm
      return { values: undefined, err: undefined };
    }
    const bytes = await readAll(this.body);
    if (bytes.length > maxFormSize) {
      return { values: undefined, err: new Error("http: POST too large") };
    }
    const parsed = parseQuery(new TextDecoder().decode(bytes));
    return { values: parsed.values, err: parsed.err };
  }

  // ParseMultipartForm parses a multipart/form-data body (after parseForm)
  // and adds its values to form and postForm.
  async parseMultipartForm(): Promise<Error | undefined> {
    let parseFormErr: Error | undefined;
    if (this.form === undefined) {
      // Let errors in parseForm fall through, and just return it at the end.
      parseFormErr = await this.parseForm();
    }
    if (this.multipartForm !== undefined) {
      return undefined;
    }

    const ct = this.headers.get("Content-Type") ?? "";
    const parsedType = parseMediaType(ct);
    if (ct === "" || "err" in parsedType || parsedType.mediaType !== "multipart/form-data") {
      return new Error("request Content-Type isn't multipart/form-data");
    }
    const boundary = parsedType.params.get("boundary");
    if (boundary === undefined) {
      return new Error("no multipart boundary param in Content-Type");
    }

    let formData: [string, string | File][];
    try {
      const bytes = await readAll(this.body);
      // the parsed (and RFC 2231 decoded) boundary, not the raw header
      const parsed = await new Response(bytes, {
        headers: { "Content-Type": `multipart/form-data; boundary=${quoteParamValue(boundary)}` },
      }).formData();
      formData = [];
      parsed.forEach((value, key) => {
        formData.push([key, value as string | File]);
      });
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }

    const form: MultipartForm = { value: new Map(), file: new Map() };
    for (const [key, value] of formData) {
      if (typeof value === "string") {
        appendValue(form.value, key, value);
      } else {
        const files = form.file.get(key) ?? [];
        files.push(value);
        form.file.set(key, files);
      }
    }

    this.postForm ??= new Map();
    this.form ??= new Map();
    for (const [k, v] of form.value) {
      for (const item of v) {
        appendValue(this.form, k, item);
        appendValue(this.postForm, k, item);
      }
    }
    this.multipartForm = form;

    return parseFormErr;
  }
}

// a media type parameter value: a token as it is, anything else as a
// quoted-string
function quoteParamValue(value: string): string {
  if (value !== "" && consumeToken(value)[1] === "") {
    return value;
  }
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

function appendValue(values: Values, key: string, value: string): void {
  const list = values.get(key);
  if (list) {
    list.push(value);
  } else {
    values.set(key, [value]);
  }
}

function copyValues(dst: Values, src: Values): Values {
  for (const [k, vs] of src) {
    for (const v of vs) {
      appendValue(dst, k, v);
    }
  }
  return dst;
}

// url.QueryEscape: the bytes of s with everything but the unreserved
// characters (A-Z a-z 0-9 - _ . ~) percent-escaped, and spaces as "+".
export function queryEscape(s: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) {
    if (
      (b >= 0x41 && b <= 0x5a) ||
      (b >= 0x61 && b <= 0x7a) ||
      (b >= 0x30 && b <= 0x39) ||
      b === 0x2d ||
      b === 0x5f ||
      b === 0x2e ||
      b === 0x7e
    ) {
      out += String.fromCharCode(b);
    } else if (b === 0x20) {
      out += "+";
    } else {
      out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

// url.Values.Encode: the values in "URL encoded" form
// ("bar=baz&foo=quux"), sorted by key (Go's byte order); the values of a
// key keep their order.
export function encodeValues(values: Values): string {
  const encoder = new TextEncoder();
  const keys = [...values.keys()]
    .map((k): [string, Uint8Array] => [k, encoder.encode(k)])
    .toSorted((a, b) => Buffer.compare(a[1], b[1]))
    .map(([k]) => k);
  const parts: string[] = [];
  for (const k of keys) {
    const keyEscaped = queryEscape(k);
    for (const v of values.get(k) ?? []) {
      parts.push(keyEscaped + "=" + queryEscape(v));
    }
  }
  return parts.join("&");
}

// url.QueryUnescape: "+" is a space; undefined on a malformed escape
function queryUnescape(s: string): string | undefined {
  return unescapeBytes(s.replaceAll("+", " "));
}

// url.ParseQuery: the values that parsed, and the first error.
export function parseQuery(query: string): { values: Values; err: Error | undefined } {
  const values: Values = new Map();
  let err: Error | undefined;
  while (query !== "") {
    let key: string;
    const amp = query.indexOf("&");
    if (amp >= 0) {
      key = query.slice(0, amp);
      query = query.slice(amp + 1);
    } else {
      key = query;
      query = "";
    }
    if (key.includes(";")) {
      err ??= new Error("invalid semicolon separator in query");
      continue;
    }
    if (key === "") {
      continue;
    }
    const eq = key.indexOf("=");
    let value = "";
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    const k = queryUnescape(key);
    if (k === undefined) {
      err ??= new Error(`invalid URL escape ${JSON.stringify(escapeAt(key))}`);
      continue;
    }
    const v = queryUnescape(value);
    if (v === undefined) {
      err ??= new Error(`invalid URL escape ${JSON.stringify(escapeAt(value))}`);
      continue;
    }
    appendValue(values, k, v);
  }
  return { values, err };
}

function escapeAt(s: string): string {
  const i = s.search(/%(?![0-9A-Fa-f]{2})/);
  return i < 0 ? s : s.slice(i, i + 3);
}

// unicode.IsSpace
const spaceRun = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*/;
function trimLeftSpace(s: string): string {
  return s.slice((spaceRun.exec(s)?.[0] ?? "").length);
}

const tspecials = '()<>@,;:\\"/[]?=';
function isTokenChar(c: string): boolean {
  const code = c.charCodeAt(0);
  return code > 0x20 && code < 0x7f && !tspecials.includes(c);
}

// mime consumeToken: the leading run of token characters and the rest.
function consumeToken(v: string): [string, string] {
  let i = 0;
  while (i < v.length && isTokenChar(v[i] as string)) {
    i++;
  }
  return [v.slice(0, i), v.slice(i)];
}

// mime consumeValue: a token or a quoted-string, and the rest; ["", v] when
// a quoted-string is not terminated or contains CR/LF.
function consumeValue(v: string): [string, string] {
  if (v === "") {
    return ["", ""];
  }
  if (v[0] !== '"') {
    return consumeToken(v);
  }
  let out = "";
  for (let i = 1; i < v.length; i++) {
    const r = v[i] as string;
    if (r === '"') {
      return [out, v.slice(i + 1)];
    }
    // an escape is only honored before a tspecial (MSIE literal backslashes)
    if (r === "\\" && i + 1 < v.length && tspecials.includes(v[i + 1] as string)) {
      out += v[i + 1];
      i++;
      continue;
    }
    if (r === "\r" || r === "\n") {
      return ["", v];
    }
    out += r;
  }
  return ["", v];
}

// mime consumeMediaParam: ["", "", v] when v does not start with a valid
// "; name=value" parameter.
function consumeMediaParam(v: string): [string, string, string] {
  let rest = trimLeftSpace(v);
  if (!rest.startsWith(";")) {
    return ["", "", v];
  }
  rest = trimLeftSpace(rest.slice(1));
  let param: string;
  [param, rest] = consumeToken(rest);
  param = param.toLowerCase();
  if (param === "") {
    return ["", "", v];
  }
  rest = trimLeftSpace(rest);
  if (!rest.startsWith("=")) {
    return ["", "", v];
  }
  rest = trimLeftSpace(rest.slice(1));
  const [value, rest2] = consumeValue(rest);
  if (value === "" && rest2 === rest) {
    return ["", "", v];
  }
  return [param, value, rest2];
}

// mime.ParseMediaType: the lower-cased media type and its parameters, or an
// error for a malformed type or parameter list. RFC 2231 extended and
// continued parameters ("name*=utf-8''%41", "name*0=", "name*1*=") are
// decoded into params under their base name.
export function parseMediaType(
  v: string,
): { mediaType: string; params: Map<string, string> } | { err: Error } {
  const base = v.split(";", 1)[0] ?? "";
  const mediaType = base.toLowerCase().trim();
  const [typ, afterType] = consumeToken(mediaType);
  if (typ === "") {
    return { err: new Error("mime: no media type") };
  }
  if (afterType !== "") {
    if (!afterType.startsWith("/")) {
      return { err: new Error("mime: expected slash after first token") };
    }
    const [subtype, afterSubtype] = consumeToken(afterType.slice(1));
    if (subtype === "") {
      return { err: new Error("mime: expected token after slash") };
    }
    if (afterSubtype !== "") {
      return { err: new Error("mime: unexpected content after media subtype") };
    }
  }

  const params = new Map<string, string>();
  const continuation = new Map<string, Map<string, string>>();
  let rest = v.slice(base.length);
  while (rest.length > 0) {
    rest = trimLeftSpace(rest);
    if (rest.length === 0) {
      break;
    }
    const [key, value, next] = consumeMediaParam(rest);
    if (key === "") {
      if (next.trim() === ";") {
        break; // a trailing semicolon is not an error
      }
      return { err: new Error("mime: invalid media parameter") };
    }
    let pmap = params;
    const star = key.indexOf("*");
    if (star >= 0) {
      const baseName = key.slice(0, star);
      pmap = continuation.get(baseName) ?? new Map<string, string>();
      continuation.set(baseName, pmap);
    }
    const existing = pmap.get(key);
    if (existing !== undefined && existing !== value) {
      return { err: new Error("mime: duplicate parameter name") };
    }
    pmap.set(key, value);
    rest = next;
  }

  // Stitch together any continuations or things with stars
  // (i.e. RFC 2231 things with stars: "foo*0" or "foo*")
  for (const [key, pieceMap] of continuation) {
    const singlePart = pieceMap.get(`${key}*`);
    if (singlePart !== undefined) {
      const decoded = decode2231Enc(singlePart);
      if (decoded !== undefined) {
        params.set(key, decoded);
      }
      continue;
    }

    let buf = "";
    let valid = false;
    for (let n = 0; ; n++) {
      const simplePart = `${key}*${n}`;
      const simple = pieceMap.get(simplePart);
      if (simple !== undefined) {
        valid = true;
        buf += simple;
        continue;
      }
      const encoded = pieceMap.get(`${simplePart}*`);
      if (encoded === undefined) {
        break;
      }
      valid = true;
      if (n === 0) {
        buf += decode2231Enc(encoded) ?? "";
      } else {
        buf += percentHexUnescape(encoded) ?? "";
      }
    }
    if (valid) {
      params.set(key, buf);
    }
  }

  return { mediaType, params };
}

// mime decode2231Enc: an RFC 2231 "charset'language'pct-encoded" value;
// undefined for a missing part or a charset other than utf-8 and us-ascii.
function decode2231Enc(v: string): string | undefined {
  const first = v.indexOf("'");
  if (first < 0) {
    return undefined;
  }
  const charset = v.slice(0, first).toLowerCase();
  const rest = v.slice(first + 1);
  // the language part is ignored
  const second = rest.indexOf("'");
  if (second < 0) {
    return undefined;
  }
  if (charset !== "us-ascii" && charset !== "utf-8") {
    return undefined; // empty or unsupported encoding
  }
  return percentHexUnescape(rest.slice(second + 1));
}

// mime percentHexUnescape: undefined when a "%" is not followed by two hex
// digits. The decoded bytes are read as UTF-8, as Go strings are.
function percentHexUnescape(s: string): string | undefined {
  // Count %, check that they're well-formed.
  let percents = 0;
  for (let i = 0; i < s.length;) {
    if (s[i] !== "%") {
      i++;
      continue;
    }
    percents++;
    if (i + 2 >= s.length || !isHex(s[i + 1] as string) || !isHex(s[i + 2] as string)) {
      return undefined;
    }
    i += 3;
  }
  if (percents === 0) {
    return s;
  }

  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (let i = 0; i < s.length;) {
    if (s[i] === "%") {
      bytes.push(Number.parseInt(s.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      const cp = s.codePointAt(i) as number;
      const ch = String.fromCodePoint(cp);
      bytes.push(...encoder.encode(ch));
      i += ch.length;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function isHex(c: string): boolean {
  return /^[0-9a-fA-F]$/.test(c);
}
