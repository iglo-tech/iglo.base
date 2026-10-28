// Upstream: apis/middlewares.go (RequireGuestOnly, RequireAuth,
// RequireSuperuserAuth, RequireSuperuserOrOwnerAuth,
// RequireSameCollectionContextAuth and their ids)
//
// The auth guards that route groups bind. RequireSameCollectionContextAuth
// looks the path collection up in the app passed in (upstream's e.App).

import type { RequestEvent } from "@/app/event-request";
import type { Collection } from "@/collections/collection-model";
import {
  type CollectionsApp,
  findCachedCollectionByNameOrId,
} from "@/collections/collection-query";
import { CollectionNameSuperusers } from "@/records/record-model-superusers";
import type { Handler, HandlerFunc } from "@/server/handler";

export const DefaultRequireGuestOnlyMiddlewareId = "pbRequireGuestOnly";
export const DefaultRequireAuthMiddlewareId = "pbRequireAuth";
export const DefaultRequireSuperuserAuthMiddlewareId = "pbRequireSuperuserAuth";
export const DefaultRequireSuperuserOrOwnerAuthMiddlewareId = "pbRequireSuperuserOrOwnerAuth";
export const DefaultRequireSameCollectionContextAuthMiddlewareId =
  "pbRequireSameCollectionContextAuth";

// RequireGuestOnly middleware requires a request to NOT have a valid
// Authorization header.
//
// This middleware is the opposite of requireAuth().
export function requireGuestOnly(): Handler<RequestEvent> {
  return {
    id: DefaultRequireGuestOnlyMiddlewareId,
    func: (e) => {
      if (e.auth !== undefined) {
        return e.badRequestError("The request can be accessed only by guests.", null);
      }

      return e.next();
    },
  };
}

// RequireAuth middleware requires a request to have a valid record Authorization header.
//
// The auth record could be from any collection.
// You can further filter the allowed record auth collections by specifying their names.
//
// Example:
//
//	requireAuth()                       // any auth collection
//	requireAuth("_superusers", "users") // only the listed auth collections
export function requireAuth(...optCollectionNames: string[]): Handler<RequestEvent> {
  return {
    id: DefaultRequireAuthMiddlewareId,
    func: requireAuthFunc(...optCollectionNames),
  };
}

function requireAuthFunc(...optCollectionNames: string[]): HandlerFunc<RequestEvent> {
  return (e) => {
    if (e.auth === undefined) {
      return e.unauthorizedError("The request requires valid record authorization token.", null);
    }

    // check record collection name
    if (optCollectionNames.length > 0 && !optCollectionNames.includes(e.auth.collection().name)) {
      return e.forbiddenError("The authorized record is not allowed to perform this action.", null);
    }

    return e.next();
  };
}

// RequireSuperuserAuth middleware requires a request to have
// a valid superuser Authorization header.
export function requireSuperuserAuth(): Handler<RequestEvent> {
  return {
    id: DefaultRequireSuperuserAuthMiddlewareId,
    func: requireAuthFunc(CollectionNameSuperusers),
  };
}

// RequireSuperuserOrOwnerAuth middleware requires a request to have
// a valid superuser or regular record owner Authorization header set.
//
// This middleware is similar to requireAuth() but
// for the auth record token expects to have the same id as the path
// parameter ownerIdPathParam (default to "id" if empty).
export function requireSuperuserOrOwnerAuth(ownerIdPathParam: string): Handler<RequestEvent> {
  return {
    id: DefaultRequireSuperuserOrOwnerAuthMiddlewareId,
    func: (e) => {
      if (e.auth === undefined) {
        return e.unauthorizedError(
          "The request requires superuser or record authorization token.",
          null,
        );
      }

      if (e.auth.isSuperuser()) {
        return e.next();
      }

      if (ownerIdPathParam === "") {
        ownerIdPathParam = "id";
      }
      const ownerId = e.request.pathValue(ownerIdPathParam);

      // note: it is considered "safe" to compare only the record id
      // since the auth record ids are treated as unique across all auth collections
      if (e.auth.id !== ownerId) {
        return e.forbiddenError("You are not allowed to perform this request.", null);
      }

      return e.next();
    },
  };
}

// RequireSameCollectionContextAuth middleware requires a request to have
// a valid record Authorization header and the auth record's collection to
// match the one from the route path parameter (default to "collection" if collectionParam is empty).
export function requireSameCollectionContextAuth(
  app: CollectionsApp,
  collectionPathParam: string,
): Handler<RequestEvent> {
  return {
    id: DefaultRequireSameCollectionContextAuthMiddlewareId,
    func: (e) => {
      if (e.auth === undefined) {
        return e.unauthorizedError("The request requires valid record authorization token.", null);
      }

      if (collectionPathParam === "") {
        collectionPathParam = "collection";
      }

      let collection: Collection | null = null;
      try {
        collection = findCachedCollectionByNameOrId(app, e.request.pathValue(collectionPathParam));
      } catch {
        collection = null;
      }
      if (collection === null || e.auth.collection().id !== collection.id) {
        return e.forbiddenError(
          `The request requires auth record from ${e.auth.collection().name} collection.`,
          null,
        );
      }

      return e.next();
    },
  };
}
