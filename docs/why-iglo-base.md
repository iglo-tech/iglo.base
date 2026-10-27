# Why iglo.base exists

PocketBase is one of the best answers to "I need a backend for this app, today": one executable, one SQLite file, auth, files, realtime and an admin dashboard, with a small and predictable API. iglo.base keeps all of that and changes two things: the stack it runs on, and how much of it is programmable.

## What PocketBase gets right

- **A small, stable product model.** Collections, records, rules, auth, files. Most apps never need more.
- **One file to run, one directory to back up.** `pb_data` holds the whole state.
- **A clear API with good SDKs.** The JavaScript and Dart SDKs, and many community clients, all speak the same REST and SSE protocol.
- **A dashboard that is good enough to be the admin panel** for many internal tools.

iglo.base starts from that work rather than from a blank page.

## What iglo.base changes

### One stack across iglo.\* projects

Bun, TypeScript and SQLite, shipped as one executable, like [iglo.monitor](https://github.com/iglo-tech/iglo.monitor) and [iglo.email](https://github.com/iglo-tech/iglo.email). PocketBase is Go. Owning a Go codebase alongside TypeScript ones means a second toolchain, a second set of conventions and a second language for every review.

### No extension surface

PocketBase is also a framework: you can [import it as a Go package or write JavaScript hooks](https://pocketbase.io/docs/use-as-framework/) that change routes, events, migrations, cron jobs, console commands and the dashboard. That flexibility has a cost:

- **The core is shaped around hooks.** Almost every operation goes through an event chain so user code can intercept it. That is a large part of the code and the main thing that makes behavior hard to predict.
- **An embedded JavaScript VM** (goja, a pool of prewarmed runtimes) and file watching are part of every binary, used or not.
- **Business logic ends up inside the database server.** Hooks run inside the request and the transaction, so a slow or broken hook is a slow or broken backend.

In the iglo.\* projects, custom logic belongs in the app that owns it, talking to the backend through its API and realtime stream. Removing the extension surface makes iglo.base a product, not a framework: a fixed, testable behavior that matches the PocketBase API exactly.

### Upstream moved and is pre-1.0

On 2026-10-23 PocketBase v0.40.6 was announced as most likely the last release on GitHub. The repository is archived and development continues on its author's own host. PocketBase is still pre-1.0 and says that full backward compatibility is not guaranteed. iglo.base pins one version's API and data format and keeps it.

## Scope

iglo.base aims for exact parity with PocketBase v0.40.6 for everything that is not an extension mechanism; see [Scope](design/01-scope.md). It does not add features in v1. It is not a Firebase or Supabase replacement and does not plan Postgres, multi-node or multi-tenant modes.

## Credit and independence

iglo.base would not exist without PocketBase. Gani Georgiev and the PocketBase contributors designed the product, the API, the rule and filter language, the dashboard and years of careful behavior that form the starting point for this work.

iglo.base is independently maintained, is not an official PocketBase edition, and does not ask PocketBase maintainers to support it. It is licensed under MIT, as PocketBase is, and keeps PocketBase's copyright notice.
