# Server-side rendering with iglo.base

This guide shows how to render pages on your server and sign users in with iglo.base. It covers the server part of the SDK, `@iglo.tech/iglo.base/ssr`, the browser part, `@iglo.tech/iglo.base/ssr/browser`, and one section per framework. The server's API is the same as PocketBase v0.41.0's, so SSR needs no change on the server.

The SDK does the parts that are easy to get wrong: a client for each request, the session cookie, session checks, the browser token for realtime, and the cache and CSRF headers. Your app still decides its routes, its pages, what a user may see, and where users go after sign-in. Each section below says which is which.

If you are moving from PocketBase, start with [the problems PocketBase lists](#the-problems-pocketbase-lists).

## The problems PocketBase lists

PocketBase's [how-to guide](https://pocketbase.io/docs/how-to-use/#why-not-js-ssr) lists four problems with JS SSR. This table shows what the SDK does for each one, and what your app still has to do.

| PocketBase's warning | What the SDK does | What your app still has to do |
|---|---|---|
| Security issues from an incorrectly initialized and shared SDK instance in a long-running server process | A new server client for each request, resumed from that request's cookie. It is never shared, and it is never reused across requests. Every request is sent with `cache: "no-store"`. The only long-lived client is the superuser client, which mints browser tokens and never answers a user's request. | Create a server client in each request, never as a module-level `pb` that serves users. Keep superuser credentials on the server. Do not use the superuser client for a user's data calls. |
| OAuth2 is hard to do server-side, or mixes client-side handling with a shared cookie | The redirect flow runs on the server (`startOAuth2`, `completeOAuth2`). It checks `state` and PKCE, and keeps its temporary state in a 10-minute cookie. Providers that return by POST, such as Sign in with Apple, use a popup flow that hands the token to the server, which then sets the session cookie. | Register each provider's redirect URL for the flow you use: the app's callback for the redirect flow, and iglo.base's `/api/oauth2-redirect` for the popup flow (see [OAuth2 providers](#oauth2-providers)). Choose the popup flow for providers that return by POST. Decide where users go after sign-in (`redirectTo`). Set the public `origin` when the app runs behind a proxy. |
| Proxying realtime connections duplicates what PocketBase already does | The server mints a short-lived browser token for each page with `impersonate` (15 minutes by default). The browser connects to iglo.base directly and renews the token through your app's renew route. The long-lived session never reaches page JavaScript, and your server does not proxy realtime. | Give the browser client the public URL of iglo.base. Make sure the browser may reach it (see `--origins` in the [operations guide](operations.md#flags)). Pass the token, the record and `serverTime` from the page. |
| Performance problems from a single Node.js process and many calls between the browser, Node.js and PocketBase | Sessions that were checked recently need no request to iglo.base: a per-process session cache (5 minutes by default) skips the check, and parallel refreshes of one session share a single request. Realtime does not pass through the app server. | Size the session cache for your traffic (see [the session cache](#the-session-cache)). Keep the number of data calls per page low. The SDK does not cache data, and the app server still runs Node.js. Cache public pages where it is safe, and never cache a user's page (see [caching and CDNs](#caching-and-cdns)). |

## The model

- **A client per request.** `createServerClient` builds a client for one request, from the session cookie. Its auth store is that request's only. Nothing from one user reaches another user's request.
- **One superuser client per process.** `createSuperuserClient` holds a superuser session in memory. It mints browser tokens (`impersonate`) and refreshes itself before it expires. It serves no user request.
- **The session cookie.** One cookie, `pb_auth` (or `__Host-pb_auth` on https), holds the user's token and record. It is `HttpOnly` and `SameSite=Lax`, and it lasts as long as the token does.
- **The session cache.** One cache per process, from `createSessionCache`. A session checked within its TTL (5 minutes by default) and with at least half its lifetime left needs no request to iglo.base. The trade-off: a session that iglo.base has revoked can still show as signed in until the TTL ends. Data calls are not affected, because iglo.base rejects the revoked token on each call.
- **The browser token.** A page gets a short token, not the session. It is minted per page at render, is not refreshable, and lasts 15 minutes by default (`browserTokenDuration`). The browser client renews it through the renew route while the page is open. Realtime uses it.

## Install and setup

Install the SDK in your app:

```sh
npm install @iglo.tech/iglo.base
```

The package is ES modules only. It has the main entry (`@iglo.tech/iglo.base`, the client), `@iglo.tech/iglo.base/ssr` (server only), `@iglo.tech/iglo.base/ssr/browser` (safe for the browser) and one entry per framework (`@iglo.tech/iglo.base/ssr/next`, `/sveltekit`, `/nuxt`, `/astro`, `/react-router`).

The SDK reads no environment variables. The example apps use these names, and you can use any others. Read the superuser credentials at run time, never at build time (see [security notes](#security-notes)):

| Variable | Use |
|---|---|
| `PB_URL` | iglo.base's URL as the app server reaches it |
| `PB_PUBLIC_URL` | iglo.base's URL as the browser reaches it, for realtime |
| `APP_ORIGIN` | your app's public origin, such as `https://app.example.com` |
| `PB_SUPERUSER_EMAIL`, `PB_SUPERUSER_PASSWORD` | the superuser that mints browser tokens |
| `PB_READABLE_COOKIE` | `1` selects the fallback without superuser credentials (see below) |

### Create the superuser credential

The app server needs a superuser to mint browser tokens. Create one on the server with the [`superuser` command](operations.md#superuser):

```sh
./iglo-base superuser upsert admin@example.com 'a long password'
```

Then choose one of these:

1. **Email and password.** Simple. The client signs in at start and signs in again with the password if a refresh is refused.

   ```js
   import { createSessionCache, createSuperuserClient } from "@iglo.tech/iglo.base/ssr";

   const superuser = await createSuperuserClient({
     url: process.env.PB_URL,
     email: process.env.PB_SUPERUSER_EMAIL,
     password: process.env.PB_SUPERUSER_PASSWORD,
   });
   const sessionCache = createSessionCache();
   ```

2. **An API key.** Sign in once as the superuser, mint a token with `impersonate` for the duration you choose, and store it as a secret. The client uses the token as it is. It cannot refresh it, so when it expires its requests fail until you replace it. Changing the superuser's password or `tokenKey` revokes it.

   ```js
   import PocketBase from "@iglo.tech/iglo.base";

   const admin = new PocketBase(process.env.PB_URL);
   await admin
     .collection("_superusers")
     .authWithPassword(process.env.PB_SUPERUSER_EMAIL, process.env.PB_SUPERUSER_PASSWORD);
   const apiKey = await admin
     .collection("_superusers")
     .impersonate(admin.authStore.record.id, 30 * 24 * 60 * 60);
   // store apiKey.authStore.token as a secret, outside the repository
   ```

   Then create the client with `createSuperuserClient({ url: process.env.PB_URL, token: process.env.PB_SUPERUSER_TOKEN })`.

Superusers may act only from the IP addresses in the [superuser IP list](operations.md#superuser). The app server's address must be on that list, or the superuser's calls are refused with 403. Behind a proxy, check the client IP setting first.

### Without superuser credentials

Pass `readableCookie: true` instead of a superuser client, and the adapters answer from the session itself. This works, but it is weaker against XSS. The session cookie is then readable by page scripts, so any script on the page can read the session token for as long as the session lasts. Use it only when you cannot keep a superuser credential on the server. Without a superuser and without `readableCookie: true`, the adapters throw a `TypeError` when they are created.

### The session cache

Create one cache per process with `createSessionCache({ ttl, maxEntries })`, and pass it as `sessionCache`. Both options are optional:

| Option | Meaning | Default |
|---|---|---|
| `ttl` | how long a session that was checked with iglo.base is trusted without another check, **in milliseconds** | `300000` (5 minutes) |
| `maxEntries` | how many sessions the cache holds. When it is full, the least recently used session is dropped | `10000` |

```js
import { createSessionCache } from "@iglo.tech/iglo.base/ssr";

const sessionCache = createSessionCache({ ttl: 60 * 1000, maxEntries: 50_000 }); // 1 minute
```

`ttl` counts milliseconds, so `ttl: 60` is 60 milliseconds, not a minute. A `ttl` of `0` turns the skip off, so every request checks its session with iglo.base. A cached session is skipped only while at least half its token lifetime is left, so a session close to expiry is checked anyway.

Size `maxEntries` to about the number of distinct signed-in users that one process sees within one `ttl`. The cache keeps one entry per session: a hash of the token and the user's record. A session that was dropped is checked again on its next request, so a small `maxEntries` costs checks, not correctness. Each process has its own cache, so with several processes each cache sees only the requests routed to it. Choose `ttl` by the trade-off below, not by traffic.

**The trade-off is revocation.** A session served from the cache can still count as signed in for up to `ttl` after iglo.base has revoked it, for example when the user is deleted or the user's password changes. A shorter `ttl` shrinks that window and makes more checks; a longer one saves checks and widens the window. Data calls are not affected, because iglo.base rejects a revoked token on each call. A page that must see a revocation at once calls `verify()`, which bypasses the cache (see "Protect a page" in your framework's section).

### The adapter options

Every framework adapter takes the same options. The app creates `sessionCache` and `superuser` once, when the process starts:

| Option | Meaning |
|---|---|
| `url` | iglo.base's URL as the app server reaches it |
| `sessionCache` | the cache from `createSessionCache()` (see [the session cache](#the-session-cache)) |
| `superuser` | the superuser client (required unless `readableCookie: true`) |
| `origin` | your app's public origin. It sets the cookie's security and the OAuth2 callback URL. Default: the request's origin |
| `secure` | forces the cookie's security (`Secure` and the `__Host-` prefix) |
| `cookieName` | the session cookie's base name (default `pb_auth`) |
| `cookieOptions` | other cookie options (see [security notes](#security-notes) for limits) |
| `readableCookie` | the fallback above |
| `csrf` | `false` turns the CSRF guard off; `{ allowedOrigins }` lists other origins that may send changing requests |
| `browserTokenDuration` | lifetime of browser tokens in seconds (default 900) |
| `routes` | paths of the adapter's routes; a route set to `false` is not mounted |
| `lang`, `clock`, `fetch` | the usual SDK options, for tests and for a custom `fetch` |

The default routes are `POST /api/pb/renew` (browser token renewal), `POST /api/pb/popup` (popup hand-off), `GET /api/pb/oauth2/start/{provider}` and `GET /api/pb/oauth2/callback`.

## OAuth2 providers

A provider sign-in has two flows. Each returns to a different URL, so register the URL for each flow your app uses with the provider:

| Flow | Use it for | Register with the provider |
|---|---|---|
| Redirect flow | Providers that return by `GET`, such as Google and GitHub | `<APP_ORIGIN>/api/pb/oauth2/callback`, the app's callback URL |
| Popup flow | Providers that return by `POST`, such as Sign in with Apple | `<PB_PUBLIC_URL>/api/oauth2-redirect`, iglo.base's own URL |

Two things to get right:

- **The popup flow registers iglo.base's URL, not your app's.** The provider returns to iglo.base, which completes the sign-in and hands the token to the app. `PB_PUBLIC_URL` is the URL the browser reaches. The browser client builds the redirect URL from its `url` option, so pass the public URL there too. The browser must reach iglo.base, because the popup navigates there.
- **The URL must match exactly.** Register it as shown, with the same scheme and no trailing slash. The redirect flow's callback URL is built from the `origin` option (or `APP_ORIGIN`), so set that to your public origin, especially behind a proxy.

In the redirect flow the server does the work. The start route (`/api/pb/oauth2/start/{provider}?redirectTo=`) sends the browser to the provider, and the callback signs the user in and returns to `redirectTo`. The start route refuses providers that return by POST, with `unsupported-provider`.

In the popup flow the browser does the work. `authWithOAuth2()` opens the provider in a popup, and `handOff()` posts the popup token to the app's popup route (`/api/pb/popup`), which sets the session cookie. Call `authWithOAuth2()` before any `await` in the click handler, so the browser allows the popup.

Each framework section below shows its own routes.

## Next.js

### Wire the adapter

Next.js 16 runs `proxy.ts` on the Node.js runtime, which the adapter needs. The Edge runtime is not supported. Create the adapter once per server process, on first use, in one module. The session cache and the superuser client belong to it, so never create them per request. The example's [`lib/auth.ts`](https://github.com/iglo-tech/iglo.base/tree/main/examples/nextjs/lib/auth.ts) is the pattern. Its `create()` ends with:

```ts
return createNextAuth({
  url,
  sessionCache: createSessionCache(),
  superuser, // from createSuperuserClient(), or undefined with readableCookie
  readableCookie,
  origin: process.env.APP_ORIGIN,
  next: (init) => NextResponse.next(init), // the SDK does not import next/server
});
```

The request hook is [`proxy.ts`](https://github.com/iglo-tech/iglo.base/tree/main/examples/nextjs/proxy.ts). It runs the adapter's middleware on every matched request, including its own routes.

```ts
import type { NextRequest } from "next/server";
import { getAuth } from "@/lib/auth";

export async function proxy(request: NextRequest) {
  return (await getAuth()).middleware(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

On Next.js 15.5, put the same code in `middleware.ts`, export it as `middleware`, and add `export const runtime = "nodejs";`. Without that line, Next.js 15.5 uses the Edge runtime.

### Sign in and sign out

`currentSession()` in `lib/auth.ts` gives a Route Handler or Server Action the session of its request. It returns `server` (this request's server client) and `browserToken`. A Route Handler that signs in writes the session cookie through the adapter when the sign-in succeeds. The route then returns its own response, which must carry `SSR_NO_CACHE_HEADERS`. From the example's [`app/session/login/route.ts`](https://github.com/iglo-tech/iglo.base/tree/main/examples/nextjs/app/session/login/route.ts), abridged:

```ts
export async function POST(request: Request) {
  const form = await request.formData();
  const { server } = await currentSession();
  // error handling as in the example; the adapter writes the cookie when the sign-in succeeds
  await server.collection("users").authWithPassword(String(form.get("email")), String(form.get("password")));
  return new Response(null, { status: 303, headers: { Location: "/", ...SSR_NO_CACHE_HEADERS } });
}
```

Sign-out works the same way: [`app/logout/route.ts`](https://github.com/iglo-tech/iglo.base/tree/main/examples/nextjs/app/logout/route.ts) calls `server.authStore.clear()` and returns `303` with `SSR_NO_CACHE_HEADERS`. A Server Action needs nothing else from the adapter: Next.js sets `Cache-Control: no-cache, no-store, max-age=0, must-revalidate` on every Server Action response. The example has no Server Action, so the sample below is not tested against it. Test it in your app.

```ts
// app/login/actions.ts
"use server";

import { redirect } from "next/navigation";
import { ClientResponseError } from "@iglo.tech/iglo.base";
import { currentSession } from "@/lib/auth";
export async function signIn(formData: FormData) {
  const { server } = await currentSession();
  try {
    await server.collection("users").authWithPassword(
      String(formData.get("email") ?? ""),
      String(formData.get("password") ?? ""),
    );
  } catch (err: unknown) {
    if (err instanceof ClientResponseError) {
      redirect("/login?error=1");
    }
    throw err;
  }
  redirect("/");
}
```

### Read the user on a page

A Server Component calls `currentSession()` and reads `server.authStore`, as [`app/page.tsx`](https://github.com/iglo-tech/iglo.base/tree/main/examples/nextjs/app/page.tsx) does. A Server Component cannot set cookies, so a refresh made there updates memory only. The proxy has already written the refreshed cookies into the request the page receives, so the page reads the current session. Do not call `cookies().set` yourself. Reading `authStore` can use the session cache and not ask iglo.base (see [the model](#the-model)).

### Protect a page

For a page that must check the session on every request, call `server.auth.verify()`. It asks iglo.base and throws when the session is not valid. The proxy does not redirect; the page does. See [`app/protected/page.tsx`](https://github.com/iglo-tech/iglo.base/tree/main/examples/nextjs/app/protected/page.tsx). 

### OAuth2 sign-in

The proxy answers the adapter's OAuth2 routes, so you write no route for the redirect flow. `GET /api/pb/oauth2/start/{provider}?redirectTo=/` sends the browser to the provider, and `GET /api/pb/oauth2/callback` signs the user in and redirects to `redirectTo`. Register `<APP_ORIGIN>/api/pb/oauth2/callback` with the provider, and set `APP_ORIGIN`. Without it the callback URL uses the request's origin, which can be an internal address behind a proxy. The example's [`app/login/page.tsx`](https://github.com/iglo-tech/iglo.base/tree/main/examples/nextjs/app/login/page.tsx) links each provider of the `users` collection to the start route. A failed callback adds `oauth2_error=<kind>` to `redirectTo`; the example does not read it.

Providers that return by POST, such as Sign in with Apple, cannot use the redirect flow. The start route answers `400` (`unsupported-provider`) for them. Use the popup flow instead, and register `<PB_PUBLIC_URL>/api/oauth2-redirect` with the provider for it, not the callback above (see [OAuth2 providers](#oauth2-providers)). The example app has no popup page, so this client component is the pattern. Call `authWithOAuth2` before any `await` in the click handler, so the browser allows the popup it opens:

```tsx
"use client";

import { createBrowserClient } from "@iglo.tech/iglo.base/ssr/browser";

export function PopupSignIn({ url, provider }: { url: string; provider: string }) {
  async function signIn() {
    const pb = createBrowserClient({ url, renewUrl: "/api/pb/renew", handOffUrl: "/api/pb/popup" });
    try {
      await pb.collection("users").authWithOAuth2({ provider });
      await pb.handOff(); // posts the popup token; /api/pb/popup sets the session cookie
      window.location.assign("/");
    } finally {
      pb.dispose();
    }
  }
  return <button type="button" onClick={signIn}>Sign in with {provider}</button>;
}
```

### Browser client and realtime

The live page mints a short browser token on the server, so the session token never reaches the browser. In Next.js the minting function is `browserToken` on the `currentSession()` result (SvelteKit, Nuxt and Astro name it `pbBrowserToken`). [`app/live/page.tsx`](https://github.com/iglo-tech/iglo.base/tree/main/examples/nextjs/app/live/page.tsx) passes it to a client component:

```tsx
const { browserToken } = await currentSession();
const session = await browserToken(); // null when nobody is signed in
// ...
<LiveClient token={session.token} record={session.record} serverTime={session.serverTime}
  url={process.env.PB_PUBLIC_URL ?? process.env.PB_URL ?? ""} renewUrl="/api/pb/renew" />
```

[`app/live/live-client.tsx`](https://github.com/iglo-tech/iglo.base/tree/main/examples/nextjs/app/live/live-client.tsx) is a `"use client"` component. It creates the browser client and subscribes with the SDK's usual calls. Import `@iglo.tech/iglo.base/ssr/browser` in client components, never `@iglo.tech/iglo.base/ssr`. Clean up with `pb.realtime.unsubscribe()` and `pb.dispose()`:

```tsx
import { createBrowserClient } from "@iglo.tech/iglo.base/ssr/browser";
const pb = createBrowserClient({ url, token, record, serverTime, renewUrl });
await pb.collection("ssr_live").subscribe("*", (e) => {
  // e.record is the new record
});
```

The browser renews the token through `/api/pb/renew`, which the proxy answers.

### CSRF

The proxy runs the adapter's CSRF check before the routes and pages. It answers `403` to a `POST`, `PUT`, `PATCH` or `DELETE` that carries the session cookie and an `Origin` that is neither the request's own origin nor allowed. Because the proxy matcher reaches them, this covers Route Handlers such as `/session/login`.

- `csrf: { allowedOrigins: ["https://www.example.com"] }` lists other origins that may send such requests. `csrf: false` turns the check off; do not do that without another guard.
- `origin` is the public origin. The adapter allows it too, so behind a proxy that changes the origin, set `origin` and list only the other origins.

Next.js checks the origin of Server Actions itself. See [security notes](#security-notes).

### Notes for Next.js

- **Runtime.** Observed with Next.js 16.4.5: a `middleware.ts` without `runtime = "nodejs"` reaches the Edge build and the package's browser stub. Turbopack (the default) then fails `next build` with `Export createNextAuth doesn't exist in target module`. webpack (`next build --webpack`) builds with warnings, and every request answers `500` with `@iglo.tech/iglo.base/ssr is server-only`. See [troubleshooting](#troubleshooting).
- **Dynamic pages.** A page that reads the session is rendered dynamically, and Next.js sends `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`. Server Components have no response of their own to mark.
- **Your Route Handlers.** A Route Handler that returns user data sends `SSR_NO_CACHE_HEADERS`, as the example's `/api/me` does: `Response.json({ id, email }, { headers: SSR_NO_CACHE_HEADERS })`.


## SvelteKit

### Wire the adapter

Create the adapter once per process, in `src/lib/server/auth.ts` ([example](https://github.com/iglo-tech/iglo.base/tree/main/examples/sveltekit/src/lib/server/auth.ts)). The session cache and the superuser client are shared by every request. The example creates them on the first request and retries if that fails:

```ts
import { env } from "$env/dynamic/private";
import { createSessionCache, createSuperuserClient } from "@iglo.tech/iglo.base/ssr";
import { createSvelteKitAuth, type SvelteKitAuth } from "@iglo.tech/iglo.base/ssr/sveltekit";

let auth: Promise<SvelteKitAuth> | undefined;

export function getAuth(): Promise<SvelteKitAuth> {
  auth ??= create().catch((err: unknown) => {
    auth = undefined;
    throw err;
  });
  return auth;
}

async function create(): Promise<SvelteKitAuth> {
  const url = env.PB_URL!;
  const superuser = await createSuperuserClient({
    url,
    email: env.PB_SUPERUSER_EMAIL!,
    password: env.PB_SUPERUSER_PASSWORD!,
  });
  return createSvelteKitAuth({
    url,
    sessionCache: createSessionCache(),
    superuser,
    origin: env.APP_ORIGIN!,
  });
}
```

Without superuser credentials, leave out `superuser` and pass `readableCookie: true`, as the example does with `PB_READABLE_COOKIE=1`. The session cookie is then readable by page scripts, which is weaker against XSS (see [security notes](#security-notes)).

Call the adapter from `src/hooks.server.ts` ([example](https://github.com/iglo-tech/iglo.base/tree/main/examples/sveltekit/src/hooks.server.ts)). The hook runs for every request and answers the adapter's own `/api/pb/*` routes, so the app defines none of them:

```ts
import type { Handle } from "@sveltejs/kit";
import { getAuth } from "$lib/server/auth";

export const handle: Handle = async ({ event, resolve }) => {
  const auth = await getAuth();
  return auth.handle({ event, resolve });
};
```

The hook sets `event.locals.pb` (this request's server client) and `event.locals.pbBrowserToken` (mints the page's browser token). Type them in `src/app.d.ts` with `interface Locals extends SvelteKitLocals {}`, where `SvelteKitLocals` is exported by `@iglo.tech/iglo.base/ssr/sveltekit` ([example](https://github.com/iglo-tech/iglo.base/tree/main/examples/sveltekit/src/app.d.ts)).

### Sign in and sign out

Sign-in is an HTML form that posts to a `+server.ts` route. The route calls `authWithPassword` on `locals.pb`. The adapter writes the session cookie through `event.cookies.set`. The example is `src/routes/session/login/+server.ts` ([source](https://github.com/iglo-tech/iglo.base/tree/main/examples/sveltekit/src/routes/session/login/+server.ts)):

```ts
import { redirect } from "@sveltejs/kit";
import { ClientResponseError } from "@iglo.tech/iglo.base";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
  const form = await request.formData();
  try {
    await locals.pb.collection("users").authWithPassword(String(form.get("email")), String(form.get("password")));
  } catch (err) {
    if (err instanceof ClientResponseError) {
      redirect(303, "/login?error=1");
    }
    throw err;
  }
  redirect(303, "/");
};
```

Sign-out calls `locals.pb.authStore.clear()`, and the adapter writes the cookie removal the same way (`src/routes/logout/+server.ts`).

### Read the user on a page

`locals.pb.authStore` holds the session that the hook resumed. The hook checks the session through the session cache, so a recently checked session needs no request to iglo.base. Use the store for display, and use `verify()` below when the check must be live. The example's `src/routes/api/me/+server.ts` shows a JSON endpoint built on `verify()`.

### Protect a page

Call `locals.pb.auth.verify()` in `+page.server.ts`. It checks the session with iglo.base every time, bypassing the cache, and throws when the session is not valid. Catch that and redirect ([example](https://github.com/iglo-tech/iglo.base/tree/main/examples/sveltekit/src/routes/protected/+page.server.ts)):

```ts
export const load: PageServerLoad = async ({ locals }) => {
  const user = await locals.pb.auth.verify().catch(() => null);
  if (!user) {
    redirect(303, "/login");
  }
  return { email: user.email };
};
```

### OAuth2 sign-in

The adapter answers the redirect flow on its default routes: `GET /api/pb/oauth2/start/{provider}?redirectTo=` starts it, and `GET /api/pb/oauth2/callback` completes it. The callback URL is `APP_ORIGIN` plus `/api/pb/oauth2/callback`, so register that exact URL with each provider. The login page lists the `users` providers in `src/routes/login/+page.server.ts` and links each one to the start route in `+page.svelte` ([example](https://github.com/iglo-tech/iglo.base/tree/main/examples/sveltekit/src/routes/login/+page.svelte)):

```svelte
{#each data.providers as provider (provider.name)}
  <a href="/api/pb/oauth2/start/{encodeURIComponent(provider.name)}">Sign in with {provider.displayName}</a>
{/each}
```

A failed flow redirects to `redirectTo` (default `/`) with `oauth2_error=<kind>` added. Providers that return by POST (Apple, for example) need the popup flow, which the example does not show. For that flow, register `<PB_PUBLIC_URL>/api/oauth2-redirect` with the provider, not the callback above (see [OAuth2 providers](#oauth2-providers)).

### Browser client and realtime

`src/routes/live/+page.server.ts` returns the URL that the browser reaches iglo.base at (`PB_PUBLIC_URL`, else `PB_URL`) and `browser: await locals.pbBrowserToken()`, which is `null` when nobody is signed in ([example](https://github.com/iglo-tech/iglo.base/tree/main/examples/sveltekit/src/routes/live/+page.server.ts)). `src/routes/live/+page.svelte` starts the client in `onMount` ([example](https://github.com/iglo-tech/iglo.base/tree/main/examples/sveltekit/src/routes/live/+page.svelte)). It imports `createBrowserClient` from `@iglo.tech/iglo.base/ssr/browser`, the only iglo.base entry a `.svelte` file may import:

```ts
import { createBrowserClient } from "@iglo.tech/iglo.base/ssr/browser";

const pb = createBrowserClient({
  url: data.url,
  token: data.browser.token,
  record: data.browser.record,
  serverTime: data.browser.serverTime,
  renewUrl: "/api/pb/renew",
});
pb.collection("ssr_live").subscribe("*", (e) => {
  ids = [...ids, e.record.id];
});
```

The client renews the token through `renewUrl`. Add `handOffUrl: "/api/pb/popup"` for popup sign-in. Call `pb.dispose()` in the `onMount` cleanup.

### CSRF

The hook checks the `Origin` header before your routes run. It applies to `POST`, `PUT`, `PATCH` and `DELETE` requests that carry the session cookie. Such a request gets 403 unless its origin is the request's own, the `origin` option, or one of `csrf.allowedOrigins`. A sign-in form has no session cookie yet, so it passes. Set `csrf: { allowedOrigins: [...] }` only if the app is served under a second origin.

### Notes for SvelteKit

- **Production server and origin.** The example uses `adapter-node`: build with `bun run build`, then run `node build`. `adapter-node` reads `PORT`, `HOST` and `ORIGIN`. Set `APP_ORIGIN` to the same public origin as `ORIGIN`, and pass it as the `origin` option. The adapter uses it for the cookie's `Secure` flag and `__Host-` prefix, the OAuth2 callback URL and the CSRF check. Behind a proxy the request's own URL can name another origin, so do not rely on it.
- **Response headers.** The adapter sets the no-cache headers on the response that `resolve` returns, after your route has run. That covers pages, `+server.ts` routes, form actions and redirects, when the request carries a session cookie, writes a cookie or mints a browser token. A response that your code builds without going through `resolve` gets no headers from the adapter, so add `SSR_NO_CACHE_HEADERS` (exported by `@iglo.tech/iglo.base/ssr`) to it yourself. Prerendered pages are served to everyone, so never put user data in them.
- **Browser code.** Do not import `@iglo.tech/iglo.base/ssr` in `.svelte` files or any module the browser loads. Keep it in `src/lib/server/`, `hooks.server.ts`, `+page.server.ts` and `+server.ts`. SvelteKit refuses to bundle `$lib/server/` into client code. The type import in `src/app.d.ts` is erased at build time.


## Nuxt

### Wire the adapter

Nuxt runs the adapter as a Nitro server middleware. Create it once per server process, as a lazy promise (as in `examples/nextjs/lib/auth.ts`, which retries a failed creation). Set `origin` to your public origin; without it, the origin comes from `Host` and `x-forwarded-proto`. Use `readableCookie: true` only without superuser credentials.

The URLs and credentials are Nuxt runtime config, so they are read at run time, and `NUXT_*` environment variables override the defaults. Declare them in `nuxt.config.ts`. Nuxt parses each `NUXT_*` value as JSON when it can, so `NUXT_PB_SUPERUSER_PASSWORD=1234567890` reaches the code as a number, not a string; the sample converts the values with `String()`, and do the same for any setting that may look like a number, `true` or `null`:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  runtimeConfig: {
    // server only: NUXT_PB_URL, NUXT_PB_SUPERUSER_EMAIL, NUXT_PB_SUPERUSER_PASSWORD, NUXT_APP_ORIGIN
    pbUrl: "",
    pbSuperuserEmail: "",
    pbSuperuserPassword: "",
    appOrigin: "",
    public: {
      // the URL the browser reaches iglo.base at: NUXT_PUBLIC_PB_URL
      pbUrl: "",
    },
  },
});
```

`server/utils/auth.ts`:

```ts
import { createSessionCache, createSuperuserClient } from "@iglo.tech/iglo.base/ssr";
import { createNuxtAuth, type NuxtAuth } from "@iglo.tech/iglo.base/ssr/nuxt";

let authPromise: Promise<NuxtAuth> | undefined;

export function getAuth(): Promise<NuxtAuth> {
  authPromise ??= (async () => {
    const config = useRuntimeConfig();
    // Nuxt reads NUXT_* values as JSON-like, so a numeric password arrives as a number: String() it
    const superuser = await createSuperuserClient({
      url: config.pbUrl,
      email: String(config.pbSuperuserEmail),
      password: String(config.pbSuperuserPassword),
    });
    return createNuxtAuth({
      url: config.pbUrl,
      sessionCache: createSessionCache(),
      superuser,
      origin: config.appOrigin || undefined,
    });
  })().catch((err: unknown) => {
    authPromise = undefined;
    throw err;
  });
  return authPromise;
}
```

The middleware maps h3's event onto the adapter's structural event. An answer (an OAuth2 route, the popup route, or the CSRF 403) goes out with `sendWebResponse`, which keeps `Set-Cookie`.

`server/middleware/auth.ts`:

```ts
import { defineEventHandler, getMethod, readBody, sendWebResponse, setCookie, setResponseHeader } from "h3";

import { getAuth } from "../utils/auth";

export default defineEventHandler(async (event) => {
  const answer = await (await getAuth()).middleware({
    method: getMethod(event),
    path: event.path,
    headers: event.node.req.headers,
    context: event.context,
    readBody: () => readBody(event),
    setCookie: (name, value, options) => setCookie(event, name, value, options),
    setHeader: (name, value) => setResponseHeader(event, name, value),
  });
  if (answer) {
    await sendWebResponse(event, answer);
  }
});
```

The middleware sets `event.context.pb` (the `ServerClient`) and `event.context.pbBrowserToken` (a function) on every request. Cast them, since Nitro types `event.context` loosely.

### Sign in and sign out

`server/api/session/login.post.ts`:

```ts
import { defineEventHandler, readBody, sendRedirect } from "h3";
import { ClientResponseError } from "@iglo.tech/iglo.base";
import type { ServerClient } from "@iglo.tech/iglo.base/ssr";

export default defineEventHandler(async (event) => {
  const pb = event.context.pb as ServerClient;
  const { email, password } = await readBody<{ email: string; password: string }>(event);
  try {
    await pb.collection("users").authWithPassword(email, password); // writes the cookie
  } catch (err: unknown) {
    if (!(err instanceof ClientResponseError)) {
      throw err;
    }
    return sendRedirect(event, "/login?error=1", 303);
  }
  return sendRedirect(event, "/", 303);
});
```

The adapter writes the session cookie when the auth store on `event.context.pb` changes, so a route only calls the store. For sign-out, call `(event.context.pb as ServerClient).authStore.clear()`. Use `POST` for both routes, so the CSRF guard checks them.

### Read the user on a page

In an API route, `event.context.pb.authStore` holds the session: `record` is the user, `isValid` says whether it is valid. A page gets its browser token from a server route, not from the server render. A `<NuxtLink>` navigation runs the page in the browser, where `import.meta.server` is false, so a token minted only during the server render is missing on that navigation. The route is called on the server render and on client navigation alike.

`server/api/account/session.get.ts`:

```ts
import { defineEventHandler } from "h3";

export default defineEventHandler(async (event) => {
  const mint = event.context.pbBrowserToken as () => Promise<unknown>;
  // { session } is { session: { token, record, expiresAt, serverTime } } or { session: null }: h3 sends a bare null as an empty body
  return { session: await mint() };
});
```

`pages/account.vue`:

```vue
<script setup lang="ts">
import { createBrowserClient, type CreateBrowserClientOptions } from "@iglo.tech/iglo.base/ssr/browser";

type Session = { token: string; record: NonNullable<CreateBrowserClientOptions["record"]>; serverTime: number };

definePageMeta({ middleware: "auth" }); // signed-out users go to /login (see "Protect a page")

// The same request runs during the server render and on a <NuxtLink> navigation, so the
// browser client always starts with a token.
const { data } = await useFetch<{ session: Session | null }>("/api/account/session", { key: "account-session" });
const session = computed(() => data.value?.session);

let pb: ReturnType<typeof createBrowserClient> | undefined;
onMounted(() => {
  pb = createBrowserClient({
    url: useRuntimeConfig().public.pbUrl,
    token: session.value?.token,
    record: session.value?.record,
    serverTime: session.value?.serverTime,
    renewUrl: "/api/pb/renew",
    handOffUrl: "/api/pb/popup",
  });
});
onBeforeUnmount(() => pb?.dispose());
</script>
```

### Protect a page

Protect a page with the route middleware `middleware/auth.ts`, and set `definePageMeta({ middleware: "auth" })` on the page. Nuxt runs the middleware on the server for the first page, and in the browser on each `<NuxtLink>` navigation. In the browser `event.context` does not exist, so the middleware asks a server route instead. `useRequestFetch()` forwards the cookie on the server, and it is a plain `$fetch` in the browser.

`middleware/auth.ts`:

```ts
export default defineNuxtRouteMiddleware(async () => {
  try {
    await useRequestFetch()("/api/account/me");
  } catch {
    return navigateTo("/login");
  }
});
```

`server/api/account/me.get.ts`:

```ts
import { createError, defineEventHandler } from "h3";
import type { ServerClient } from "@iglo.tech/iglo.base/ssr";

export default defineEventHandler(async (event) => {
  const pb = event.context.pb as ServerClient;
  try {
    return await pb.auth.verify(); // asks iglo.base now, bypassing the session cache
  } catch {
    throw createError({ statusCode: 401 });
  }
});
```

Check the session in every API route that needs a user as well: a page check does not protect the API. In such a route, call `verify()` in a `try` and throw `createError({ statusCode: 401 })` from h3 in the `catch`.

### OAuth2 sign-in

The default routes do the flow: link to `/api/pb/oauth2/start/{provider}?redirectTo=/account`, and register `https://<your origin>/api/pb/oauth2/callback` with the provider. A failed callback redirects to `redirectTo` with `oauth2_error=<kind>`. Your routes need no code. For providers that return by POST (Apple and others), sign in with a popup: in the browser, `pb.collection("users").authWithOAuth2({ provider: "apple" })`, then `await pb.handOff()`. The popup route reads the JSON body through the `readBody` mapping above. For that flow, register `<PB_PUBLIC_URL>/api/oauth2-redirect` with the provider (see [OAuth2 providers](#oauth2-providers)).

### Browser client and realtime

The browser client is created in `onMounted`, so it never runs on the server. Its URL is `runtimeConfig.public.pbUrl` from the config above, which `NUXT_PUBLIC_PB_URL` overrides. Realtime uses the usual `pb.collection("posts").subscribe(...)`. Call the unsubscribe function it returns, and `dispose()`, when the page is torn down.

### CSRF

The middleware checks `POST`, `PUT`, `PATCH` and `DELETE` requests that carry a session cookie. A request from another origin gets `403` before your route runs. To allow another origin, pass `csrf: { allowedOrigins: [...] }` to `createNuxtAuth`; `csrf: false` turns the check off.

### Notes for Nuxt

- **Headers.** The adapter's `setHeader` calls reach the response, because Nitro sends it after your handler. A handler that sets its own `Cache-Control` after the middleware overrides the no-cache value, so for user data keep `SSR_NO_CACHE_HEADERS` (server code only). Do not put user-data routes under `routeRules` caching (`cache`, `swr`, `isr`, `prerender`).
- **Imports.** Import `@iglo.tech/iglo.base/ssr` and `@iglo.tech/iglo.base/ssr/nuxt` only in `server/`. Components use `@iglo.tech/iglo.base/ssr/browser`; the browser build of `@iglo.tech/iglo.base/ssr` throws on import. The repository has no Nuxt example; the Next.js one (https://github.com/iglo-tech/iglo.base/tree/main/examples/nextjs) shows the same flow.


## Astro

### Wire the adapter

Run Astro on the server: `output: "server"` in `astro.config.mjs`, with a server adapter such as `@astrojs/node`. A prerendered page is built once, so the middleware cannot read the session on it.

Create the adapter once per process, in `src/lib/auth.ts`. The superuser client signs in when it is created:

```ts
import { createSessionCache, createSuperuserClient } from "@iglo.tech/iglo.base/ssr";
import { createAstroAuth, type AstroAuth } from "@iglo.tech/iglo.base/ssr/astro";

let auth: Promise<AstroAuth> | undefined;
export function getAuth(): Promise<AstroAuth> {
  auth ??= (async () => {
    // read at run time with process.env: Astro replaces import.meta.env values at build time
    const url = process.env.PB_URL as string;
    const superuser = await createSuperuserClient({
      url,
      email: process.env.PB_SUPERUSER_EMAIL,
      password: process.env.PB_SUPERUSER_PASSWORD,
    });
    return createAstroAuth({ url, origin: process.env.APP_ORIGIN, sessionCache: createSessionCache(), superuser });
  })().catch((error) => { auth = undefined; throw error; }); // a failed start is retried
  return auth;
}
```

Do not read the superuser credentials or the iglo.base URL with `import.meta.env`. Astro fills that in at build time, so the password would be written into `dist/server`, and the values set when the server starts would be ignored (see [security notes](#security-notes)).

Run it from `src/middleware.ts`, the pattern Astro documents (`defineMiddleware`, exported as `onRequest`):

```ts
import { defineMiddleware } from "astro:middleware";
import { getAuth } from "./lib/auth";

export const onRequest = defineMiddleware(async (context, next) => {
  return (await getAuth()).onRequest(context, next);
});
```

The adapter sets `context.locals.pb` and `context.locals.pbBrowserToken`. The SDK exports no Astro locals type, so declare them in `src/env.d.ts`:

```ts
/// <reference types="astro/client" />
declare namespace App {
  interface Locals {
    pb: import("@iglo.tech/iglo.base/ssr").ServerClient;
    pbBrowserToken: () => Promise<import("@iglo.tech/iglo.base/ssr").BrowserToken | null>;
  }
}
```

### Sign in and sign out

`authWithPassword` saves the session on `locals.pb`. The adapter writes the HttpOnly cookie through `context.cookies.set`, so the route does not set it.

```ts
// src/pages/api/login.ts
import type { APIRoute } from "astro";

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const form = await request.formData();
  try {
    await locals.pb.collection("users").authWithPassword(String(form.get("email")), String(form.get("password")));
  } catch {
    return redirect("/login?error=1", 303);
  }
  return redirect("/dashboard", 303);
};
```

```ts
// src/pages/api/logout.ts
import type { APIRoute } from "astro";

export const POST: APIRoute = ({ locals, redirect }) => {
  locals.pb.authStore.clear(); // the adapter clears the cookie
  return redirect("/login", 303);
};
```

### Read the user on a page

`Astro.locals.pb.authStore.record` is the user the adapter resumed for this request. Reading it makes no request of its own: the adapter has already checked the session, through the session cache, before your page runs. An API route reads `locals.pb.authStore.record` the same way and answers `401` when it is `null`.

### Protect a page

`pb.auth.verify()` asks iglo.base whether the session is still valid, and throws when it is not:

```astro
---
// src/pages/account.astro
export const prerender = false;
let user;
try {
  user = await Astro.locals.pb.auth.verify();
} catch {
  return Astro.redirect("/login");
}
---
<p>Account of {user.email}</p>
```

### OAuth2 sign-in

The adapter mounts `GET /api/pb/oauth2/start/{provider}?redirectTo=` and `GET /api/pb/oauth2/callback`; do not add files under `/api/pb/`. Register `https://<your-origin>/api/pb/oauth2/callback` with each provider. The login page links to the start route, for example `<a href="/api/pb/oauth2/start/google?redirectTo=/dashboard">`. A failed sign-in returns to `redirectTo` with `oauth2_error=<kind>` added. A provider that returns by POST (Apple) needs the popup flow in the browser, shown below. For that flow, register `<PB_PUBLIC_URL>/api/oauth2-redirect` with the provider, not the callback above (see [OAuth2 providers](#oauth2-providers)).

### Browser client and realtime

The browser token goes in a `data-` attribute, so it sits in the page's HTML for its 15-minute default lifetime. The browser's URL is read per request too, so the build does not fix it. `dispose()` stops only the renewal timers, so the sample also calls the unsubscribe function that `subscribe` returns.

```astro
---
// src/pages/tasks.astro
export const prerender = false;
const browser = await Astro.locals.pbBrowserToken();
// the URL the browser reaches iglo.base at, read per request (not inlined at build time)
const url = process.env.PB_PUBLIC_URL ?? process.env.PB_URL;
---
<div id="live" data-url={url} data-session={JSON.stringify(browser)}>waiting</div>

<script>
  import { createBrowserClient } from "@iglo.tech/iglo.base/ssr/browser";
  const el = document.getElementById("live")!;
  const session = JSON.parse(el.dataset.session ?? "null");
  if (session) {
    const client = createBrowserClient({
      url: el.dataset.url!,
      token: session.token,
      record: session.record,
      serverTime: session.serverTime,
      renewUrl: "/api/pb/renew",
      handOffUrl: "/api/pb/popup",
    });
    const unsubscribe = client.collection("tasks").subscribe("*", (event) => {
      el.textContent = `${event.action} ${event.record.id}`;
    });
    addEventListener("pagehide", () => { client.dispose(); unsubscribe.then((stop) => stop()); });
  }
</script>
```

This sample does not use view transitions. If you add `<ClientRouter />`, a bundled `<script>` is not run again by a client-side navigation, so the page would not start its client. Give links to pages like this one the `data-astro-reload` attribute, which makes the browser load the page in full (see Astro's view transitions guide).

### CSRF

The middleware runs the CSRF guard before your page or endpoint. A `POST`, `PUT`, `PATCH` or `DELETE` that carries the session cookie from another origin gets `403`. Form posts from your own pages pass. The `origin` option is already allowed; list other public origins in `csrf: { allowedOrigins: [...] }`.

### Notes for Astro

- Keep `@iglo.tech/iglo.base/ssr` and `@iglo.tech/iglo.base/ssr/astro` out of `<script>` tags and client components. Client code imports `@iglo.tech/iglo.base/ssr/browser`.
- Response headers: the middleware sets the no-cache headers on the response `next()` returns, when the request carries user data. Pages and endpoints return through `next()`, so a `new Response(...)` built in an endpoint needs no headers of its own. A prerendered page is the gap.


## React Router 7 and Remix

### Wire the adapter

Create the adapter once per process, in a module only the server loads. The `.server.ts` suffix keeps it out of the browser build. `createSuperuserClient` is async, so build the adapter from a lazy promise, and retry it if the start fails.

```ts
// app/auth.server.ts
import { createSessionCache, createSuperuserClient } from "@iglo.tech/iglo.base/ssr";
import { createReactRouterAuth, type ReactRouterAuth } from "@iglo.tech/iglo.base/ssr/react-router";

const url = process.env.PB_URL as string; // iglo.base as this server reaches it
let authPromise: Promise<ReactRouterAuth> | undefined;

export function getAuth(): Promise<ReactRouterAuth> {
  authPromise ??= createSuperuserClient({
    url,
    email: process.env.PB_SUPERUSER_EMAIL,
    password: process.env.PB_SUPERUSER_PASSWORD,
  })
    .then((superuser) =>
      createReactRouterAuth({
        url,
        origin: process.env.APP_ORIGIN, // such as https://app.example.com
        superuser,
        sessionCache: createSessionCache(),
      }),
    )
    .catch((err: unknown) => {
      authPromise = undefined;
      throw err;
    });
  return authPromise;
}
```

Each loader and action starts with `const result = await (await getAuth()).session(request);`. Set `origin` behind a proxy: it decides the cookie's `Secure` flag and the OAuth2 callback URL. Without superuser credentials, see [security notes](#security-notes).

### Sign in and sign out

Sign-in is an action for a form POST. It returns its redirect with `headers()`, called last, so the cookies it wrote are in the response.

```ts
// app/routes/login.tsx
import { data, redirect, type ActionFunctionArgs } from "react-router";
import { getAuth } from "~/auth.server";

export async function action({ request }: ActionFunctionArgs) {
  const result = await (await getAuth()).session(request);
  if ("response" in result) {
    return result.response;
  }
  const { session, headers } = result;
  const form = await request.formData();
  try {
    await session.server.collection("users").authWithPassword(String(form.get("email")), String(form.get("password")));
  } catch {
    return data({ error: "Wrong email or password." }, { status: 400, headers: headers() });
  }
  return redirect("/notes", { headers: headers() });
}
```

Sign-out is an action too. Call `session.server.authStore.clear()` before `headers()`. Use a POST form, not a link: a GET can be triggered from another site.

### Read the user on a page

In a loader, `session.server.authStore.record` is the signed-in user, or `null`. The resume check uses the session cache, so a session revoked less than the cache TTL ago (5 minutes by default) can still read as signed in. Use `verify()`, below, where that matters.

### Protect a page

In the loader, call `session.server.auth.verify()`. It checks the session with iglo.base now, bypassing the cache, and throws when the session is not valid. Redirect from the catch, and call `headers()` there, so the check's cookie writes are in the redirect.

```ts
// app/routes/notes.tsx
import { data, redirect, type LoaderFunctionArgs } from "react-router";
import { getAuth } from "~/auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const result = await (await getAuth()).session(request);
  if ("response" in result) {
    return result.response;
  }
  const { session, headers } = result;
  try {
    await session.server.auth.verify();
  } catch {
    return redirect("/login", { headers: headers() });
  }
  return data({ email: session.server.authStore.record?.email ?? null }, { headers: headers() });
}
```

### OAuth2 sign-in

The adapter answers the OAuth2 start and callback itself. A link to `/api/pb/oauth2/start/<provider>?redirectTo=/notes` gets a `302` to the provider. The provider returns to `/api/pb/oauth2/callback`, built from `origin`: register that URL with the provider. The callback redirects to `redirectTo` (a same-site path, else `/`), with `oauth2_error=<kind>` added on failure.

`session()` answers these routes by their path, so each path must reach a route module that calls it. In `app/routes.ts`, add four routes for the default paths: `route("api/pb/renew", "routes/api.pb.renew.ts")` and `route("api/pb/popup", "routes/api.pb.popup.ts")`, which are `POST` routes, and `route("api/pb/oauth2/start/:provider", "routes/api.pb.oauth2.start.ts")` and `route("api/pb/oauth2/callback", "routes/api.pb.oauth2.callback.ts")`, which are `GET` routes. In each module, call `session(request)` and return `result.response`. The renew and popup modules export an `action`; the start and callback modules export a `loader`, since a route with only a `loader` does not receive `POST`s.

Providers that return by POST, such as Sign in with Apple, cannot use this redirect flow: the start route answers `400` (`unsupported-provider`). Use the popup flow below, and register `<PB_PUBLIC_URL>/api/oauth2-redirect` with the provider for it (see [OAuth2 providers](#oauth2-providers)).

### Browser client and realtime

The page's loader mints the browser token. Call `session.browserToken()` before `headers()`, since minting marks the response as user data. The loader returns `token`, `record` and `serverTime`, which are `undefined` when nobody is signed in.

```ts
// app/routes/notes.tsx (loader part)
export async function loader({ request }: LoaderFunctionArgs) {
  const result = await (await getAuth()).session(request);
  if ("response" in result) {
    return result.response;
  }
  const { session, headers } = result;
  const browser = await session.browserToken();
  return data(
    {
      url: process.env.PB_PUBLIC_URL, // iglo.base as the browser reaches it
      token: browser?.token,
      record: browser?.record,
      serverTime: browser?.serverTime,
    },
    { headers: headers() },
  );
}
```

The component starts the browser client in an effect, and disposes it in the cleanup:

```tsx
// app/routes/notes.tsx (component part)
import { useEffect } from "react";
import { useLoaderData } from "react-router";
import { createBrowserClient } from "@iglo.tech/iglo.base/ssr/browser";

export default function Notes() {
  const { url, token, record, serverTime } = useLoaderData<typeof loader>();
  useEffect(() => {
    if (!token || !url) return;
    const client = createBrowserClient({ url, token, record, serverTime, renewUrl: "/api/pb/renew", handOffUrl: "/api/pb/popup" });
    const unsubscribe = client.collection("notes").subscribe("*", () => {});
    return () => {
      void unsubscribe.then((stop) => stop());
      client.dispose();
    };
  }, [url, token, record, serverTime]);
  return null;
}
```

Realtime is the same `subscribe` call as the rest of the SDK. For popup sign-in, call `client.collection("users").authWithOAuth2({ provider })` in the browser, then `await client.handOff()`. Register `<PB_PUBLIC_URL>/api/oauth2-redirect` with the provider for that flow.

### CSRF

For a `POST`, `PUT`, `PATCH` or `DELETE` that carries the session cookie, the adapter checks `Origin`. A missing or foreign origin gets a `403`, which `session()` returns as `{ response }`. A request without the session cookie is not checked, so a sign-in form works signed out. Use `csrf: false` to opt out, or `csrf: { allowedOrigins: [...] }`.

### Notes for React Router

- **The one thing to add: `sessionHeaders`.** Every route module that calls `session()`, resource routes included, re-exports it as `headers`: `export { sessionHeaders as headers } from "@iglo.tech/iglo.base/ssr/react-router";`. So does every route with an `ErrorBoundary`, at least `app/root.tsx`. React Router builds a page's and a `.data` response's headers from this export. Without it, only the `Set-Cookie` lines of the loader's or action's headers reach the response, and the no-cache headers are lost. This was checked with `react-router@7.18.5` in framework mode. Check your version, and Remix, the same way.
- **Boundary routes.** A session route that throws `data(…, { headers: headers() })` is rendered by the nearest boundary route, which takes those headers from its own export. Without the export on the root, the thrown response loses its no-cache headers and cookie writes.
- **The adapter cannot change a built response.** Call `headers()` last; a response React Router has already built gets no later cookie writes.
- **Browser build.** React Router drops the `headers` export from the browser build, so the adapter's import stays on the server. Import `@iglo.tech/iglo.base/ssr/react-router` only from loaders, actions, resource routes and `.server` modules.


## Plain Web handlers (Bun, Hono, Deno)

### Wire the adapter

There is no adapter for plain handlers, so your `fetch` handler runs the steps in this order: CSRF check, SDK routes, session resume, your pages, then headers and cookies. Create the session cache and superuser client once per process, and the server client per request.

```ts
import { ClientResponseError } from "@iglo.tech/iglo.base";
import {
  checkCsrf, createRequestCookieAdapter, createServerClient, createSessionCache,
  createSuperuserClient, handleBrowserTokenRenew, handlePopupHandOff, mintBrowserToken,
  OAuth2Error, SSR_NO_CACHE_HEADERS, type RequestCookieAdapter, type ServerClient,
} from "@iglo.tech/iglo.base/ssr";

const PB_URL = process.env.PB_URL!; // iglo.base as this server reaches it
const PB_PUBLIC_URL = process.env.PB_PUBLIC_URL ?? PB_URL; // iglo.base as the browser reaches it
const APP_ORIGIN = process.env.APP_ORIGIN!; // your public origin, no path
const secure = new URL(APP_ORIGIN).protocol === "https:";
const superuser = process.env.PB_SUPERUSER_EMAIL
  ? await createSuperuserClient({ url: PB_URL, email: process.env.PB_SUPERUSER_EMAIL, password: process.env.PB_SUPERUSER_PASSWORD })
  : undefined;
const sessionCache = createSessionCache();
// no superuser: the session cookie becomes readable by page scripts (weaker)
const common = { url: PB_URL, sessionCache, secure, readableCookie: superuser === undefined };
const SESSION_NAMES = new Set(["pb_auth", "__Host-pb_auth"]);
const OAUTH2_START = "/api/pb/oauth2/start/";
function finish(response: Response, cookies: RequestCookieAdapter, userData: boolean): Response {
  if (userData || cookies.queuedCookies.length > 0) {
    for (const [name, value] of Object.entries(SSR_NO_CACHE_HEADERS)) response.headers.set(name, value);
  }
  return cookies.applyToResponse(response); // the queued Set-Cookie headers
}

const redirect = (location: string, cookies: RequestCookieAdapter): Response =>
  finish(new Response(null, { status: 302, headers: { Location: location } }), cookies, true);

export async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const csrf = checkCsrf(request, { allowedOrigins: [APP_ORIGIN] });
  if (!csrf.ok) return csrf.response;
  if (pathname === "/api/pb/renew") {
    return handleBrowserTokenRenew(request, { ...common, superuser, allowedOrigins: [APP_ORIGIN] });
  }
  if (pathname === "/api/pb/popup") {
    return handlePopupHandOff(request, { ...common, allowedOrigins: [APP_ORIGIN] });
  }
  const oauth = await oauth2Route(request, pathname); // see OAuth2 sign-in
  if (oauth) return oauth;

  const cookies = createRequestCookieAdapter(request, { secure });
  const hadSession = cookies.getAll().some((c) => SESSION_NAMES.has(c.name));
  const pb = await createServerClient({ ...common, origin: APP_ORIGIN, cookies });

  const response = await pages(request, pb); // your routes, below
  return finish(response, cookies, hadSession || pb.authStore.token !== "");
}
Bun.serve({ port: 3000, fetch: handle });
```

### Sign in and sign out

Sign in with `authWithPassword` on the server client. The SDK writes the session cookie itself, and `finish` adds the headers. Sign out with `authStore.clear()`, which clears the cookie. Both are `POST` routes, so the CSRF check covers the sign-out.

```ts
async function pages(request: Request, pb: ServerClient): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && pathname === "/login") {
    const form = await request.formData();
    try {
      await pb.collection("users").authWithPassword(String(form.get("email")), String(form.get("password")));
    } catch (err) {
      if (!(err instanceof ClientResponseError)) throw err;
      return new Response("Wrong email or password.", { status: 401 });
    }
    return new Response(null, { status: 303, headers: { Location: "/account" } });
  }
  if (request.method === "POST" && pathname === "/logout") {
    pb.authStore.clear();
    return new Response(null, { status: 303, headers: { Location: "/login" } });
  }
  return new Response("Not found", { status: 404 });
}
```

### Read the user on a page

After `createServerClient`, `pb.authStore.record` is the signed-in user, or `null`. It may come from the session cache (up to 5 minutes); use `pb.auth.verify()` when that is not fresh enough.

### Protect a page

`pb.auth.verify()` checks the session with iglo.base now and throws when it is not valid. Send the user to sign in on `401`, `403` or `404`. This page function renders the account page with the browser token, and `pages` calls it for `GET /account` before it answers the 404:

```ts
async function accountPage(pb: ServerClient): Promise<Response> {
  try {
    await pb.auth.verify();
  } catch (err) {
    if (!(err instanceof ClientResponseError) || ![401, 403, 404].includes(err.status)) throw err;
    return new Response(null, { status: 303, headers: { Location: "/login" } });
  }
  const bt = await mintBrowserToken(pb, superuser);
  if (!bt) return new Response(null, { status: 303, headers: { Location: "/login" } });
  const boot = JSON.stringify({ url: PB_PUBLIC_URL, ...bt }).replaceAll("<", "\\u003c"); // no "</script>" in the JSON
  const html = `<script id="boot" type="application/json">${boot}</script><script type="module" src="/account.js"></script>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// in pages(), before the 404 response:
// if (request.method === "GET" && pathname === "/account") return accountPage(pb);
```

### OAuth2 sign-in

Two routes: `startOAuth2` redirects to the provider and keeps the state in a short cookie, and `completeOAuth2` reads the callback. `callbackUrl` must equal the redirect URI registered with the provider. A provider that returns by `POST` (Apple) needs the popup flow instead: the browser calls `authWithOAuth2()`, then posts the token to `handlePopupHandOff` (the `/api/pb/popup` route in `handle`). Register `<PB_PUBLIC_URL>/api/oauth2-redirect` with the provider for that flow (see [OAuth2 providers](#oauth2-providers)).

```ts
async function oauth2Route(request: Request, pathname: string): Promise<Response | undefined> {
  const start = pathname.startsWith(OAUTH2_START) ? pathname.slice(OAUTH2_START.length) : undefined;
  if (start === undefined && pathname !== "/api/pb/oauth2/callback") return undefined;
  const cookies = createRequestCookieAdapter(request, { secure });
  const pb = await createServerClient({ ...common, origin: APP_ORIGIN, cookies });
  if (start === undefined) {
    const result = await pb.completeOAuth2(request.url);
    const target = new URL(result.redirectTo, APP_ORIGIN);
    if (!result.ok) {
      target.searchParams.set("oauth2_error", result.error instanceof OAuth2Error ? result.error.kind : "server");
    }
    return redirect(target.href, cookies);
  }
  try {
    const redirectTo = new URL(request.url).searchParams.get("redirectTo") ?? "/";
    const location = await pb.startOAuth2(start, { callbackUrl: `${APP_ORIGIN}/api/pb/oauth2/callback`, redirectTo });
    return redirect(location, cookies);
  } catch (err) {
    if (err instanceof OAuth2Error) return new Response(err.message, { status: err.kind === "unknown-provider" ? 404 : 400 });
    throw err;
  }
}
```

### Browser client and realtime

`mintBrowserToken(pb, superuser)` returns the token, record and server clock, or `null`. The page passes them to its script as JSON (the `pages` sample). The script calls `dispose()` when the page goes away.

```js
// public/account.js, bundled for the browser: plain JavaScript, no type annotations
import { createBrowserClient } from "@iglo.tech/iglo.base/ssr/browser";
const boot = JSON.parse(document.getElementById("boot").textContent);
const pb = createBrowserClient({
  url: boot.url, // iglo.base as the browser reaches it, set by the server at run time
  token: boot.token, record: boot.record, serverTime: boot.serverTime,
  renewUrl: "/api/pb/renew", handOffUrl: "/api/pb/popup",
});
const unsubscribe = await pb.collection("posts").subscribe("*", () => {});
addEventListener("pagehide", () => { unsubscribe(); pb.dispose(); });
```

### CSRF

`checkCsrf` runs first in `handle`. It returns `{ ok: true }` or `{ ok: false, reason, response }`, where `response` is a ready 403; return it unchanged. It checks only `POST`, `PUT`, `PATCH` and `DELETE` requests that carry a session cookie. `allowedOrigins` entries are origins with no path.

### Notes for Plain Web

- You own the `Response`, so you own the headers. Add `SSR_NO_CACHE_HEADERS` to every response of a request with user data: a session cookie in, a cookie written (sign-in, sign-out, refresh), or a browser token minted. `finish` does this, and an anonymous request that writes nothing stays cacheable. Build responses with `new Response`, not `Response.redirect()` or `fetch()`: the SDK treats their headers as immutable in Node (`withMutableHeaders`, `sdk/src/ssr/adapter.ts`).
- Behind a proxy, the request URL is the internal one. Set `secure` and `origin` yourself, as the sample does, and list the public origin in `allowedOrigins`. `superuser` is not a `createServerClient` option: it goes to `handleBrowserTokenRenew` and `mintBrowserToken`. With a custom `cookieName`, change `SESSION_NAMES`.
- Hono and Deno use the same functions with their own routing (Deno reads the environment with `Deno.env.get`). This sample is for Bun and is not tested with them.


## Caching and CDNs

A response that carries user data gets these headers, from `SSR_NO_CACHE_HEADERS`:

```
Cache-Control: private, no-cache, no-store, must-revalidate, max-age=0
Expires: 0
Pragma: no-cache
```

A request carries user data when it has a session cookie (under either name), when it writes a session cookie, or when it mints a browser token. Every response of that request gets the headers, including its redirects and error pages. An anonymous request that writes nothing is not changed, so its response keeps whatever cache headers your app sets.

What the app must add itself:

- **Your own responses.** In plain Web handlers the app owns every `Response`, so it adds `SSR_NO_CACHE_HEADERS` to any response of a request that carries user data. See [plain Web handlers](#plain-web-handlers-bun-hono-deno).
- **Next.js.** Server Components cannot set headers, and a Route Handler that signs in or out returns its own response. Both are covered in [the Next.js section](#nextjs). Next.js sets its own `no-store` on Server Action responses.
- **Nuxt.** If a handler sets its own `Cache-Control`, it must keep the no-cache value for a user's response. See [the Nuxt section](#nuxt).
- **React Router 7 and Remix.** Export `sessionHeaders` as `headers` from every route that uses the session and from every route with an `ErrorBoundary`. See [the React Router section](#react-router-7-and-remix).

Public pages that do not depend on the user can be cached as usual. Set their headers in your app. Configure your CDN to honor `Cache-Control` from the origin, and do not add a rule that caches a path whatever the origin says. The headers above are what keep a shared cache from storing one user's cookie or token for another user.

## Security notes

- **Cookies on https.** The session cookie is `__Host-pb_auth`: `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`. A sibling subdomain cannot set it. On https the SDK reads only the `__Host-` name, so a plain `pb_auth` is ignored there.
- **The app's origin decides the cookie, not iglo.base's URL.** Cookie security follows your app's own request: the `secure` option if you set it, else the `origin` option, else the request. An https app that talks to `http://127.0.0.1:8090` still gets a `Secure` cookie.
- **Behind a proxy, set `origin`.** A proxy that terminates TLS hands your app plain http. Without `origin`, the app may write a non-`Secure` cookie, and the CSRF guard may compare against the wrong origin. Set `origin` (or `APP_ORIGIN`) to your public origin.
- **CSRF.** A `POST`, `PUT`, `PATCH` or `DELETE` that carries the session cookie must come from your app's origin or from one of the origins in `csrf.allowedOrigins`. The guard reads `Origin`, and reads `Referer` only when `Origin` is missing. A request with neither, or with `Origin: null`, is refused with 403. Requests without the session cookie pass, so a sign-in form works without a token. Entries in `allowedOrigins` must be origins, with no path; an invalid entry throws on every call.
- **Open redirects.** `redirectTo` must be a same-origin path that starts with one `/`. `//host`, a backslash, a control character, or any value that resolves to another origin becomes `/`. The SDK checks the stored value again when the OAuth2 flow completes. Check your own redirect targets the same way.
- **OAuth2 state.** The redirect flow compares `state` in constant time, uses PKCE, and rejects a temporary cookie older than 10 minutes. It keeps one temporary cookie per browser, so a sign-in started in a second tab before the first finishes fails there with `state-mismatch`. The temporary cookie is not signed, so the state binding stops a stale or mismatched cookie. It does not stop someone who can write cookies for your host.
- **Superuser credentials.** Keep the superuser email, password or token in your server's secret store. Never put them in a browser bundle, a page, a repository or a log. Read them at run time, with `process.env`, `Bun.env`, SvelteKit's `$env/dynamic/private` or Nuxt's `runtimeConfig`. A build step that inlines them writes them into the build output: Astro and Vite replace `import.meta.env.*` at build time, and Next.js inlines any `NEXT_PUBLIC_*` variable into the browser bundle, so never use that prefix for a secret. After a build, search the output (for example `dist/`) for the password to confirm it is not there. Limit the superuser to the [IP list](operations.md#superuser) that your app server uses, and rotate the password or the token when someone who should not have it has seen it.
- **Browser tokens.** A browser token is valid for 15 minutes by default, can be used only for the one user, and cannot be refreshed. Keep `browserTokenDuration` short. The renew route checks the session with iglo.base before it mints a new one, so a revoked session cannot keep renewing.
- **Plain http.** The default cookie is `Secure`. Browsers store a `Secure` cookie only from an https page, or from `localhost` (and `127.0.0.1` and `::1`). So over plain http outside localhost, sign-in can appear to work and the next page shows the user signed out. Use https. If you set `secure: false` to make it work over http, the session cookie then travels in clear text, and anyone on the network can read or replace it. Over http, the OAuth2 temporary cookie is read under its plain name, which anyone who can write cookies for your host can set. Do not run the callback over plain http outside localhost.
- **The readable-cookie fallback.** See [the fallback](#without-superuser-credentials). Any script on the page can read the session token.

## Troubleshooting

### `@iglo.tech/iglo.base/ssr is server-only` in a browser bundle, or on Edge

The error means that a browser bundle or an Edge runtime loaded `@iglo.tech/iglo.base/ssr`. The package's browser condition resolves to a stub that throws this error. In a bundler, the build fails (Turbopack: `Export createNextAuth doesn't exist in target module`) or the page throws when it loads (webpack).

Keep `@iglo.tech/iglo.base/ssr` in server-only modules: `lib/` or `$lib/server/` in SvelteKit, route handlers, middleware and server functions. Import `createBrowserClient` from `@iglo.tech/iglo.base/ssr/browser` in client code. On Next.js, run the request hook on the Node.js runtime. See [the Next.js section](#nextjs).

### Cookies are not set in Server Components

Server Components cannot write cookies or headers in Next.js, and other frameworks treat their read-only stores the same way. The adapter tries to write, skips the write without an error, and keeps the refreshed session in memory for that render. Sign-in and sign-out must happen in a route handler, a server action or the request hook, where cookies can be written. In a Server Component, read the session (with `serverSession` in Next.js), and do not expect a new cookie from it.

### Realtime after sign-out

A sign-out in the same page ends the realtime connection's identity at once: the browser client reconnects as a guest. A sign-out in another tab is not seen by this page until its next renewal. The renewal is refused and the page's store is cleared. The page keeps its token until then, which can take up to about half the browser token's lifetime (7.5 minutes by default). To end it sooner, reload the page, or set a shorter `browserTokenDuration`.

### Sessions end too soon, or tokens look expired early (clock skew)

The SDK allows 60 seconds of clock skew. It learns iglo.base's clock from each response's `Date` header, so an app server whose clock is minutes off does not drop a valid session once it has had one response. Until the first response in a process, the offset counts as 0, so a server clock more than 60 seconds fast can drop a session that is close to its expiry. The browser client measures its own clock from `serverTime`, so a device clock that is minutes off does not change when a token renews. Run NTP on your app server and on iglo.base's host, and check both clocks first.

### Renewal fails with 503, or superuser calls fail

A `503` from the renew route means iglo.base is unreachable, or it refused the superuser credential (missing, expired, revoked, or a superuser's IP is not allowed). The session cookie is kept, so the user is not signed out. Check the superuser credential, its password or token, and the [superuser IP list](operations.md#superuser). The app server's address must be on the list.

### Sign-in works locally but not behind HTTPS

Set `origin` (or `APP_ORIGIN`) to the public `https://` origin, so the cookie is `Secure` and the CSRF guard compares the right origin. Behind a proxy, also check the [client IP setting](operations.md#reverse-proxy-with-tls), so superuser calls are not refused by the IP list.

### `403` on a sign-in or sign-out `POST`

The CSRF guard refused the request. The request carried the session cookie, and its `Origin` is neither your app's origin nor in `csrf.allowedOrigins`. This happens when the app runs behind a proxy that changes the public origin. Set `origin`, and list any other origin that legitimately posts to the app in `csrf.allowedOrigins`.

### OAuth2 ends with `oauth2_error`

- `missing-cookie`: the temporary cookie is not there. Check that the start and the callback use the same origin and scheme, since on https only `__Host-pb_oauth2` is read. Check that the browser accepts cookies from the callback.
- `state-mismatch`: a newer sign-in in the same browser replaced the temporary cookie. Finish one sign-in before you start another.
- `expired`: the callback came more than 10 minutes after the start.
- `provider-error`: the provider returned an error, with its code in `error`.
- `unsupported-provider` from the start route: the provider returns by POST (Sign in with Apple). Use the popup flow.
- `server`: iglo.base refused the exchange. Check the callback URL: it must be the redirect URI registered with the provider.

### The provider rejects the redirect URI

The provider's error names a redirect URI that does not match what it has registered. Each flow registers its own URL (see [OAuth2 providers](#oauth2-providers)). The redirect flow needs `<APP_ORIGIN>/api/pb/oauth2/callback`. The popup flow, which Sign in with Apple and other providers that return by POST need, needs `<PB_PUBLIC_URL>/api/oauth2-redirect`, iglo.base's own URL. Registering the app's callback for the popup flow makes the provider refuse the sign-in.

### Realtime does not deliver events

Check the browser client's `url`. It must be the URL the browser reaches, not the app server's internal URL. Check that the renew route answers `200` on the page, since a renewal that fails with a `5xx` keeps the token and retries. Realtime sends only the records the user may see under the collection's rules.
