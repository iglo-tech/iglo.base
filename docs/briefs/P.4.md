# Brief P.4

Written by the chief of staff on 2026-11-06. User documentation, first part (the iglo.tech site exists: github.com/iglo-tech/iglo.tech, owner 2026-11-06).

```text
Task P.4: User documentation (operations guide and differences from PocketBase)
Goal: someone who has never seen this repository can install, run, operate and upgrade iglo.base, and knows exactly what differs from PocketBase, from user-facing Markdown in docs/ that the iglo.tech site publishes.
Read first: AGENTS.md, README.md, docs/releasing.md, docs/cutover.md, docs/why-iglo-base.md, docs/design/04-api-compatibility.md (Deliberate differences), docs/design/01-scope.md, docs/design/10-decisions.md (D3, D5, D17, D19, D24, D30, D33, D34), src/cli/ (every command and flag, their defaults, the serve banner).
How the site uses these files: iglo-tech/iglo.tech (private; read it with gh if useful, do not change it) clones this repository's main at build time and renders the Markdown files listed for iglo.base in its src/data/projects.ts; relative links to other listed docs become site links, every other relative link points to GitHub. So write plain GitHub Markdown, link between user docs with relative links, and never link users into docs/design for something they need (summarize it instead; a "details" link to design docs is fine).
Owns: docs/operations.md (new), docs/differences.md (new), README.md (links to both; keep its structure and performance section as they are), docs/cutover.md and docs/releasing.md (only to link the new pages and remove duplication).
Depends on: P.2 (merged).
Acceptance:
  - docs/operations.md: install from the release archive (each platform, checksum, macOS quarantine) and the Docker image; first superuser (installer link and `superuser upsert`); every `serve` flag and env var with its default, checked against the code, not upstream's docs; directories (`pb_data`, `pb_migrations`, `pb_public`); running as a systemd service (a complete unit file with a dedicated user and `--dir`), and with Docker (`docker run` with volumes and restart policy); a reverse proxy with TLS for Caddy and nginx, complete configs, including what realtime (SSE) needs (no buffering, long read timeouts) and the trusted proxy settings for the client IP; backups (dashboard and API, S3, copying the whole directory with the server stopped, never only data.db); upgrades (replace the executable or pull the image; the way back to PocketBase links cutover.md); logs and health check (`/api/health`); the other CLI commands (superuser, migrate) with examples. Test every command and config you write that can run on this host: run the release build on a `mktemp -d` dir, the systemd unit with `systemd-analyze verify` (no install), the Caddy and nginx configs with their own validators only if those tools are installed (do not install packages; otherwise say so in the PR).
  - docs/differences.md: for users, what is not there (hooks, Go framework mode, plugins, dashboard extensions, `update`, built-in HTTPS) and what to use instead, then every deliberate difference of 04-api-compatibility.md in plain words with what a client would notice, or "no client sends this" where that is the case; link PocketBase's docs (pocketbase.io/docs) for the API itself.
  - Facts only from the code and the design docs; every flag, path, default and number checked. Plain, short English; no marketing.
  - `bun run check` passes (docs only; test:reference not needed unless src/ changes).
Out of scope: the dashboard's documentation links (PB_DOCS_URL, D17): they wait until the site is hosted; changes to the iglo.tech repository (the lead adds the new files to its list); src/ changes (a defect the docs work finds: describe it in the PR).
Notes from the lead:
  - Branch: task/P.4-user-docs. PR title: "P.4: Operations guide and differences from PocketBase".
  - There is no time limit; finish the task. Stop early only for a real blocker, and describe it in the PR and your reply.
```

The worker instructions from `docs/chief-of-staff.md` follow this brief.
