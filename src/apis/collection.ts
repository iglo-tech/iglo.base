// Upstream: apis/collection.go
//
// The OnCollectionsListRequest, OnCollectionViewRequest,
// OnCollectionCreateRequest, OnCollectionUpdateRequest and
// OnCollectionDeleteRequest hooks are not ported (no extension surface):
// their default actions run directly. The handlers never run in a
// transaction, so execAfterSuccessTx writes the response at once.
//
// A collection body is bound as upstream binds it: JSON goes through the
// Collection's own unmarshalJSON (Collection.UnmarshalJSON), as do the
// @jsonPayload values of form data. Plain form keys bind only the
// collection's top-level scalar and string list members (collectionForm);
// the `fields` list and the nested auth options are not read from form
// keys.

import type { App } from "@/app/app";
import type { RequestEvent } from "@/app/event-request";
import { collectionsImport } from "@/apis/collection-import";
import { firstApiError } from "@/apis/record-helpers";
import {
  Collection,
  CollectionTypeAuth,
  CollectionTypeBase,
  CollectionTypeView,
  newAuthCollection,
  newBaseCollection,
  newCollection,
  newViewCollection,
} from "@/collections/collection-model";
import {
  collectionQuery,
  findCachedCollectionByNameOrId,
  findCollectionByNameOrId,
  findCollectionReferences,
  truncateCollection,
} from "@/collections/collection-query";
import { deleteCollection, saveCollection } from "@/collections/collection-save";
import { dryRunView } from "@/collections/view";
import { defaultIdAlphabet } from "@/db/db";
import { marshalStruct } from "@/fields/field";
import { requireSuperuserAuth } from "@/middlewares/require-auth";
import { providerMetadata } from "@/oauth2/provider-list";
import { newProvider } from "@/search/provider";
import { newSimpleFieldResolver } from "@/search/simple-field-resolver";
import type { RouterGroup } from "@/server/group";
import type { HandlerResult } from "@/server/handler";
import { errorsAs } from "@/server/error";
import { encodeValues } from "@/server/request";
import { pointerTo, sliceOf, structOf } from "@/server/unmarshal-request-data";
import { randomStringWithAlphabet } from "@/tools/security/random";
import { type JSONMarshaler, marshal } from "@/tools/types/go-json";
import { Errors } from "@/validation/error";
import { Length } from "@/validation/length";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";

// bindCollectionApi registers the collection api endpoints and the corresponding handlers.
export function bindCollectionApi(_app: App, rg: RouterGroup<RequestEvent>): void {
  const subGroup = rg.group("/collections").bind(requireSuperuserAuth());
  subGroup.GET("", collectionsList);
  subGroup.POST("", collectionCreate);
  subGroup.GET("/{collection}", collectionView);
  subGroup.PATCH("/{collection}", collectionUpdate);
  subGroup.DELETE("/{collection}", collectionDelete);
  subGroup.DELETE("/{collection}/truncate", collectionTruncate);
  subGroup.PUT("/import", collectionsImport);
  subGroup.GET("/meta/scaffolds", collectionScaffolds);

  // @todo experimental
  subGroup.GET("/meta/oauth2-providers", collectionListOAuth2Providers);
  subGroup.POST("/meta/dry-run-view", collectionDryRunView);
}

async function collectionsList(e: RequestEvent): Promise<Error | undefined> {
  const fieldResolver = newSimpleFieldResolver(
    "id",
    "created",
    "updated",
    "name",
    "system",
    "type",
  );

  let result;
  try {
    result = await newProvider(fieldResolver, { clock: e.app.clock })
      .query(collectionQuery(e.app))
      .parseAndExec<Collection>(encodeValues(e.request.query()), () => new Collection());
  } catch (err) {
    return e.badRequestError("", err);
  }

  return e.json(200, result);
}

function collectionView(e: RequestEvent): HandlerResult {
  let collection: Collection;
  try {
    collection = findCachedCollectionByNameOrId(e.app, e.request.pathValue("collection"));
  } catch (err) {
    return e.notFoundError("", err);
  }

  return e.json(200, collection);
}

