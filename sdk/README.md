iglo.base JavaScript SDK
======================================================================

JavaScript SDK (browser, Node, Deno, Bun and React Native) for the [iglo.base](https://github.com/iglo-tech/iglo.base) API.

This is a fork of the [PocketBase JavaScript SDK](https://github.com/pocketbase/js-sdk) v0.28.1 (MIT), maintained with iglo.base. It keeps the `pocketbase` package's API (same default export and named exports) and works with PocketBase v0.41.0 too, but ships ES modules only (no `./cjs`, `./umd` or script-tag build).

- [Installation](#installation)
- [Usage](#usage)
- [Caveats](#caveats)
    - [Binding filter parameters](#binding-filter-parameters)
    - [File upload](#file-upload)
    - [Error handling](#error-handling)
    - [Auth store](#auth-store)
        - [LocalAuthStore (default)](#localauthstore-default)
        - [AsyncAuthStore (_usually used with React Native_)](#asyncauthstore)
        - [Custom auth store](#custom-auth-store)
        - [Common auth store fields and methods](#common-auth-store-fields-and-methods)
    - [Auto cancellation](#auto-cancellation)
    - [Specify TypeScript definitions](#specify-typescript-definitions)
    - [Custom request options](#custom-request-options)
    - [Send hooks](#send-hooks)
    - [Server-side rendering](#server-side-rendering)
    - [Security](#security)
- [Definitions](#definitions)
- [Development](#development)


## Installation

### Browser (ES modules)

```html
<script type="module">
    import PocketBase from '/path/to/dist/iglo-base.es.mjs'

    const pb = new PocketBase("https://example.com")
    ...
</script>
```

### Node.js / Bun (via npm)

```sh
npm install iglo.base --save
```

```js
import PocketBase from 'iglo.base'
```

> 🔧 For **Node < 17** you'll need to load a `fetch()` polyfill.
> I recommend [lquixada/cross-fetch](https://github.com/lquixada/cross-fetch):
> ```js
> // npm install cross-fetch --save
> import 'cross-fetch/polyfill';
> ```
---
> 🔧 Node doesn't have native `EventSource` implementation, so in order to use the realtime subscriptions you'll need to load a `EventSource` polyfill.
> ```js
> // for server: npm install eventsource --save
> import { EventSource } from "eventsource";
>
> // for React Native: npm install react-native-sse --save
> import EventSource from "react-native-sse";
>
> global.EventSource = EventSource;
> ```


## Usage

```js
import PocketBase from 'iglo.base';

const pb = new PocketBase('http://127.0.0.1:8090');

...

// authenticate as auth collection record
const userData = await pb.collection('users').authWithPassword('test@example.com', '123456');

// list and filter "example" collection records
const result = await pb.collection('example').getList(1, 20, {
    filter: 'status = true && created > "2022-08-01 10:00:00"'
});

// and much more...
```
> More detailed API docs and copy-paste examples could be found in the [API documentation for each service](https://pocketbase.io/docs/api-records/).


## Caveats

### Binding filter parameters

The SDK comes with a helper `pb.filter(expr, params)` method to generate a filter string with placeholder parameters (`{:paramName}`) populated from an object.

**This method is also recommended when using the SDK in Node/Deno/Bun server-side list queries and accepting untrusted user input as `filter` string arguments, because it will take care to properly escape the generated string expression, avoiding eventual string injection attacks** (_on the client-side this is not much of an issue_).

```js
const records = await pb.collection("example").getList(1, 20, {
  // the same as: "title ~ 'te\\'st' && (totalA = 123 || totalB = 123)"
  filter: pb.filter("title ~ {:title} && (totalA = {:num} || totalB = {:num})", { title: "te'st", num: 123 })
})
```

The supported placeholder parameter values are:

- `string`
- `number`
- `boolean`
- `null`
- `undefined` (stringified as `null`)
- `Date` object (stringified into the format expected by PocketBase)
- everything else is converted to a string using `JSON.stringify()`


### File upload

PocketBase Web API supports file upload via `multipart/form-data` requests,
which means that to upload a file it is enough to provide either a [`FormData`](https://developer.mozilla.org/en-US/docs/Web/API/FormData) instance OR plain object with `File`/`Blob` prop values.

- Using plain object as body _(this is the same as above and it will be converted to `FormData` behind the scenes)_:
    ```js
    const data = {
      'title':    'lorem ipsum...',
      'document': new File(...),
    };

    await pb.collection('example').create(data);
    ```

- Using `FormData` as body:
    ```js
    // the standard way to create multipart/form-data body
    const data = new FormData();
    data.set('title', 'lorem ipsum...')
    data.set('document', new File(...))

    await pb.collection('example').create(data);
    ```

### Error handling

All services return a standard [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)-based response, so the error handling is straightforward:
```js
pb.collection('example').getList(1, 50).then((result) => {
  // success...
  console.log('Result:', result);
}).catch((error) => {
  // error...
  console.log('Error:', error);
});

// OR if you are using the async/await syntax:
try {
  const result = await pb.collection('example').getList(1, 50);
  console.log('Result:', result);
} catch (error) {
  console.log('Error:', error);
}
```

The response error is normalized and always returned as `ClientResponseError` object with the following public fields that you could use:
```js
ClientResponseError {
    url:           string,     // requested url
    status:        number,     // response status code
    response:      { ... },    // the API JSON error response
    isAbort:       boolean,    // is abort/cancellation error
    originalError: Error|null, // the original non-normalized error
}
```

### Auth store

The SDK keeps track of the authenticated token and auth model for you via the `pb.authStore` instance.

##### LocalAuthStore (default)

The default [`LocalAuthStore`](https://github.com/iglo-tech/iglo.base/blob/main/sdk/src/stores/LocalAuthStore.ts) uses the browser's `LocalStorage` if available, otherwise - will fallback to runtime/memory (aka. on page refresh or service restart you'll have to authenticate again).

Conveniently, the default store also takes care to automatically sync the auth store state between multiple tabs.

> _**NB!** Deno also supports `LocalStorage` but keep in mind that, unlike in browsers where the client is the only user, by default Deno `LocalStorage` will be shared by all clients making requests to your server!_

##### AsyncAuthStore

The SDK comes also with a helper [`AsyncAuthStore`](https://github.com/iglo-tech/iglo.base/blob/main/sdk/src/stores/AsyncAuthStore.ts) that you can use to integrate with any 3rd party async storage implementation (_usually this is needed when working with React Native_):
```js
import AsyncStorage from '@react-native-async-storage/async-storage';
import PocketBase, { AsyncAuthStore } from 'iglo.base';

const store = new AsyncAuthStore({
    save:    async (serialized) => AsyncStorage.setItem('pb_auth', serialized),
    initial: AsyncStorage.getItem('pb_auth'),
});

const pb = new PocketBase('http://127.0.0.1:8090', store)
```

##### Custom auth store

In some situations it could be easier to create your own custom auth store. For this you can extend [`BaseAuthStore`](https://github.com/iglo-tech/iglo.base/blob/main/sdk/src/stores/BaseAuthStore.ts) and pass the new custom instance as constructor argument to the client:

```js
import PocketBase, { BaseAuthStore } from 'iglo.base';

class CustomAuthStore extends BaseAuthStore {
    save(token, model) {
        super.save(token, model);

        // your custom business logic...
    }
}

const pb = new PocketBase('http://127.0.0.1:8090', new CustomAuthStore());
```

##### Common auth store fields and methods

The default `pb.authStore` extends [`BaseAuthStore`](https://github.com/iglo-tech/iglo.base/blob/main/sdk/src/stores/BaseAuthStore.ts) and has the following public members that you can use:

```js
BaseAuthStore {
    // base fields
    record:       RecordModel|null // the authenticated auth record
    token:        string  // the authenticated token
    isValid:      boolean // checks if the store has existing and unexpired token
    isSuperuser:  boolean // checks if the store state is for superuser

    // main methods
    clear()             // "logout" the authenticated record
    save(token, record) // update the store with the new auth data
    onChange(callback, fireImmediately = false) // register a callback that will be called on store change

    // cookie parse and serialize helpers
    loadFromCookie(cookieHeader, key = 'pb_auth')
    exportToCookie(options = {}, key = 'pb_auth')
}
```

To _"logout"_ the authenticated record you can call `pb.authStore.clear()`.

To _"listen"_ for changes in the auth store, you can register a new listener via `pb.authStore.onChange`, eg:
```js
// triggered everytime on store change
const removeListener1 = pb.authStore.onChange((token, record) => {
    console.log('New store data 1:', token, record)
});

// triggered once right after registration and everytime on store change
const removeListener2 = pb.authStore.onChange((token, record) => {
    console.log('New store data 2:', token, record)
}, true);

// (optional) removes the attached listeners
removeListener1();
removeListener2();
```


### Auto cancellation

The SDK client will auto cancel duplicated pending requests for you.
For example, if you have the following 3 duplicated endpoint calls, only the last one will be executed, while the first 2 will be cancelled with `ClientResponseError` error:

```js
pb.collection('example').getList(1, 20) // cancelled
pb.collection('example').getList(2, 20) // cancelled
pb.collection('example').getList(3, 20) // executed
```

To change this behavior per request basis, you can adjust the `requestKey: null|string` special query parameter.
Set it to `null` to unset the default request identifier and to disable auto cancellation for the specific request.
Or set it to a unique string that will be used as request identifier and based on which pending requests will be matched (default to `HTTP_METHOD + path`, eg. "GET /api/users")

If you want to globally disable the auto cancellation behavior, you could set `pb.autoCancellation(false)`.

Examples:

```js
pb.collection('example').getList(1, 20);                        // cancelled
pb.collection('example').getList(1, 20);                        // executed
pb.collection('example').getList(1, 20, { requestKey: "test" }) // cancelled
pb.collection('example').getList(1, 20, { requestKey: "test" }) // executed
pb.collection('example').getList(1, 20, { requestKey: null })   // executed
pb.collection('example').getList(1, 20, { requestKey: null })   // executed

// globally disable auto cancellation
pb.autoCancellation(false);

pb.collection('example').getList(1, 20); // executed
pb.collection('example').getList(1, 20); // executed
pb.collection('example').getList(1, 20); // executed
```

If you want to manually cancel pending requests, you could use `pb.cancelAllRequests()` or `pb.cancelRequest(requestKey)`.


### Specify TypeScript definitions

You could specify custom TypeScript definitions for your Record models using generics:

```ts
interface Task {
  // type the collection fields you want to use...
  id:   string;
  name: string;
}

pb.collection('tasks').getList<Task>(1, 20) // -> results in Promise<ListResult<Task>>
pb.collection('tasks').getOne<Task>("RECORD_ID")  // -> results in Promise<Task>
```

Alternatively, if you don't want to type the generic argument every time you can define a global PocketBase type using type assertion:

```ts
interface Task {
  id:   string;
  name: string;
}

interface Post {
  id:     string;
  title:  string;
  active: boolean;
}

interface TypedPocketBase extends PocketBase {
  collection(idOrName: string): RecordService // default fallback for any other collection
  collection(idOrName: 'tasks'): RecordService<Task>
  collection(idOrName: 'posts'): RecordService<Post>
}

...

const pb = new PocketBase("http://127.0.0.1:8090") as TypedPocketBase;

pb.collection('tasks').getOne("RECORD_ID") // -> results in Promise<Task>
pb.collection('posts').getOne("RECORD_ID") // -> results in Promise<Post>
```


### Custom request options

All API services accept an optional `options` argument (usually the last one and of type [`SendOptions`](https://github.com/iglo-tech/iglo.base/blob/main/sdk/src/tools/options.ts)), that can be used to provide:

- custom headers for a single request
- custom fetch options
- or even your own `fetch` implementation

For example:

```js
pb.collection('example').getList(1, 20, {
    expand:          'someRel',
    otherQueryParam: '123',

    // custom headers
    headers: {
        'X-Custom-Header': 'example',
    },

    // custom fetch options
    keepalive: false,
    cache:     'no-store',

    // or custom fetch implementation
    fetch: async (url, config) => { ... },
})
```

_Note that for backward compatability and to minimize the verbosity, any "unknown" top-level field will be treated as query parameter._


### Send hooks

Sometimes you may want to modify the request data globally or to customize the response.

To accomplish this, the SDK provides 2 function hooks:

- `beforeSend` - triggered right before sending the `fetch` request, allowing you to inspect/modify the request config.
    ```js
    const pb = new PocketBase('http://127.0.0.1:8090');

    pb.beforeSend = function (url, options) {
        // For list of the possible request options properties check
        // https://developer.mozilla.org/en-US/docs/Web/API/fetch#options
        options.headers = Object.assign({}, options.headers, {
            'X-Custom-Header': 'example',
        });

        return { url, options };
    };

    // use the created client as usual...
    ```

- `afterSend` - triggered after successfully sending the `fetch` request, allowing you to inspect/modify the response object and its parsed data.
    ```js
    const pb = new PocketBase('http://127.0.0.1:8090');

    pb.afterSend = function (response, data) {
        // do something with the response state
        console.log(response.status);

        return Object.assign(data, {
            // extend the data...
            "additionalField": 123,
        });
    };

    // use the created client as usual...
    ```

### Server-side rendering

`iglo.base/ssr` is the server-side entry point. It works with any server that handles Web `Request`/`Response` (Bun, Hono, Deno, and framework middleware built on them). Its exports:

- `createServerClient`: a `Client` per request, resumed from the session cookie. Requests are sent with `cache: "no-store"`.
- `createSessionCache`: one in-memory cache per process. It skips the session check for recently checked sessions and shares one refresh between parallel requests.
- `createRequestCookieAdapter`: the cookie adapter for Web `Request`/`Response` handlers.
- `createSuperuserClient`: a long-lived superuser client. `impersonate(collection, id, duration)` mints a short token (15 minutes by default) for page JavaScript and realtime. A client built from a non-refreshable token (an `impersonate` API key) does not refresh it; its requests fail once it expires.
- `mintBrowserToken()`: the short token and user record a page needs at render. `handleBrowserTokenRenew()`: the adapter route that renews that token. `pb.startOAuth2()` and `pb.completeOAuth2()`: the OAuth2 redirect flow, on the server client (see below). `handlePopupHandOff()`: the adapter route that completes a popup sign-in. `checkCsrf()` and `checkOrigin()`: the Origin check for state-changing requests.

The browser client is a separate entry, `iglo.base/ssr/browser`, which is safe to bundle for the browser: `createBrowserClient()` (see "Browser client and realtime" below).

`iglo.base/ssr` is server-only. A browser bundle that imports its named exports fails at build time in most bundlers (webpack only warns, and the app throws when it loads); a namespace import (`import * as ssr`) throws when it loads.

```js
import {
  createServerClient,
  createRequestCookieAdapter,
  createSessionCache,
} from "iglo.base/ssr";

// one per process; ttl is in milliseconds (default 5 minutes)
const sessionCache = createSessionCache({ ttl: 5 * 60 * 1000, maxEntries: 10_000 });

export default {
  async fetch(request) {
    const cookies = createRequestCookieAdapter(request);
    const pb = await createServerClient({
      url: "http://127.0.0.1:8090", // iglo.base backend URL
      request, // the app's own request: decides Secure and the __Host- prefix
      cookies,
      sessionCache,
    });

    // Sign in: the session cookie is written through the adapter
    // await pb.collection("users").authWithPassword("user@example.com", "secret");

    // Sign out: the session cookie is cleared through the adapter
    // pb.authStore.clear();

    const records = await pb.collection("example").getList(1, 20);

    const response = new Response(JSON.stringify(records), {
      headers: { "Content-Type": "application/json" },
    });

    // apply the cookies and headers queued during the request
    return cookies.applyToResponse(response);
  },
};
```

Things to know:

- Pass the app's own request (`request`), or its `origin`, or `secure`. These decide the cookie security. The backend URL is never used for that. Without any of them the cookie is secure, so a local `http://localhost` app should pass `origin` or `request`.
- `await pb.auth.verify()` checks the session with iglo.base now, skipping the cache. Use it on pages that must not show a revoked session for up to the cache TTL (account settings, payments). It throws when the session is not valid.
- A 401 from a data call does not sign the user out. Only the session check does.
- Between checks a revoked session can still render as signed in for up to the cache TTL. Data calls are unaffected: iglo.base rejects the revoked token on every call.

#### Browser client and realtime

A page talks to iglo.base directly for realtime and reads, with a short token minted at render, so the long-lived session never reaches page JavaScript. The app server mints the token with `impersonate` (15 minutes by default) and passes it to the page. The browser client renews it through an adapter route before it expires:

```js
// server, plain Web Request/Response (Bun, Deno, or any handler)
import {
  createServerClient,
  createRequestCookieAdapter,
  createSessionCache,
  createSuperuserClient,
  handleBrowserTokenRenew,
  mintBrowserToken,
  SSR_NO_CACHE_HEADERS,
} from "iglo.base/ssr";

const BACKEND = "http://127.0.0.1:8090"; // iglo.base backend URL
const sessionCache = createSessionCache();
const superuser = await createSuperuserClient({
  url: BACKEND,
  email: process.env.ADMIN_EMAIL,
  password: process.env.ADMIN_PASSWORD,
});

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // POST /api/session/renew: same origin, with the session cookie, answers a fresh token
    if (url.pathname === "/api/session/renew") {
      return handleBrowserTokenRenew(request, { url: BACKEND, sessionCache, superuser });
    }

    // the page: mint the browser token and hand it over with the record. The token is per user,
    // so the page is never cached (SSR_NO_CACHE_HEADERS).
    const cookies = createRequestCookieAdapter(request);
    const pb = await createServerClient({ url: BACKEND, request, cookies, sessionCache });
    const page = await mintBrowserToken(pb, superuser); // null when nobody is signed in
    // escape "<" so the JSON cannot close the script element
    const json = JSON.stringify(page).replaceAll("<", "\\u003c");
    const html = `<script>window.__PB__ = ${json};</script><script type="module" src="/app.js"></script>`;
    const headers = { "Content-Type": "text/html", ...SSR_NO_CACHE_HEADERS };
    return cookies.applyToResponse(new Response(html, { headers }));
  },
};
```

```js
// browser, app.js (a bundle for the browser; no Bun or Node API)
import { createBrowserClient } from "iglo.base/ssr/browser";

const { token, record, serverTime } = window.__PB__ ?? {};
const pb = createBrowserClient({
  url: "http://127.0.0.1:8090", // the backend the browser can reach
  token,
  record,
  serverTime, // the server's clock at minting: the page's clock is measured against it
  renewUrl: "/api/session/renew", // the app's route above
});

// realtime: subscriptions are resubmitted with each renewed token
await pb.collection("posts").subscribe("*", (e) => console.log(e.action, e.record));
```

Things to know:

- `renew()` runs on its own: at half of the token's remaining life, and never less than 60 seconds before it expires. Successful renewals are at least 30 seconds apart. Parallel calls share one request. A 401 from the renew route signs the page out: the store is cleared, and realtime reconnects as a guest. A network error or a 5xx keeps the token and retries with backoff, at most ten times in a row; after that the store is cleared when the token expires.
- Lifetimes are measured on the server's clock, from `serverTime` and from each renewal answer, so a device clock that is minutes off does not renew the token in a loop or drop the session.
- Realtime follows the signed-in user. A renewal for the same user keeps the connection and resubmits its subscriptions with the new token. A sign-out, or a sign-in as another user, opens a new connection for the subscriptions, authorized as that user or as a guest. If iglo.base is unreachable then, the connection retries with the usual backoff, as a dropped one does. `onDisconnect` is not called for these changes.
- `createBrowserClient` takes an injected `clock` and `timers` for tests. `pb.dispose()` stops the renewal timers.
- `pb.handOff()` posts the popup token (from `authWithOAuth2()`) to a hand-off route (`handlePopupHandOff`) and then renews it, so the long-lived popup token does not stay in page memory. On any failure, whatever the status, the store is cleared and the error is thrown.
- `mintBrowserToken` returns `null` when nobody is signed in, and the record is the server client's own, never data from the request. `expiresAt` and `serverTime` are in milliseconds. The response that carries the token is per user: send it with `SSR_NO_CACHE_HEADERS`, as the example does, so no shared cache keeps it.
- The renew route checks the session with iglo.base on each call (it does not use the session cache), so a session revoked since its last check is refused there. It answers `401` only when the session is over: the user was deleted (`impersonate` answers 404), or the session was revoked. A superuser credential that is refused (`impersonate` answers 401 or 403) is a `503` that keeps the session cookie, so one expired superuser key does not sign every user out.

**Fallback without superuser credentials.** Without superuser credentials the page can still work: create the server client with `readableCookie: true`. The session cookie is then written without `HttpOnly`, and `mintBrowserToken(pb)` and `handleBrowserTokenRenew(request, { url, readableCookie: true })` answer from the session itself. The browser client, given no token, reads the cookie. This is weaker: any script on the page can read the session token for as long as the session lasts, so an XSS bug is a session takeover. Use the superuser path where you can.

#### OAuth2 sign-in (redirect flow)

The redirect flow runs on two routes of your app. The provider sends the browser back to `callbackUrl`, which must be registered with the provider exactly as written here.

```js
import {
  createServerClient,
  createRequestCookieAdapter,
  createSessionCache,
} from "iglo.base/ssr";

const BACKEND = "http://127.0.0.1:8090";
const CALLBACK = "https://app.example.com/auth/callback";
const sessionCache = createSessionCache();

// GET /auth/login: redirect to the provider
export async function login(request) {
  const cookies = createRequestCookieAdapter(request);
  const pb = await createServerClient({ url: BACKEND, request, cookies, sessionCache });
  const location = await pb.startOAuth2("oidc", { callbackUrl: CALLBACK, redirectTo: "/dashboard" });
  const response = new Response(null, { status: 302, headers: { Location: location } });
  return cookies.applyToResponse(response);
}

// GET /auth/callback: the provider's redirect back
export async function callback(request) {
  const cookies = createRequestCookieAdapter(request);
  const pb = await createServerClient({ url: BACKEND, request, cookies, sessionCache });
  const result = await pb.completeOAuth2(request);
  // result.ok: the session cookie is set. Otherwise result.error says why (an OAuth2Error or the server's ClientResponseError).
  const response = new Response(null, { status: 302, headers: { Location: result.redirectTo } });
  return cookies.applyToResponse(response);
}
```

- `startOAuth2(provider, { callbackUrl, redirectTo?, collection? })` returns the provider's URL. It also sets a 10-minute temporary cookie with the state and the PKCE verifier. `redirectTo` must be a same-origin path; anything else becomes `/`.
- `completeOAuth2(request)` checks `state` against that cookie, exchanges the code and sets the session cookie. It deletes the temporary cookie on every outcome. It returns `{ ok: true, redirectTo, auth }` or `{ ok: false, redirectTo, error }`. A replayed callback fails with `missing-cookie`.
- Errors are `OAuth2Error` instances with a `kind`: `unknown-provider`, `unsupported-provider`, `invalid-callback`, `missing-cookie`, `expired`, `state-mismatch`, `provider-error`, `missing-code`. A failure the server reports is its `ClientResponseError`.
- Sign in with Apple returns to the callback by a cross-site POST, which this flow cannot read. `startOAuth2` refuses it with `unsupported-provider`; use the popup sign-in below for Apple.
- The temporary cookie is not signed. It is bound to the `state` of the flow. On https it is `__Host-pb_oauth2`, and the SDK reads only that name, so a sibling subdomain cannot plant one. Two sign-ins in one browser at once: the second one replaces the first.

Popup sign-in (`authWithOAuth2()` in the browser, then a POST of the token; this is the flow for Apple): the adapter route calls `handlePopupHandOff(request, { url, sessionCache })`. It accepts a `POST` with the JSON body `{ "token": "..." }` from the same origin, checks the token with one `auth-refresh` and sets the session cookie. It answers `200 { "record": ... }`, or `401` with no cookie for a revoked token.

#### CSRF

Cookie-authenticated, state-changing requests need an Origin check. `checkCsrf` rejects a `POST`, `PUT`, `PATCH` or `DELETE` that carries the session cookie unless its `Origin` (or `Referer` when there is no `Origin`) is your own origin or one of `allowedOrigins`. Requests without the session cookie, and `GET`, `HEAD` and `OPTIONS`, pass.

```js
const guard = checkCsrf(request, { allowedOrigins: ["https://www.example.com"] });
if (!guard.ok) return guard.response; // 403
```

Behind a proxy that changes the public origin, list that origin in `allowedOrigins`. Next.js Server Actions have their own check, so the guard is not needed there.

#### Framework adapters

Each adapter is a subpath of `iglo.base` with no dependencies. It resumes the session per request, writes the cookies back, sets the no-cache headers on every response of a request that carries user data (a session cookie, a cookie write, or a minted browser token), runs the CSRF check, answers the renew, popup and OAuth2 routes, and sets the page's server client and browser-token function. The app creates the session cache and the superuser client once and passes them in. Each adapter is server-only: under the `browser` condition the package is a stub that throws, so browser code cannot import it (a named import fails the build, and under webpack the app throws at run time). A response with immutable headers, such as a `fetch()` response that an endpoint returns unchanged in Node, is sent as a copy with the same status, body and headers, plus the no-cache headers when they apply. The routes default to `/api/pb/renew`, `/api/pb/popup` and `/api/pb/oauth2/start/<provider>` and `/api/pb/oauth2/callback`, and `routes` changes them; `csrf: false` turns the CSRF check off.

- **`iglo.base/ssr/next`**: `createNextAuth({ next, ... })` returns `middleware(request)` for the request hook: `proxy.ts` on Next.js 16 (pass `next: (init) => NextResponse.next(init)`, since the SDK cannot import `next/server`), or `middleware.ts` on Next.js 15.5 with `export const runtime = "nodejs"`. It runs on the Node.js runtime only; the Edge runtime is not supported. There is no guard for it: the Edge build loads the stub instead. With `next@16.4.5`, `next build` fails under Turbopack with `Export createNextAuth doesn't exist in target module` (the stub), and under webpack the build passes and every request answers `500` with `iglo.base/ssr is server-only`. `serverSession({ cookies, headers })` is for Server Components. A refresh inside a Server Component updates memory only, because cookies there are read-only, and Server Components cannot set response headers. A Route Handler that signs in or out returns `SSR_NO_CACHE_HEADERS` itself, since the adapter cannot add headers to it. Next.js sets `Cache-Control: no-cache, no-store, max-age=0, must-revalidate` on every Server Action response, so an action's response is not stored and needs nothing more. A page that reads the session is rendered dynamically by Next.js. Server Actions keep Next.js's own CSRF check. See [`examples/nextjs`](https://github.com/iglo-tech/iglo.base/tree/main/examples/nextjs).
- **`iglo.base/ssr/sveltekit`**: `createSvelteKitAuth(options)` returns `handle`, which sets `event.locals.pb` and `event.locals.pbBrowserToken`. See [`examples/sveltekit`](https://github.com/iglo-tech/iglo.base/tree/main/examples/sveltekit).
- **`iglo.base/ssr/nuxt`**: `createNuxtAuth(options)` returns `middleware(event)` for a Nitro server middleware. It sets `event.context.pb` and `event.context.pbBrowserToken`. The event is a small structural shape the app maps from h3, so the adapter needs no h3 import.
- **`iglo.base/ssr/astro`**: `createAstroAuth(options)` returns `onRequest(context, next)` for an Astro middleware. It sets `Astro.locals.pb` and `Astro.locals.pbBrowserToken` and writes cookies through `context.cookies`.
- **`iglo.base/ssr/react-router`**: `createReactRouterAuth(options)` returns `session(request)`, for a loader or action on the Web `Request`. It answers the adapter routes and the CSRF check with a `Response`; otherwise it returns the resumed session and a `headers()` function. Call `headers()` last, when the route builds its response, so it includes every cookie the handler wrote: `data(value, { headers: headers() })` or `redirect(url, { headers: headers() })`. Every route module that calls `session()` re-exports the adapter's `sessionHeaders` as its `headers` export, and so does every route module with an `ErrorBoundary`, at least `root.tsx` (the default template's only one): `export { sessionHeaders as headers } from "iglo.base/ssr/react-router";`. Without it React Router copies only the loader's and action's `Set-Cookie` lines onto the page and the `.data` response, so the no-cache headers are lost (checked with `react-router@7.18.5` in framework mode, for a loader and an action). A session route that throws `data(…, { headers: headers() })` hands those headers to the nearest boundary route, so that route needs the export too; without it a thrown 403 page has no `Cache-Control`. The export keeps the parent route's headers and adds the no-cache headers when the loader, the action or an error carries them; on an anonymous request it adds nothing, so the page stays cacheable. React Router still appends the `Set-Cookie` lines itself. React Router drops that export from the browser build, so the adapter's import stays on the server. See [`examples/sveltekit`](https://github.com/iglo-tech/iglo.base/tree/main/examples/sveltekit) for the other frameworks.

#### Cookie Security & `__Host-` Prefix

The session cookie is `__Host-pb_auth` (`Secure`, `Path=/`, no `Domain`, `HttpOnly`, `SameSite=Lax`) when the app's request is https. Over local http (`localhost`, `127.0.0.1`, `::1`) it is the plain `pb_auth` without `Secure`. On https a plain `pb_auth` is ignored, because a sibling subdomain can set it; over http only the plain name is read. When the session ends, both names are cleared on https.

#### Token Lifetime & Single-Flight Refresh

- The SDK learns each auth collection's token lifetime from the sign-in and refresh responses it sees (`exp` minus the response `Date`). It never assumes a fixed lifetime. The first check of a collection refreshes once to learn it.
- A session check uses the cached record, with no request, only when the session was checked within the cache `ttl` (default 5 minutes), the collection's lifetime is known, and at least half of the lifetime remains. Otherwise it calls `auth-refresh`: on the first check after the `ttl`, and whenever less than half of the lifetime remains.
- Parallel requests for one session share one refresh. A 401, 403 or 404 signs out every waiting request. A network error or 5xx keeps the session.

Below you could find legacy low-level cookie store examples:

<details>
  <summary><strong>SvelteKit</strong></summary>

One way to integrate with SvelteKit SSR could be to create the PocketBase client in a [hook handle](https://kit.svelte.dev/docs/hooks#handle)
and pass it to the other server-side actions using the `event.locals`.

```js
// src/hooks.server.js
import PocketBase from 'iglo.base';

/** @type {import('@sveltejs/kit').Handle} */
export async function handle({ event, resolve }) {
    event.locals.pb = new PocketBase('http://127.0.0.1:8090');

    // load the store data from the request cookie string
    event.locals.pb.authStore.loadFromCookie(event.request.headers.get('cookie') || '');

    try {
        // get an up-to-date auth store state by verifying and refreshing the loaded auth model (if any)
        event.locals.pb.authStore.isValid && await event.locals.pb.collection('users').authRefresh();
    } catch (_) {
        // clear the auth store on failed refresh
        event.locals.pb.authStore.clear();
    }

    const response = await resolve(event);

    // send back the default 'pb_auth' cookie to the client with the latest store state
    response.headers.append('set-cookie', event.locals.pb.authStore.exportToCookie());

    return response;
}
```

And then, in some of your server-side actions, you could directly access the previously created `event.locals.pb` instance:

```js
// src/routes/login/+server.js
/**
 * Creates a `POST /login` server-side endpoint
 *
 * @type {import('./$types').RequestHandler}
 */
export async function POST({ request, locals }) {
    const { email, password } = await request.json();

    const { token, record } = await locals.pb.collection('users').authWithPassword(email, password);

    return new Response('Success...');
}
```

For proper `locals.pb` type detection, you can also add `PocketBase` in your your global types definition:

```ts
// src/app.d.ts
import PocketBase from 'iglo.base';

declare global {
    declare namespace App {
        interface Locals {
            pb: PocketBase
        }
    }
}
```
</details>

<details>
  <summary><strong>Astro</strong></summary>

To integrate with Astro SSR, you could create the PocketBase client in the [Middleware](https://docs.astro.build/en/guides/middleware) and pass it to the Astro components using the `Astro.locals`.

```ts 
// src/middleware/index.ts
import PocketBase from 'iglo.base';

import { defineMiddleware } from 'astro/middleware';

export const onRequest = defineMiddleware(async ({ locals, request }: any, next: () => any) => {
    locals.pb = new PocketBase('http://127.0.0.1:8090');

    // load the store data from the request cookie string
    locals.pb.authStore.loadFromCookie(request.headers.get('cookie') || '');

    try {
        // get an up-to-date auth store state by verifying and refreshing the loaded auth record (if any)
        locals.pb.authStore.isValid && await locals.pb.collection('users').authRefresh();
    } catch (_) {
        // clear the auth store on failed refresh
        locals.pb.authStore.clear();
    }

    const response = await next();

    // send back the default 'pb_auth' cookie to the client with the latest store state
    response.headers.append('set-cookie', locals.pb.authStore.exportToCookie());

    return response;
});
```

And then, in your Astro file's component script, you could directly access the previously created `locals.pb` instance:

```ts
// src/pages/index.astro
---
const locals = Astro.locals;

const userAuth = async () => {
    const { token, record } = await locals.pb.collection('users').authWithPassword('test@example.com', '123456');

    return new Response('Success...');
};
---
```

Although middleware functionality is available in both `SSG` and `SSR` projects, you would likely want to handle any sensitive data on the server side. Update your `output` configuration to `'server'`:

```mjs
// astro.config.mjs
import { defineConfig } from 'astro/config';

export default defineConfig({
    output: 'server'
});
```
</details>

<details>
  <summary><strong>Nuxt 3</strong></summary>

One way to integrate with Nuxt 3 SSR could be to create the PocketBase client in a [nuxt plugin](https://v3.nuxtjs.org/guide/directory-structure/plugins)
and provide it as a helper to the `nuxtApp` instance:

```js
// plugins/pocketbase.js
import PocketBase from 'iglo.base';

export default defineNuxtPlugin(async () => {
  const pb = new PocketBase('http://127.0.0.1:8090');

  const cookie = useCookie('pb_auth', {
    path:     '/',
    secure:   true,
    sameSite: 'strict',
    httpOnly: false, // change to "true" if you want only server-side access
    maxAge:   604800,
  })

  // load the store data from the cookie value
  pb.authStore.save(cookie.value?.token, cookie.value?.record);

  // send back the default 'pb_auth' cookie to the client with the latest store state
  pb.authStore.onChange(() => {
    cookie.value = {
      token: pb.authStore.token,
      record: pb.authStore.record,
    };
  });

  try {
      // get an up-to-date auth store state by verifying and refreshing the loaded auth model (if any)
      pb.authStore.isValid && await pb.collection('users').authRefresh();
  } catch (_) {
      // clear the auth store on failed refresh
      pb.authStore.clear();
  }

  return {
    provide: { pb }
  }
});
```

And then in your component you could access it like this:

```html
<template>
  <div>
    Show: {{ data }}
  </div>
</template>

<script setup>
  const { data } = await useAsyncData(async (nuxtApp) => {
    // fetch and return all "example" records...
    const records = await nuxtApp.$pb.collection('example').getFullList();

    return structuredClone(records);
  })
</script>
```
</details>

<details>
  <summary><strong>Nuxt 2</strong></summary>

One way to integrate with Nuxt 2 SSR could be to create the PocketBase client in a [nuxt plugin](https://nuxtjs.org/docs/directory-structure/plugins#plugins-directory) and provide it as a helper to the `$root` context:

```js
// plugins/pocketbase.js
import PocketBase from  'iglo.base';

export default async (ctx, inject) => {
  const pb = new PocketBase('http://127.0.0.1:8090');

  // load the store data from the request cookie string
  pb.authStore.loadFromCookie(ctx.req?.headers?.cookie || '');

  // send back the default 'pb_auth' cookie to the client with the latest store state
  pb.authStore.onChange(() => {
    ctx.res?.setHeader('set-cookie', pb.authStore.exportToCookie());
  });

  try {
      // get an up-to-date auth store state by verifying and refreshing the loaded auth record (if any)
      pb.authStore.isValid && await pb.collection('users').authRefresh();
  } catch (_) {
      // clear the auth store on failed refresh
      pb.authStore.clear();
  }

  inject('pocketbase', pb);
};
```

And then in your component you could access it like this:

```html
<template>
  <div>
    Show: {{ items }}
  </div>
</template>

<script>
  export default {
    async asyncData({ $pocketbase }) {
      // fetch and return all "example" records...
      const items = await $pocketbase.collection('example').getFullList();

      return { items }
    }
  }
</script>
```
</details>

<details>
  <summary><strong>Next.js</strong></summary>

Next.js doesn't seem to have a central place where you can read/modify the server request and response.
[There is support for middlewares](https://nextjs.org/docs/advanced-features/middleware),
but they are very limited and, at the time of writing, you can't pass data from a middleware to the `getServerSideProps` functions (https://github.com/vercel/next.js/discussions/31792).

One way to integrate with Next.js SSR could be to create a custom `PocketBase` instance in each of your `getServerSideProps`:

```jsx
import PocketBase from 'iglo.base';

// you can place this helper in a separate file so that it can be reused
async function initPocketBase(req, res) {
  const pb = new PocketBase('http://127.0.0.1:8090');

  // load the store data from the request cookie string
  pb.authStore.loadFromCookie(req?.headers?.cookie || '');

  // send back the default 'pb_auth' cookie to the client with the latest store state
  pb.authStore.onChange(() => {
    res?.setHeader('set-cookie', pb.authStore.exportToCookie());
  });

  try {
      // get an up-to-date auth store state by verifying and refreshing the loaded auth record (if any)
      pb.authStore.isValid && await pb.collection('users').authRefresh();
  } catch (_) {
      // clear the auth store on failed refresh
      pb.authStore.clear();
  }

  return pb
}

export async function getServerSideProps({ req, res }) {
  const pb = await initPocketBase(req, res)

  // fetch example records...
  const result = await pb.collection('example').getList(1, 30);

  return {
    props: {
      // ...
    },
  }
}

export default function Home() {
  return (
    <div>Hello world!</div>
  )
}
```
</details>

### Security

The most common frontend related vulnerability is XSS (and CSRF when dealing with cookies).
Fortunately, modern browsers can detect and mitigate most of this type of attacks if [Content Security Policy (CSP)](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP) is provided.

**To prevent a malicious user or 3rd party script to steal your PocketBase auth token, it is recommended to configure a basic CSP for your application (either as `meta` tag or HTTP header).**

This is out of the scope of the SDK, but you could find more resources about CSP at:

- https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP
- https://content-security-policy.com


**Depending on how and where you use the JS SDK, it is also recommended to use the helper `pb.filter(expr, params)` when constructing filter strings with untrusted user input to avoid eventual string injection attacks (see [Binding filter parameters](#binding-filter-parameters)).**


## Definitions

### Creating new client instance

```js
const pb = new PocketBase(baseURL = '/', authStore = LocalAuthStore);
```

### Instance methods

> Each instance method returns the `PocketBase` instance allowing chaining.

| Method                            | Description                                                                   |
|:----------------------------------|:------------------------------------------------------------------------------|
| `pb.send(path, sendOptions = {})` | Sends an api http request.                                                    |
| `pb.autoCancellation(enable)`     | Globally enable or disable auto cancellation for pending duplicated requests. |
| `pb.cancelAllRequests()`          | Cancels all pending requests.                                                 |
| `pb.cancelRequest(cancelKey)`     | Cancels single request by its cancellation token key.                         |
| `pb.buildURL(path)`               | Builds a full client url by safely concatenating the provided path.           |


### Services

> Each service call returns a `Promise` object with the API response.

##### RecordService

###### _Crud handlers_

```js
// Returns a paginated records list.
🔓 pb.collection(collectionIdOrName).getList(page = 1, perPage = 30, options = {});

// Returns a list with all records batch fetched at once
// (by default 1000 items per request; to change it set the `batch` param).
🔓 pb.collection(collectionIdOrName).getFullList(options = {});

// Returns the first found record matching the specified filter.
🔓 pb.collection(collectionIdOrName).getFirstListItem(filter, options = {});

// Returns a single record by its id.
🔓 pb.collection(collectionIdOrName).getOne(recordId, options = {});

// Creates (aka. register) a new record.
🔓 pb.collection(collectionIdOrName).create(bodyParams = {}, options = {});

// Updates an existing record by its id.
🔓 pb.collection(collectionIdOrName).update(recordId, bodyParams = {}, options = {});

// Deletes a single record by its id.
🔓 pb.collection(collectionIdOrName).delete(recordId, options = {});

```

###### _Realtime handlers_

```js
// Subscribe to realtime changes to the specified topic ("*" or recordId).
//
// It is safe to subscribe multiple times to the same topic.
//
// You can use the returned UnsubscribeFunc to remove a single registered subscription.
// If you want to remove all subscriptions related to the topic use unsubscribe(topic).
🔓 pb.collection(collectionIdOrName).subscribe(topic, callback, options = {});

// Unsubscribe from all registered subscriptions to the specified topic ("*" or recordId).
// If topic is not set, then it will remove all registered collection subscriptions.
🔓 pb.collection(collectionIdOrName).unsubscribe([topic]);
```

###### _Auth handlers_

> Available only for "auth" type collections.

```js
// Returns all available application auth methods.
🔓 pb.collection(collectionIdOrName).listAuthMethods(options = {});

// Authenticates a record with their username/email and password.
🔓 pb.collection(collectionIdOrName).authWithPassword(usernameOrEmail, password, options = {});

// Authenticates a record with an OTP.
🔓 pb.collection(collectionIdOrName).authWithOTP(otpId, password, options = {});

// Authenticates a record with OAuth2 provider without custom redirects, deeplinks or even page reload.
🔓 pb.collection(collectionIdOrName).authWithOAuth2(authConfig);

// Authenticates a record with OAuth2 code.
🔓 pb.collection(collectionIdOrName).authWithOAuth2Code(provider, code, codeVerifier, redirectUrl, createData = {}, options = {});

// Refreshes the current authenticated record and auth token.
🔐 pb.collection(collectionIdOrName).authRefresh(options = {});

// Sends a record OTP email request.
🔓 pb.collection(collectionIdOrName).requestOTP(email, options = {});

// Sends a record password reset email.
🔓 pb.collection(collectionIdOrName).requestPasswordReset(email, options = {});

// Confirms a record password reset request.
🔓 pb.collection(collectionIdOrName).confirmPasswordReset(resetToken, newPassword, newPasswordConfirm, options = {});

// Sends a record verification email request.
🔓 pb.collection(collectionIdOrName).requestVerification(email, options = {});

// Confirms a record email verification request.
🔓 pb.collection(collectionIdOrName).confirmVerification(verificationToken, options = {});

// Sends a record email change request to the provider email.
🔐 pb.collection(collectionIdOrName).requestEmailChange(newEmail, options = {});

// Confirms record new email address.
🔓 pb.collection(collectionIdOrName).confirmEmailChange(emailChangeToken, userPassword, options = {});

// Lists all linked external auth providers for the specified record.
🔐 pb.collection(collectionIdOrName).listExternalAuths(recordId, options = {});

// Unlinks a single external auth provider relation from the specified record.
🔐 pb.collection(collectionIdOrName).unlinkExternalAuth(recordId, provider, options = {});

// Impersonate authenticates with the specified recordId and returns a new client with the received auth token in a memory store.
🔐 pb.collection(collectionIdOrName).impersonate(recordId, duration, options = {});
```

---

#### BatchService

```js
// create a new batch instance
const batch = pb.createBatch();

// register create/update/delete/upsert requests to the created batch
batch.collection('example1').create({ ... });
batch.collection('example2').update('RECORD_ID', { ... });
batch.collection('example3').delete('RECORD_ID');
batch.collection('example4').upsert({ ... });

// send the batch request
const result = await batch.send()
```

---

##### FileService

```js
// Builds and returns an absolute record file url for the provided filename.
🔓 pb.files.getURL(record, filename, options = {});

// Requests a new private file access token for the current authenticated record.
🔐 pb.files.getToken(options = {});
```

---

##### CollectionService

```js
// Returns a paginated collections list.
🔐 pb.collections.getList(page = 1, perPage = 30, options = {});

// Returns a list with all collections batch fetched at once
// (by default 200 items per request; to change it set the `batch` query param).
🔐 pb.collections.getFullList(options = {});

// Returns the first found collection matching the specified filter.
🔐 pb.collections.getFirstListItem(filter, options = {});

// Returns a single collection by its id or name.
🔐 pb.collections.getOne(idOrName, options = {});

// Creates (aka. register) a new collection.
🔐 pb.collections.create(bodyParams = {}, options = {});

// Updates an existing collection by its id or name.
🔐 pb.collections.update(idOrName, bodyParams = {}, options = {});

// Deletes a single collection by its id or name.
🔐 pb.collections.delete(idOrName, options = {});

// Deletes all records associated with the specified collection.
🔐 pb.collections.truncate(idOrName, options = {});

// Imports the provided collections.
🔐 pb.collections.import(collections, deleteMissing = false, options = {});

// Returns type indexed map with scaffolded collection models populated with their default field values.
🔐 pb.collections.getScaffolds(options = {});

// Returns a list with all configurable OAuth2 providers.
🔐 pb.collections.getAllOAuth2Providers(options = {});

// Tests the specified view query and returns a sample of the resulting records.
🔐 pb.collections.dryRunViewQuery(query, options = {});
```

---

##### LogService

```js
// Returns a paginated logs list.
🔐 pb.logs.getList(page = 1, perPage = 30, options = {});

// Returns a single log by its id.
🔐 pb.logs.getOne(id, options = {});

// Returns logs statistics.
🔐 pb.logs.getStats(options = {});

// Delete all logs.
🔐 pb.logs.truncate(options = {});
```

---

##### SettingsService

```js
// Returns a map with all available app settings.
🔐 pb.settings.getAll(options = {});

// Bulk updates app settings.
🔐 pb.settings.update(bodyParams = {}, options = {});

// Performs a S3 storage connection test.
🔐 pb.settings.testS3(filesystem = "storage", options = {});

// Sends a test email (verification, password-reset, email-change).
🔐 pb.settings.testEmail(collectionIdOrName, toEmail, template, options = {});

// Generates a new Apple OAuth2 client secret.
🔐 pb.settings.generateAppleClientSecret(clientId, teamId, keyId, privateKey, duration, options = {});
```

---

##### RealtimeService

> This service is usually used with custom realtime actions.
> For records realtime subscriptions you can use the subscribe/unsubscribe
> methods available in the `pb.collection()` RecordService.

```js
// Initialize the realtime connection (if not already) and register the subscription listener.
//
// You can subscribe to the `PB_CONNECT` event if you want to listen to the realtime connection connect/reconnect events.
🔓 pb.realtime.subscribe(topic, callback, options = {});

// Unsubscribe from all subscription listeners with the specified topic.
🔓 pb.realtime.unsubscribe(topic?);

// Unsubscribe from all subscription listeners starting with the specified topic prefix.
🔓 pb.realtime.unsubscribeByPrefix(topicPrefix);

// Unsubscribe from all subscriptions matching the specified topic and listener function.
🔓 pb.realtime.unsubscribeByTopicAndListener(topic, callback);

// Getter that checks whether the realtime connection has been established.
pb.realtime.isConnected

// An optional hook that is invoked when the realtime client disconnects
// either when unsubscribing from all subscriptions or when the connection
// was interrupted or closed by the server.
//
// Note that the realtime client autoreconnect on its own and this hook is
// useful only for the cases where you want to apply a special behavior on
// server error or after closing the realtime connection.
pb.realtime.onDisconnect = function(activeSubscriptions)
```

---

##### BackupService

```js
// Returns list with all available backup files.
🔐 pb.backups.getFullList(options = {});

// Initializes a new backup.
🔐 pb.backups.create(basename = "", options = {});

// Upload an existing app data backup.
🔐 pb.backups.upload({ file: File/Blob }, options = {});

// Deletes a single backup by its name.
🔐 pb.backups.delete(key, options = {});

// Initializes an app data restore from an existing backup.
🔐 pb.backups.restore(key, options = {});

// Builds a download url for a single existing backup using a
// superuser file token and the backup file key.
🔐 pb.backups.getDownloadURL(token, key);
```

##### CronService

```js
// Returns list with all available cron jobs.
🔐 pb.crons.getFullList(options = {});

// Runs the specified cron job.
🔐 pb.crons.run(jobId, options = {});
```

##### SQLService

```js
// Runs the specified raw SQL query.
🔐 pb.sql.run(query, options = {});
```

---

##### HealthService

```js
// Checks the health status of the api.
🔓 pb.health.check(options = {});
```


## Development

Run from the repository root of [iglo.base](https://github.com/iglo-tech/iglo.base):

```sh
bun install
bun test sdk            # unit tests
bun run sdk:build       # build into sdk/dist
bun run check           # lint, format, typecheck, tests and build (server and SDK)
```
