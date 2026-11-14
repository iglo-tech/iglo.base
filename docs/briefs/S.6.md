# S.6 Development and production modes, OAuth2 environment references

Written by the chief of staff on 2026-11-14. The spec is GitHub issue [#81](https://github.com/iglo-tech/iglo.base/issues/81) (`gh issue view 81 --comments`), including the owner's comment of 2026-11-13. Decision D40 and `docs/design/14-schema.md`, both on `develop`, are binding. Where the issue and D40 differ, D40 wins. **Base branch: `develop`.** S.2–S.5 are merged there: the format, the apply, types and migrations.

## Scope

### Modes

- **The flag:** `serve --mode dev|prod`, default `dev`. Without `--schema`, nothing changes in either mode, and the differential suite must pass unchanged. `--dev` (verbose logs) stays as it is.
- **`--automigrate`** is off whenever `--schema` is set (D40).

**Development** (`--mode dev --schema <file> [--types <path>]`):
- **Write-back:** after any collection change saved through the dashboard or the collections API, write the file back with S.2's writer and regenerate the types file if `--types` is given. Both happen within one second.
  - The process ignores its own writes; it must not re-apply what it just wrote.
  - Write-back keeps the file's environment references (below).
- **Re-apply on change:** watch the schema file and the TypeScript migrations directory. On a change, apply with S.3's steps and checks but no backup (D40).
  - A failure prints the report to the terminal and leaves the database unchanged.
  - The server keeps running on the old schema.
  - Debounce editor save bursts.
- **Not watched:** neither the file nor the migrations directory is watched with `--mode prod`.

**Production** (`--mode prod --schema <file>`):
- **At startup:** the file is applied (S.3), then the schema is locked.
- **Locked endpoints** answer `403`, with a body in upstream's error format whose message says the schema and settings are managed by the schema file:
  - collection create, update, delete and import;
  - `PATCH /api/settings`.

  Superusers get the 403 too. Records, users, files, backups (including restore), logs and everything else work as usual.
- **Dashboard:** the collection and settings screens are read-only. Use the vendored UI's patch set (`docs/design/08-admin-ui.md`): it hides or disables the edit controls and shows a short notice. Check it with `agent-browser`.
- **Restore:** a restore restarts the process, and S.3's loop re-applies the file. Test it.
- **D41 (new decision record)** in `docs/design/10-decisions.md`, plus a new row in `docs/design/04-api-compatibility.md` for the locked endpoints.
- **Token invalidation:** "Invalidate all tokens" is a collection update, so in production it needs a migration. The docs say so.

### OAuth2 providers with environment references (owner, 2026-11-13)

- **Writing providers:** an auth collection's `oauth2.providers` may now be written in the schema file. Each secret-bearing key (`clientSecret`, and any other secret a provider has in PocketBase v0.41.0) must be an environment reference, `{"env": "NAME"}`.
  - A plain string for a secret is still refused with a clear error.
  - Non-secret keys (`clientId`, URLs, `displayName`, `pkce`, `extra`) may be a plain value or a reference.
  - The JSON Schema (`schema/iglo.schema.json`) and the reader cover this.
- **Applying them:**
  - When the file lists providers, the apply sets them from the file, resolving each reference from the process environment.
  - When the file leaves `providers` out, the stored providers stay as today (D40).
  - A missing variable fails `schema plan` and startup with the variable's name. A value is never printed.
  - Values are read at apply time and never written to the file, to logs, or into reports.
- **Change detection:** the plan detects changes without showing secret values. For example, it says "github: clientSecret changed".
- **`schema pull` and dev write-back:**
  - A provider already in the file keeps its references.
  - A provider added in the dashboard is written with generated reference names (for example `{"env": "USERS_GITHUB_CLIENT_SECRET"}`), and the terminal prints which variables to set. A secret value never reaches the file.
- **Amend D40** with a dated line: OAuth2 providers may be in the file with secrets as environment references; plain secrets are still refused; token secrets stay out of the file.

## Tests

- **Development:**
  - a dashboard/API collection change reaches the file and the types within one second;
  - a file edit applies;
  - a bad edit changes nothing and prints the error;
  - a new migration file applies;
  - the process doesn't loop on its own writes.
- **Production:**
  - every locked endpoint answers 403 with its message, and records/auth/files still work;
  - the dashboard is read-only (`agent-browser`, in `test/browser/`);
  - a restore restarts and re-applies.
- **Default:** neither flag, then `--mode dev` without `--schema`, then `--mode prod` without `--schema`. The differential suite passes unchanged for all three.
- **Environment references:**
  - a provider from references works end to end against a fake OAuth2 server the test starts, the same way existing OAuth2 tests do. No external services.
  - a missing variable fails with its name;
  - a plain secret is refused;
  - `schema pull` writes references, never values;
  - grep the file, logs and plan output for the secret value in tests.

## Docs

- `docs/schema.md`: a "Development and production" section and an "OAuth2 providers" section with an example.
- `docs/operations.md`: `--mode`, `--types`, and the production setup with environment variables.
- `docs/design/14-schema.md`, `docs/design/01-scope.md`: mark these items as built.

## Verification

- Run `bun run check`, then `bun run test:reference`, then `bun run test:browser`, one after the other, in the foreground. Never detach a check with `&`. Report each exit code.
- The worker rules in `docs/design/12-work-plan.md` and the worker instructions in `docs/chief-of-staff.md` apply.
- Open a PR titled "S.6: development and production modes" against `develop`, with "Part of #81" in the body. Do not merge.