// the `form` tagged members of Collection that UnmarshalRequestData binds
// from plain form keys (BaseModel.Id, baseCollection, collectionAuthOptions
// and collectionViewOptions)
const collectionForm = structOf([
  { name: "id", type: "string", tags: { form: "id" } },
  { name: "listRule", type: pointerTo("string"), tags: { form: "listRule" } },
  { name: "viewRule", type: pointerTo("string"), tags: { form: "viewRule" } },
  { name: "createRule", type: pointerTo("string"), tags: { form: "createRule" } },
  { name: "updateRule", type: pointerTo("string"), tags: { form: "updateRule" } },
  { name: "deleteRule", type: pointerTo("string"), tags: { form: "deleteRule" } },
  { name: "name", type: "string", tags: { form: "name" } },
  { name: "type", type: "string", tags: { form: "type" } },
  { name: "indexes", type: sliceOf("string"), tags: { form: "indexes" } },
  { name: "system", type: "bool", tags: { form: "system" } },
  { name: "authRule", type: pointerTo("string"), tags: { form: "authRule" } },
  { name: "manageRule", type: pointerTo("string"), tags: { form: "manageRule" } },
  { name: "viewQuery", type: "string", tags: { form: "viewQuery" } },
]);

const factoryExtractType = structOf([
  { name: "Type", type: "string", tags: { form: "type", json: "type" } },
  { name: "Name", type: "string", tags: { form: "name", json: "name" } },
]);

async function collectionCreate(e: RequestEvent): Promise<Error | undefined> {
  // populate the minimal required factory collection data (if any)
  const factoryExtract = { Type: "", Name: "" };
  const extractErr = await e.bindBody(factoryExtract, factoryExtractType);
  if (extractErr) {
    return e.badRequestError(
      "Failed to load the collection type data due to invalid formatting.",
      extractErr,
    );
  }

  // create scaffold
  const collection = newCollection(factoryExtract.Type, factoryExtract.Name);

  // merge the scaffold with the submitted request data
  const bindErr = await e.bindBody(collection, collectionForm);
  if (bindErr) {
    return e.badRequestError(
      "Failed to load the submitted data due to invalid formatting.",
      bindErr,
    );
  }

  try {
    saveCollection(e.app, collection);
  } catch (err) {
    // validation failure
    const validationErrors = errorsAs(err, Errors);
    if (validationErrors) {
      return e.badRequestError("Failed to create collection.", validationErrors);
    }

    // other generic db error
    return e.badRequestError(`Failed to create collection. Raw error: \n${errorText(err)}`, null);
  }

  return e.json(200, collection);
}

async function collectionUpdate(e: RequestEvent): Promise<Error | undefined> {
  let collection: Collection;
  try {
    collection = findCollectionByNameOrId(e.app, e.request.pathValue("collection"));
  } catch (err) {
    return e.notFoundError("", err);
  }

  const bindErr = await e.bindBody(collection, collectionForm);
  if (bindErr) {
    return e.badRequestError(
      "Failed to load the submitted data due to invalid formatting.",
      bindErr,
    );
  }

  try {
    saveCollection(e.app, collection);
  } catch (err) {
    // validation failure
    const validationErrors = errorsAs(err, Errors);
    if (validationErrors) {
      return e.badRequestError("Failed to update collection.", validationErrors);
    }

    // other generic db error
    return e.badRequestError(`Failed to update collection. Raw error: \n${errorText(err)}`, null);
  }

  return e.json(200, collection);
}

function collectionDelete(e: RequestEvent): HandlerResult {
  let collection: Collection;
  try {
    collection = findCachedCollectionByNameOrId(e.app, e.request.pathValue("collection"));
  } catch (err) {
    return e.notFoundError("", err);
  }

  try {
    deleteCollection(e.app, collection);
  } catch (err) {
    let msg = "Failed to delete collection";

    // check fo references
    let refs = new Map<Collection, unknown>();
    try {
      refs = findCollectionReferences(e.app, collection, collection.id);
    } catch {
      // ignored, as upstream
    }
    if (refs.size > 0) {
      const names = [...refs.keys()].map((ref) => ref.name);
      msg += " probably due to existing reference in " + names.join(", ");
    }

    return e.badRequestError(msg, err);
  }

  return e.noContent(204);
}

