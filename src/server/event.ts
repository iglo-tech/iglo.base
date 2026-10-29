// Upstream: tools/router/event.go
//
// Event is the base route handler event, extended by the app's
// RequestEvent (@/app/event-request).
//
// JSON writes JSONMarshaler values (records, search results) and the
// output of the "fields" picker with the Go JSON port; other values are
// plain objects that stand for Go structs, written in their member order.
//
// FindUploadedFiles returns the parts as filesystem.File values (M3.1);
// storing them is M3.2.
//
// Not ported yet:
//   - FileFS (static files, M5.7);
//   - XML responses and SetCookie: no upstream endpoint uses them.

import { Resolver } from "@/server/handler";
import {
  newApiError,
  newBadRequestError,
  newForbiddenError,
  newInternalServerError,
  newNotFoundError,
  newTooManyRequestsError,
  newUnauthorizedError,
  type ApiError,
} from "@/server/error";
import type { ReadCloser } from "@/server/buffer-with-file";
import {
  decodeFirstValue,
  decodeUTF8Bytes,
  hasInvalidUTF8,
  JsonEOFError,
  JsonSyntaxError,
  type JsonValue,
} from "@/server/json-decode";
import type { HttpRequest } from "@/server/request";
import { isRereader, readAll } from "@/server/rereadable-read-closer";
import type { ResponseWriter } from "@/server/router";
import {
  unmarshalJSON,
  unmarshalRequestData,
  type MapRef,
  type RequestData,
  type StructType,
} from "@/server/unmarshal-request-data";
import { unmarshalXML } from "@/server/xml-decode";
import { File, NewFileFromMultipart } from "@/tools/filesystem/file";
import { InvalidModifierDataError, PickPanic, pick } from "@/tools/picker/pick";
import { isJSONMarshaler, marshal } from "@/tools/types/go-json";

export const ErrUnsupportedContentType = newBadRequestError("Unsupported Content-Type", undefined);
export const ErrInvalidRedirectStatusCode = newInternalServerError(
  "Invalid redirect status code",
  undefined,
);
export const ErrFileNotFound = newNotFoundError("File not found", undefined);

// http.ErrMissingFile
export const ErrMissingFile = new Error("http: no such file");

export const IndexPage = "index.html";

const headerContentType = "Content-Type";
const jsonFieldsParam = "fields";

export class Event extends Resolver {
  response: ResponseWriter;
  request: HttpRequest;

  readonly #data = new Map<string, unknown>();

  constructor(response: ResponseWriter, request: HttpRequest) {
    super();
    this.response = response;
    this.request = request;
  }

  // Written reports whether the current response has already been written.
  written(): boolean {
    return this.response.written();
  }

  // Status reports the status code of the current response.
  status(): number {
    return this.response.status();
  }

  // Flush flushes buffered data to the current response.
  flush(): Error | undefined {
    return this.response.flush();
  }

  // IsTLS reports whether the connection on which the request was received is TLS.
  isTLS(): boolean {
    return this.request.tls;
  }

  // RemoteIP returns the IP address of the client that sent the request.
  //
  // IPv6 addresses are returned expanded.
  // For example, "2001:db8::1" becomes "2001:0db8:0000:0000:0000:0000:0000:0001".
  //
  // Note that if you are behind reverse proxy(ies), this method returns
  // the IP of the last connecting proxy.
  remoteIP(): string {
    return expandIP(splitHost(this.request.remoteAddr));
  }

  // FindUploadedFiles extracts all form files of "key" from a http request
  // and returns a slice with filesystem.File instances (if any).
  //
  // Fails with ErrMissingFile when the key has no files.
  async findUploadedFiles(key: string): Promise<File[]> {
    if (this.request.multipartForm === undefined) {
      const err = await this.request.parseMultipartForm();
      if (err) {
        throw err;
      }
    }

    const files = this.request.multipartForm?.file.get(key);
    if (files === undefined || files.length === 0) {
      throw ErrMissingFile;
    }

    const result: File[] = [];

    for (const fh of files) {
      result.push(await NewFileFromMultipart(fh));
    }

    return result;
  }

  // Store
  // -------------------------------------------------------------------

