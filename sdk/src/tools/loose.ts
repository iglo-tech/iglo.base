// iglo.base addition (not in js-sdk v0.28.1): the one place where `any` is allowed in the SDK.
//
// Upstream types many public shapes (record fields, request body and query bags, settings,
// response data) as `{ [key: string]: any }`. User code reads those fields without casts
// (`record.title.length`, `settings.meta.appName`) and assigns typed objects to them, so
// `unknown` would break existing callers. They keep the loose type through these aliases.

// oxlint-disable-next-line typescript/no-explicit-any -- public shapes stay assignable and readable without casts
export type Loose = any;

/** Open object bag used by public request and response shapes. */
export type LooseObject = { [key: string]: Loose };
