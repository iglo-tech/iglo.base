## 1.0.0

- Forked from the PocketBase JavaScript SDK v0.28.1 (`ff30f71041aeb8107001bb1ac82ad56a4fbeb93c`) and published as `iglo.base`. No behavior change: same public API, exports and entry points (`.`, `./cjs`, `./umd`).
- Strict TypeScript sources without `any` (except deliberately loose public shapes), type tests, tests ported to `bun test`.
- The deprecated `pocketbase.iife.js` bundle is not shipped; use `./umd` (sets `window.PocketBase`).
