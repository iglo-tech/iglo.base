## Unreleased

- SSR server core (`iglo.base/ssr`): `createServerClient` per request, resumed from the session cookie, with requests sent `cache: "no-store"` at the fetch layer; `createSuperuserClient` with `impersonate`; `createSessionCache({ ttl, maxEntries, clock })` (LRU, SHA-256 token keys, `ttl` in milliseconds); token lifetimes learned from auth responses, sliding refresh at half the lifetime; single-flight refresh that applies each outcome per request; `pb.auth.verify()`; server sign-in and sign-out write the session cookie; app-origin cookie security (`__Host-` and `Secure` follow the app's own request, not the backend URL); `createRequestCookieAdapter` for Web `Request`/`Response` handlers. The `ssr` entry shares the SDK's classes with `iglo.base`, so `instanceof ClientResponseError` agrees across both.

## 1.0.0

- Forked from the PocketBase JavaScript SDK v0.28.1 (`ff30f71041aeb8107001bb1ac82ad56a4fbeb93c`) and published as `iglo.base`. ESM-only package (`import PocketBase from "iglo.base"`).
- Strict TypeScript sources without `any` (except deliberately loose public shapes), type tests, tests ported to `bun test`.
- fixed: loadFromCookie crash on a null cookie value, an upstream bug
- difference from upstream: a non-string token from a cookie (`loadFromCookie`) or from `AsyncAuthStore`'s initial value becomes `""` instead of preserving the non-string value.
- difference from upstream: a non-object `@jsonPayload` in `convertFormDataToObject` is skipped instead of spreading primitive characters via `Object.assign`.
