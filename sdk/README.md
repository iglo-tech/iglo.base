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

`iglo.base/ssr` lets your server render pages for signed-in users. Each request gets its own client, the session lives in an HttpOnly cookie, and the browser receives only a short token for realtime. The SDK also provides the browser entry `iglo.base/ssr/browser` (`createBrowserClient`), which is safe to bundle for the browser.

`iglo.base/ssr` is server-only: import it only in server code. Its exports include `createServerClient`, `createSuperuserClient`, `createSessionCache`, `createRequestCookieAdapter`, `mintBrowserToken`, `handleBrowserTokenRenew`, `handlePopupHandOff`, `checkCsrf`, `checkOrigin` and `SSR_NO_CACHE_HEADERS`. The framework adapters are `iglo.base/ssr/next`, `/sveltekit`, `/nuxt`, `/astro` and `/react-router`.

`createSessionCache({ ttl, maxEntries })` takes two optional options. `ttl` is in milliseconds (default 300000, five minutes), and `maxEntries` defaults to 10000. A session served from the cache can stay signed in for up to `ttl` after iglo.base revokes it; the guide's [session cache](https://github.com/iglo-tech/iglo.base/blob/main/docs/ssr.md#the-session-cache) section covers the trade-off.

For a provider that returns by POST, such as Sign in with Apple, use the popup flow (`authWithOAuth2()` in the browser, then `handOff()`). Register `<PB_PUBLIC_URL>/api/oauth2-redirect` with that provider, not the app's callback URL; the guide's [OAuth2 providers](https://github.com/iglo-tech/iglo.base/blob/main/docs/ssr.md#oauth2-providers) section explains both flows.

For setup, the framework sections, caching headers, security notes and troubleshooting, read the **[server-side rendering guide](https://github.com/iglo-tech/iglo.base/blob/main/docs/ssr.md)**. The example apps are in [`examples/nextjs`](https://github.com/iglo-tech/iglo.base/tree/main/examples/nextjs) and [`examples/sveltekit`](https://github.com/iglo-tech/iglo.base/tree/main/examples/sveltekit).

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
