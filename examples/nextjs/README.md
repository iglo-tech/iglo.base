# iglo.base with Next.js (App Router)

A small Next.js app that shows iglo.base's server-side rendering support through the
`iglo.base/ssr/next` adapter (see `docs/design/13-ssr.md`, "Framework adapters"). It signs users
in with a form, keeps the session in an HttpOnly cookie, checks it on each request, and shows a
realtime collection on a page whose browser client never sees the session token.

What the pages show:

- `/` shows the signed-in user's email, or `signed out`.
- `/login` is the sign-in form. A wrong password comes back as `?error=1`. Below it, `Sign in with <provider>` links to the OAuth2 redirect flow: the adapter's start route sends the browser to the provider, and its callback signs the user in and returns to `/`. The providers are the users collection's, so the link appears only when iglo.base has one configured.
- `/protected` checks the session with iglo.base on every request, then redirects to `/login`.
- `/live` subscribes to the `ssr_live` collection with a browser client and lists the ids of the
  records that arrive.
- `/api/me` returns the signed-in user as JSON, or 401.
- `POST /session/login` and `POST /logout` change the session. The adapter answers
  `/api/pb/renew`, `/api/pb/popup` and the OAuth2 routes itself.

The request hook is `proxy.ts` (Next.js 16). A proxy runs on the Node.js runtime, which the
adapter requires: the Edge runtime is not supported. On Next.js 15.5 the same code is a
`middleware.ts` that exports `runtime = "nodejs"`.

## Run it

The app talks to a running iglo.base (or PocketBase v0.41.0) at `PB_URL`.

```sh
bun install
bun run build
PORT=3000 HOST=127.0.0.1 APP_ORIGIN=http://127.0.0.1:3000 \
  PB_URL=http://127.0.0.1:8090 \
  PB_SUPERUSER_EMAIL=... PB_SUPERUSER_PASSWORD=... \
  bun run start
```

Variables:

- `PB_URL`: iglo.base's URL as the app server reaches it (required).
- `PB_PUBLIC_URL`: the URL the browser uses for realtime (default `PB_URL`).
- `PB_SUPERUSER_EMAIL` and `PB_SUPERUSER_PASSWORD`: a superuser that mints the browser tokens
  (required unless `PB_READABLE_COOKIE=1`).
- `PB_READABLE_COOKIE=1`: the fallback without superuser credentials. The session cookie is then
  readable by page scripts, which is weaker against XSS. Set it instead of the superuser variables.
- `APP_ORIGIN`: the app's public origin, such as `https://app.example.com` (sets the cookie's
  security and the OAuth2 callback URL).
- `PORT` and `HOST`: where `bun run start` listens (default `3000` and `127.0.0.1`).

The fallback, with no superuser variables:

```sh
PB_READABLE_COOKIE=1 PB_URL=http://127.0.0.1:8090 APP_ORIGIN=http://127.0.0.1:3000 bun run start
```

The credentials used by the end-to-end tests are test-only fixtures. Do not use them anywhere
else, and never put real credentials in this directory.
