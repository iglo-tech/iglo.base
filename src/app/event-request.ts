// Upstream: core/event_request.go
//
// RequestEvent is the app's router handler event. The auth record is set by
// the loadAuthToken middleware (src/middlewares/load-auth-token.ts). Trusted
// proxy headers for RealIP land in M5.7 (settings); until then RealIP is
// RemoteIP.

import type { App } from "@/app/app";
import type { Record } from "@/records/record-model";
import { Event } from "@/server/event";
import { setOwn } from "@/server/json-decode";
import type { HttpRequest } from "@/server/request";
import type { ResponseWriter } from "@/server/router";
import type { MapRef } from "@/server/unmarshal-request-data";

// Common request store keys used by the middlewares and api handlers.
export const RequestEventKeyInfoContext = "infoContext";

export const RequestInfoContextDefault = "default";
export const RequestInfoContextExpand = "expand";
export const RequestInfoContextRealtime = "realtime";
export const RequestInfoContextProtectedFile = "protectedFile";
export const RequestInfoContextBatch = "batch";
export const RequestInfoContextOAuth2 = "oauth2";
export const RequestInfoContextOTP = "otp";
export const RequestInfoContextPasswordAuth = "password";

// RequestInfo defines a HTTP request data struct, usually used
// as part of the `@request.*` filter resolver.
//
// The query and headers fields contain only the first value for each found entry.
export class RequestInfo {
  query: { [key: string]: string } = {};
  headers: { [key: string]: string } = {};
  // null when the body unmarshals a JSON null (a nil map upstream)
  body: { [key: string]: unknown } | null = {};
  auth: Record | undefined;
  method = "";
  context = "";

  // HasSuperuserAuth checks whether the current RequestInfo instance
  // has superuser authentication loaded.
  hasSuperuserAuth(): boolean {
    return this.auth !== undefined && this.auth.isSuperuser();
  }

  // Clone creates a new shallow copy of the current RequestInfo and its Auth record (if any).
  clone(): RequestInfo {
    const clone = new RequestInfo();
    clone.method = this.method;
    clone.context = this.context;
    clone.query = { ...this.query };
    clone.body = this.body === null ? null : { ...this.body };
    clone.headers = { ...this.headers };
    if (this.auth) {
      clone.auth = this.auth.fresh();
    }
    return clone;
  }
}

export class RequestEvent extends Event {
  readonly app: App;
  auth: Record | undefined;

  #cachedRequestInfo: RequestInfo | undefined;

  constructor(app: App, response: ResponseWriter, request: HttpRequest) {
    super(response, request);
    this.app = app;
  }

  // RealIP returns the "real" IP address from the configured trusted proxy
  // headers. Until settings exist (M5.7: trusted proxy) it is RemoteIP.
  realIP(): string {
    return this.remoteIP();
  }

  // HasSuperuserAuth checks whether the current RequestEvent has superuser authentication loaded.
  hasSuperuserAuth(): boolean {
    return this.auth !== undefined && this.auth.isSuperuser();
  }

  // RequestInfo parses the current request into RequestInfo instance.
  //
  // Note that the returned result is cached to avoid copying the request data multiple times
  // but the auth state and other common store items are always refreshed in case they were changed by another handler.
  async requestInfo(): Promise<RequestInfo | Error> {
    if (this.#cachedRequestInfo) {
      this.#cachedRequestInfo.auth = this.auth;

      const infoCtx = this.get(RequestEventKeyInfoContext);
      if (typeof infoCtx === "string" && infoCtx !== "") {
        this.#cachedRequestInfo.context = infoCtx;
      } else {
        this.#cachedRequestInfo.context = RequestInfoContextDefault;
      }
    } else {
      // (re)init the cached request info based on the current request event
      const err = await this.#initRequestInfo();
      if (err) {
        return err;
      }
    }

    return this.#cachedRequestInfo as RequestInfo;
  }

  async #initRequestInfo(): Promise<Error | undefined> {
    let infoCtx = this.get(RequestEventKeyInfoContext);
    if (typeof infoCtx !== "string" || infoCtx === "") {
      infoCtx = RequestInfoContextDefault;
    }

    const info = new RequestInfo();
    info.context = infoCtx as string;
    info.method = this.request.method;

    const body: MapRef = { map: {} };
    const err = await this.bindBody(body);
    if (err) {
      return err;
    }
    info.body = body.map;

    // extract the first value of all query params
    for (const [k, v] of this.request.query()) {
      if (v.length > 0) {
        // own property, so keys like "__proto__" are kept as submitted
        setOwn(info.query, k, v[0] as string);
      }
    }

    // extract the first value of all headers and normalizes the keys
    // ("X-Token" is converted to "x_token")
    for (const [k, v] of this.request.headers) {
      // Bun.serve joins repeated header lines with ", " (D22)
      setOwn(info.headers, snakecase(k), v);
    }

    info.auth = this.auth;

    this.#cachedRequestInfo = info;

    return undefined;
  }
}

// inflector.Snakecase removes all non word characters and converts any
// english text into a snakecase. "ABBREVIATIONS" are preserved, eg.
// "myTestDB" will become "my_test_db".
export function snakecase(str: string): string {
  let result = "";

  // split at any non word character and underscore
  for (const word of str.split(/[\W_]+/)) {
    if (word === "") {
      continue;
    }

    if (result.length > 0) {
      result += "_";
    }

    for (let i = 0; i < word.length; i++) {
      const c = word[i] as string;
      if (isUpper(c) && i > 0 && !isUpper(word[i - 1] as string)) {
        result += "_";
      }
      result += c;
    }
  }

  return result.toLowerCase();
}

function isUpper(c: string): boolean {
  return /\p{Lu}/u.test(c);
}
