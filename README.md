# iglo.base

**iglo.base is a self-hosted realtime backend in one file, built on Bun and SQLite. It is a drop-in replacement for PocketBase.**

Canonical repository: [iglo-tech/iglo.base](https://github.com/iglo-tech/iglo.base). The default branch is `main`.

It is an independently maintained port of [PocketBase](https://pocketbase.io) v0.41.0 to Bun and TypeScript. The REST API, realtime API, admin dashboard and `pb_data` directory format stay the same, so existing apps, SDKs and data work without changes. iglo.base removes PocketBase's extension surface: there is no Go framework mode, no JavaScript hooks (`pb_hooks`), no user migrations (`pb_migrations`) and no dashboard extensions. It also drops the self-`update` command; update by rebuilding your image with a new release.

> **Status: design phase.** There is no code yet. Start with the [design docs](docs/design/README.md).

## Planned

- collections (base, auth, view), 14 field types, API rules and the filter language
- records CRUD with expand, field selection, batch requests and realtime subscriptions over SSE
- authentication with password, OTP, MFA, OAuth2 (the same 30+ providers), impersonation and new-login alerts
- file uploads to local disk or S3, thumbnails and protected files
- SMTP or `sendmail` email with editable templates
- backups (local or S3), request logs, rate limits, built-in maintenance jobs
- PocketBase's admin dashboard at `/_/`, branded as iglo.base
- **your existing `pb_data` directory**, opened as is, and still readable by PocketBase if you go back

## Moving from PocketBase

Stop PocketBase, point iglo.base at the same `pb_data` (or copy it next to the executable) and start it. Clients keep the same URLs. The [data compatibility](docs/design/03-data-compatibility.md) doc explains what is checked at startup and how to roll back.

## Why iglo.base?

Read [Why iglo.base exists](docs/why-iglo-base.md).

## License

MIT, the same license as PocketBase, from which this project is derived. PocketBase's copyright notice is kept. See [LICENSE](LICENSE).
