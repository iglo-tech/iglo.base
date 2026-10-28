// Upstream: core/collection_model_view_options.go
//
// The view options are promoted fields of Go's Collection (it embeds
// collectionViewOptions), so here they are properties of Collection
// itself. Not here: collectionViewOptions.validate (M1.6a).

import { marshalStruct } from "@/fields/field";
import { type MemberDecoders, decodeString, unmarshalGoStruct } from "@/collections/go-json-struct";

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
