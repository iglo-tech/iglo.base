// Upstream: golang.org/x/oauth2 v0.37.0: token.go (Token, Type, Extra,
// expired, Valid), oauth2.go (Config.Exchange, tokenRefresher,
// reuseTokenSource) and internal/token.go (RetrieveToken, newTokenRequest,
// doTokenRoundTrip, tokenJSON, expirationTime)
//
// Only what tools/auth uses. The config's AuthStyle is always AuthStyleAutoDetect
// (BaseProvider sets none): the client credentials go in a Basic header first
// and, after any failure, in the form body. A new Config per call means
// the style cache never hits, so it is not ported. The error texts stay,
// they reach only the logs.
//
// tokenJSON is decoded with encoding/json (v1) semantics, except that the
// field names are matched exactly (v1 also takes ACCESS_TOKEN). An
// `expires_in` number with an integer value but a fraction or exponent in
// its text (3600.0) is accepted here and refused by json.Number.Int64.

import type { Clock } from "@/app/clock";
import { parseQuery, encodeValues, queryEscape, type Values } from "@/server/request";
import { parseGoFloat } from "@/server/unmarshal-request-data";
import { anyType, mapOf, stringType, unmarshal, unmarshalStruct } from "@/tools/types/go-json";

// defaultExpiryDelta: how many seconds before its expiry a token counts as expired
const defaultExpiryDeltaMs = 10_000;

// doTokenRoundTrip's io.LimitReader
const maxTokenResponseBytes = 1 << 20;

const maxInt32 = 2147483647n;

// the endpoint and credentials of a token request (the parts of
// oauth2.Config that RetrieveToken reads)
export interface TokenConfig {
  clientId: string;
  clientSecret: string;
  tokenURL: string;
  signal: AbortSignal | undefined;
  clock: Clock;
}

// oauth2.Token
export class Token {
  accessToken = "";
  tokenType = "";
  refreshToken = "";
  // the zero time.Time is null
  expiry: Date | null = null;
  // the raw response: a JSON object, or a query string's values
  raw: { [key: string]: unknown } | Values | null = null;

  constructor(init: Partial<Token> = {}) {
    Object.assign(this, init);
  }

  // Type returns t.TokenType if non-empty, else "Bearer".
  type(): string {
    const lower = this.tokenType.toLowerCase();
    if (lower === "bearer" || lower === "") {
      return "Bearer";
    }
    if (lower === "mac") {
      return "MAC";
    }
    if (lower === "basic") {
      return "Basic";
    }
    return this.tokenType;
  }

  // Extra returns an extra field: a key-value pair returned by the server
  // as part of the token retrieval response.
  extra(key: string): unknown {
    const raw = this.raw;
    if (raw === null) {
      return undefined;
    }
    if (!(raw instanceof Map)) {
      return Object.hasOwn(raw, key) ? raw[key] : undefined;
    }

    const v = raw.get(key)?.[0] ?? "";
    const s = v.trim();
    switch (s.split(".").length - 1) {
      case 0: // contains no "."; try to parse as int
        if (/^[+-]?[0-9]+$/.test(s)) {
          const i = BigInt(s);
          if (BigInt.asIntN(64, i) === i) {
            return Number(i);
          }
        }
        break;
      case 1: // contains a single "."; try to parse as float
        try {
          return parseGoFloat(s, 64);
        } catch {
          // not a float
        }
        break;
    }

    return v;
  }

  // Valid reports whether t has an AccessToken and is not expired.
  valid(clock: Clock): boolean {
    return this.accessToken !== "" && !this.#expired(clock);
  }

  #expired(clock: Clock): boolean {
    if (this.expiry === null) {
      return false;
    }
    return this.expiry.getTime() - defaultExpiryDeltaMs < clock.now().getTime();
  }
}

// Config.Exchange: converts an authorization code into a token. opts are
// its SetAuthURLParam options, in order.
export function exchangeToken(
  c: TokenConfig,
  redirectURL: string,
  code: string,
  opts: readonly (readonly [key: string, value: string])[],
): Promise<Token> {
  const v: Values = new Map([
    ["grant_type", ["authorization_code"]],
    ["code", [code]],
  ]);
  if (redirectURL !== "") {
    v.set("redirect_uri", [redirectURL]);
  }
  for (const [key, value] of opts) {
    v.set(key, [value]);
  }
  return retrieveToken(c, v);
}

// reuseTokenSource.Token: the token while it is valid, otherwise a new one
// through its refresh token (tokenRefresher.Token)
export async function validToken(c: TokenConfig, token: Token): Promise<Token> {
  if (token.valid(c.clock)) {
    return token;
  }

  if (token.refreshToken === "") {
    throw new Error("oauth2: token expired and refresh token is not set");
  }

  return retrieveToken(
    c,
    new Map([
      ["grant_type", ["refresh_token"]],
      ["refresh_token", [token.refreshToken]],
    ]),
  );
}

async function retrieveToken(c: TokenConfig, v: Values): Promise<Token> {
  let token: Token;
  try {
    token = await doTokenRoundTrip(c, newTokenRequest(c, v, false));
  } catch {
    // assume the server wants the clientID & clientSecret in a different form
    token = await doTokenRoundTrip(c, newTokenRequest(c, v, true));
  }

  // don't overwrite `RefreshToken` with an empty value
  // if this was a token refreshing request
  if (token.refreshToken === "") {
    token.refreshToken = v.get("refresh_token")?.[0] ?? "";
  }

  return token;
}

