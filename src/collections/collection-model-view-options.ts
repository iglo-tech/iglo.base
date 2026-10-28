// Upstream: core/collection_model_view_options.go
//
// The view options are promoted fields of Go's Collection (it embeds
// collectionViewOptions), so here they are properties of Collection
// itself. collectionViewOptions.validate is validateViewOptions; it reads
// the collection validator's view query check through ViewOptionsValidator
// (collection-validate.ts implements it).

import { marshalStruct } from "@/fields/field";
import { type MemberDecoders, decodeString, unmarshalGoStruct } from "@/collections/go-json-struct";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";
import { By, type RuleFunc } from "@/validation/validation";

// collectionViewOptions defines the options for the "view" type collection.
export interface CollectionViewOptions {
  viewQuery: string;
}

// The JSON members of collectionViewOptions in the Go struct order.
export function viewOptionsMembers(o: CollectionViewOptions): [string, unknown][] {
  return [["viewQuery", o.viewQuery]];
}

// json.Marshal(collectionViewOptions)
export function marshalViewOptions(o: CollectionViewOptions): string {
  return marshalStruct(viewOptionsMembers(o));
}

// The member decoders of collectionViewOptions (json.Unmarshal into the
// embedded struct).
export function viewOptionsDecoders(o: CollectionViewOptions): MemberDecoders {
  return {
    viewQuery: (raw) => (o.viewQuery = decodeString(raw)),
  };
}

// json.Unmarshal(data, &collectionViewOptions)
export function unmarshalViewOptions(o: CollectionViewOptions, data: string | Uint8Array): void {
  unmarshalGoStruct(data, viewOptionsDecoders(o), () => (o.viewQuery = ""));
}

// The collection validator member collectionViewOptions.validate uses
// (core/collection_validate.go collectionValidator).
export interface ViewOptionsValidator {
  // checkViewQuery checks that the view query runs (DryRunView).
  checkViewQuery: RuleFunc;
}

// collectionViewOptions.validate
export function validateViewOptions(
  o: CollectionViewOptions,
  cv: ViewOptionsValidator,
): Error | null {
  return ValidateStruct(Field("viewQuery", o.viewQuery, Required, By(cv.checkViewQuery)));
}
