// Upstream: tools/router/event.go
//
// Event is the base route handler event, extended by the app's
// RequestEvent (@/app/event-request).
//
// Not ported yet:
//   - the JSON "fields" picker (tools/picker, M2.4);
//   - FindUploadedFiles (filesystem.File, M3.2) and FileFS (static files, M5.7);
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
import { decodeFirstValue } from "@/server/json-decode";
import type { HttpRequest } from "@/server/request";
import { readAll } from "@/server/rereadable-read-closer";
import type { ResponseWriter } from "@/server/router";
import {
  unmarshalJSON,
  unmarshalRequestData,
  type MapRef,
  type RequestData,
  type StructType,
} from "@/server/unmarshal-request-data";
import { unmarshalXML } from "@/server/xml-decode";

export const ErrUnsupportedContentType = newBadRequestError("Unsupported Content-Type", undefined);
export const ErrInvalidRedirectStatusCode = newInternalServerError(
  "Invalid redirect status code",
  undefined,
);
export const ErrFileNotFound = newNotFoundError("File not found", undefined);

export const IndexPage = "index.html";

const headerContentType = "Content-Type";

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
    // the "fields" query parameter picker lands with tools/picker (M2.4)
    this.#setResponseHeaderIfEmpty(headerContentType, "application/json");
    this.response.writeHeader(status);
    return this.response.write(JSON.stringify(data) ?? "null");
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
        const text = decodeUTF8(await readAll(this.request.body));
        if (type) {
          unmarshalJSON(decodeFirstValue(text), dst as Record<string, unknown>, type, true);
        } else {
          unmarshalJSON(decodeFirstValue(text), dst as MapRef, undefined, true);
        }
        // reading to EOF already rewound the body for the next read
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
        unmarshalXML(
          new TextDecoder().decode(await readAll(this.request.body)),
          dst as Record<string, unknown>,
          type,
        );
        return undefined;
      }
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }

    return ErrUnsupportedContentType;
  }
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

// JSON input must be valid UTF-8 (jsontext rejects invalid UTF-8)
function decodeUTF8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