// newTokenRequest: the credentials in the form body (inParams) or in the
// Authorization header
function newTokenRequest(c: TokenConfig, v: Values, inParams: boolean): RequestInit {
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  const values = new Map(v);

  if (inParams) {
    if (c.clientId !== "") {
      values.set("client_id", [c.clientId]);
    }
    if (c.clientSecret !== "") {
      values.set("client_secret", [c.clientSecret]);
    }
  } else {
    const credentials = queryEscape(c.clientId) + ":" + queryEscape(c.clientSecret);
    headers.set("Authorization", "Basic " + btoa(credentials));
  }

  return { method: "POST", headers, body: encodeValues(values) };
}

async function doTokenRoundTrip(c: TokenConfig, init: RequestInit): Promise<Token> {
  const res = await fetch(c.tokenURL, { ...init, signal: c.signal ?? null });
  const body = await readLimited(res, maxTokenResponseBytes);

  const failureStatus = res.status < 200 || res.status > 299;
  const retrieveError = (errorCode = ""): Error =>
    new Error(
      errorCode !== ""
        ? `oauth2: "${errorCode}"`
        : `oauth2: cannot fetch token: ${res.status}\nResponse: ${new TextDecoder().decode(body)}`,
    );

  let token: Token;
  let errorCode = "";
  const content = mediaType(res.headers.get("Content-Type") ?? "");
  if (content === "application/x-www-form-urlencoded" || content === "text/plain") {
    // some endpoints return a query string
    const { values, err } = parseQuery(new TextDecoder().decode(body));
    if (err) {
      if (failureStatus) {
        throw retrieveError();
      }
      throw new Error(`oauth2: cannot parse response: ${err.message}`);
    }
    errorCode = values.get("error")?.[0] ?? "";
    token = new Token({
      accessToken: values.get("access_token")?.[0] ?? "",
      tokenType: values.get("token_type")?.[0] ?? "",
      refreshToken: values.get("refresh_token")?.[0] ?? "",
      raw: values,
    });
    const expires = atoi(values.get("expires_in")?.[0] ?? "");
    if (expires !== 0) {
      token.expiry = new Date(c.clock.now().getTime() + expires * 1000);
    }
  } else {
    let tj: TokenJSON;
    try {
      tj = decodeTokenJSON(body);
    } catch (err) {
      if (failureStatus) {
        throw retrieveError();
      }
      throw new Error(`oauth2: cannot parse json: ${(err as Error).message}`, { cause: err });
    }
    errorCode = tj.error;
    token = new Token({
      accessToken: tj.accessToken,
      tokenType: tj.tokenType,
      refreshToken: tj.refreshToken,
    });
    if (tj.expiresIn !== 0) {
      token.expiry = new Date(c.clock.now().getTime() + tj.expiresIn * 1000);
    }
    try {
      // no error checks for optional fields
      token.raw = unmarshal(body, mapOf(anyType), { legacy: true }) as {
        [key: string]: unknown;
      };
    } catch {
      token.raw = {};
    }
  }

  // according to spec, servers should respond status 400 in error case
  // https://www.rfc-editor.org/rfc/rfc6749#section-5.2
  // but some unorthodox servers respond 200 in error case
  if (failureStatus || errorCode !== "") {
    throw retrieveError(errorCode);
  }
  if (token.accessToken === "") {
    throw new Error("oauth2: server response missing access_token");
  }

  return token;
}

interface TokenJSON {
  accessToken: string;
  tokenType: string;
  refreshToken: string;
  expiresIn: number;
  error: string;
}

function decodeTokenJSON(body: Uint8Array): TokenJSON {
  const tj: TokenJSON = {
    accessToken: "",
    tokenType: "",
    refreshToken: "",
    expiresIn: 0,
    error: "",
  };
  const text =
    (key: "accessToken" | "tokenType" | "refreshToken" | "error") => (value: unknown) => {
      tj[key] = (value ?? "") as string;
    };
  unmarshalStruct(
    body,
    {
      access_token: text("accessToken"),
      token_type: text("tokenType"),
      refresh_token: text("refreshToken"),
      error: text("error"),
      expires_in: (value) => {
        if (value !== null && value !== undefined) {
          tj.expiresIn = expirationTime(value);
        }
      },
    },
    {
      access_token: stringType,
      token_type: stringType,
      refresh_token: stringType,
      error: stringType,
      expires_in: anyType, // at least PayPal returns string, while most return number
    },
    () => {},
    { legacy: true },
  );
  return tj;
}

// expirationTime.UnmarshalJSON: a number or a numeric string, as an int32
function expirationTime(value: unknown): number {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(text)) {
    throw new Error(`oauth2: invalid expires_in ${String(value)}`);
  }
  const i = BigInt(text);
  if (BigInt.asIntN(64, i) !== i) {
    throw new Error(`oauth2: expires_in ${text} out of range`);
  }
  return Number(BigInt.asIntN(32, i > maxInt32 ? maxInt32 : i));
}

// strconv.Atoi with its error ignored, as doTokenRoundTrip does: 0 for a
// value that is not a number
function atoi(s: string): number {
  return /^[+-]?[0-9]+$/.test(s) ? Number(s) : 0;
}

// the type of mime.ParseMediaType, for an exact comparison
function mediaType(value: string): string {
  return (value.split(";")[0] as string).trim().toLowerCase();
}

// io.ReadAll(io.LimitReader(res.Body, limit)): what is past the limit is
// dropped, not an error
export async function readLimited(res: Response, limit: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (reader === undefined) {
    return new Uint8Array();
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const chunk = value.subarray(0, limit - size);
    chunks.push(chunk);
    size += chunk.length;
  }
  await reader.cancel();

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
