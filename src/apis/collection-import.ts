// Upstream: apis/collection_import.go
//
// The OnCollectionsImportRequest hook is not ported (no extension
// surface): its default action runs directly. The handler never runs in a
// transaction, so execAfterSuccessTx writes the response at once.

import type { App } from "@/app/app";
import type { RequestEvent } from "@/app/event-request";
import { firstApiError } from "@/apis/record-helpers";
import { importCollections } from "@/collections/collection-import";
import { findAllCollections } from "@/collections/collection-query";
import { schemaLockedMessage } from "@/schema/lock";
import { sliceOf, structOf } from "@/server/unmarshal-request-data";
import { errorsAs } from "@/server/error";
import { Errors, NewError } from "@/validation/error";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";

export async function collectionsImport(e: RequestEvent): Promise<Error | undefined> {
  if (e.app.schemaLocked) {
    return e.forbiddenError(schemaLockedMessage, null);
  }
  const form: CollectionsImportForm = { Collections: [], DeleteMissing: false };

  let err = await e.bindBody(form, collectionsImportFormType);
  err ??= checkMaps(form.Collections);
  if (err) {
    return firstApiError(
      err,
      e.badRequestError("An error occurred while loading the submitted data.", err),
    );
  }

  const validateErr = validateCollectionsImportForm(form);
  if (validateErr !== null) {
    return firstApiError(
      validateErr,
      e.badRequestError("An error occurred while validating the submitted data.", validateErr),
    );
  }

  try {
    // oxlint-disable-next-line quality/no-unsafe-dictionary-type -- a Go []map[string]any: each collection is a JSON object of any kind of value, read by the import
    const imported = form.Collections as Array<Record<string, unknown> | null>;
    const before = collectionNames(e.app);
    importCollections(e.app, imported, form.DeleteMissing);
    e.app.collectionsChanged?.(importChanges(before, collectionNames(e.app), imported));
  } catch (error) {
    // validation failure
    const validationErrors = errorsAs(error, Errors);
    if (validationErrors) {
      return e.badRequestError("Failed to import collections.", validationErrors);
    }

    // generic/db failure
    return e.badRequestError(
      "Failed to import collections.",
      new Errors({
        collections: NewError(
          "validation_collections_import_failure",
          "Failed to import the collections configuration. Raw error:\n" +
            (error instanceof Error ? error.message : String(error)),
        ),
      }),
    );
  }

  return e.noContent(204);
}

// -------------------------------------------------------------------

// Collections is a []map[string]any: its elements are bound as Go `any`
// values and checked to be objects (or null, a nil map) by checkMaps.
const collectionsImportFormType = structOf([
  {
    name: "Collections",
    type: sliceOf("any"),
    tags: { form: "collections", json: "collections" },
  },
  { name: "DeleteMissing", type: "bool", tags: { form: "deleteMissing", json: "deleteMissing" } },
]);

type CollectionsImportForm = {
  Collections: Array<unknown> | null;
  DeleteMissing: boolean;
};

// the error json/v2 gives for an element that is not a JSON object or null
function checkMaps(collections: Array<unknown> | null): Error | undefined {
  for (const c of collections ?? []) {
    if (c !== null && (typeof c !== "object" || Array.isArray(c))) {
      return new Error("json: cannot unmarshal into Go map[string]any");
    }
  }
  return undefined;
}

function validateCollectionsImportForm(form: CollectionsImportForm): Error | null {
  return ValidateStruct(Field("collections", form.Collections, Required));
}

function collectionNames(app: App): Set<string> {
  return new Set(findAllCollections(app).map((collection) => collection.name));
}

// the collections an import changes: the ones it names, and the ones it adds or deletes
function importChanges(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
  // oxlint-disable-next-line quality/no-unsafe-dictionary-type -- a Go []map[string]any: each collection is a JSON object of any kind of value, read by name
  imported: ReadonlyArray<Record<string, unknown> | null>,
): Array<string> {
  const changed = new Set<string>();
  for (const item of imported) {
    if (typeof item?.name === "string") {
      changed.add(item.name);
    }
  }
  for (const name of [...before, ...after]) {
    if (before.has(name) !== after.has(name)) {
      changed.add(name);
    }
  }
  return [...changed];
}
