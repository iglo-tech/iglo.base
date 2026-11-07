## 1.0.0

- Forked from the PocketBase JavaScript SDK v0.28.1 (`ff30f71041aeb8107001bb1ac82ad56a4fbeb93c`) and published as `iglo.base`. ESM-only package (`import PocketBase from "iglo.base"`).
- Strict TypeScript sources without `any` (except deliberately loose public shapes), type tests, tests ported to `bun test`.
- fixed: loadFromCookie crash on a null cookie value, an upstream bug
