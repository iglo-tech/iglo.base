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
// clients each, and sends every message from its own goroutine. Here the
// checks read through the async resolvers (the read worker pool), the
// chunks run concurrently, and the broadcasts of an app are delivered one
// after the other, so a client gets a record's messages in the order of
// its changes. The JSON data of a message is encoded once per broadcast
// for the subscribers that get the same bytes (no expand, the same
// superuser and email visibility state and `fields`).
//
// The delete dry cache runs inside the delete chain, before the row is
// deleted, so the rules still see the record. Outside a transaction it
// reads like the broadcasts. Inside one (a cascade delete, a superuser
// delete) the chain must stay synchronous: the rule checks read the
// committed data synchronously (upstream's outside-scoped app,
// Databases.committedReads()), and a subscription's `expand` is applied
// when the message is sent, after the commit, since the expand reads are
// async.

import type { App } from "@/app/app";
import { RequestInfo, RequestInfoContextRealtime } from "@/app/event-request";
import {
  checkForSuperuserOnlyRuleFields,
  expandFetch,
  expandQueryParam,
  fieldsQueryParam,
} from "@/apis/record-helpers";
import type { Collection } from "@/collections/collection-model";
import type { CollectionsApp } from "@/collections/collection-query";
import { HashExp } from "@/db/dbx/expression";
import type { Record } from "@/records/record-model";
import type { RecordsApp } from "@/records/record-query";
import { expandRecord } from "@/records/record-query-expand";
import { canAccessRecord, canAccessRecordAsync } from "@/records/record-query-filter";
import { newRecordFieldResolver } from "@/resolver/record-field-resolver";
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

// the app store key of the broadcast queue
const broadcastQueueStoreKey = "@realtimeBroadcastQueue";

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
// the record still exists. A step of the record delete chain: it yields
// the promises it waits for (none inside a transaction).
export function* realtimeRecordDelete(
  app: RecordsApp,
  record: Record,
): Generator<unknown, void, unknown> {
  try {
    yield* dryCacheRecordDelete(app, record);
  } catch (err) {
    // the delete goes on (upstream only logs the error)
    app.logger.error("Failed to dry cache the realtime record delete", err);
  }
}

