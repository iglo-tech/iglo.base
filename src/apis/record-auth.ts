// Upstream: apis/record_auth.go (bindRecordAuthApi, findAuthCollection)
//
// The routes of this task are bound in upstream's order; the others keep
// a named slot. collectionPathRateLimit resolves the path collection
// (a missing one is a 404 before any other middleware); its settings rate
// limit rules are M4.8.

import type { App } from "@/app/app";
import type { RequestEvent } from "@/app/event-request";
import { recordAuthImpersonate } from "@/apis/record-auth-impersonate";
import { recordAuthMethods } from "@/apis/record-auth-methods";
import { recordRequestOTP } from "@/apis/record-auth-otp-request";
import { recordAuthRefresh } from "@/apis/record-auth-refresh";
import { recordAuthWithOTP } from "@/apis/record-auth-with-otp";
import { recordAuthWithPassword } from "@/apis/record-auth-with-password";
import type { Collection } from "@/collections/collection-model";
import { findCachedCollectionByNameOrId } from "@/collections/collection-query";
import { collectionPathRateLimit } from "@/middlewares/rate-limit";
import { requireSameCollectionContextAuth, requireSuperuserAuth } from "@/middlewares/require-auth";
import type { ApiError } from "@/server/error";
import type { RouterGroup } from "@/server/group";

// bindRecordAuthApi registers the auth record api endpoints and
// the corresponding handlers.
export function bindRecordAuthApi(_app: App, rg: RouterGroup<RequestEvent>): void {
  // GET and POST /oauth2-redirect (oauth2SubscriptionRedirect): M4.5

  const sub = rg.group("/collections/{collection}");

  sub.GET("/auth-methods", recordAuthMethods).bind(collectionPathRateLimit("", "listAuthMethods"));

  sub
    .POST("/auth-refresh", recordAuthRefresh)
    .bind(collectionPathRateLimit("", "authRefresh"), requireSameCollectionContextAuth(""));

  sub
    .POST("/auth-with-password", recordAuthWithPassword)
    .bind(collectionPathRateLimit("", "authWithPassword", "auth"));

  // POST /auth-with-oauth2 (recordAuthWithOAuth2): M4.5

  sub.POST("/request-otp", recordRequestOTP).bind(collectionPathRateLimit("", "requestOTP"));

  sub
    .POST("/auth-with-otp", recordAuthWithOTP)
    .bind(collectionPathRateLimit("", "authWithOTP", "auth"));

  // POST /request-password-reset, /confirm-password-reset,
  // /request-verification, /confirm-verification, /request-email-change
  // and /confirm-email-change: M4.3

  sub.POST("/impersonate/{id}", recordAuthImpersonate).bind(requireSuperuserAuth());
}

// findAuthCollection returns the auth collection of the path's
// "collection" value, or the 404 error.
export function findAuthCollection(e: RequestEvent): Collection | ApiError {
  let collection: Collection | undefined;
  let err: unknown = null;
  try {
    collection = findCachedCollectionByNameOrId(e.app, e.request.pathValue("collection"));
  } catch (findErr) {
    err = findErr;
  }

  if (collection === undefined || !collection.isAuth()) {
    return e.notFoundError("Missing or invalid auth collection context.", err);
  }

  return collection;
}
