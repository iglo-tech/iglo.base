// Upstream: tools/filesystem/internal/s3blob/s3/s3.go
//
// Package s3 implements a lightweight client for interacting with the REST
// APIs of any S3 compatible service, on fetch. It takes upstream's client
// instead of Bun.S3Client because API responses show the raw S3 error, and
// object metadata, list pages and the multipart thresholds are on the wire
// as upstream's (M5.4a).
//
// S3.URL parses a key as url.Parse does for what real keys hold: a path, a
// query and a fragment. A key with a scheme ("a:b") stays a plain path here,
// where Go's parser takes it for an opaque URL (D26). Go's *url.Error texts
// for the failures of a request are put together in goRequestError: on an
// endpoint given by host name a refused connection names the host, where Go
// names the address it dialed. Go's 30 second dial timeout has no fetch
// counterpart; the operating system's applies.

import { errorsAs, joinErrors } from "@/tools/filesystem/blob/bucket";
import { ResponseError } from "@/tools/filesystem/internal/s3blob/s3/error";
import { childText, parseRoot } from "@/tools/filesystem/internal/s3blob/s3/xml";
import { goQuote } from "@/fields/field";
import { textToBytes } from "@/tools/types/go-json";

const awsS3ServiceCode = "s3";
const awsSignAlgorithm = "AWS4-HMAC-SHA256";
const awsTerminationString = "aws4_request";
export const metadataPrefix = "x-amz-meta-";

export interface S3Config {
  bucket: string;
  region: string;
  endpoint: string; // can be with or without the schema
  accessKey: string;
  secretKey: string;
  usePathStyle: boolean;
}

export interface S3Request {
  method: string;
  url: string;
  headers?: Headers;
  body?: Uint8Array | string;
  // Go's request context
  signal?: AbortSignal | undefined;
}

// the request options fetch has beyond RequestInit's
interface BunFetchInit extends RequestInit {
  decompress: boolean;
  timeout: boolean;
}

// Go's url.Parse of a key: the path with its escapes decoded (as a string of
// bytes), or null when it fails (Go's err branch keeps the text as it is)
function parsePath(rawPath: string): string | null {
  for (let i = 0; i < rawPath.length; i++) {
    const c = rawPath.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      return null;
    }
  }
  if (
    /^[^/]*:/.test(rawPath.split("/", 1)[0] as string) &&
    !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawPath)
  ) {
    return null; // first path segment in URL cannot contain colon
  }
  return unescapePath(rawPath);
}

// url.PathUnescape to a string of bytes; null on an invalid escape
function unescapePath(path: string): string | null {
  const bytes = Buffer.from(textToBytes(path)).toString("latin1");
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== "%") {
      out += bytes[i];
      continue;
    }
    const hex = bytes.slice(i + 1, i + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
      return null;
    }
    out += String.fromCharCode(Number.parseInt(hex, 16));
    i += 2;
  }
  return out;
}