  // Get retrieves single value from the current event data store.
  get(key: string): unknown {
    return this.#data.get(key);
  }

  // GetAll returns a copy of the current event data store.
  getAll(): Map<string, unknown> {
    return new Map(this.#data);
  }

  // Set saves single value into the current event data store.
  set(key: string, value: unknown): void {
    this.#data.set(key, value);
  }

  // SetAll saves all items from m into the current event data store.
  setAll(m: Map<string, unknown> | Record<string, unknown>): void {
    for (const [k, v] of m instanceof Map ? m : Object.entries(m)) {
      this.set(k, v);
    }
  }

  // Response writers
  // -------------------------------------------------------------------

  #setResponseHeaderIfEmpty(key: string, value: string): void {
    const header = this.response.header;
    if (!header.get(key)) {
      header.set(key, value);
    }
  }

  // String writes a plain string response.
  string(status: number, data: string): Error | undefined {
    this.#setResponseHeaderIfEmpty(headerContentType, "text/plain; charset=utf-8");
    this.response.writeHeader(status);
    return this.response.write(data);
  }

  // HTML writes an HTML response.
  html(status: number, data: string): Error | undefined {
    this.#setResponseHeaderIfEmpty(headerContentType, "text/html; charset=utf-8");
    this.response.writeHeader(status);
    return this.response.write(data);
  }

  // JSON writes a JSON response.
  json(status: number, data: unknown): Error | undefined {
    let picked = false;

    // try to pick only the requested fields (currently allowed only for "success" responses)
    const rawFields = this.request.query().get(jsonFieldsParam)?.[0] ?? "";
    if (rawFields !== "" && status >= 200 && status <= 299) {
      try {
        data = pick(data, rawFields);
        picked = true;
      } catch (err) {
        if (err instanceof PickPanic) {
          throw err; // a Go panic: the panic recovery middleware answers 500
        }
        if (!(err instanceof InvalidModifierDataError)) {
          return err instanceof Error ? err : new Error(String(err));
        }
        // @todo ignore for now modifier data errors to avoid introducing
        // breaking changes but once the router is merged with core consider
        // at least logging for dev purposes
      }
    }

    let body: string;
    try {
      if (picked) {
        body = marshal(data, {
          // for compliance with old data (and slightly better performance)
          allowDuplicateNames: true,
          // preserve the old jsonv1 behavior in case of invalid data
          allowInvalidUTF8: true,
        });
      } else if (isJSONMarshaler(data)) {
        // written as it is: the marshalers here (records, search results)
        // use the Go JSON port with the same options, so Go's reformatting
        // of a marshaler's output would not change it
        body = data.marshalJSON();
      } else {
        body = JSON.stringify(data) ?? "null";
      }
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }

    this.#setResponseHeaderIfEmpty(headerContentType, "application/json");
    this.response.writeHeader(status);
    return this.response.write(body);
  }

