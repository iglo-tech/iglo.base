// Upstream: core/collection_model_base_options.go
//
// collectionBaseOptions has no options: a base collection stores `{}` in
// `_collections.options` (see Collection.dbExport). Its validate method
// (always valid) comes with the collection validator (M1.6a).

// collectionBaseOptions defines the options for the "base" type collection.
export type CollectionBaseOptions = Record<string, never>;
