// Upstream: apis/collection_import.go
//
// The OnCollectionsImportRequest hook is not ported (no extension
// surface): its default action runs directly. The handler never runs in a
// transaction, so execAfterSuccessTx writes the response at once.

import type { RequestEvent } from "@/app/event-request";
import { firstApiError } from "@/apis/record-helpers";
import { importCollections } from "@/collections/collection-import";
import { sliceOf, structOf } from "@/server/unmarshal-request-data";
import { errorsAs } from "@/server/error";
import { Errors, NewError } from "@/validation/error";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";

export async function collectionsImport(e: RequestEvent): Promise<Error | undefined> {
  const form: CollectionsImportForm = { Collections: [], DeleteMissing: false };

  let err = await e.bindBody(form as unknown as Record<string, unknown>, collectionsImportFormType);
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
    importCollections(
      e.app,
      form.Collections as (Record<string, unknown> | null)[],
      form.DeleteMissing,
    );
  } catch (importErr) {
    // validation failure
    const validationErrors = errorsAs(importErr, Errors);
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
            (importErr instanceof Error ? importErr.message : String(importErr)),
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

interface CollectionsImportForm {
  Collections: unknown[] | null;
  DeleteMissing: boolean;
}

// the error json/v2 gives for an element that is not a JSON object or null
function checkMaps(collections: unknown[] | null): Error | undefined {
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
