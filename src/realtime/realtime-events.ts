// Upstream: apis/realtime.go (bindRealtimeEvents, realtimeUpdateClientsAuth,
// realtimeUnsetClientsAuthByRecordModelOrProxy,
// realtimeUnsetClientsAuthByCollection, realtimeBroadcastRecord,
// realtimeBroadcastDryCacheKey, realtimeUnsetDryCacheKey, getDryCacheKey,
// isSameAuth, realtimeCanAccessRecord)
//
// There is no hook system (D5): bindRealtimeEvents' handlers are the
// functions below, called directly by the record save and delete chain
// (src/records/record-save.ts) and the collection save and delete
// (src/collections/collection-save.ts) at the points upstream's priorities
// give them:
//
//	realtimeRecordAfterCreate      OnModelAfterCreateSuccess (-99)
//	realtimeRecordAfterUpdate      OnModelAfterUpdateSuccess (-99): the
//	                               clients' auth, then the broadcast
//	realtimeRecordDelete           OnModelDelete (99): the dry cache, right
//	                               before the row delete
//	realtimeRecordAfterDelete      OnModelAfterDeleteSuccess (-99): the
//	                               clients' auth, then the dry cache
//	realtimeRecordAfterDeleteError OnModelAfterDeleteError (-99)
//	realtimeCollectionUpdate       OnCollectionUpdate (-99)
//	realtimeCollectionAfterDelete  OnCollectionAfterDeleteSuccess (-99)
//
// "After success" means after the outer transaction commits; the record
// chain calls them from its txInfo.OnComplete, never inside a transaction.
// A failure here never fails the save (upstream only logs it at debug
// level, which iglo.base does not print).
//
// Upstream checks the rules of one broadcast in goroutines, a chunk of 150
// clients each, in the after success path of the request that wrote the
// record: the request answers only after the checks, so they see the
// database as that write left it, before the client's next write can
// land. Here every read of a broadcast (the list/view rule, the
// subscription's filter, the manage rule for the email visibility, the
// expand and its view rules) is synchronous on the main-thread connection
// (D8), right after the commit: no other request runs, so no later write
// can land before the messages are prepared. Only the delivery is
// deferred: the prepared messages are sent from a queue, the broadcasts of
// an app one after the other, so a client gets a record's messages in the
// order of its changes (upstream sends each from its own goroutine).
// Within one broadcast, subscribers whose rule check reads the same values
// (rule, query, headers, auth record) share one check, and the JSON data
// of a message is encoded once for the subscribers that get the same bytes
// (no expand, the same superuser and email visibility state and `fields`);
// upstream checks and encodes for each (docs/perf/M5.1-realtime.md).
//
// The delete dry cache runs inside the delete chain, before the row is
// deleted, so the rules still see the record. It prepares the complete
// messages there, expand and `fields` included, as upstream does: inside a
// transaction (a cascade delete) the expand reads through the transaction,
// so relations deleted later in it are still expanded, while the rule
// checks read the data as last committed (upstream's outside-scoped app,
// Databases.committedReads()). The messages are sent after the commit.

import type { App } from "@/app/app";
import { RequestInfo, RequestInfoContextRealtime } from "@/app/event-request";
import {
  checkForSuperuserOnlyRuleFields,
  expandFetchSync,
  expandQueryParam,
  fieldsQueryParam,
  newRequestFieldResolver,
} from "@/apis/record-helpers";
import type { Collection } from "@/collections/collection-model";
import type { CollectionsApp } from "@/collections/collection-query";
import { HashExp } from "@/db/dbx/expression";
import type { SelectQuery } from "@/db/dbx/select";
import type { Record } from "@/records/record-model";
import { type RecordsApp, recordQuery } from "@/records/record-query";
import { expandRecordSync } from "@/records/record-query-expand";
import { filterBuildExpr } from "@/search/filter";
import { FilterQueryParam } from "@/search/provider";
import { pick } from "@/tools/picker/pick";
import type { Broker } from "@/tools/subscriptions/broker";
import type { Client, SubscriptionOptions } from "@/tools/subscriptions/client";
import { Message } from "@/tools/subscriptions/message";
import { marshal } from "@/tools/types/go-json";