  // Stream streams the specified reader into the response.
  async stream(
    status: number,
    contentType: string,
    reader: ReadableStream<Uint8Array>,
  ): Promise<Error | undefined> {
    this.response.header.set(headerContentType, contentType);
    this.response.writeHeader(status);
    try {
      for await (const chunk of reader) {
        const err = this.response.write(chunk);
        if (err) {
          return err;
        }
      }
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
    return undefined;
  }

  // Blob writes a blob (bytes slice) response.
  blob(status: number, contentType: string, b: Uint8Array): Error | undefined {
    this.#setResponseHeaderIfEmpty(headerContentType, contentType);
    this.response.writeHeader(status);
    return this.response.write(b);
  }

  // NoContent writes a response with no body (ex. 204).
  noContent(status: number): Error | undefined {
    this.response.writeHeader(status);
    return undefined;
  }

  // Redirect writes a redirect response to the specified url.
  // The status code must be in between 300 – 399 range.
  redirect(status: number, url: string): Error | undefined {
    if (status < 300 || status > 399) {
      return ErrInvalidRedirectStatusCode;
    }
    this.response.header.set("Location", url);
    this.response.writeHeader(status);
    return undefined;
  }

  // ApiError helpers
  // -------------------------------------------------------------------

  error(status: number, message: string, errData: unknown): ApiError {
    return newApiError(status, message, errData);
  }

  badRequestError(message: string, errData: unknown): ApiError {
    return newBadRequestError(message, errData);
  }

  notFoundError(message: string, errData: unknown): ApiError {
    return newNotFoundError(message, errData);
  }

  forbiddenError(message: string, errData: unknown): ApiError {
    return newForbiddenError(message, errData);
  }

  unauthorizedError(message: string, errData: unknown): ApiError {
    return newUnauthorizedError(message, errData);
  }

  tooManyRequestsError(message: string, errData: unknown): ApiError {
    return newTooManyRequestsError(message, errData);
  }

  internalServerError(message: string, errData: unknown): ApiError {
    return newInternalServerError(message, errData);
  }

  // Binders
  // -------------------------------------------------------------------

  // BindBody unmarshals the request body into dst: a *map[string]any
  // (MapRef, a JSON null body sets it to null) when type is omitted,
  // otherwise the struct the type describes.
  //
  // The rules depend on the request Content-Type:
  //   - application/json: json/v2 with case-insensitive field names;
  //     only the first JSON value is read
  //   - text/xml, application/xml: the `xml` tags (structs only)
  //   - multipart/form-data, application/x-www-form-urlencoded: the `form`
  //     tags, see unmarshalRequestData
  async bindBody(dst: MapRef): Promise<Error | undefined>;
  async bindBody(dst: Record<string, unknown>, type: StructType): Promise<Error | undefined>;
  async bindBody(
    dst: MapRef | Record<string, unknown>,
    type?: StructType,
  ): Promise<Error | undefined> {
    if (this.request.contentLength === 0) {
      return undefined;
    }

    const contentType = this.request.headers.get(headerContentType) ?? "";

    try {
      if (contentType.startsWith("application/json")) {
        const value = await readFirstJSONValue(this.request.body);
        if (type) {
          unmarshalJSON(value, dst as Record<string, unknown>, type, true);
        } else {
          unmarshalJSON(value, dst as MapRef, undefined, true);
        }
        // manually rewind because reading the first value doesn't ensure
        // that the entire body was read (ex. trailing spaces or invalid
        // trailing parts like: `{"test":1},something`)
        if (isRereader(this.request.body)) {
          this.request.body.reread();
        }
        return undefined;
      }

      if (contentType.startsWith("multipart/form-data")) {
        const err = await this.request.parseMultipartForm();
        if (err) {
          return err;
        }
        bindRequestData(this.request.form, dst, type);
        return undefined;
      }

      if (contentType.startsWith("application/x-www-form-urlencoded")) {
        const err = await this.request.parseForm();
        if (err) {
          return err;
        }
        bindRequestData(this.request.form, dst, type);
        return undefined;
      }

      if (contentType.startsWith("text/xml") || contentType.startsWith("application/xml")) {
        if (!type) {
          return new Error("xml: unsupported type: map[string]interface {}");
        }
        unmarshalXML(await readAll(this.request.body), dst as Record<string, unknown>, type);
        return undefined;
      }
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }

    return ErrUnsupportedContentType;
  }
}

// Reads the first JSON value of body as a jsontext.Decoder does: in reads
// into a buffer that starts at 64 bytes and doubles when it is 3/4 full,
// stopping as soon as the value is complete (a top-level number needs the
// byte after it, or EOF). Bytes after the value are not read past that
// buffer, so a body limit only fails a body whose first value does not end
// within the limit. An error returned with data is ignored (jsontext's
// fetch); the next read throws it.
async function readFirstJSONValue(body: ReadCloser): Promise<JsonValue> {
  let buf = new Uint8Array(64);
  let length = 0;
  const scan = new FirstValueScanner();
  // a parse of the buffered bytes reports syntax errors before the value
  // ends; it is retried each time the buffer doubles
  let nextParse = 0;

  for (;;) {
    const end = scan.scan(buf, length);
    if (end === "invalid") {
      return decodeFirstValue(decodeUTF8Bytes(buf.subarray(0, length)));
    }
    if (end !== "more") {
      return decodeFirstValue(decodeUTF8Bytes(buf.subarray(0, end)));
    }
    if (length > 0 && length >= nextParse) {
      nextParse = length * 2;
      checkPrefix(buf.subarray(0, length));
    }

    if (length >= (buf.length * 3) / 4) {
      const grown = new Uint8Array(buf.length * 2);
      grown.set(buf.subarray(0, length));
      buf = grown;
    }
    const { n, eof } = await body.read(buf.subarray(length));
    if (n > 0) {
      length += n;
      continue;
    }
    if (eof) {
      // a value that ends at EOF, or the EOF error
      return decodeFirstValue(decodeUTF8Bytes(buf.subarray(0, length)));
    }
  }
}

// throws the syntax error of an incomplete JSON prefix, if it has one, as
// jsontext reports it before the value is complete. A number cut at the
// end of the prefix is dropped first (the parser rejects "1." or "-" as
// invalid numbers); a UTF-8 sequence cut at the end is not invalid UTF-8
// (utf8.FullRune). Other truncated tokens are EOF to the parser.
function checkPrefix(prefix: Uint8Array): void {
  let k = prefix.length;
  while (k > 0 && isNumberByte(prefix[k - 1] as number)) {
    k--;
  }
  const text = decodeUTF8Bytes(prefix.subarray(0, k));
  try {
    decodeFirstValue(text);
  } catch (err) {
    // an incomplete value is EOF; a syntax error is final
    if (!(err instanceof JsonEOFError)) {
      throw err;
    }
  }
  // invalid UTF-8 outside strings is a syntax error above; within one,
  // it fails the value, unless the bytes may start a rune
  const cut = cutRuneLength(prefix.subarray(0, k));
  if (hasInvalidUTF8(text.slice(0, text.length - cut))) {
    throw new JsonSyntaxError("invalid UTF-8 within string");
  }
}

// the number of bytes at the end of b that are an incomplete but valid
// start of a UTF-8 sequence (decodeUTF8Bytes makes each a lone surrogate)
function cutRuneLength(b: Uint8Array): number {
  for (let n = 1; n <= 3 && n <= b.length; n++) {
    const c = b[b.length - n] as number;
    if (c >= 0x80 && c <= 0xbf) {
      continue; // a continuation byte
    }
    const size =
      c >= 0xc2 && c <= 0xdf ? 2 : c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0;
    if (size <= n) {
      return 0;
    }
    // the second byte's range (utf8 acceptRanges)
    const second = b[b.length - n + 1];
    if (second !== undefined) {
      const lo = c === 0xe0 ? 0xa0 : c === 0xf0 ? 0x90 : 0x80;
      const hi = c === 0xed ? 0x9f : c === 0xf4 ? 0x8f : 0xbf;
      if (second < lo || second > hi) {
        return 0;
      }
    }
    return n;
  }
  return 0;
}

// 0-9 . e E + -
function isNumberByte(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x65 || c === 0x45 || c === 0x2b || c === 0x2d
  );
}

