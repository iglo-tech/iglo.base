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
// @jsonPayload values of form data, after the plain form keys
// (bindCollectionBody). Of the plain form keys only the collection's
// top-level members are read (collectionForm); the nested auth option
// structs ("passwordAuth.enabled", ...) and the `fields` list are not.

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
import { DefaultMaxMemory } from "@/server/buffer-with-file";
import { decodeValue } from "@/server/json-decode";
import {
  JSONPayloadKey,
  pointerTo,
  sliceOf,
  structOf,
  unmarshalRequestData,
} from "@/server/unmarshal-request-data";
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

// the `form` tagged top-level members of Collection, by their Go names
// (BaseModel.Id, baseCollection, collectionAuthOptions and
// collectionViewOptions, in struct order), and the Collection properties
// they are
const collectionFormMembers: [goName: string, prop: keyof Collection][] = [
  ["Id", "id"],
  ["ListRule", "listRule"],
  ["ViewRule", "viewRule"],
  ["CreateRule", "createRule"],
  ["UpdateRule", "updateRule"],
  ["DeleteRule", "deleteRule"],
  ["Name", "name"],
  ["Type", "type"],
  ["Indexes", "indexes"],
  ["System", "system"],
  ["AuthRule", "authRule"],
  ["ManageRule", "manageRule"],
  ["ViewQuery", "viewQuery"],
];

const collectionForm = structOf([
  { name: "Id", type: "string", tags: { form: "id" } },
  { name: "ListRule", type: pointerTo("string"), tags: { form: "listRule" } },
  { name: "ViewRule", type: pointerTo("string"), tags: { form: "viewRule" } },
  { name: "CreateRule", type: pointerTo("string"), tags: { form: "createRule" } },
  { name: "UpdateRule", type: pointerTo("string"), tags: { form: "updateRule" } },
  { name: "DeleteRule", type: pointerTo("string"), tags: { form: "deleteRule" } },
  { name: "Name", type: "string", tags: { form: "name" } },
  { name: "Type", type: "string", tags: { form: "type" } },
  { name: "Indexes", type: sliceOf("string"), tags: { form: "indexes" } },
  { name: "System", type: "bool", tags: { form: "system" } },
  { name: "AuthRule", type: pointerTo("string"), tags: { form: "authRule" } },
  { name: "ManageRule", type: pointerTo("string"), tags: { form: "manageRule" } },
  { name: "ViewQuery", type: "string", tags: { form: "viewQuery" } },
]);

// e.BindBody(collection): JSON through the collection's unmarshalJSON;
// form data as router.UnmarshalRequestData binds it into the Collection
// struct: the form keys (a nil rule pointer is allocated, so an unsent
// rule becomes ""), then each @jsonPayload value through unmarshalJSON.
async function bindCollectionBody(
  e: RequestEvent,
  collection: Collection,
): Promise<Error | undefined> {
  const contentType = e.request.headers.get("content-type") ?? "";
  const isMultipart = contentType.startsWith("multipart/form-data");
  if (
    e.request.contentLength === 0 ||
    (!isMultipart && !contentType.startsWith("application/x-www-form-urlencoded"))
  ) {
    return e.bindBody(collection);
  }

  const parseErr = isMultipart
    ? await e.request.parseMultipartForm(DefaultMaxMemory)
    : await e.request.parseForm();
  if (parseErr) {
    return parseErr;
  }

  try {
    const data = new Map(e.request.form);
    const payloads = data.get(JSONPayloadKey) ?? [];
    data.delete(JSONPayloadKey);

    const holder: Record<string, unknown> = {};
    for (const [goName, prop] of collectionFormMembers) {
      holder[goName] = collection[prop];
    }
    unmarshalRequestData(data, holder, collectionForm);
    for (const [goName, prop] of collectionFormMembers) {
      (collection as unknown as Record<string, unknown>)[prop] = holder[goName];
    }

    for (const payload of payloads) {
      // json.Unmarshal checks the value before calling UnmarshalJSON
      decodeValue(payload);
      collection.unmarshalJSON(payload);
    }
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }

  return undefined;
}

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
  const bindErr = await bindCollectionBody(e, collection);
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

  const bindErr = await bindCollectionBody(e, collection);
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