// note: the chunk size is arbitrary chosen and may change in the future
const clientsChunkSize = 150;

// RealtimeClientAuthKey is the name of the realtime client store key that holds its auth state.
export const RealtimeClientAuthKey = "auth";

// RealtimeClientIPKey is the name of the realtime client store key that holds the IP of the connected client.
export const RealtimeClientIPKey = "pbRealtimeClientIP";

// the app store keys of the broadcast queue and the auth record keys
const broadcastQueueStoreKey = "@realtimeBroadcastQueue";
const authKeysStoreKey = "@realtimeAuthKeys";

const encoder = new TextEncoder();

// -------------------------------------------------------------------
// the event handlers

// OnModelAfterCreateSuccess: broadcasts the created record.
export function realtimeRecordAfterCreate(app: RecordsApp, record: Record): void {
  realtimeBroadcastRecord(app, "create", record);
}

// OnModelAfterUpdateSuccess: updates the clients that has auth record
// association, then broadcasts the updated record.
export function realtimeRecordAfterUpdate(app: RecordsApp, record: Record): void {
  if (record.collection().isAuth()) {
    realtimeUpdateClientsAuth(app, record);
  }
  realtimeBroadcastRecord(app, "update", record);
}

// OnModelDelete (delete: dry cache): prepares the delete messages while
// the record still exists.
export function realtimeRecordDelete(app: RecordsApp, record: Record): void {
  try {
    dryCacheRecordDelete(app, record);
  } catch (err) {
    // the delete goes on (upstream only logs the error)
    app.logger.error("Failed to dry cache the realtime record delete", err);
  }
}

function dryCacheRecordDelete(app: RecordsApp, record: Record): void {
  const broker = app.subscriptionsBroker;
  if (broker === undefined || broker.totalClients() === 0) {
    return; // no subscribers
  }

  // note: use the outside scoped app instance for the access checks so that the API rules
  // are performed out of the delete transaction ensuring that they would still work even if
  // a cascade-deleted record's API rule relies on an already deleted parent record
  const accessCheckApp: RecordsApp = app.databases.isTransactional()
    ? { ...app, databases: app.databases.committedReads() }
    : app;

  const broadcast = new RecordBroadcast(app, accessCheckApp, "delete", record);
  const dryCacheKey = getDryCacheKey("delete", record);

  for (const chunk of broker.chunkedClients(clientsChunkSize)) {
    for (const client of chunk) {
      const messages = broadcast.clientMessages(client);
      if (messages.length === 0) {
        continue;
      }
      const cached = client.get(dryCacheKey);
      client.set(dryCacheKey, Array.isArray(cached) ? [...cached, ...messages] : messages);
    }
  }
}

// OnModelAfterDeleteSuccess: unsets the auth of the clients of a deleted
// auth record, then broadcasts the dry cached delete messages.
export function realtimeRecordAfterDelete(app: RecordsApp, record: Record): void {
  if (record.collection().isAuth()) {
    realtimeUnsetClientsAuthByRecord(app, record);
  }

  const broker = app.subscriptionsBroker;
  if (broker === undefined) {
    return;
  }
  realtimeBroadcastDryCacheKey(app, broker, getDryCacheKey("delete", record));
}

// OnModelAfterDeleteError: removes the dry cached delete messages.
export function realtimeRecordAfterDeleteError(app: RecordsApp, record: Record): void {
  realtimeUnsetDryCacheKey(app, getDryCacheKey("delete", record));
}

