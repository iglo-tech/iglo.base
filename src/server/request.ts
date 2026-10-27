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
    const mediaType = parseMediaType(ct);
    if (mediaType === undefined) {
      return { values: undefined, err: new Error("mime: invalid media parameter") };
    }
    if (mediaType !== "application/x-www-form-urlencoded") {
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
    const mediaType = parseMediaType(ct);
    if (ct === "" || mediaType !== "multipart/form-data") {
      return new Error("request Content-Type isn't multipart/form-data");
    }
    if (!/;\s*boundary=/i.test(ct)) {
      return new Error("no multipart boundary param in Content-Type");
    }

    let formData: [string, string | File][];
    try {
      const bytes = await readAll(this.body);
      const parsed = await new Response(bytes, { headers: { "Content-Type": ct } }).formData();
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

// mime.ParseMediaType: the lower-cased media type, or undefined when it is
// malformed.
export function parseMediaType(v: string): string | undefined {
  const mediaType = (v.split(";", 1)[0] ?? "").trim().toLowerCase();
  if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+(?:\/[!#$%&'*+\-.^_`|~0-9a-z]+)?$/.test(mediaType)) {
    return undefined;
  }
  return mediaType;
}
