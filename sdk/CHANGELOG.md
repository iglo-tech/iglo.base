## Unreleased

- SSR server core (`iglo.base/ssr`): `createServerClient` per-request client with cookie resumption, sliding refresh with dynamic token lifetime learning (`Date` header), app-origin cookie security (`__Host-` prefix and dual-clear on HTTPS), server sign-in/out cookie lifecycle sync; `createSuperuserClient` with impersonation token minting; `createSessionCache` with LRU eviction and SHA-256 token hashing; single-flight deduplication sharing auth outcomes; and `createRequestCookieAdapter` for standard Web Request/Response handlers. Shared chunk ensures cross-entry class identity (`instanceof ClientResponseError`).

## 1.0.0

- Forked from the PocketBase JavaScript SDK v0.28.1 (`ff30f71041aeb8107001bb1ac82ad56a4fbeb93c`) and published as `iglo.base`. ESM-only package (`import PocketBase from "iglo.base"`).
- Strict TypeScript sources without `any` (except deliberately loose public shapes), type tests, tests ported to `bun test`.
- fixed: loadFromCookie crash on a null cookie value, an upstream bug
- difference from upstream: a non-string token from a cookie (`loadFromCookie`) or from `AsyncAuthStore`'s initial value becomes `""` instead of preserving the non-string value.
- difference from upstream: a non-object `@jsonPayload` in `convertFormDataToObject` is skipped instead of spreading primitive characters via `Object.assign`.
