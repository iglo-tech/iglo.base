# iglo.base

**A self-hosted backend in one file: database, auth, file storage, realtime and an admin dashboard. Built on Bun and SQLite, and a drop-in replacement for [PocketBase](https://pocketbase.io) v0.41.0.**

Your existing PocketBase apps, SDKs and `pb_data` work unchanged. If you change your mind, PocketBase opens the same data again.

[Download](https://github.com/iglo-tech/iglo.base/releases/latest) · [Docker image](#docker) · [Move from PocketBase](docs/cutover.md) · [Why iglo.base?](docs/why-iglo-base.md)

## Quick start

1. Download the archive for your platform from the [latest release](https://github.com/iglo-tech/iglo.base/releases/latest) and unzip it.
2. Start the server:

   ```sh
   ./iglo-base serve
   ```

3. Open the installer link the server prints, create your first superuser, and you land in the dashboard at http://127.0.0.1:8090/_/.

Your API is at http://127.0.0.1:8090/api/. All data goes into `pb_data/` next to the executable.

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
| Linux arm64 | `iglo-base_<version>_linux_arm64.zip` (from the release after 1.0.0) |
| macOS on Apple silicon | `iglo-base_<version>_darwin_arm64.zip` (from the release after 1.0.0) |

Windows and Intel Macs are not supported. Check the archive with `sha256sum -c SHA256SUMS`. The macOS build is not signed: after downloading, run `xattr -d com.apple.quarantine iglo-base` once.

### Docker

```sh
docker run -d --name iglo -p 8090:8090 -v iglo-data:/pb_data ghcr.io/iglo-tech/iglo.base:latest
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

iglo.base is fast. With one client, every common request finishes in 0.4 to 3.5 ms, and most of them sooner than on PocketBase. Median response times in ms, both servers on the same machine and data:

| Request | 1 client: iglo.base | 1 client: PocketBase | 10 clients: iglo.base | 10 clients: PocketBase |
|---|---|---|---|---|
| Filter and sort | **3.48** | 6.00 | **11.56** | 20.93 |
| List 30 records | **1.09** | 1.57 | **4.95** | 5.57 |
| Expand a relation | **2.36** | 2.90 | **13.07** | 13.25 |
| View one record | 0.39 | 0.39 | **2.03** | 2.33 |
| Create a record | 0.75 | **0.66** | 5.81 | **3.00** |

- **Filtered and sorted lists are almost 2 times as fast** at every load tested. With 50 clients at once, iglo.base answers in 70 ms against PocketBase's 134 ms, and serves 607 requests/s against 356.
- **Plain lists serve 56% more requests/s with one client:** 807 against 517.
- **The slowest requests are faster too.** With 50 clients at once, the slowest 5% of every request type finish sooner than on PocketBase: lists in 50 ms against 83 ms, expands in 103 ms against 164 ms.
- **The one place PocketBase leads is simple requests under heavy load.** With 50 clients hitting one server at once, a typical list, view, expand or create takes longer than on PocketBase (a view 9.0 ms against 6.6 ms). iglo.base handles requests on one CPU core, while PocketBase spreads them over all cores, so it pulls ahead when spare cores are idle. Even then iglo.base serves about 5,000 views/s and 1,700 creates/s, more than most apps ever see.
- **It starts in under 0.2 s**, even with 10,500 records.

The method and every measurement are in [docs/perf](docs/perf/P.3-second-pass.md).

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

A few edge cases behave slightly differently, such as error texts for malformed requests and the timing of query timeouts. Each one is listed in [API compatibility](docs/design/04-api-compatibility.md#deliberate-differences). Every other API response is checked against PocketBase v0.41.0 by a differential test suite.

## Status

The current release is 1.0.0, from 5 November 2026. iglo.base is maintained by [iglo-tech](https://github.com/iglo-tech) for its own projects and published as is: there is no support promise and no release schedule. It is not an official PocketBase project.

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