function* dryCacheRecordDelete(app: RecordsApp, record: Record): Generator<unknown, void, unknown> {
  const broker = app.subscriptionsBroker;
  if (broker === undefined || broker.totalClients() === 0) {
    return; // no subscribers
  }

  const sync = app.databases.isTransactional();

  // note: use the outside scoped app instance for the access checks so that the API rules
  // are performed out of the delete transaction ensuring that they would still work even if
  // a cascade-deleted record's API rule relies on an already deleted parent record
  const accessCheckApp: RecordsApp = sync
    ? { ...app, databases: app.databases.committedReads() }
    : app;

  const broadcast = new RecordBroadcast(app, accessCheckApp, "delete", record, sync);
  const dryCacheKey = getDryCacheKey("delete", record);

  const cache = (client: Client, messages: DryMessage[]): void => {
    if (messages.length === 0) {
      return;
    }
    const cached = client.get(dryCacheKey);
    client.set(dryCacheKey, Array.isArray(cached) ? [...cached, ...messages] : messages);
  };

  const chunks = broker.chunkedClients(clientsChunkSize);
  if (sync) {
    for (const chunk of chunks) {
      for (const client of chunk) {
        cache(client, driveSync(broadcast.clientMessages(client)));
      }
    }
    return;
  }

  yield Promise.all(
    chunks.map(async (chunk) => {
      for (const client of chunk) {
        cache(client, await drive(broadcast.clientMessages(client)));
      }
    }),
  );
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

// a dry cached message: ready, or waiting for its expand (prepared inside
// a transaction)
type DryMessage = Message | DeferredMessage;

interface DeferredMessage {
  sub: string;
  record: Record;
  requestInfo: RequestInfo;
  rawExpand: string;
  rawFields: string;
  action: string;
}

// realtimeBroadcastRecord broadcasts the record change to the subscribed
// clients that may access it, after the broadcasts before it.
function realtimeBroadcastRecord(app: RecordsApp, action: string, record: Record): void {
  const broker = app.subscriptionsBroker;
  if (broker === undefined || broker.totalClients() === 0) {
    return; // no subscribers
  }

  // the record as saved: the caller may change the instance afterwards
  const broadcast = new RecordBroadcast(app, app, action, record.fresh(), false);

  broadcastQueue(app).add(async () => {
    const chunks = broker.chunkedClients(clientsChunkSize);
    await Promise.all(
      chunks.map(async (chunk) => {
        for (const client of chunk) {
          for (const msg of await drive(broadcast.clientMessages(client))) {
            client.send(msg as Message);
          }
        }
      }),
    );
  });
}

// realtimeBroadcastDryCacheKey broadcasts the dry cached key related messages.
function realtimeBroadcastDryCacheKey(app: RecordsApp, broker: Broker, key: string): void {
  if (broker.totalClients() === 0) {
    return; // no subscribers
  }

  const pending: [Client, DryMessage[]][] = [];
  for (const client of broker.clients().values()) {
    const messages = client.get(key);
    if (!Array.isArray(messages)) {
      continue;
    }

    client.unset(key);

    pending.push([client, messages as DryMessage[]]);
  }

  if (pending.length === 0) {
    return;
  }

  broadcastQueue(app).add(async () => {
    for (const [client, messages] of pending) {
      for (const msg of messages) {
        const ready = msg instanceof Message ? msg : await deferredMessage(app, msg);
        client.send(ready);
      }
    }
  });
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

// a dry cached message whose expand waited for the commit
async function deferredMessage(app: RecordsApp, msg: DeferredMessage): Promise<Message> {
  try {
    await expandRecord(
      app,
      msg.record,
      msg.rawExpand.split(","),
      expandFetch(app as App, msg.requestInfo),
    );
  } catch {
    // expand errors are only logged upstream
  }
  return new Message(msg.sub, encoder.encode(recordData(msg.action, msg.record, msg.rawFields)));
}

// One record change and what its subscribers get.
class RecordBroadcast {
  readonly #collection: Collection;
  // the subscription topic prefixes with the rule each is checked against
  readonly #subscriptionRules: [string, string | null][];
  // the encoded data shared by the subscribers that get the same bytes
  readonly #encoded = new Map<string, Uint8Array>();

  // app runs the expand; accessCheckApp the rule checks. sync: inside a
  // transaction, nothing may wait (the expand is deferred).
  constructor(
    readonly app: RecordsApp,
    readonly accessCheckApp: RecordsApp,
    readonly action: string,
    readonly record: Record,
    readonly sync: boolean,
  ) {
    const collection = record.collection();
    this.#collection = collection;
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

  // the messages of one client, in its subscriptions' order; yields the
  // promises it waits for
  *clientMessages(client: Client): Generator<unknown, DryMessage[], unknown> {
    const collection = this.#collection;
    const messages: DryMessage[] = [];

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

        if (!(yield* this.#canAccessRecord(this.record, requestInfo, rule))) {
          continue;
        }

        // create a clean record copy without expand and unknown fields because we don't know yet
        // which exact fields the client subscription requested or has permissions to access
        const cleanRecord = this.record.fresh();

        // enable hidden fields for superuser subscribers
        if (requestInfo.hasSuperuserAuth()) {
          cleanRecord.unhide(...collection.fields.fieldNames());
        }

        // apply expand
        const rawExpand = queryValue(options, expandQueryParam);
        let deferExpand = false;
        if (rawExpand !== "") {
          if (this.sync) {
            deferExpand = true;
          } else {
            try {
              yield expandRecord(
                this.app,
                cleanRecord,
                rawExpand.split(","),
                expandFetch(this.app as App, requestInfo),
              );
            } catch {
              // expand errors are only logged upstream
            }
          }
        }

        // ignore the auth record email visibility checks
        // for auth owner, superuser or manager
        let ignoreEmailVisibility = false;
        if (collection.isAuth()) {
          if (
            isSameAuth(clientAuth, cleanRecord) ||
            (yield* this.#canAccessRecord(cleanRecord, requestInfo, collection.manageRule))
          ) {
            cleanRecord.ignoreEmailVisibility(true);
            ignoreEmailVisibility = true;
          }
        }

        // check fields
        const rawFields = queryValue(options, fieldsQueryParam);

        if (deferExpand) {
          messages.push({
            sub,
            record: cleanRecord,
            requestInfo,
            rawExpand,
            rawFields,
            action: this.action,
          });
          continue;
        }

        messages.push(
          new Message(
            sub,
            this.#data(cleanRecord, rawExpand, rawFields, requestInfo, ignoreEmailVisibility),
          ),
        );
      }
    }

    return messages;
  }

  // the message data; the same bytes for the subscribers without expand
  // and with the same visibility and fields
  #data(
    cleanRecord: Record,
    rawExpand: string,
    rawFields: string,
    info: RequestInfo,
    ignoreEmailVisibility: boolean,
  ): Uint8Array {
    if (rawExpand !== "") {
      return encoder.encode(recordData(this.action, cleanRecord, rawFields));
    }
    const key =
      (info.hasSuperuserAuth() ? "s" : "-") + (ignoreEmailVisibility ? "e" : "-") + rawFields;
    let data = this.#encoded.get(key);
    if (data === undefined) {
      data = encoder.encode(recordData(this.action, cleanRecord, rawFields));
      this.#encoded.set(key, data);
    }
    return data;
  }

  // realtimeCanAccessRecord checks if the subscription client has access to the specified record model.
  *#canAccessRecord(
    record: Record,
    requestInfo: RequestInfo,
    accessRule: string | null,
  ): Generator<unknown, boolean, unknown> {
    const app = this.accessCheckApp;

    // check the access rule
    // ---
    try {
      const ok = yield this.sync
        ? canAccessRecord(app, record, requestInfo, accessRule)
        : canAccessRecordAsync(app, record, requestInfo, accessRule);
      if (ok !== true) {
        return false;
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

      const resolver = newRecordFieldResolver(app, collection, requestInfo, false);
      const expr = filterBuildExpr(filter, resolver, resolver.filterOptions());

      q.andWhere(expr);

      resolver.updateQuery(q);

      q.limit(1);
      const row = (yield this.sync ? q.row() : q.rowAsync()) as unknown[];

      return Number(row[0]) > 0;
    } catch {
      return false;
    }
  }
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

// -------------------------------------------------------------------
// drivers

// runs a generator, awaiting the promises it yields
async function drive<T>(gen: Generator<unknown, T, unknown>): Promise<T> {
  let input: unknown;
  let failed = false;
  for (;;) {
    const res = failed ? gen.throw(input) : gen.next(input);
    if (res.done === true) {
      return res.value;
    }
    failed = false;
    if (res.value instanceof Promise) {
      try {
        input = await res.value;
      } catch (err) {
        input = err;
        failed = true;
      }
    } else {
      input = res.value;
    }
  }
}

// runs a generator that yields no promises (inside a transaction)
function driveSync<T>(gen: Generator<unknown, T, unknown>): T {
  let res = gen.next();
  while (res.done !== true) {
    if (res.value instanceof Promise) {
      throw new Error("realtime dry cache must be synchronous inside a transaction");
    }
    res = gen.next(res.value);
  }
  return res.value;
}

// The broadcasts of an app, delivered one after the other.
class BroadcastQueue {
  #tail: Promise<void> = Promise.resolve();

  add(task: () => Promise<void>): void {
    this.#tail = this.#tail.then(task).catch(() => {
      // a failed broadcast is only logged upstream
    });
  }
}

function broadcastQueue(app: CollectionsApp): BroadcastQueue {
  return app.store.getOrSet(broadcastQueueStoreKey, () => new BroadcastQueue()) as BroadcastQueue;
}
