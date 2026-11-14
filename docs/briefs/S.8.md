# S.8 Schema-as-code follow-ups (1.2.1)

Written by the chief of staff on 2026-11-14. These items came from the S.2–S.7 reviews and were left for later; they are in `docs/status.md` under the S.* rows. All are small, and they ship as server v1.2.1. **Base branch: `main`.**

## Scope

Each item needs a test through the CLI or API on `mktemp -d` data that fails on `main` (docs-only items excepted).

1. **Field names starting with a digit in a rename.** The index-name scan in `clearedIndex` (`src/schema/apply.ts`) matches `/[a-z_][a-z0-9_]*/g`, so a renamed `_superusers` field like `2fa` with an index stops the start with "no such column". Match field names the way upstream allows them (check `core/field*.go` and the name validator for the exact rule).
2. **Views during migrations.** With a pending rename, views don't exist while TypeScript migrations run, so a migration that reads a view collection fails with "no such table". Recreate the views before step 5 (TypeScript migrations), if they can be built from the post-rename tables. Otherwise, add a clear error that names the view, plus a line under Limitations in `docs/schema.md`. Say which in the PR.
3. **Step numbering in `docs/schema.md` Limitations.** It says "the views are created again in step 7", which is D40's numbering, not the guide's. Reword it in the guide's own terms.
4. **Optional file fields in create types.** In `schema types`, a non-required file field accepts `null` and `""` on create, as upstream does (it ignores them).
5. **Formatter marker.** Emit `// prettier-ignore` instead of `// oxfmt-ignore` above `tsType` lines, if oxfmt honours it (the S.4 reviewer said it does). Then apps that format with Prettier keep those lines too. Prove it with `oxfmt --check` on the output in the test.
6. **Case in rename checks.** Rename checks compare names case-insensitively, as collection and field names are unique without regard to case upstream (verify). A rename refused for case reasons gets a clear message.
7. **`records()` memory.** The migration helper `records()` iterates in pages (for example 500 rows) instead of loading every match first. Behaviour is unchanged. Test that it handles more rows than one page.
8. **Missing anchor.** Fix the broken `#d34-…` link in `docs/design/10-decisions.md`.

## Release prep

- Bump nothing in `sdk/`.
- In `docs/schema.md`, the `$schema` example URL is `v1.2.1`. Search the repository for other `v1.2.0` URLs that should follow.
- `AGENTS.md` "Current state" says v1.2.1 with a short note.

The lead tags and publishes after the merge.

## Verification

- Run `bun run check`, then `bun run test:reference`, one after the other, in the foreground. Never detach a check with `&`, and never wrap one in `timeout`. Report each exit code.
- The worker instructions in `docs/chief-of-staff.md` apply.
- Open a PR titled "S.8: schema-as-code follow-ups (1.2.1)" against `main`. Do not merge.
