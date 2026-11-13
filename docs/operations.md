# Operations guide

How to install, run, back up and upgrade iglo.base. For what is different from PocketBase, see [Differences from PocketBase](differences.md). To move an existing PocketBase deployment, see the [cutover runbook](cutover.md).

iglo.base is one executable. It serves the API, the admin dashboard (`/_/`) and your static files, and keeps all data in one directory.

## Install

### From a release archive

1. Download the archive for your platform and `SHA256SUMS` from the [latest release](https://github.com/iglo-tech/iglo.base/releases/latest).

   | Platform | Archive |
   |---|---|
   | Linux x64 | `iglo-base_<version>_linux_amd64.zip` |
   | Linux arm64 | `iglo-base_<version>_linux_arm64.zip` |

   Only Linux is supported; on other systems, run from source with Bun. The linux/arm64 archive exists from release 1.1.0; 1.0.0 has only the Linux x64 archive. (Releases 1.0.0 and 1.1.0 also keep a macOS archive; later releases have none.)

2. Check the checksum. On Linux, with both files in one directory:

   ```sh
   sha256sum -c SHA256SUMS --ignore-missing
   ```

3. Unpack it:

   ```sh
   unzip iglo-base_<version>_linux_amd64.zip
   ```

   The archive holds `iglo-base` (the executable), `LICENSE` and `README.txt`.

4. Check the version:

   ```sh
   ./iglo-base --version
   ```

### With Docker

```sh
docker run -d --name iglo --restart unless-stopped -p 8090:8090 \
  -v iglo-data:/pb_data ghcr.io/iglo-tech/iglo.base:1.2.0
```

The image holds only the release executable. It is multi-arch (linux/amd64 and linux/arm64) from 1.1.0; 1.0.0 has no arm64 variant. Use a version tag (`:1.2.0`) in production instead of `:latest`, so a restart never changes the version. See [Docker container](#docker-container) below for volumes and permissions.

### Create the first superuser

On the first start the server prints an installer link:

```text
(!) Launch the URL below in the browser if it hasn't been open already to create your first superuser account:
http://127.0.0.1:8090/_/#/pbinstall/<token>
(you can also create your first superuser by running: ./iglo-base superuser upsert EMAIL PASS)
```

Open the link and fill in the form. The server prints the link only while no superuser exists, and it works for 30 minutes. If it has expired, or you have no browser on the host, create the superuser on the command line:

```sh
./iglo-base superuser upsert admin@example.com 'a long password'
```

Run it with the same `--dir` as the server. It works while the server runs.

## Run

```sh
./iglo-base serve --dir ./pb_data
```

By default the server listens on `127.0.0.1:8090`, so only the same machine can connect. To accept other connections, set the address: `serve --http 0.0.0.0:8090`. Put a [reverse proxy](#reverse-proxy-with-tls) in front for TLS.

The startup banner shows the server, dashboard and API URLs:

```text
2026/11/06 09:19:25 Server started at http://127.0.0.1:8090
> Dashboard: http://127.0.0.1:8090/_/
> REST API:  http://127.0.0.1:8090/api/
```

Stop the server with SIGTERM or Ctrl+C. It closes realtime connections, waits up to one second for open requests and exits with status 0.

### Flags

Flags work before or after the command name. Flag names are case-sensitive (`--publicDir`, not `--publicdir`). Run `./iglo-base serve --help` for the list in your version.

Flags of `serve`:

| Flag | Default | Meaning |
|---|---|---|
| `--http <addr>` | `127.0.0.1:8090` | TCP address for the HTTP server, as `host:port`. |
| `--origins <list>` | `*` | Allowed CORS origins, comma separated (`--origins https://a.example,https://b.example`). |
| `--https <addr>` | none | Not supported. The server refuses to start (see [Differences](differences.md)). |
| `--schema <file>` | none | The schema file (`iglo.schema.json`) to apply before the server starts. See [Schema as code](schema.md#applying-the-file-at-startup). |
| `--allow-data-loss` | `false` | With `--schema`: let the apply delete fields and collections that hold data. Without it, an apply that would delete data stops before it changes anything. Without `--schema` it has no effect. |

With `--schema`, the apply runs at every start, before the server answers requests. A file that is not valid, or an apply that fails, makes the start exit with status `1`, and the server does not start. The database is unchanged then. Without `--schema`, the server starts as before.

Global flags, accepted by `serve`, `superuser` and `migrate`:

| Flag | Default | Meaning |
|---|---|---|
| `--dir <path>` | `pb_data` in the directory of the command (see below) | The data directory. |
| `--publicDir <path>` | `pb_public` in the directory of the command | Directory of static files served at `/`. Nothing is served when it does not exist. It does not follow `--dir`. |
| `--indexFallback` | `true` | Serve `index.html` of `--publicDir` for a missing path, for single-page apps. Use `--indexFallback=false` to turn it off. |
| `--migrationsDir <path>` | `pb_migrations` next to the `--dir` directory (`<dir>/../pb_migrations`) | Directory of JavaScript migration files. |
| `--automigrate` | `true` | Write a migration file when you change collections in the dashboard. Use `--automigrate=false` to turn it off. Migrations in the directory are applied at start either way. |
| `--encryptionEnv <NAME>` | none | Name of an environment variable that holds a 32-character key. The settings (SMTP password, S3 secrets and so on) are then stored encrypted with it. Keep the key: without it the settings cannot be read. |
| `--queryTimeout <seconds>` | `30` | Timeout of read queries. |
| `--dev` | `false` | Also print logs and SQL statements to the console. |
| `-h`, `--help` | | Help for the command. |
| `-v`, `--version` | | Prints `iglo-base version <version>` (root command only). |

The flags `--hooksDir`, `--hooksWatch` and `--hooksPool` are refused: iglo.base has no hooks.

The defaults `pb_data`, `pb_public` and `pb_migrations` are taken from the directory of the command as you typed it. Started with a path (`./iglo-base`, `/usr/local/bin/iglo-base`, or the `ExecStart` of a systemd unit), that is the directory that holds the executable. Started by bare name through `PATH` (`iglo-base serve`), there is no directory in the name and they are the **working directory**. Start the same executable from another directory and you get a new, empty instance, so your data seems to be gone. Always pass `--dir` (and `--publicDir`) explicitly.

### Environment variables

None is needed. The server reads these:

| Variable | Default | Meaning |
|---|---|---|
| the one named by `--encryptionEnv` | | The settings encryption key. |
| `PB_THUMBS_MAX_WORKERS` | CPU count + 2 | Thumbnails generated at the same time. |
| `PB_THUMBS_MAX_WAIT` | `60` | Seconds a thumbnail request waits for a free worker. |
| `PB_THUMBS_MAX_SOURCE_PIXELS` | `104857600` (100 × 2^20) | Largest source image, in pixels, that gets thumbnails. A larger image is served as it is. |
| `PB_FILES_DELETE_MAX_WORKERS` | `2000` | Files deleted at the same time. |
| `PB_ID_TOKEN_LEEWAY` | `300` | Seconds of clock difference accepted when checking an OpenID Connect ID token from an OAuth2 provider. Any integer, 0 and negative values included. |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | none | Used for the server's outgoing HTTP requests that go through `fetch`, such as the OAuth2 avatar download. `NO_PROXY` lists the hosts that bypass the proxy. |
| `NO_COLOR`, `TERM=dumb` | | Either one turns off colors in the console output. |
| `TZ` | system time zone | Go's local time zone, used where PocketBase uses it: some conversions of date values that carry no zone, and time values in JavaScript migrations. Stored timestamps are always UTC, and cron expressions, including the backup schedule, always run in UTC. |

A value that is not a number falls back to the default. For the counts (`PB_THUMBS_*`, `PB_FILES_DELETE_MAX_WORKERS`), 0 and negative values fall back too; `PB_ID_TOKEN_LEEWAY` takes any integer.

### Directories

All of them can be changed with the flags above.

| Directory | Holds |
|---|---|
| `pb_data/` | `data.db` (collections and records), `auxiliary.db` (logs and other data), `storage/` (uploaded files), `backups/` (local backups) and a temporary `.pb_temp_to_delete/`. |
| `pb_migrations/` | JavaScript migration files. The dashboard adds one for every change to collections when `--automigrate` is on. Keep this directory with your code or back it up. |
| `pb_public/` | Static files, served at `/`. |

A `pb_hooks` directory next to `pb_data` is ignored; the server prints a warning when it exists.

Keep `pb_data` on local disk. SQLite does not work reliably on network file systems.

## Run as a service

### systemd

Create a dedicated user and the directories (Debian, Ubuntu and similar):

```sh
sudo useradd --system --home-dir /var/lib/iglo-base --shell /usr/sbin/nologin iglo
sudo install -d -o iglo -g iglo -m 0750 /var/lib/iglo-base /var/lib/iglo-base/pb_data
sudo install -d -m 0755 /opt/iglo-base
sudo install -m 0755 iglo-base /opt/iglo-base/iglo-base
```

`/etc/systemd/system/iglo-base.service`:

```ini
[Unit]
Description=iglo.base
After=network.target

[Service]
Type=simple
User=iglo
Group=iglo
WorkingDirectory=/var/lib/iglo-base
ExecStart=/opt/iglo-base/iglo-base serve \
    --http 127.0.0.1:8090 \
    --dir /var/lib/iglo-base/pb_data \
    --publicDir /var/lib/iglo-base/pb_public
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
LimitNOFILE=65536

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/iglo-base

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now iglo-base
sudo journalctl -u iglo-base -f
```

Without `--migrationsDir` the migrations go to `/var/lib/iglo-base/pb_migrations`, next to `pb_data`, which the service user may write. Run the other commands as the same user and with the same `--dir`:

```sh
sudo -u iglo /opt/iglo-base/iglo-base superuser upsert admin@example.com 'a long password' --dir /var/lib/iglo-base/pb_data
```

To set `--encryptionEnv`, add `Environment=` or `EnvironmentFile=` to the unit (the file must be readable by root only) and `--encryptionEnv NAME` to `ExecStart`.

Restoring a backup from the dashboard restarts the server in the same process (it re-runs itself), so the unit needs nothing special for it.

### Docker container

```sh
docker run -d --name iglo --restart unless-stopped \
  -p 127.0.0.1:8090:8090 \
  -v iglo-data:/pb_data \
  -v iglo-migrations:/pb_migrations \
  -v /srv/site:/pb_public:ro \
  ghcr.io/iglo-tech/iglo.base:1.2.0
```

- The executable is `/iglo-base` and the working directory is `/`, so the defaults are the mounts above: `/pb_data`, `/pb_migrations` (declared as volumes) and `/pb_public` (mount it if you serve static files). The default command is `serve --http 0.0.0.0:8090`. If you pass your own command, keep `serve` and add the flags after the image name: `... ghcr.io/iglo-tech/iglo.base:1.2.0 serve --http 0.0.0.0:8090 --origins https://app.example.com`.
- `-p 127.0.0.1:8090:8090` keeps the port off the public network when a reverse proxy runs on the same host. Without the `127.0.0.1:` prefix Docker publishes the port on all interfaces.
- `--restart unless-stopped` starts the container after a crash or a reboot.
- The process runs as uid and gid 65532. A new named volume gets that owner. For a bind mount, hand the directory over first: `sudo chown -R 65532:65532 /srv/iglo/pb_data`. With rootless Docker or Podman, see the [image notes](releasing.md#image).
- The image has no shell, `curl` or `wget`, so a container health check that runs a command inside it cannot work. Check `/api/health` from the host or the proxy.
- Run other commands with the full path, in the running container or in a one-off container on the same volume:

  ```sh
  docker exec iglo /iglo-base superuser upsert admin@example.com 'a long password'
  docker run --rm -v iglo-data:/pb_data ghcr.io/iglo-tech/iglo.base:1.2.0 superuser upsert admin@example.com 'a long password'
  ```

## Reverse proxy with TLS

iglo.base serves plain HTTP. Let a reverse proxy end TLS. Keep iglo.base on `127.0.0.1:8090` and open only the proxy's ports 80 and 443.

Two things matter for the proxy:

- **Realtime uses server-sent events (SSE).** `GET /api/realtime` is a response that stays open and sends events whenever they happen. The proxy must not buffer it and must not close it for being idle. The server sends `X-Accel-Buffering: no`, and closes a connection after 5 minutes without a message and after 30 minutes in all; the client SDKs then reconnect. Set the read timeout of the proxy above 5 minutes.
- **The client IP.** Behind a proxy every request comes from the proxy's address. Rate limits, logs and the superuser IP allow-list use the client IP, so tell iglo.base which header carries it: dashboard **Settings → Application → IP proxy headers**, or `trustedProxy.headers` in the settings API. Use a header that only your proxy sets, such as `X-Forwarded-For`. Leave **Use leftmost IP** off for the configs below: nginx appends the real client address to the right of any value the client sent, Caddy replaces an untrusted incoming value with the client address, and iglo.base takes the rightmost address, which is the address your proxy wrote in both cases. If a client could send the header itself and your proxy passes it on unchanged, the client IP can be faked. The dashboard shows "Detected proxy header" when a request arrives with a header it recognizes.

### Caddy

Caddy gets and renews the certificate by itself. `Caddyfile`:

```caddyfile
example.com {
	reverse_proxy 127.0.0.1:8090 {
		# SSE: send events at once, keep long connections open
		flush_interval -1
		transport http {
			read_timeout 6m
		}
	}
}
```

Caddy sets `X-Forwarded-For` to the client's address by itself and drops a value sent by an untrusted client, so set the trusted header to `X-Forwarded-For`.

### nginx

`/etc/nginx/conf.d/iglo.conf`, with a certificate from Let's Encrypt (for example with `certbot`) or your own. It works on nginx 1.22 and later and talks HTTP/1.1 to clients, which is enough for SSE. To add HTTP/2, write `listen 443 ssl http2;` (nginx before 1.25.1) or add `http2 on;` (1.25.1 and later).

```nginx
server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    # file uploads: the API accepts bodies up to the limits set per collection
    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 360s;
        proxy_send_timeout 360s;
    }

    location /api/realtime {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 360s;
    }
}
```

`$proxy_add_x_forwarded_for` appends the client address to what the client sent, so keep **Use leftmost IP** off and trust `X-Forwarded-For`. If nginx itself sits behind another proxy, set the header from the real address that proxy provides (for example with the `realip` module) before trusting it.

Raise `client_max_body_size` if you accept larger uploads; nginx's default is 1 MB.

## Backups

All data is in the data directory, so a backup is a copy of it.

### Built-in backups

In the dashboard open **Settings → Backups**. You can create a backup, upload or download one, restore one, and schedule backups with a cron expression and the number of backups to keep. Backups are zip files of the data directory and are stored in `pb_data/backups/`, or in an S3 bucket when you enable S3 for backups there.

The same functions are in the API for superusers. This example needs `curl` and `jq` (`sudo apt install jq`):

```sh
TOKEN=$(curl -s http://127.0.0.1:8090/api/collections/_superusers/auth-with-password \
  -H 'Content-Type: application/json' \
  -d '{"identity":"admin@example.com","password":"a long password"}' | jq -r .token)

curl -X POST http://127.0.0.1:8090/api/backups -H "Authorization: $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"before-upgrade.zip"}'
curl http://127.0.0.1:8090/api/backups -H "Authorization: $TOKEN"
```

A restore replaces the data directory and restarts the server. See PocketBase's [Backups API](https://pocketbase.io/docs/api-backups/) for all endpoints.

A backup that lives only on the same disk does not protect you from losing the disk. Copy backups elsewhere or use S3.

### Backups before a schema apply

`serve --schema` makes a backup before an apply that changes something and passes its dry run; a file that would fail makes no backup. It is named `pre-schema-<UTC time>.zip` with milliseconds, for example `pre-schema-20261112T101500.123Z.zip`, and it goes to the same backup storage (local or S3). The three newest `pre-schema-*` backups are kept, and older ones are deleted after every apply that made one, successful or failed, so a server that restarts on a failing file keeps at most three. The automatic backup setting `cronMaxKeep` does not touch them. If the backup fails, the server does not start. The details are in [Schema as code](schema.md#backups-before-an-apply).

### Copy the directory

To back up with a file copy, **stop the server first** and copy the whole data directory (and `pb_migrations`):

```sh
sudo systemctl stop iglo-base
sudo install -d /srv/backup
sudo cp -a /var/lib/iglo-base /srv/backup/iglo-base-$(date +%F)
sudo systemctl start iglo-base
```

Never copy only `data.db`. While the server runs, recent writes sit in `data.db-wal` and `auxiliary.db-wal`, and a file copied by itself is missing them or is damaged. A clean stop writes them into the database files.

To restore, stop the server, put the copy back as the data directory and start the server.

## Upgrade

Releases keep the data format, and the server applies its own migrations at start. Before an upgrade, make a backup (see above).

- **Executable:** stop the service, replace the file with the new `iglo-base` from the release (check the checksum), start the service. With the unit above:

  ```sh
  sudo systemctl stop iglo-base
  sudo install -m 0755 iglo-base /opt/iglo-base/iglo-base
  sudo systemctl start iglo-base
  /opt/iglo-base/iglo-base --version
  ```

- **Docker:** pull the new image and create the container again on the same volumes:

  ```sh
  docker pull ghcr.io/iglo-tech/iglo.base:<new-version>
  docker stop iglo && docker rm iglo
  docker run -d --name iglo ... ghcr.io/iglo-tech/iglo.base:<new-version>
  ```

There is no `update` command. A version number is not a promise of a release schedule: iglo.base is published as is.

**Way back to PocketBase:** `pb_data` stays in PocketBase v0.41.0's format. To switch back, stop iglo.base and start PocketBase v0.41.0 on the same directory. The steps are in the [cutover runbook](cutover.md#rollback). For the way from PocketBase to iglo.base, see the same page.

## Logs and health

- **Console:** the server prints the startup banner and errors and warnings that need attention. Under systemd read it with `journalctl -u iglo-base`, under Docker with `docker logs iglo`. With `--dev` it prints every request and SQL statement too.
- **Request logs** are stored in `auxiliary.db` and shown in the dashboard under **Logs**, and in the API at `/api/logs` for superusers. A new instance keeps them for 5 days and stores client IPs. Change that in **Settings → Application** (`logs` in the settings API).
- **Health check:** `GET /api/health` answers `200` with `{"message":"API is healthy.","code":200,"data":{}}`:

  ```sh
  curl -f http://127.0.0.1:8090/api/health
  ```

  Use it for the proxy's or monitor's check. A start takes a fraction of a second, but give a restore or a large migration longer.

## Other commands

The commands use the same global flags. Run them with the same `--dir` as the server; they can run while the server is up. A running server picks up the settings and collections changes a command makes (`superuser ips`, and `migrate up`, `migrate down` or `migrate collections` when a migration changes them) within about 50 ms, as PocketBase does. The commands and servers on one data directory tell each other through the `.notify` directory inside it: it is created by PocketBase too, empty marker files appear in it for an instant after each save, and it must stay on the same local volume as `data.db`. If the directory cannot be watched, the server logs a warning at start and such changes need a restart.

### `superuser`

```sh
./iglo-base superuser create admin@example.com 'a long password'   # new superuser
./iglo-base superuser upsert admin@example.com 'a long password'   # create, or change the password if it exists
./iglo-base superuser update admin@example.com 'a new password'    # change the password
./iglo-base superuser delete admin@example.com
./iglo-base superuser otp admin@example.com                        # one-time password, needs OTP enabled for superusers
./iglo-base superuser ips 203.0.113.7 10.0.0.0/24                  # superusers may only act from these IPs/subnets
./iglo-base superuser ips                                          # no arguments: remove the restriction
```

`superuser ips` writes the setting to the database, and a running server applies it within about 50 ms, also when the list is cleared.

Mind the IP list: a request that is signed in as a superuser from any other address is refused with 403, so a wrong list locks you out of the dashboard. Behind a proxy it checks the client IP, so set the trusted proxy header first (see above). If you are locked out, run `./iglo-base superuser ips --dir <dir>` with no arguments; it clears the list and the running server applies that at once. The other `superuser` commands change records and act at once.

### `migrate`

Applies and manages the JavaScript files in `pb_migrations`:

```sh
./iglo-base migrate up                 # apply all pending migrations
./iglo-base migrate down 1             # revert the last migration (asks y/N first)
./iglo-base migrate create add_posts   # new empty migration file (asks y/N first)
./iglo-base migrate collections        # a file with a snapshot of the current collections (asks y/N first)
./iglo-base migrate history-sync       # drop history rows of migration files that no longer exist
```

The three commands that ask read the answer from standard input; without a terminal the answer is no and the command is cancelled, so in a script pipe it in (`echo y | ./iglo-base migrate create add_posts`).

`serve` runs pending migrations at start, so `migrate up` is rarely needed by hand. A running server picks up the collections and settings changes of `migrate up`, `migrate down` and `migrate collections` within about 50 ms, without a restart. Pass `--migrationsDir` if the files are not in `<dir>/../pb_migrations`. Migration files use the same API as PocketBase's JavaScript migrations. iglo.base runs them with Bun.

### `schema`

Reads and checks the schema file. See [Schema as code](schema.md).

```sh
./iglo-base schema pull --out iglo.schema.json                  # write the file from the database
./iglo-base schema plan --schema iglo.schema.json               # what applying the file would change
./iglo-base schema plan --schema iglo.schema.json --allow-data-loss
```

`schema pull` reads the database and writes the file. It changes nothing.

`schema plan` runs the apply of the file and rolls it back. It prints the changes, the migrations that would run, the data that would be lost and every problem. It makes no backup. Its exit code is `0` when the file would apply, also when nothing changes, and `1` when it would not. It holds the write locks of `data.db` and `auxiliary.db` from its first write until it rolls back, so run it on a live server when a short pause in writes is acceptable; the server's writes to `auxiliary.db` wait for it. It needs an existing database in `--dir`.

### `update`

Does not exist; the command fails with an error. Deploy a new release instead.
