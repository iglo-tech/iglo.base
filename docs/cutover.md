# Cutover runbook: from PocketBase v0.41.0 to iglo.base

How to switch a running PocketBase v0.41.0 (or v0.40.x) instance to iglo.base on the same `pb_data`, and how to go back. It is generic: it holds no details of any deployment. The way back works because iglo.base never converts `pb_data` ([data compatibility](design/03-data-compatibility.md)): PocketBase v0.41.0 opens the directory again after iglo.base has run on it.

The procedure was rehearsed once on a copy of a real production backup (task M7.4, [D32](design/10-decisions.md#d32-an-agent-runs-the-cutover-rehearsal-on-the-staging-copy)); the rehearsal's counts are in that task's pull request.

## What carries over

| PocketBase | iglo.base |
| --- | --- |
| `pb_data` directory (`data.db`, `auxiliary.db`, `storage/`, `backups/`) | the same directory, untouched format |
| settings in `_params` (SMTP, S3, backups, rate limits, trusted proxy, logs) | the same, read from the same rows |
| `serve --http host:port` | `serve --http host:port` |
| `--dir`, `--publicDir`, `--migrationsDir`, `--automigrate`, `--queryTimeout`, `--origins`, `--indexFallback`, `--dev` | the same flags with the same defaults (other flags: see below) |
| `--encryptionEnv NAME` and the variable it names | the same; the settings stay encrypted with the same key |
| `pb_public/` static files | served the same way |
| `pb_migrations/` auto-generated files | the same JavaScript migration files run under Bun ([D23](design/10-decisions.md)). Copy the directory next to `pb_data` (or pass `--migrationsDir`) |
| superusers, `superuser upsert` and the other `superuser` subcommands | the same CLI |

What does not carry over:

- `pb_hooks` and JavaScript plugins: iglo.base has no extension surface ([D5](design/10-decisions.md)). If the deployment uses them, do not switch.
- `--hooksDir`, `--hooksWatch` and `--hooksPool`: iglo.base refuses them and exits with status 1. Remove them from the command line (PocketBase Docker images often pass `--hooksDir` even when no hooks are used).
- A `pb_hooks/` directory next to `pb_data`, even an empty one, makes iglo.base print a warning on stderr at start. Move it away if it holds no hooks.
- `--https` and `serve example.com`: iglo.base serves plain HTTP only ([D30](design/10-decisions.md#d30-no-tls-in-the-app)). TLS ends at the reverse proxy.
- Anything else listed under deliberate differences in [04-api-compatibility.md](design/04-api-compatibility.md): read it once before the switch.

The `--dir` default is `pb_data` next to the executable, as in PocketBase. Pass `--dir` explicitly and keep the same value in both binaries.

## From the PocketBase Docker image

The iglo.base image (`ghcr.io/iglo-tech/iglo.base`, see [releasing.md](releasing.md#image)) keeps the data in `/pb_data`, the path most PocketBase images use; check your own mount, as some use `/pb/pb_data` or another path. Keep the same volume and point the new container at it:

- Mount the existing directory on `/pb_data` (or pass another path with `--dir`). The process runs as uid/gid 65532, not root: `chown -R 65532:65532` the directory (and the migrations directory) while the old container is stopped, or the database opens read-only and the server fails. Changing the owner does not alter the data; `chown` back before starting PocketBase again.
- Mount the old `pb_migrations` on `/pb_migrations`.
- Drop `--hooksDir`, `--hooksWatch` and `--hooksPool` from the command: iglo.base exits with status 1 on them. The default command is `serve --http 0.0.0.0:8090 --dir /pb_data`; if you override it, keep `serve`.
- The port inside the container is 8090, as in PocketBase images. Expect `docker stop` to finish well within the default 10 s.

## Before the day

1. Download the release archive (see [releasing.md](releasing.md)) and check it: `sha256sum -c SHA256SUMS`, `unzip` the archive, then `./iglo-base --version`.
2. Note how PocketBase is started today: the full command line, the environment, the service manager unit and the reverse proxy configuration. The new unit differs in the binary path and the name, and drops the hooks flags listed above.
3. Look at the settings in the PocketBase dashboard: trusted proxy headers, rate limits, SMTP, S3, scheduled backups. They carry over unchanged. Check that the reverse proxy sends the headers `trustedProxy.headers` names, because iglo.base resolves the client IP from them in the same way.
4. Note the PocketBase version that runs today, from the binary (`./pocketbase --version`) or the image tag; `_migrations` cannot tell it, as several releases share the same newest system migration. If it is not v0.41.0, first move PocketBase to v0.41.0 and run it for a while: the rollback below starts PocketBase v0.41.0, and iglo.base ports v0.41.0's system migrations.

## The switch

1. **Stop PocketBase** with SIGTERM (`systemctl stop`, `docker stop`). Wait until the process has exited: a clean exit closes both SQLite databases and checkpoints their write-ahead logs. Do not copy `pb_data` while PocketBase runs.
2. **Take a backup of the stopped directories**: `cp -a pb_data pb_data.before-iglo` and, if the deployment has a migrations directory, `cp -a pb_migrations pb_migrations.before-iglo` (the directory `--migrationsDir` names, if set) on the same volume, or any other copy you can restore from. This copy is the last-resort way back; keep it until the cutover is accepted.
3. **Place the binary.** Put `iglo-base` where the service can run it, next to the old binary, and keep the old binary and its unit file unchanged.
4. **Start iglo.base on the same directory** with the same flags, for example:
   ```sh
   ./iglo-base serve --http 127.0.0.1:8090 --dir /path/to/pb_data
   ```
   Add `--encryptionEnv NAME` and the variable if the settings are encrypted. Run it under the service manager that ran PocketBase. Start takes about 0.3–0.5 s, against about 0.05 s for PocketBase; give the proxy's or service manager's health check that much time.
5. **Check the start.** The banner prints three lines (the server URL, the dashboard URL and the REST API URL); the process prints no error output. `curl -i http://127.0.0.1:8090/api/health` answers 200 with `{"message":"API is healthy.","code":200,"data":{}}`.
6. **Point the reverse proxy** at it. If the address and port are unchanged, nothing changes. TLS, HTTP/2 and SSE pass-through (realtime is Server-Sent Events: the endpoint needs unbuffered responses and a long read timeout) stay with the proxy.

## Checks after the start

Run these as a superuser (dashboard or API) against the live server:

- the dashboard opens at `/_/` and lists every collection;
- for a few collections, list records and open one record; counts match what PocketBase showed before the stop;
- log in as a real user of each auth collection and refresh the token;
- open a file and, if image thumbnails are used, a thumbnail;
- subscribe to realtime from a client, change a record and see the event;
- create a record, update it, delete it (use a collection where a test record is harmless);
- if scheduled backups or SMTP are enabled in the settings, use the dashboard's test-email button and create one backup (Settings → Backups), then check that the file appears;
- the application's own client: use it for a few minutes.

## Rollback

Use it whenever a check fails or the clients misbehave, at any time. Writes made while iglo.base ran stay in `pb_data`: PocketBase opens them.

1. **Stop iglo.base** with SIGTERM and wait for the process to exit with status 0.
2. **Start PocketBase v0.41.0** with its old command line and unit on the same `pb_data`. It starts with no error output and shows every collection and record, including those written while iglo.base ran.
3. Point the reverse proxy back if you changed it.

If PocketBase does not open the directory (this was never observed in the rehearsal), stop it, restore `pb_data.before-iglo` and `pb_migrations.before-iglo` from the switch step 2 (together: migration files written by `--automigrate` while iglo.base ran would otherwise run again on PocketBase's next start) and start PocketBase on it. Writes since the switch are then lost.

To try iglo.base again later, repeat the switch from step 1: stop PocketBase and take a new backup first. Never run both servers on the same `pb_data` at once.

## After acceptance

Keep `pb_data.before-iglo` and `pb_migrations.before-iglo` until you are sure, then delete them. Keep the PocketBase binary and unit file as long as the rollback should stay possible. Scheduled backups continue as configured in the settings; restore tests of a backup made by iglo.base are covered by the same API as PocketBase's.