// Finds where the first JSON value of a growing buffer ends, without
// validating it: the offset after the value, "more" when the buffer has
// no complete value yet, or "invalid" at a byte that cannot appear there.
class FirstValueScanner {
  #pos = 0;
  #kind: "none" | "container" | "string" | "number" | "literal" = "none";
  #depth = 0;
  #inString = false;
  #escape = false;
  #literalEnd = 0;

  scan(buf: Uint8Array, length: number): number | "more" | "invalid" {
    for (; this.#pos < length; this.#pos++) {
      const c = buf[this.#pos] as number;
      switch (this.#kind) {
        case "none":
          if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
            continue;
          }
          if (c === 0x7b || c === 0x5b) {
            this.#kind = "container";
            this.#depth = 1;
          } else if (c === 0x22) {
            this.#kind = "string";
            this.#inString = true;
          } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
            this.#kind = "number";
          } else if (c === 0x74 || c === 0x6e) {
            // true, null
            this.#kind = "literal";
            this.#literalEnd = this.#pos + 4;
          } else if (c === 0x66) {
            // false
            this.#kind = "literal";
            this.#literalEnd = this.#pos + 5;
          } else {
            return "invalid";
          }
          continue;
        case "number":
          if (!isNumberByte(c)) {
            return this.#pos;
          }
          continue;
        case "literal":
          if (this.#pos >= this.#literalEnd) {
            return this.#literalEnd;
          }
          continue;
        default:
          break;
      }
      // container or string
      if (this.#inString) {
        if (this.#escape) {
          this.#escape = false;
        } else if (c === 0x5c) {
          this.#escape = true;
        } else if (c === 0x22) {
          this.#inString = false;
          if (this.#kind === "string") {
            return this.#pos + 1;
          }
        }
        continue;
      }
      if (c === 0x22) {
        this.#inString = true;
      } else if (c === 0x7b || c === 0x5b) {
        this.#depth++;
      } else if (c === 0x7d || c === 0x5d) {
        this.#depth--;
        if (this.#depth === 0) {
          return this.#pos + 1;
        }
      } else if (!isContainerByte(c)) {
        return "invalid";
      }
    }
    if (this.#kind === "literal" && length >= this.#literalEnd) {
      return this.#literalEnd;
    }
    return "more";
  }
}

