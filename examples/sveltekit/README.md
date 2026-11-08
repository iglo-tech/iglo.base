# iglo.base SvelteKit example

The step-by-step guide for this app is the [SvelteKit section of the SSR guide](../../docs/ssr.md#sveltekit).

A SvelteKit 2 app that uses iglo.base's server-side rendering support through the adapter
`iglo.base/ssr/sveltekit` (`docs/design/13-ssr.md`, "Framework adapters"). It shows:

- a session cookie that the `handle` hook resumes and refreshes on every request (`/`);
- sign-in and sign-out with `locals.pb` (`/login`, `POST /session/login`, `POST /logout`);
- a session check with iglo.base on every request (`/api/me`, `/protected`);
- the OAuth2 redirect flow: `/login` links to `Sign in with <provider>` for each provider the
  users collection has, and the adapter's callback signs the user in and returns to `/`;
- a browser client for realtime updates, started from a short-lived token (`/live`).

The adapter answers `/api/pb/renew`, `/api/pb/popup` and the OAuth2 routes itself. The app
does not define them.

## Run it

Requires Bun 1.4 or newer and Node.js (the production server runs `node build`). The app uses
the SDK in `../../sdk`, which must be built first: `bun run sdk:build` from the repository root.

```sh
bun install
bun run build
PORT=3000 ORIGIN=http://localhost:3000 APP_ORIGIN=http://localhost:3000 \
  PB_URL=http://127.0.0.1:8090 \
  PB_SUPERUSER_EMAIL=test@example.com PB_SUPERUSER_PASSWORD=1234567890 \
  bun run start
```

Environment variables:

| Variable | Meaning |
|---|---|
| `PB_URL` | iglo.base's URL as the app server reaches it. Required. |
| `PB_PUBLIC_URL` | iglo.base's URL as the browser reaches it. Default `PB_URL`. |
| `PB_SUPERUSER_EMAIL`, `PB_SUPERUSER_PASSWORD` | A superuser that mints browser tokens. Required unless `PB_READABLE_COOKIE=1`. |
| `PB_READABLE_COOKIE` | `1` selects the fallback without superuser credentials. The session cookie is then readable by page scripts, and no superuser client is created. |
| `APP_ORIGIN` | The app's public origin, such as `https://app.example.com`. Required. |
| `PORT`, `HOST`, `ORIGIN` | Read by `adapter-node` (`ORIGIN` is the public origin, the same as `APP_ORIGIN`). |

OAuth2 callbacks: the redirect flow this example uses needs `<APP_ORIGIN>/api/pb/oauth2/callback` registered with each provider. A provider that returns by POST (Sign in with Apple) uses the popup flow instead, which registers `<PB_PUBLIC_URL>/api/oauth2-redirect` with the provider. The example does not show the popup flow; the guide does.

For the fallback, run it without the superuser variables:

```sh
PB_READABLE_COOKIE=1 PB_URL=http://127.0.0.1:8090 APP_ORIGIN=http://localhost:3000 \
  ORIGIN=http://localhost:3000 PORT=3000 bun run start
```

## Pages and routes

| Route | What it does |
|---|---|
| `GET /` | `signed in as <email>` or `signed out` |
| `GET /login` | The sign-in form, and a `Sign in with <provider>` link per OAuth2 provider. `?error=1` shows `wrong email or password`. |
| `POST /session/login` | Signs in with `authWithPassword`; 303 to `/` or `/login?error=1` |
| `POST /logout` | Clears the session; 303 to `/` |
| `GET /api/me` | `{ id, email }` for a valid session, otherwise 401 `{}` |
| `GET /protected` | Checks the session with iglo.base every time; redirects to `/login` if it is not valid |
| `GET /live` | Realtime events of the `ssr_live` collection, in the browser |

## Credentials

The only credentials in this example are the test ones used by `test/examples`
(`test@example.com` / `1234567890`), against a local test instance. Do not use real credentials
in this example or commit them to the repository.

## Files

- `src/hooks.server.ts`: the adapter's `handle` hook, for every request.
- `src/lib/server/auth.ts`: creates the adapter once per process, with the superuser client
  (unless `PB_READABLE_COOKIE=1`).
- `src/app.d.ts`: `App.Locals` extends `SvelteKitLocals`.