function collectionTruncate(e: RequestEvent): HandlerResult {
  let collection: Collection;
  try {
    collection = findCachedCollectionByNameOrId(e.app, e.request.pathValue("collection"));
  } catch (err) {
    return e.notFoundError("", err);
  }

  if (collection.isView()) {
    return e.badRequestError(
      "View collections cannot be truncated since they don't store their own records.",
      null,
    );
  }

  try {
    truncateCollection(e.app, collection);
  } catch (err) {
    return e.badRequestError(
      "Failed to truncate collection (most likely due to required cascade delete record references).",
      err,
    );
  }

  return e.noContent(204);
}

function collectionScaffolds(e: RequestEvent): HandlerResult {
  const randomId = randomStringWithAlphabet(10, defaultIdAlphabet); // could be used as part of the default indexes name

  // a Go map: json/v2 writes its members in no fixed order; here they are
  // sorted
  const collections = new Map<string, Collection>([
    [CollectionTypeBase, newBaseCollection("", randomId)],
    [CollectionTypeAuth, newAuthCollection("", randomId)],
    [CollectionTypeView, newViewCollection("", randomId)],
  ]);

  for (const c of collections.values()) {
    c.id = ""; // clear random id
  }

  return e.json(
    200,
    goMarshaler(() => marshal(collections)),
  );
}

interface ProviderListItem {
  order: number;

  name: string;
  displayName: string;
  logo: string;
}

function collectionListOAuth2Providers(e: RequestEvent): HandlerResult {
  const providers: ProviderListItem[] = [];

  for (const [name, p] of providerMetadata) {
    providers.push({
      order: p.order,
      name,
      displayName: p.displayName,
      logo: p.logo,
    });
  }

  providers.sort((a, b) => {
    // sort by order
    if (a.order !== b.order) {
      return a.order < b.order ? -1 : 1;
    }

    // fallback sort by name
    if (a.name < b.name) {
      return -1;
    }
    if (a.name > b.name) {
      return 1;
    }

    return 0;
  });

  return e.json(
    200,
    goMarshaler(
      () =>
        "[" +
        providers
          .map((p) =>
            marshalStruct([
              ["name", p.name],
              ["displayName", p.displayName],
              ["logo", p.logo],
            ]),
          )
          .join(",") +
        "]",
    ),
  );
}

async function collectionDryRunView(e: RequestEvent): Promise<Error | undefined> {
  // extra precaution in case reused in custom route group
  if (!e.hasSuperuserAuth()) {
    return e.forbiddenError("", null);
  }

  const form: DryRunViewForm = { Query: "" };

  const bindErr = await e.bindBody(form as unknown as Record<string, unknown>, dryRunViewFormType);
  if (bindErr) {
    return firstApiError(
      bindErr,
      e.badRequestError("An error occurred while loading the submitted data.", bindErr),
    );
  }

  const validateErr = validateDryRunViewForm(form);
  if (validateErr !== null) {
    return firstApiError(
      validateErr,
      e.badRequestError("An error occurred while validating the submitted data.", validateErr),
    );
  }

  let result;
  try {
    result = dryRunView(e.app, form.Query, 10);
  } catch (err) {
    return firstApiError(
      err,
      e.badRequestError(`Invalid view query. Raw error: \n${errorText(err)}`, null),
    );
  }

  const { fields, sample } = result;
  return e.json(
    200,
    goMarshaler(() =>
      marshalStruct([
        ["fields", fields],
        ["sample", sample],
      ]),
    ),
  );
}

const dryRunViewFormType = structOf([
  { name: "Query", type: "string", tags: { form: "query", json: "query" } },
]);

interface DryRunViewForm {
  Query: string;
}

function validateDryRunViewForm(form: DryRunViewForm): Error | null {
  return ValidateStruct(Field("query", form.Query, Required, Length(0, 5000)));
}

// -------------------------------------------------------------------

// a value written with the given JSON text
function goMarshaler(marshalJSON: () => string): JSONMarshaler {
  return { marshalJSON };
}

// err.Error()
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
