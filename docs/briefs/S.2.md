# S.2 Schema file format and `schema pull`

Written by the chief of staff on 2026-11-09. The spec is GitHub issue [#77](https://github.com/iglo-tech/iglo.base/issues/77) (read it with `gh issue view 77`) and decision D40 in `docs/design/10-decisions.md` (merged on `develop`). This brief adds only what they leave open. **Base branch: `develop`** (branch from `origin/develop`, PR against `develop`).

## Scope

- **Module.** New code in `src/schema/` (no upstream counterpart; header comments name D40) and the command in `src/cli/schema.ts`, wired into `src/cli/root.ts` and the help text as upstream-style subcommands. This task owns:
  - the file format and its TypeScript types;
  - the JSON Schema;
  - a writer (database → file text);
  - a reader (file text → validated, normalized in-memory description, with clear error messages naming the JSON path).

  S.3 builds the apply on the reader, so make it a plain function that takes the text and returns the description or a list of errors. It must not touch the database.
- **Format details D40 fixes.** Collections and fields keyed by name, without ids. Relations name their target collection by name. There are no secrets: no token `secret` values and no OAuth2 `providers` list. System collections are written only when they differ from upstream's defaults for them, and system fields are implied. `tsType` and `description` are extra keys. Field order inside a collection is meaningful (it is the API and dashboard order). Keep it, and do not lose it to `JSON.parse` on integer-like names: read the text with order preserved, or refuse integer-like field and collection names with a clear error, and say which in the PR.
- **Deterministic output.** Collections sorted by name; fields in their stored order; each object's keys in one fixed order; options equal to upstream's default value left out when that keeps the file readable and the reader restores them exactly. A second `pull` on an unchanged database is byte-identical. Two-space indent, final newline.
- **JSON Schema.** Store it in `schema/iglo.schema.json` in the repository and embed it in the executable. `schema pull` writes `"$schema": "https://github.com/iglo-tech/iglo.base/releases/download/v<version>/iglo.schema.json"` with the running version. Add the file to the release assets in `.github/workflows/release.yml`, next to `SHA256SUMS` and included in it. Do not run the release workflow. It must cover every field type and option of PocketBase v0.41.0 (`core/field_*.go`, `core/collection_model*.go` for auth and view options), with descriptions so editors show help.
- **`iglo-base schema pull [--out iglo.schema.json]`.** Respects `--dir`. Without `--out` it writes to stdout. Read through the app's collection access, never by hand-written SQL against `_collections`.
- **No apply.** Nothing here writes to the database. `schema plan`, `--schema` and types come later (S.3, S.4).

## Tests

All tests go through public boundaries.

- **Round trip.** For each fixture database (the ones the differential suite and `test/fixtures` already have, plus one built by the test with every field type, an auth collection with changed options, a view and a changed system collection):
  1. `schema pull` through the CLI;
  2. read the file back with the reader;
  3. compare with the collections from `GET /api/collections` with the ids and secrets taken out;
  4. check that the relation targets resolve by name.
- **Validation.** Pulled files validate against `schema/iglo.schema.json`. A devDependency for JSON Schema validation in tests is allowed if you justify it in the PR, but no runtime dependency.
- **Reader errors.** Unknown field type, unknown option, a relation to a missing collection, a duplicate name and a secret key present. Each gives an error that names the path.
- **Determinism.** Pull twice and the output is byte-identical. Change field order in the dashboard API and the file follows.

## Docs

- `docs/schema.md`, a new user guide in plain short English, in the style of `docs/ssr.md`. Its sections: what schema as code is (short), the file format with an example, `schema pull`, and what is not in the file (secrets, OAuth2 providers, settings) and why. Later tasks add plan, apply, types, migrations and modes. It is not listed on the iglo.tech site until release (S.7).
- `docs/design/14-schema.md`, a short design doc for the module (layout, reader and writer contracts, the order rules). Later tasks extend it. Link it from `docs/design/README.md`.
- `docs/design/01-scope.md` "Added: schema as code": mark `schema pull` as built.

## Verification

- Run `bun run check`, then `bun run test:reference`, one after the other.
- The worker rules in `docs/design/12-work-plan.md` and the worker instructions in `docs/chief-of-staff.md` apply.
- Open a PR titled "S.2: Schema file format and schema pull" against `develop`, with "Part of #77" in the body. Do not merge.
