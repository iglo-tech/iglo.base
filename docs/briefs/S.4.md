# S.4 TypeScript types from the schema (`schema types`)

Written by the chief of staff on 2026-11-13. The spec is GitHub issue [#79](https://github.com/iglo-tech/iglo.base/issues/79) (`gh issue view 79`). Decision D40 and `docs/design/14-schema.md`, both on `develop`, are binding. Where the issue and D40 differ, D40 wins. **Base branch: `develop`.** S.2 (format, `tsType`, `description`) and S.3 (apply, `schema plan`, the rolled-back transaction) are merged there; build on them.

## Scope

- **Command:** `iglo-base schema types [--out <file>] [--schema <file>] [--check]`, respecting `--dir`. Without `--out`, it writes to stdout.
  - **Source of the types:** they come from the database through the app's collection access, not from the raw file. View collections therefore get their resolved fields.
  - **`--schema`:** applies the file in S.3's rolled-back transaction first (the same path as `schema plan`, with the same locks and the same notes on pending migrations), so no running server is needed. It makes no backup.
  - **`--check`:** exits nonzero and names the file when the file on disk differs from what would be generated.
- **What each collection gets**, exactly as the issue lists it:
  - `<Name>Record`, `<Name>Response<Expand = {}>`, `<Name>Create` and `<Name>Update`, the last one with the `field+`, `+field` and `field-` modifiers wherever upstream accepts them;
  - a `Collections` enum, and `TypedPocketBase`.
- **Type mapping:**
  - **Every field type of PocketBase v0.41.0** (`core/field_*.go`) is covered, including system and hidden fields as the API shows them. Hidden fields are left out of `Response`.
  - **Auth collections** get the auth fields the API returns (`email` follows `emailVisibility`, so it is optional).
  - **Json fields** take `tsType` verbatim, or `unknown` without one.
  - **Field `description`** becomes JSDoc.
- **Names:** turn collection names into valid, stable TypeScript identifiers, and handle clashes (two names mapping to the same identifier, reserved words) with a clear error or a documented rule. Say which in the PR.
- **Output:** deterministic (a second run is byte-identical), with a generated-file header naming the command, and the repository's format.
- **SDK** (npm `@iglo.tech/iglo.base`, D36, renamed in P.14):
  - `TypedPocketBase` must type `pb.collection("posts")` on the plain client and on the `@iglo.tech/iglo.base/ssr` server, browser and framework clients.
  - If the SSR clients need a type parameter, add it in `sdk/` with a changelog entry under "Unreleased". Changes are type-only, and runtime behaviour stays identical to upstream's SDK.
  - The SDK is released with S.7, not here.
- **Out of scope:** `--mode`, dev-mode regeneration on file change (S.6) and TypeScript migrations (S.5).

## Tests

- **Type tests:** `tsc --noEmit` on a fixture app built by the test. They cover every field type, a view collection, an auth collection (both `emailVisibility` settings), a typed expand (single and multiple relations), create and update with each modifier, and `tsType` on json. Include negative cases (`// @ts-expect-error`) for wrong select values and unknown fields.
- **SDK check:**
  - Calls through the plain client and an SSR server client type-check.
  - Their real responses from a running iglo.base (started by the test, on a free port) match the generated types, checked at runtime.
  - One case also type-checks against the official `pocketbase` npm package. A test-only devDependency is allowed; justify it in the PR.
- **CLI:** `--check` passes on fresh output and fails after a schema change; `--schema` leaves `pb_data` unchanged; the output is byte-identical across runs.

## Docs

- `docs/schema.md`: a "Types" section.
- `sdk/README.md`: a short pointer.
- `docs/design/14-schema.md`: the generator's design.
- `docs/design/01-scope.md`: mark `schema types` as built.

## Verification

- Run `bun run check`, then `bun run test:reference`, one after the other, in the foreground. Never detach a check with `&`.
- The worker rules in `docs/design/12-work-plan.md` and the worker instructions in `docs/chief-of-staff.md` apply.
- Open a PR titled "S.4: TypeScript types from the schema" against `develop`, with "Part of #79" in the body. Do not merge.
