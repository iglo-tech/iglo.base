// Upstream: apis/record_auth.go (bindRecordAuthApi, findAuthCollection)
//
// The routes are bound in upstream's order. collectionPathRateLimit resolves the path collection
// (a missing one is a 404 before any other middleware); its settings rate
// limit rules are M4.8.

import type { App } from "@/app/app";
import type { RequestEvent } from "@/app/event-request";
import { recordConfirmEmailChange } from "@/apis/record-auth-email-change-confirm";
import { recordRequestEmailChange } from "@/apis/record-auth-email-change-request";
import { recordAuthImpersonate } from "@/apis/record-auth-impersonate";
import { recordAuthMethods } from "@/apis/record-auth-methods";
import { recordRequestOTP } from "@/apis/record-auth-otp-request";
import { recordConfirmPasswordReset } from "@/apis/record-auth-password-reset-confirm";
import { recordRequestPasswordReset } from "@/apis/record-auth-password-reset-request";
import { recordAuthRefresh } from "@/apis/record-auth-refresh";
import { recordConfirmVerification } from "@/apis/record-auth-verification-confirm";
import { recordRequestVerification } from "@/apis/record-auth-verification-request";
import { recordAuthWithOAuth2, type RecordAuthOptions } from "@/apis/record-auth-with-oauth2";
import { oauth2SubscriptionRedirect } from "@/apis/record-auth-with-oauth2-redirect";
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
//
// options carries the test seams of the OAuth2 flow.
export function bindRecordAuthApi(
  _app: App,
  rg: RouterGroup<RequestEvent>,
  options: RecordAuthOptions = {},
): void {
  // global oauth2 subscription redirect handler
  rg.GET("/oauth2-redirect", oauth2SubscriptionRedirect);
  // add again as POST in case of response_mode=form_post
  rg.POST("/oauth2-redirect", oauth2SubscriptionRedirect);

  const sub = rg.group("/collections/{collection}");

  sub.GET("/auth-methods", recordAuthMethods).bind(collectionPathRateLimit("", "listAuthMethods"));

  sub
    .POST("/auth-refresh", recordAuthRefresh)
    .bind(collectionPathRateLimit("", "authRefresh"), requireSameCollectionContextAuth(""));

  sub
    .POST("/auth-with-password", recordAuthWithPassword)
    .bind(collectionPathRateLimit("", "authWithPassword", "auth"));

  sub
    .POST("/auth-with-oauth2", (e) => recordAuthWithOAuth2(e, options))
    .bind(collectionPathRateLimit("", "authWithOAuth2", "auth"));

  sub.POST("/request-otp", recordRequestOTP).bind(collectionPathRateLimit("", "requestOTP"));

  sub
    .POST("/auth-with-otp", recordAuthWithOTP)
    .bind(collectionPathRateLimit("", "authWithOTP", "auth"));

  sub
    .POST("/request-password-reset", recordRequestPasswordReset)
    .bind(collectionPathRateLimit("", "requestPasswordReset"));
  sub
    .POST("/confirm-password-reset", recordConfirmPasswordReset)
    .bind(collectionPathRateLimit("", "confirmPasswordReset"));

  sub
    .POST("/request-verification", recordRequestVerification)
    .bind(collectionPathRateLimit("", "requestVerification"));
  sub
    .POST("/confirm-verification", recordConfirmVerification)
    .bind(collectionPathRateLimit("", "confirmVerification"));

  sub
    .POST("/request-email-change", recordRequestEmailChange)
    .bind(collectionPathRateLimit("", "requestEmailChange"), requireSameCollectionContextAuth(""));
  sub
    .POST("/confirm-email-change", recordConfirmEmailChange)
    .bind(collectionPathRateLimit("", "confirmEmailChange"));

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
