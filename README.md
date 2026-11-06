# iglo.base

**A self-hosted backend in one file: database, auth, file storage, realtime and an admin dashboard. Built on Bun and SQLite, and a drop-in replacement for [PocketBase](https://pocketbase.io) v0.41.0.**

Your existing PocketBase apps, SDKs and `pb_data` work unchanged. If you change your mind, PocketBase opens the same data again.

[Download](https://github.com/iglo-tech/iglo.base/releases/latest) · [Docker image](#docker) · [Operations guide](docs/operations.md) · [Move from PocketBase](docs/cutover.md) · [Differences](docs/differences.md) · [Why iglo.base?](docs/why-iglo-base.md)

## Quick start

1. Download the archive for your platform from the [latest release](https://github.com/iglo-tech/iglo.base/releases/latest) and unzip it.
2. Start the server:

   ```sh
   ./iglo-base serve
   ```

3. Open the installer link the server prints, create your first superuser, and you land in the dashboard at http://127.0.0.1:8090/_/.

For a service, a reverse proxy with TLS, backups and upgrades, see the [operations guide](docs/operations.md).

Your API is at http://127.0.0.1:8090/api/. All data goes into `pb_data/`: next to the executable when you start it with a path (`./iglo-base`), in the working directory when you start it by name through `PATH`. Pass `--dir` to choose (see the [operations guide](docs/operations.md#flags)).

Use any PocketBase client, for example the [JavaScript SDK](https://github.com/pocketbase/js-sdk):

```js
import PocketBase from "pocketbase";

const pb = new PocketBase("http://127.0.0.1:8090");
const posts = await pb.collection("posts").getList(1, 20);
```

### Platforms

| Platform | Archive |
|---|---|
| Linux x64 | `iglo-base_<version>_linux_amd64.zip` |
| Linux arm64 | `iglo-base_<version>_linux_arm64.zip` (from 1.1.0) |
| macOS on Apple silicon | `iglo-base_<version>_darwin_arm64.zip` (from 1.1.0) |

Windows and Intel Macs are not supported. Check the archive with `sha256sum -c SHA256SUMS`. The macOS build is not signed: after downloading, run `xattr -d com.apple.quarantine iglo-base` once.

### Docker

```sh
docker run -d --name iglo -p 8090:8090 -v iglo-data:/pb_data ghcr.io/iglo-tech/iglo.base:1.1.0
docker exec iglo /iglo-base superuser upsert admin@example.com 'a long password'
```

The image holds only the release executable. Data lives in `/pb_data`, migrations in `/pb_migrations`, static files in `/pb_public`. The process runs as uid 65532. To reuse a directory from PocketBase's image, see [Image](docs/releasing.md#image).

## What you get

- **Collections**: base, auth and view collections, 14 field types, indexes and API rules with PocketBase's filter language.
- **Records API**: list, filter, sort, expand relations, pick fields, batch requests.
- **Realtime**: subscriptions over server-sent events.
- **Auth**: password, one-time codes, MFA, OAuth2 with the same 30+ providers, impersonation and new-login alerts.
- **Files**: local disk or S3, thumbnails, protected files.
- **Email**: SMTP or `sendmail`, with editable templates.
- **Operations**: backups to disk or S3, request logs, rate limits, scheduled maintenance jobs.
- **Admin dashboard** at `/_/`: PocketBase's dashboard, branded as iglo.base.
- **Migrations**: JavaScript files in `pb_migrations`, `migrate` and `--automigrate`, as in PocketBase.

## Performance

iglo.base is fast. With one client, every common request finishes in 0.4 ms to 3.5 ms, most of them sooner than on PocketBase. Both servers were measured on the same machine with the same data.

**Median response time** (lower is better; the faster server in bold):

| Request | 1 client: iglo.base | 1 client: PocketBase | 10 clients: iglo.base | 10 clients: PocketBase | 50 clients: iglo.base | 50 clients: PocketBase |
|---|---|---|---|---|---|---|
| Filter and sort | **3.48 ms** | 6.00 ms | **11.56 ms** | 20.93 ms | **70.10 ms** | 133.48 ms |
| List 30 records | **1.09 ms** | 1.57 ms | **4.95 ms** | 5.57 ms | 28.66 ms | **19.77 ms** |
| Expand a relation | **2.36 ms** | 2.90 ms | **13.07 ms** | 13.25 ms | 71.00 ms | **44.22 ms** |
| View one record | 0.39 ms | 0.39 ms | **2.03 ms** | 2.33 ms | 8.99 ms | **6.58 ms** |
| Create a record | 0.75 ms | **0.66 ms** | 5.81 ms | **3.00 ms** | 27.03 ms | **14.48 ms** |

**Slowest 5% of requests with 50 clients** (the 95th percentile; lower is better):

| Request | iglo.base | PocketBase |
|---|---|---|
| Filter and sort | **147.33 ms** | 241.03 ms |
| List 30 records | **49.68 ms** | 82.87 ms |
| Expand a relation | **102.92 ms** | 163.75 ms |
| View one record | **18.28 ms** | 27.72 ms |
| Create a record | **45.91 ms** | 52.06 ms |

- **Filtered and sorted lists are almost 2 times as fast at every load**, and serve 607 requests/s against 356 with 50 clients.
- **Plain lists serve 56% more requests/s with one client:** 807 against 517.
- **Response times are steadier.** With 50 clients, the slowest 5% of every request type finish sooner than on PocketBase.
- **PocketBase's typical response is quicker for simple requests under heavy load.** With 50 clients hitting one server at once, the median list, expand, view and create are faster on PocketBase. iglo.base handles requests on one CPU core, while PocketBase spreads them over all cores. Even then iglo.base serves about 5,000 views/s and 1,700 creates/s.
- **It starts in 117 ms to 153 ms** on a database with 10,500 records (PocketBase: 29 ms to 38 ms).

**Memory** (RSS, lower is better):

| Situation | iglo.base | PocketBase |
|---|---|---|
| Just started, idle | 74 MiB | **35 MiB** |
| After the 50-client benchmark above | **171 MiB to 199 MiB** | 178 MiB to 389 MiB |
| Per open realtime connection (1,000 connections) | **12 KiB** | 50 KiB |
| Peak during a 60 s request burst that writes about 1 million log entries | **163 MiB** | 1,299 MiB |

iglo.base starts with more memory, for the Bun runtime and its four database read workers, and then grows less under load.

The method and every measurement are in [docs/perf](docs/perf/P.3-second-pass.md), with the memory runs in [M7.1a](docs/perf/M7.1a-profile.md), [M5.1](docs/perf/M5.1-realtime.md) and [M5.5](docs/perf/M5.5-logs.md).

## Moving from PocketBase

1. Stop PocketBase and back up the whole `pb_data` and `pb_migrations` directories.
2. Start iglo.base with the same flags on the same directories.
3. Clients keep the same URLs.

To go back, stop iglo.base and start PocketBase v0.41.0 on the same directory. The full checklist, with the flags that carry over and the checks to run, is in the [cutover runbook](docs/cutover.md). Data from PocketBase v0.40.x works too.

## How it differs from PocketBase

iglo.base runs the same product with no extension surface. It does not have:

- JavaScript hooks (`pb_hooks`), custom routes or Go framework mode. If you use hooks, stay on PocketBase.
- Dashboard extensions.
- The `update` command. Download a new release, or pull a new image.
- Built-in HTTPS (`--https`, `serve example.com`). Put a reverse proxy such as Caddy or nginx in front for TLS.

A few edge cases behave slightly differently, such as error texts for malformed requests and the timing of query timeouts. Each one is listed in [Differences from PocketBase](docs/differences.md). Every other API response is checked against PocketBase v0.41.0 by a differential test suite.

## Status

The current release is 1.1.0, from 6 November 2026. iglo.base is maintained by [iglo-tech](https://github.com/iglo-tech) for its own projects and published as is: there is no support promise and no release schedule. It is not an official PocketBase project.

## For developers

You need [Bun](https://bun.sh) 1.4 or newer.

```sh
bun install
bun run build    # builds dist/iglo-base
bun run check    # lint, format, typecheck, tests, build
```

[AGENTS.md](AGENTS.md) lists every command and the project rules. The design is in [docs/design](docs/design/README.md), and releases are described in [docs/releasing.md](docs/releasing.md).

## License

MIT, the same license as PocketBase, from which iglo.base is derived. PocketBase's copyright notice is kept in [LICENSE](LICENSE).