// OnCollectionUpdate: resets the clients auth on collection secret change.
// cached is the collection as it was before the save (nil for a new or
// non-auth collection); called once the save succeeded.
//
// (@todo with the future tracking of old collections data consider replacing with *AfterUpdateSuccess to account for transaction rollback)
export function realtimeCollectionUpdate(
  app: CollectionsApp,
  collection: Collection,
  cached: Collection | null,
): void {
  if (cached !== null && cached.authToken.secret !== collection.authToken.secret) {
    realtimeUnsetClientsAuthByCollection(app, collection);
  }
}

// OnCollectionAfterDeleteSuccess: unsets the clients auth on auth
// collection delete.
export function realtimeCollectionAfterDelete(app: CollectionsApp, collection: Collection): void {
  if (collection.isAuth()) {
    realtimeUnsetClientsAuthByCollection(app, collection);
  }
}

// -------------------------------------------------------------------
// the clients auth

// realtimeUpdateClientsAuth updates the auth state of all clients related to the provided authRecord.
//
// Realtime connections has short lifetime by design, but to minimize abuse
// if the new record has a different tokenKey (e.g. in case of password reset)
// the auth state of the related realtime connections is also cleared
// (aka. they remain active but unauthenticated, allowing to reauthenicate with the next subscription).
function realtimeUpdateClientsAuth(app: CollectionsApp, authRecord: Record): void {
  for (const client of app.subscriptionsBroker?.clients().values() ?? []) {
    const clientAuth = clientAuthRecord(client);
    if (
      clientAuth !== undefined &&
      clientAuth.id === authRecord.id &&
      clientAuth.collection().name === authRecord.collection().name
    ) {
      if (clientAuth.tokenKey() !== authRecord.tokenKey()) {
        client.unset(RealtimeClientAuthKey);
      } else {
        // a copy, so later changes of the saved instance do not leak in
        client.set(RealtimeClientAuthKey, authRecord.fresh());
      }
    }
  }
}

// realtimeUnsetClientsAuthByRecordModelOrProxy unsets the auth state of all clients that have the provided auth model.
function realtimeUnsetClientsAuthByRecord(app: CollectionsApp, authRecord: Record): void {
  for (const client of app.subscriptionsBroker?.clients().values() ?? []) {
    const clientAuth = clientAuthRecord(client);
    if (
      clientAuth !== undefined &&
      clientAuth.id === authRecord.id &&
      clientAuth.collection().name === authRecord.tableName()
    ) {
      client.unset(RealtimeClientAuthKey);
    }
  }
}

// realtimeUnsetClientsAuthByCollection unsets the auth state of all authenticated clients related to the collection.
function realtimeUnsetClientsAuthByCollection(app: CollectionsApp, collection: Collection): void {
  for (const client of app.subscriptionsBroker?.clients().values() ?? []) {
    const clientAuth = clientAuthRecord(client);
    if (clientAuth !== undefined && clientAuth.collection().name === collection.name) {
      client.unset(RealtimeClientAuthKey);
    }
  }
}

// client.Get(RealtimeClientAuthKey).(*core.Record)
export function clientAuthRecord(client: Client): Record | undefined {
  const auth = client.get(RealtimeClientAuthKey);
  return auth === undefined || auth === null ? undefined : (auth as Record);
}

// isSameAuth reports whether both are the same auth record (or both nil).
export function isSameAuth(authA: Record | undefined, authB: Record | undefined): boolean {
  if (authA === undefined) {
    return authB === undefined;
  }

  if (authB === undefined) {
    return false;
  }

  return authA.id === authB.id && authA.collection().id === authB.collection().id;
}

// -------------------------------------------------------------------
// the broadcasts

