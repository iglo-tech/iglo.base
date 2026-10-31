// Upstream: apis/record_auth_with_oauth2_redirect.go
//
// The realtime part is findOAuth2RedirectClient and sendOAuth2Redirect in
// src/realtime/realtime.ts. The fallback pages for a build without the
// bundled UI are not ported: the executable always has the UI. The debug
// logs are not written (application code logs errors only).

import type { RequestEvent } from "@/app/event-request";
import { findOAuth2RedirectClient, sendOAuth2Redirect } from "@/realtime/realtime";
import { oauth2SubscriptionTopic } from "@/realtime/realtime";
import type { HandlerResult } from "@/server/handler";
import { structOf } from "@/server/unmarshal-request-data";
import {
  anyType,
  mapOf,
  marshal,
  textToBytes,
  bytesToText,
  unmarshal,
} from "@/tools/types/go-json";

const oauth2RedirectFailurePath = "../_/#/auth/oauth2-redirect-failure";
const oauth2RedirectSuccessPath = "../_/#/auth/oauth2-redirect-success";
export const oauth2RedirectAppleNameStoreKeyPrefix = "@redirect_name_";

// how long the Apple user's name stays in the app store
const appleNameLifetimeMs = 60_000;

// requestEventKeySkipSuccessActivityLog (apis/middlewares.go): read by the
// activity logger (M5.5). A success log could contain sensitive information
// in the url.
const requestEventKeySkipSuccessActivityLog = "__skipSuccessActivityLogger";

const encoder = new TextEncoder();

const oauth2RedirectDataType = structOf([
  { name: "State", type: "string", tags: { form: "state", json: "state" } },
  { name: "Code", type: "string", tags: { form: "code", json: "code" } },
  { name: "Error", type: "string", tags: { form: "error", json: "error" } },
  // returned by Apple only
  { name: "AppleUser", type: "string", tags: { form: "user", json: "-" } },
]);

interface OAuth2RedirectData {
  State: string;
  Code: string;
  Error: string;
  AppleUser: string;
}

export async function oauth2SubscriptionRedirect(e: RequestEvent): Promise<HandlerResult> {
  // SkipSuccessActivityLog
  e.set(requestEventKeySkipSuccessActivityLog, true);

  const data: OAuth2RedirectData = { State: "", Code: "", Error: "", AppleUser: "" };

  if (e.request.method === "POST") {
    const bindErr = await e.bindBody(
      data as unknown as { [key: string]: unknown },
      oauth2RedirectDataType,
    );
    if (bindErr) {
      return failureRedirect(e);
    }
  } else {
    const query = e.request.query();
    data.State = query.get("state")?.[0] ?? "";
    data.Code = query.get("code")?.[0] ?? "";
    data.Error = query.get("error")?.[0] ?? "";
  }

  if (data.State === "") {
    return failureRedirect(e);
  }

  const client = findOAuth2RedirectClient(e.app, data.State, e.realIP());
  if (client === undefined) {
    return failureRedirect(e);
  }

  // temporary store the Apple user's name so that it can be later retrieved with the authWithOAuth2 call
  // (see https://ganigeorgiev.com/pocketbase/discussions/7090)
  if (data.AppleUser !== "" && data.Error === "" && data.Code !== "") {
    try {
      parseAndStoreAppleRedirectName(
        e,
        oauth2RedirectAppleNameStoreKeyPrefix + data.Code,
        data.AppleUser,
      );
    } catch {
      // non-critical error
    }
  }

  let encodedData: string;
  try {
    // in the struct's field order (marshal sorts a plain object's members)
    encodedData = `{"state":${marshal(data.State)},"code":${marshal(data.Code)}`;
    if (data.Error !== "") {
      encodedData += `,"error":${marshal(data.Error)}`;
    }
    encodedData += "}";
  } catch {
    client.unsubscribe(oauth2SubscriptionTopic);
    return failureRedirect(e);
  }

  sendOAuth2Redirect(client, encoder.encode(encodedData));

  if (data.Error !== "" || data.Code === "") {
    return failureRedirect(e);
  }

  return successRedirect(e);
}

function redirectStatusCode(e: RequestEvent): number {
  return e.request.method !== "GET" ? 303 : 307;
}

function failureRedirect(e: RequestEvent): HandlerResult {
  return e.redirect(redirectStatusCode(e), oauth2RedirectFailurePath);
}

function successRedirect(e: RequestEvent): HandlerResult {
  return e.redirect(redirectStatusCode(e), oauth2RedirectSuccessPath);
}

function appleNamePart(value: unknown): string {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new Error("json: cannot unmarshal into Go string");
  }
  return value ?? "";
}

// parseAndStoreAppleRedirectName extracts the first and last name
// from serializedNameData and temporary store them in the app.Store.
//
// This is hacky workaround to forward safely and seamlessly the Apple
// redirect user's name back to the OAuth2 auth handler.
//
// Note that currently Apple is the only provider that behaves like this and
// for now it is unnecessary to check whether the redirect is coming from Apple or not.
//
// Ideally this shouldn't be needed and will be removed in the future
// once Apple adds a dedicated userinfo endpoint.
function parseAndStoreAppleRedirectName(
  e: RequestEvent,
  nameKey: string,
  serializedNameData: string,
): void {
  // just in case to prevent storing large strings in memory
  if (textToBytes(nameKey).length > 1000) {
    throw new Error("nameKey is too large");
  }

  // https://developer.apple.com/documentation/signinwithapple/incorporating-sign-in-with-apple-into-other-platforms#Handle-the-response
  const extracted = unmarshal(serializedNameData, mapOf(anyType)) as
    | { [key: string]: unknown }
    | undefined;
  const name = extracted?.["name"];
  if (name !== undefined && name !== null && (typeof name !== "object" || Array.isArray(name))) {
    throw new Error("json: cannot unmarshal into Go struct");
  }
  const parts = (name ?? {}) as { [key: string]: unknown };

  const fullName = appleNamePart(parts["firstName"]) + " " + appleNamePart(parts["lastName"]);

  // truncate just in case to prevent storing large strings in memory
  const trimmed = bytesToText(textToBytes(fullName).subarray(0, 150)).trim();
  if (trimmed === "") {
    return;
  }

  // store (and remove)
  const store = e.app.store;
  store.set(nameKey, trimmed);
  setTimeout(() => store.remove(nameKey), appleNameLifetimeMs).unref();
}