export class S3 implements S3Config {
  bucket: string;
  region: string;
  endpoint: string;
  accessKey: string;
  secretKey: string;
  usePathStyle: boolean;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.region = config.region;
    this.endpoint = config.endpoint;
    this.accessKey = config.accessKey;
    this.secretKey = config.secretKey;
    this.usePathStyle = config.usePathStyle;
  }

  // URL constructs an S3 request URL based on the current configuration.
  //
  // Note that the path will be URL escaped based on the AWS UriEncode rules
  // for broader compatibility with some providers that expect the same path
  // format as the one in the canonical signed header.
  url(path: string): string {
    let scheme = "https";
    let endpoint = this.endpoint.replace(/\/+$/, "");
    if (endpoint.startsWith("https://")) {
      endpoint = endpoint.slice("https://".length);
    } else if (endpoint.startsWith("http://")) {
      endpoint = endpoint.slice("http://".length);
      scheme = "http";
    }

    // to prevent double escaping we first parse/unescape it
    const hash = path.indexOf("#");
    const fragment = hash === -1 ? null : path.slice(hash + 1);
    const noFragment = hash === -1 ? path : path.slice(0, hash);
    const question = noFragment.indexOf("?");
    const rawPath = question === -1 ? noFragment : noFragment.slice(0, question);
    const parsed = parsePath(rawPath);
    if (parsed !== null) {
      path = escapePath(parsed);

      // the rest is usually not expected to be part of the S3 path but it
      // is kept to avoid surprises
      if (question !== -1 && question < noFragment.length - 1) {
        path += "?" + noFragment.slice(question + 1);
      }
      if (fragment !== null && fragment !== "") {
        path += "#" + fragment;
      }
    }

    path = path.replace(/^\/+/, "");

    if (this.usePathStyle) {
      return `${scheme}://${endpoint}/${this.bucket}/${path}`;
    }

    return `${scheme}://${this.bucket}.${endpoint}/${path}`;
  }

  // SignAndSend signs the provided request per AWS Signature v4 and sends
  // it.
  //
  // It automatically normalizes all 40x/50x responses to ResponseError.
  async signAndSend(req: S3Request): Promise<Response> {
    const headers = new Headers(req.headers);
    const parsed = parseRequestURL(req.url);
    this.#sign(req.method, parsed, headers);

    const init: BunFetchInit = {
      method: req.method,
      headers,
      decompress: false,
      timeout: false,
    };
    if (req.body !== undefined) {
      init.body = req.body as Uint8Array<ArrayBuffer> | string;
    }
    if (req.signal !== undefined) {
      init.signal = req.signal;
    }

    let resp: Response;
    try {
      resp = await fetch(req.url, init);
    } catch (err) {
      throw goRequestError(req.method, req.url, err, req.signal);
    }

    if (resp.status < 400) {
      return resp;
    }

    const respErr = new ResponseError(resp.status);

    try {
      respErr.raw = new Uint8Array(await resp.arrayBuffer());
    } catch (err) {
      throw joinErrors(goRequestError(req.method, req.url, err, req.signal), respErr);
    }

    if (respErr.raw.length > 0) {
      try {
        const root = parseRoot(respErr.raw, "Error");
        respErr.code = childText(root, "Code");
        respErr.s3Message = childText(root, "Message");
        const status = Number.parseInt(childText(root, "Status").trim(), 10);
        if (Number.isSafeInteger(status)) {
          respErr.status = status;
        }
      } catch (err) {
        throw joinErrors(err, respErr);
      }
    }

    throw respErr;
  }

  // https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html#create-signed-request-steps
  #sign(method: string, url: ParsedURL, headers: Headers): void {
    // explicitly set Accept-Encoding to avoid transparent decompression
    if ((headers.get("Accept-Encoding") ?? "") === "") {
      headers.set("Accept-Encoding", "identity");
    }

    // fallback to the Unsigned payload option
    // (data integrity checks could be still applied via the content-md5 or
    // x-amz-checksum-* headers)
    if ((headers.get("x-amz-content-sha256") ?? "") === "") {
      headers.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
    }

    let dateTime = headers.get("x-amz-date") ?? "";
    if (!/^\d{8}T\d{6}Z$/.test(dateTime)) {
      dateTime = new Date()
        .toISOString()
        .replace(/\.\d+Z$/, "Z")
        .replace(/[-:]/g, "");
      headers.set("x-amz-date", dateTime);
    }

    headers.set("host", url.host);

    const date = dateTime.slice(0, 8);

    // 1. Create canonical request
    // -----------------------------------------------------------------
    const { canonicalHeaders, signedHeaders } = canonicalAndSignedHeaders(headers);

    const canonicalParts = [
      method,
      escapePath(url.path),
      escapeQuery(url.query),
      canonicalHeaders,
      signedHeaders,
      headers.get("x-amz-content-sha256") as string,
    ];

    // 2. Create a hash of the canonical request
    // -----------------------------------------------------------------
    const hashedCanonicalRequest = sha256Hex(canonicalParts.join("\n"));

    // 3. Create a string to sign
    // -----------------------------------------------------------------
    const scope = [date, this.region, awsS3ServiceCode, awsTerminationString].join("/");

    const stringToSign = [awsSignAlgorithm, dateTime, scope, hashedCanonicalRequest].join("\n");

    // 4. Derive a signing key for SigV4
    // -----------------------------------------------------------------
    const dateKey = hmacSHA256(textToBytes("AWS4" + this.secretKey), date);
    const dateRegionKey = hmacSHA256(dateKey, this.region);
    const dateRegionServiceKey = hmacSHA256(dateRegionKey, awsS3ServiceCode);
    const signingKey = hmacSHA256(dateRegionServiceKey, awsTerminationString);
    const signature = Buffer.from(hmacSHA256(signingKey, stringToSign)).toString("hex");

    // 5. Add the signature to the request
    headers.set(
      "authorization",
      `${awsSignAlgorithm} Credential=${this.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    );
  }
}

interface ParsedURL {
  host: string;
  // the decoded path, a string of bytes
  path: string;
  // the decoded query, key and value as strings of bytes
  query: [string, string][];
}

function parseRequestURL(url: string): ParsedURL {
  const bad = /%(?![0-9a-fA-F]{2})(.{0,2})/s.exec(url.split("?", 1)[0] as string);
  if (bad !== null) {
    throw new Error(`parse ${goQuote(url)}: invalid URL escape ${goQuote("%" + (bad[1] ?? ""))}`);
  }

  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new Error(`parse ${goQuote(url)}: invalid URL`);
  }

  const rest = url.replace(/^https?:\/\/[^/?#]*/, "").replace(/#.*$/s, "");
  const question = rest.indexOf("?");
  return {
    host,
    path: unescapePath(question === -1 ? rest : rest.slice(0, question)) ?? "",
    query: question === -1 ? [] : parseQuery(rest.slice(question + 1)),
  };
}

// url.ParseQuery, leaving out what it refuses
function parseQuery(rawQuery: string): [string, string][] {
  const out: [string, string][] = [];
  for (const pair of rawQuery.split("&")) {
    if (pair === "" || pair.includes(";")) {
      continue;
    }
    const eq = pair.indexOf("=");
    const key = unescapePath((eq === -1 ? pair : pair.slice(0, eq)).replaceAll("+", " "));
    const value = unescapePath((eq === -1 ? "" : pair.slice(eq + 1)).replaceAll("+", " "));
    if (key !== null && value !== null) {
      out.push([key, value]);
    }
  }
  return out;
}

// Go's *url.Error of a failed client.Do
function goRequestError(
  method: string,
  url: string,
  err: unknown,
  signal: AbortSignal | undefined,
): Error {
  const op = method[0] + method.slice(1).toLowerCase();
  const prefix = `${op} ${goQuote(url)}: `;
  const code = (err as { code?: string } | null)?.code;
  const location = new URL(url);
  const port = location.port || (location.protocol === "https:" ? "443" : "80");
  let text: string;
  if (signal?.aborted === true) {
    text = "context deadline exceeded";
  } else if (code === "ECONNREFUSED") {
    text = `dial tcp ${location.hostname}:${port}: connect: connection refused`;
  } else if (code === "ENOTFOUND") {
    text = `dial tcp: lookup ${location.hostname}: no such host`;
  } else {
    text = err instanceof Error ? err.message : String(err);
  }
  return new Error(prefix + text, { cause: err });
}

export function isResponseError(err: unknown): ResponseError | null {
  return errorsAs(err, ResponseError);
}

function sha256Hex(content: string): string {
  return new Bun.CryptoHasher("sha256").update(textToBytes(content)).digest("hex");
}

function hmacSHA256(key: Uint8Array, content: string): Uint8Array {
  return new Bun.CryptoHasher("sha256", key).update(textToBytes(content)).digest();
}

function canonicalAndSignedHeaders(headers: Headers): {
  canonicalHeaders: string;
  signedHeaders: string;
} {
  const signed: string[] = [];
  const canonical = new Map<string, string>();

  headers.forEach((value, key) => {
    const normalizedKey = key.toLowerCase();

    if (
      normalizedKey !== "host" &&
      normalizedKey !== "content-type" &&
      !normalizedKey.startsWith("x-amz-")
    ) {
      return;
    }

    signed.push(normalizedKey);

    // trim any leading or trailing spaces
    // convert sequential spaces to a single space
    canonical.set(normalizedKey, value.trim().replaceAll("  ", " "));
  });

  signed.sort();

  let sortedCanonical = "";
  for (const key of signed) {
    sortedCanonical += `${key}:${canonical.get(key) as string}\n`;
  }

  return { canonicalHeaders: sortedCanonical, signedHeaders: signed.join(";") };
}

// extractMetadata parses and extracts the metadata from the specified
// request headers.
//
// The metadata keys are all lowercased and without the "x-amz-meta-" prefix.
export function extractMetadata(headers: Headers): Map<string, string> {
  const result = new Map<string, string>();

  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower.startsWith(metadataPrefix)) {
      result.set(lower.slice(metadataPrefix.length), value);
    }
  });

  return result;
}

// escapeQuery returns the URI encoded request query parameters according to
// the AWS S3 spec requirements (it is similar to url.Values.Encode but
// instead of url.QueryEscape uses our own escape method).
function escapeQuery(values: [string, string][]): string {
  const keys = [...new Set(values.map(([k]) => k))].toSorted((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  const out: string[] = [];
  for (const k of keys) {
    for (const [key, value] of values) {
      if (key === k) {
        out.push(`${escape(k)}=${escape(value)}`);
      }
    }
  }

  return out.join("&");
}

// escapePath returns the URI encoded request path according to the AWS S3
// spec requirements. path is a string of bytes.
function escapePath(path: string): string {
  return path.split("/").map(escape).join("/");
}

const unreserved = /^[A-Za-z0-9\-._~]$/;

// escape is similar to the std url.escape but implements the AWS UriEncode
// requirements: every byte of the string of bytes s except the unreserved
// characters is encoded, the hexadecimal letters in upper case.
function escape(s: string): string {
  let out = "";
  for (const ch of s) {
    out += unreserved.test(ch)
      ? ch
      : "%" + (ch.codePointAt(0) as number).toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}