// realtimeBroadcastRecord broadcasts the record change to the subscribed
// clients that may access it, after the broadcasts before it.
function realtimeBroadcastRecord(app: RecordsApp, action: string, record: Record): void {
  const broker = app.subscriptionsBroker;
  if (broker === undefined || broker.totalClients() === 0) {
    return; // no subscribers
  }

  // the record as saved: the caller may change the instance afterwards
  const broadcast = new RecordBroadcast(app, app, action, record.fresh());

  // prepared now, against the database state this write left
  const pending: [Client, Message[]][] = [];
  for (const chunk of broker.chunkedClients(clientsChunkSize)) {
    for (const client of chunk) {
      const messages = broadcast.clientMessages(client);
      if (messages.length > 0) {
        pending.push([client, messages]);
      }
    }
  }

  sendLater(app, pending);
}

// sends the prepared messages after the broadcasts before them
function sendLater(app: RecordsApp, pending: [Client, Message[]][]): void {
  if (pending.length === 0) {
    return;
  }

  broadcastQueue(app).add(() => {
    for (const [client, messages] of pending) {
      for (const msg of messages) {
        client.send(msg);
      }
    }
  });
}

// realtimeBroadcastDryCacheKey broadcasts the dry cached key related messages.
function realtimeBroadcastDryCacheKey(app: RecordsApp, broker: Broker, key: string): void {
  if (broker.totalClients() === 0) {
    return; // no subscribers
  }

  const pending: [Client, Message[]][] = [];
  for (const client of broker.clients().values()) {
    const messages = client.get(key);
    if (!Array.isArray(messages)) {
      continue;
    }

    client.unset(key);

    pending.push([client, messages as Message[]]);
  }

  sendLater(app, pending);
}

// realtimeUnsetDryCacheKey removes the dry cached key related messages.
function realtimeUnsetDryCacheKey(app: CollectionsApp, key: string): void {
  for (const client of app.subscriptionsBroker?.clients().values() ?? []) {
    if (client.get(key) !== undefined) {
      client.unset(key);
    }
  }
}

function getDryCacheKey(action: string, record: Record): string {
  return action + "/" + record.tableName() + "/" + record.id;
}

// One record change and what its subscribers get.
class RecordBroadcast {
  readonly #collection: Collection;
  // the subscription topic prefixes with the rule each is checked against
  readonly #subscriptionRules: [string, string | null][];
  // the encoded data shared by the subscribers that get the same bytes
  readonly #encoded = new Map<string, Uint8Array>();
  // the access checks made so far, by everything their result depends on
  readonly #access = new Map<string, boolean>();
  // the auth records' part of those keys
  readonly #authKeys: WeakMap<Record, string>;