// a byte outside strings in an object or array: whitespace, separators,
// numbers and the letters of true, false and null
function isContainerByte(c: number): boolean {
  return (
    c === 0x20 ||
    c === 0x09 ||
    c === 0x0a ||
    c === 0x0d ||
    c === 0x2c ||
    c === 0x3a ||
    isNumberByte(c) ||
    "truefalsn".includes(String.fromCharCode(c))
  );
}

function bindRequestData(
  data: RequestData | undefined,
  dst: MapRef | Record<string, unknown>,
  type: StructType | undefined,
): void {
  if (type) {
    unmarshalRequestData(data, dst as Record<string, unknown>, type, "", "");
  } else {
    unmarshalRequestData(data, dst as MapRef);
  }
}

// net.SplitHostPort host part ("" on error)
function splitHost(hostport: string): string {
  if (hostport.startsWith("[")) {
    const end = hostport.indexOf("]");
    return end < 0 ? "" : hostport.slice(1, end);
  }
  const colon = hostport.lastIndexOf(":");
  if (colon < 0) {
    return "";
  }
  const host = hostport.slice(0, colon);
  return host.includes(":") ? "" : host;
}

// netip.ParseAddr(ip).StringExpanded()
export function expandIP(ip: string): string {
  if (
    /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(ip)
  ) {
    return ip;
  }
  const [addr, zone] = ip.split("%", 2) as [string, string | undefined];
  if (!addr.includes(":")) {
    return "invalid IP";
  }
  let groups: number[];
  try {
    groups = parseIPv6(addr);
  } catch {
    return "invalid IP";
  }
  const expanded = groups.map((g) => g.toString(16).padStart(4, "0")).join(":");
  return zone ? `${expanded}%${zone}` : expanded;
}

function parseIPv6(addr: string): number[] {
  let tail: number[] = [];
  let s = addr;
  // embedded IPv4 suffix
  const v4 = /:((?:\d{1,3}\.){3}\d{1,3})$/.exec(s);
  if (v4) {
    const octets = (v4[1] as string).split(".").map(Number);
    if (octets.some((o) => o > 255)) {
      throw new Error("bad IPv4");
    }
    const [a, b, c, d] = octets as [number, number, number, number];
    tail = [(a << 8) | b, (c << 8) | d];
    s = s.slice(0, s.length - (v4[1] as string).length);
    if (s.endsWith("::")) {
      // keep the "::"
    } else {
      s = s.slice(0, -1);
    }
  }
  const double = s.indexOf("::");
  let groups: number[];
  if (double >= 0) {
    if (s.indexOf("::", double + 1) >= 0) {
      throw new Error("multiple ::");
    }
    const head = parseGroups(s.slice(0, double));
    const rest = parseGroups(s.slice(double + 2));
    const fill = 8 - head.length - rest.length - tail.length;
    if (fill < 1) {
      throw new Error("too many groups");
    }
    groups = [...head, ...Array.from({ length: fill }, () => 0), ...rest, ...tail];
  } else {
    groups = [...parseGroups(s), ...tail];
  }
  if (groups.length !== 8) {
    throw new Error("wrong group count");
  }
  return groups;
}

function parseGroups(part: string): number[] {
  if (part === "") {
    return [];
  }
  return part.split(":").map((g) => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
      throw new Error("bad group");
    }
    return Number.parseInt(g, 16);
  });
}