  // app runs the expand; accessCheckApp the rule checks. Every read is
  // synchronous: the messages are prepared before any later write.
  constructor(
    readonly app: RecordsApp,
    readonly accessCheckApp: RecordsApp,
    readonly action: string,
    readonly record: Record,
  ) {
    const collection = record.collection();
    this.#collection = collection;
    this.#authKeys = authKeys(app);
    this.#subscriptionRules = [
      [collection.name + "/" + record.id + "?", collection.viewRule],
      [collection.id + "/" + record.id + "?", collection.viewRule],
      [collection.name + "/*?", collection.listRule],
      [collection.id + "/*?", collection.listRule],

      // @deprecated: the same as the wildcard topic but kept for backward compatibility
      [collection.name + "?", collection.listRule],
      [collection.id + "?", collection.listRule],
    ];
  }

  // the messages of one client, in its subscriptions' order
  clientMessages(client: Client): Message[] {
    const collection = this.#collection;
    const messages: Message[] = [];

    // note: not executed concurrently to avoid races and to ensure
    // that the access checks are applied for the current record db state
    for (const [prefix, rule] of this.#subscriptionRules) {
      const subs = client.subscriptions(prefix);
      if (subs.size === 0) {
        continue;
      }

      const clientAuth = clientAuthRecord(client);

      for (const [sub, options] of subs) {
        // mock request data
        const requestInfo = subscriptionRequestInfo(options, clientAuth);

        if (!this.#canAccessRecord(this.record, requestInfo, rule)) {
          continue;
        }

        const superuser = requestInfo.hasSuperuserAuth();
        const rawExpand = queryValue(options, expandQueryParam);
        const rawFields = queryValue(options, fieldsQueryParam);

        // ignore the auth record email visibility checks
        // for auth owner, superuser or manager
        // (upstream checks the clean record after its expand: the same
        // id, collection and database state)
        let ignoreEmailVisibility = false;
        if (collection.isAuth()) {
          ignoreEmailVisibility =
            isSameAuth(clientAuth, this.record) ||
            this.#canAccessRecord(this.record, requestInfo, collection.manageRule);
        }

        // the same bytes as an earlier subscriber's
        const sharedKey =
          rawExpand === ""
            ? (superuser ? "s" : "-") + (ignoreEmailVisibility ? "e" : "-") + rawFields
            : "";
        const shared = sharedKey === "" ? undefined : this.#encoded.get(sharedKey);
        if (shared !== undefined) {
          messages.push(new Message(sub, shared));
          continue;
        }

        // create a clean record copy without expand and unknown fields because we don't know yet
        // which exact fields the client subscription requested or has permissions to access
        const cleanRecord = this.record.fresh();

        // enable hidden fields for superuser subscribers
        if (superuser) {
          cleanRecord.unhide(...collection.fields.fieldNames());
        }

        if (ignoreEmailVisibility) {
          cleanRecord.ignoreEmailVisibility(true);
        }

        // apply expand
        if (rawExpand !== "") {
          // expand errors are only logged upstream
          expandRecordSync(
            this.app,
            cleanRecord,
            rawExpand.split(","),
            expandFetchSync(this.app as App, requestInfo),
          );
        }

        // check fields
        const data = encoder.encode(recordData(this.action, cleanRecord, rawFields));
        if (sharedKey !== "") {
          this.#encoded.set(sharedKey, data);
        }
        messages.push(new Message(sub, data));
      }
    }

    return messages;
  }

  // realtimeCanAccessRecord checks if the subscription client has access to the specified record model.
  //
  // The result depends only on the record, the rule, the subscription's
  // query and headers and the client's auth record (what the field
  // resolver reads of it), so the subscribers with the same of these share
  // one check per broadcast (upstream checks each).
  #canAccessRecord(record: Record, requestInfo: RequestInfo, accessRule: string | null): boolean {
    let key: string;
    try {
      key =
        record.id +
        "\0" +
        (accessRule === null ? "\u0001" : accessRule) +
        "\0" +
        (requestInfo.auth === undefined ? "" : this.#authKey(requestInfo.auth)) +
        "\0" +
        JSON.stringify(requestInfo.query) +
        "\0" +
        JSON.stringify(requestInfo.headers);
    } catch {
      // an auth record that cannot be encoded: checked on its own
      return this.#checkAccess(record, requestInfo, accessRule);
    }
    let ok = this.#access.get(key);
    if (ok === undefined) {
      ok = this.#checkAccess(record, requestInfo, accessRule);
      this.#access.set(key, ok);
    }
    return ok;
  }

  // the auth record as the field resolver sees it (@request.auth.*); a
  // client's auth record is never changed once set (an update sets a copy)
  #authKey(auth: Record): string {
    let key = this.#authKeys.get(auth);
    if (key === undefined) {
      const clone = auth.clone();
      key =
        clone.collection().id +
        "\0" +
        marshal(
          clone
            .unhide(...clone.collection().fields.fieldNames())
            .ignoreEmailVisibility(true)
            .publicExport(),
        );
      this.#authKeys.set(auth, key);
    }
    return key;
  }

  #checkAccess(record: Record, requestInfo: RequestInfo, accessRule: string | null): boolean {
    const app = this.accessCheckApp;

    // check the access rule (app.CanAccessRecord; false on error)
    // ---
    try {
      const query = accessQuery(app, record, requestInfo, accessRule);
      if (typeof query === "boolean") {
        if (!query) {
          return false;
        }
      } else {
        const row = query.row();
        if (!(Number(row[0]) > 0)) {
          return false;
        }
      }
    } catch {
      return false;
    }

    // check the subscription client-side filter (if any)
    // ---
    const filter = Object.hasOwn(requestInfo.query, FilterQueryParam)
      ? (requestInfo.query[FilterQueryParam] as string)
      : "";
    if (filter === "") {
      return true; // no further checks needed
    }

    if (checkForSuperuserOnlyRuleFields(requestInfo) !== undefined) {
      return false;
    }

    try {
      const collection = record.collection();
      const q = app.databases
        .concurrentDB()
        .select("(1)")
        .from(collection.name)
        .andWhere(new HashExp({ [collection.name + ".id"]: record.id }));

      const resolver = newRequestFieldResolver(app as App, collection, requestInfo, false);
      const expr = filterBuildExpr(filter, resolver, resolver.filterOptions());

      q.andWhere(expr);

      resolver.updateQuery(q);

      q.limit(1);
      const row = q.row();

      return Number(row[0]) > 0;
    } catch {
      return false;
    }
  }
}

// CanAccessRecord's query (src/records/record-query-filter.ts), or its
// result when no query is needed, with the app's parsed filters cache: one
// broadcast checks the same rule for every subscriber
function accessQuery(
  app: RecordsApp,
  record: Record,
  requestInfo: RequestInfo,
  accessRule: string | null,
): SelectQuery | boolean {
  // superusers can access everything
  if (requestInfo.hasSuperuserAuth()) {
    return true;
  }

  // only superusers can access this record
  if (accessRule === null) {
    return false;
  }

  // empty public rule, aka. everyone can access
  if (accessRule === "") {
    return true;
  }

  const query = recordQuery(app, record.collection())
    .select("(1)")
    .andWhere(new HashExp({ [record.collection().name + ".id"]: record.id }));

  // parse and apply the access rule filter
  const resolver = newRequestFieldResolver(app as App, record.collection(), requestInfo, true);
  const expr = filterBuildExpr(accessRule, resolver, resolver.filterOptions());

  resolver.updateQuery(query);

  return query.andWhere(expr).limit(1);
}

// the RequestInfo a subscription's rules are checked with
function subscriptionRequestInfo(
  options: SubscriptionOptions,
  auth: Record | undefined,
): RequestInfo {
  const info = new RequestInfo();
  info.context = RequestInfoContextRealtime;
  info.method = "GET";
  info.query = options.query;
  info.headers = options.headers;
  info.body = null;
  info.auth = auth;
  return info;
}

function queryValue(options: SubscriptionOptions, key: string): string {
  return Object.hasOwn(options.query, key) ? (options.query[key] as string) : "";
}

// recordData: the broadcasted record subscription message data,
// {"record":…,"action":…} (Go's struct field order)
function recordData(action: string, record: Record, rawFields: string): string {
  let encodedRecord: string | undefined;

  if (rawFields !== "") {
    try {
      encodedRecord = marshal(pick(record, rawFields));
    } catch {
      // pick fields errors are only logged upstream
    }
  }

  encodedRecord ??= record.marshalJSON();

  return `{"record":${encodedRecord},"action":${JSON.stringify(action)}}`;
}

// The broadcasts of an app, delivered one after the other.
class BroadcastQueue {
  #tail: Promise<void> = Promise.resolve();

  add(task: () => void): void {
    this.#tail = this.#tail.then(task).catch(() => {
      // a failed broadcast is only logged upstream
    });
  }
}

// the access check keys of the clients' auth records, kept while a client
// holds the record
function authKeys(app: CollectionsApp): WeakMap<Record, string> {
  return app.store.getOrSet(authKeysStoreKey, () => new WeakMap()) as WeakMap<Record, string>;
}

function broadcastQueue(app: CollectionsApp): BroadcastQueue {
  return app.store.getOrSet(broadcastQueueStoreKey, () => new BroadcastQueue()) as BroadcastQueue;
}
