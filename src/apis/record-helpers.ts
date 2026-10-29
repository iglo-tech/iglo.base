// Upstream: apis/record_helpers.go (RecordAuthResponse,
// recordAuthResponse, wantsMFA, checkMFA, EnrichRecord, EnrichRecords,
// defaultEnrichRecords, expandFetch, autoResolveRecordsFlags,
// checkForSuperuserOnlyRuleFields, firstApiError, execAfterSuccessTx,
// authAlert)
//
// The OnRecordEnrich and OnRecordAuthRequest hook chains
// (triggerRecordEnrichHooks) are not ported (no extension surface): their
// default actions run directly, in upstream's order. The record reads are
// async and go through the read worker pool. Upstream logs a failed
// default enrich or expand as a warning in its `_logs` (M5); here those
// failures are dropped, as upstream drops them from the response. A
// failed auth alert is reported to the app's error logger.
//
// The auth alert email is mails.SendRecordAuthAlert (src/mail/mails).

import type { App } from "@/app/app";
import { type RequestEvent, RequestInfo, RequestInfoContextExpand } from "@/app/event-request";
import type { Collection } from "@/collections/collection-model";
import { HashExp, inExp } from "@/db/dbx/expression";
import type { SelectQuery } from "@/db/dbx/select";
import { sendRecordAuthAlert } from "@/mail/mails/record";
import { isIPInList } from "@/middlewares/superuser-ips-whitelist";
import {
  type AuthOrigin,
  deleteAuthOrigin,
  newAuthOrigin,
  saveAuthOrigin,
} from "@/records/auth-origin-model";
import { findAllAuthOriginsByRecord } from "@/records/auth-origin-query";
import { deleteMFA, type MFA, newMFA, saveMFA } from "@/records/mfa-model";
import { findMFAById } from "@/records/mfa-query";
import type { Record } from "@/records/record-model";
import { recordQuery, recordsTarget } from "@/records/record-query";
import { canAccessRecordAsync } from "@/records/record-query-filter";
import { type ExpandFetchFunc, expandRecords } from "@/records/record-query-expand";
import { isNoRows } from "@/records/record-save";
import { newAuthToken } from "@/records/record-tokens";
import { newRecordFieldResolver } from "@/resolver/record-field-resolver";
import { ApiError, errorsAs, newForbiddenError, newInternalServerError } from "@/server/error";
import type { HandlerResult } from "@/server/handler";
import { structOf } from "@/server/unmarshal-request-data";
import { filterBuildExpr, ParsedFilterCache } from "@/search/filter";
import { FilterQueryParam, SortQueryParam } from "@/search/provider";
import { nowDateTime } from "@/tools/types/datetime";
import { type JSONMarshaler, marshal } from "@/tools/types/go-json";

export const expandQueryParam = "expand";
export const fieldsQueryParam = "fields";

// ErrMFA is returned (after the 401 `mfaId` response is written) when the
// auth requires an extra step.
export const ErrMFA = new Error("mfa required");

// the app store key of the parsed filters cache that the request handlers
// share (upstream's package-level cache in tools/search)
const parsedFilterCacheStoreKey = "@igloParsedFilterCache";

// The parsed filters cache of the app (created on first use).
export function parsedFilterCache(app: App): ParsedFilterCache {
  return app.store.getOrSet(
    parsedFilterCacheStoreKey,
    () => new ParsedFilterCache(),
  ) as ParsedFilterCache;
}

// core.NewRecordFieldResolver with the app's parsed filters cache
export function newRequestFieldResolver(
  app: App,
  collection: Collection,
  requestInfo: RequestInfo | null,
  allowHiddenFields: boolean,
): ReturnType<typeof newRecordFieldResolver> {
  const resolver = newRecordFieldResolver(app, collection, requestInfo, allowHiddenFields);
  resolver.filterCache = parsedFilterCache(app);
  return resolver;
}

// RecordAuthResponse writes standardized json record auth response
// into the specified request context.
//
// The authMethod argument specify the name of the current authentication method (eg. password, oauth2, etc.)
// that it is used primarily as an auth identifier during MFA and for login alerts.
//
// Set authMethod to empty string if you want to ignore the MFA checks and the login alerts.
export async function recordAuthResponseWithNewToken(
  e: RequestEvent,
  authRecord: Record,
  authMethod: string,
  meta: unknown,
): Promise<HandlerResult> {
  let token: string;
  try {
    token = newAuthToken(authRecord, e.app.clock);
  } catch (err) {
    return e.internalServerError("Failed to create auth token.", err);
  }

  return recordAuthResponse(e, authRecord, token, authMethod, meta);
}

// recordAuthResponse; meta is omitted from the body when undefined (Go's
// nil any with omitempty)
export async function recordAuthResponse(
  e: RequestEvent,
  authRecord: Record,
  token: string,
  authMethod: string,
  meta: unknown,
): Promise<HandlerResult> {
  if (authRecord.isSuperuser()) {
    const allowedIPs = e.app.settings.SuperuserIPs ?? [];
    if (allowedIPs.length > 0 && !isIPInList(allowedIPs, e.realIP())) {
      return e.forbiddenError("", new Error("superuser IP is not whitelisted"));
    }
  }

  const originalRequestInfo = await e.requestInfo();
  if (originalRequestInfo instanceof Error) {
    return originalRequestInfo;
  }

  let ok = false;
  let accessErr: unknown;
  try {
    ok = await canAccessRecordAsync(
      e.app,
      authRecord,
      originalRequestInfo,
      authRecord.collection().authRule,
    );
  } catch (err) {
    accessErr = err;
  }
  if (!ok) {
    return firstApiError(
      accessErr,
      e.forbiddenError(
        "The request doesn't satisfy the collection requirements to authenticate.",
        accessErr ?? null,
      ),
    );
  }

  // the OnRecordAuthRequest default action
  if (e.written()) {
    return undefined;
  }

  // MFA
  // ---
  const [mfaId, mfaErr] = await checkMFA(e, authRecord, authMethod);
  if (mfaErr) {
    return mfaErr;
  }

  // require additional authentication
  if (mfaId !== "") {
    // eagerly write the mfa response and return an err so that
    // external middlewars are aware that the auth response requires an extra step
    e.json(401, { mfaId });
    return ErrMFA;
  }
  // ---

  // create a shallow copy of the cached request data and adjust it to the current auth record
  const requestInfo = Object.assign(new RequestInfo(), originalRequestInfo);
  requestInfo.auth = authRecord;

  // the OnRecordEnrich default action
  if (authRecord.isSuperuser()) {
    authRecord.unhide(...authRecord.collection().fields.fieldNames());
  }

  // allow always returning the email address of the authenticated model
  authRecord.ignoreEmailVisibility(true);

  // expand record relations
  const expands = (e.request.query().get(expandQueryParam)?.[0] ?? "").split(",");
  if (expands.length > 0) {
    // failures are only logged upstream ("Failed to expand relations")
    await expandRecords(e.app, [authRecord], expands, expandFetch(e.app, requestInfo));
  }

  if (authMethod !== "" && authRecord.collection().authAlert.enabled) {
    try {
      await authAlert(e, authRecord);
    } catch (err) {
      e.app.logger.error("[recordAuthResponse] Failed to send login alert", err);
    }
  }

  // execAfterSuccessTx: the auth handlers never run in a transaction here
  return e.json(200, new RecordAuthResult(authRecord, token, meta));
}

// the auth response body: {"meta"?, "record", "token"}, in this order
class RecordAuthResult implements JSONMarshaler {
  constructor(
    readonly record: Record,
    readonly token: string,
    readonly meta: unknown,
  ) {}

  marshalJSON(): string {
    // marshal writes a plain object's members sorted by name, which is
    // the struct's field order here
    const result: { [key: string]: unknown } = { record: this.record, token: this.token };
    if (this.meta !== undefined && this.meta !== null) {
      result["meta"] = this.meta;
    }
    return marshal(result, { allowDuplicateNames: true, allowInvalidUTF8: true });
  }
}

// wantsMFA checks whether to enable MFA for the specified auth record based on its MFA rule
// (note: throws in case of an error, which checkMFA treats as a failure).
async function wantsMFA(e: RequestEvent, record: Record): Promise<boolean> {
  const rule = record.collection().mfa.rule;
  if (rule === "") {
    return true;
  }

  const requestInfo = await e.requestInfo();
  if (requestInfo instanceof Error) {
    throw requestInfo;
  }

  const query = recordQuery(e.app, record.collection())
    .select("(1)")
    .andWhere(new HashExp({ [record.collection().name + ".id"]: record.id }));

  // parse and apply the access rule filter
  const resolver = newRequestFieldResolver(e.app, record.collection(), requestInfo, true);
  const expr = filterBuildExpr(rule, resolver, resolver.filterOptions());

  resolver.updateQuery(query);

  let exists: unknown = 0;
  try {
    [exists] = await query.andWhere(expr).limit(1).rowAsync();
  } catch (err) {
    if (!isNoRows(err)) {
      throw err;
    }
  }

  return Number(exists) > 0;
}

const mfaIdType = structOf([
  { name: "MfaId", type: "string", tags: { form: "mfaId", json: "mfaId", xml: "mfaId" } },
]);

// checkMFA handles any MFA auth checks that needs to be performed for the specified request event.
// Returns the mfaId that needs to be written as response to the user.
//
// (note: all auth methods are treated as equal and there is no requirement for "pairing").
async function checkMFA(
  e: RequestEvent,
  authRecord: Record,
  currentAuthMethod: string,
): Promise<[string, Error | undefined]> {
  if (!authRecord.collection().mfa.enabled || currentAuthMethod === "") {
    return ["", undefined];
  }

  let ok: boolean;
  try {
    ok = await wantsMFA(e, authRecord);
  } catch (err) {
    return [
      "",
      e.badRequestError(
        "Failed to authenticate.",
        new Error(`MFA rule failure: ${errorMessage(err)}`, { cause: err }),
      ),
    ];
  }
  if (!ok) {
    return ["", undefined]; // no mfa needed for this auth record
  }

  // read the mfaId either from the qyery params or request body
  let mfaId = e.request.query().get("mfaId")?.[0] ?? "";
  if (mfaId === "") {
    // check the body
    const data = { MfaId: "" };
    const bindErr = await e.bindBody(data, mfaIdType);
    if (bindErr) {
      return ["", firstApiError(bindErr, e.badRequestError("Failed to read MFA Id", bindErr))];
    }
    mfaId = data.MfaId;
  }

  // first-time auth
  // ---
  if (mfaId === "") {
    const mfa = newMFA(e.app);
    mfa.setCollectionRef(authRecord.collection().id);
    mfa.setRecordRef(authRecord.id);
    mfa.setMethod(currentAuthMethod);
    try {
      await saveMFA(e.app, mfa);
    } catch (err) {
      return ["", firstApiError(err, e.internalServerError("Failed to create MFA record", err))];
    }

    return [mfa.id, undefined];
  }

  // second-time auth
  // ---
  let mfa: MFA | undefined;
  let findErr: unknown;
  try {
    mfa = findMFAById(e.app, mfaId);
  } catch (err) {
    findErr = err;
  }
  const deleteFoundMFA = async (): Promise<void> => {
    // try to delete the expired mfa
    if (mfa !== undefined) {
      try {
        await deleteMFA(e.app, mfa);
      } catch (err) {
        e.app.logger.error(`Failed to delete expired MFA record (mfaId ${mfa.id})`, err);
      }
    }
  };
  if (
    mfa === undefined ||
    mfa.hasExpired(authRecord.collection().mfa.durationTime(), e.app.clock)
  ) {
    await deleteFoundMFA();
    return ["", e.badRequestError("Invalid or expired MFA session.", findErr ?? null)];
  }

  if (mfa.recordRef() !== authRecord.id || mfa.collectionRef() !== authRecord.collection().id) {
    return ["", e.badRequestError("Invalid MFA session.", null)];
  }

  if (mfa.method() === currentAuthMethod) {
    return ["", e.badRequestError("A different authentication method is required.", null)];
  }

  await deleteFoundMFA();

  return ["", undefined];
}

// EnrichRecord parses the request context and enrich the provided record:
//   - expands relations (if defaultExpands and/or ?expand query param is set)
//   - ensures that the emails of the auth record and its expanded auth relations
//     are visible only for the current logged superuser, record owner or record with manage access
export function enrichRecord(
  e: RequestEvent,
  record: Record,
  ...defaultExpands: string[]
): Promise<Error | undefined> {
  return enrichRecords(e, [record], ...defaultExpands);
}

// EnrichRecords parses the request context and enriches the provided records:
//   - expands relations (if defaultExpands and/or ?expand query param is set)
//   - ensures that the emails of the auth records and their expanded auth relations
//     are visible only for the current logged superuser, record owner or record with manage access
//
// Note: Expects all records to be from the same collection!
export async function enrichRecords(
  e: RequestEvent,
  records: Record[],
  ...defaultExpands: string[]
): Promise<Error | undefined> {
  if (records.length === 0) {
    return undefined;
  }

  const info = await e.requestInfo();
  if (info instanceof Error) {
    return info;
  }

  let expands = defaultExpands;
  const param = Object.hasOwn(info.query, expandQueryParam) ? info.query[expandQueryParam] : "";
  if (param !== undefined && param !== "") {
    expands = [...expands, ...param.split(",")];
  }

  try {
    await defaultEnrichRecords(e.app, info, records, ...expands);
  } catch {
    // only logged upstream because it is not critical
  }

  return undefined;
}

async function defaultEnrichRecords(
  app: App,
  requestInfo: RequestInfo,
  records: Record[],
  ...expands: string[]
): Promise<void> {
  try {
    await autoResolveRecordsFlags(app, records, requestInfo);
  } catch (err) {
    throw new Error(`failed to resolve records flags: ${errorMessage(err)}`, { cause: err });
  }

  if (expands.length > 0) {
    const expandErrs = await expandRecords(app, records, expands, expandFetch(app, requestInfo));
    if (expandErrs.size > 0) {
      const errs = [...expandErrs].map(
        ([key, err]) => new Error(`failed to expand ${JSON.stringify(key)}: ${err.message}`),
      );
      throw new Error(`failed to expand records: ${errs.map((err) => err.message).join("\n")}`);
    }
  }
}

// expandFetch is the records fetch function that is used to expand related records.
export function expandFetch(app: App, originalRequestInfo: RequestInfo): ExpandFetchFunc {
  // shallow clone the provided request info to set an "expand" context
  const requestInfoPtr = Object.assign(new RequestInfo(), originalRequestInfo);
  requestInfoPtr.context = RequestInfoContextExpand;

  return async (relCollection, relIds) => {
    // FindRecordsByIds with the view rule filter
    const q = recordQuery(app, relCollection).andWhere(
      inExp(relCollection.name + ".id", ...relIds),
    );
    applyViewRule(app, relCollection, requestInfoPtr, q);
    const records = await q.allAsync<Record>(recordsTarget);

    try {
      await autoResolveRecordsFlags(app, records, requestInfoPtr);
    } catch {
      // non-critical error (logged upstream)
    }

    return records;
  };
}

function applyViewRule(
  app: App,
  relCollection: Collection,
  requestInfo: RequestInfo,
  q: SelectQuery,
): void {
  if (requestInfo.auth !== undefined && requestInfo.auth.isSuperuser()) {
    return; // superusers can access everything
  }

  if (relCollection.viewRule === null) {
    throw new Error(
      `only superusers can view collection ${JSON.stringify(relCollection.name)} records`,
    );
  }

  if (relCollection.viewRule !== "") {
    const resolver = newRequestFieldResolver(app, relCollection, requestInfo, true);

    const expr = filterBuildExpr(relCollection.viewRule, resolver, resolver.filterOptions());

    q.andWhere(expr);

    resolver.updateQuery(q);
  }
}

// autoResolveRecordsFlags resolves various visibility flags of the provided records.
//
// Currently it enables:
// - export of hidden fields if the current auth model is a superuser
// - email export ignoring the emailVisibity checks if the current auth model is superuser, owner or a "manager".
//
// Note: Expects all records to be from the same collection!
export async function autoResolveRecordsFlags(
  app: App,
  records: Record[],
  requestInfo: RequestInfo,
): Promise<void> {
  if (records.length === 0) {
    return; // nothing to resolve
  }

  const first = records[0] as Record;

  if (requestInfo.hasSuperuserAuth()) {
    const hiddenFields = first.collection().fields.fieldNames();
    for (const rec of records) {
      rec.unhide(...hiddenFields);
      rec.ignoreEmailVisibility(true);
    }
  }

  // additional emailVisibility checks
  // ---------------------------------------------------------------
  if (!first.collection().isAuth()) {
    return; // not auth collection records
  }

  const collection = first.collection();

  const mappedRecords = new Map<string, Record>();
  const recordIds: string[] = [];
  for (const rec of records) {
    mappedRecords.set(rec.id, rec);
    recordIds.push(rec.id);
  }

  if (requestInfo.auth !== undefined) {
    mappedRecords.get(requestInfo.auth.id)?.ignoreEmailVisibility(true);
  }

  if (collection.manageRule === null || collection.manageRule === "") {
    return; // no manage rule to check
  }

  // fetch the ids of the managed records
  // ---
  const db = app.databases.concurrentDB();
  const query = recordQuery(app, collection)
    .select(db.quoteSimpleColumnName(collection.name) + ".id")
    .andWhere(inExp(db.quoteSimpleColumnName(collection.name) + ".id", ...recordIds));

  const resolver = newRequestFieldResolver(app, collection, requestInfo, true);
  const expr = filterBuildExpr(collection.manageRule, resolver, resolver.filterOptions());

  query.andWhere(expr);

  resolver.updateQuery(query);

  const managedIds = await query.columnAsync<unknown>();
  // ---

  // ignore the email visibility check for the managed records
  for (const id of managedIds) {
    mappedRecords.get(String(id))?.ignoreEmailVisibility(true);
  }
}

const ruleQueryParams = [FilterQueryParam, SortQueryParam];
const superuserOnlyRuleFields = ["@collection.", "@request."];

// checkForSuperuserOnlyRuleFields loosely checks and returns an error if
// the provided RequestInfo contains rule fields that only the superuser can use.
export function checkForSuperuserOnlyRuleFields(requestInfo: RequestInfo): ApiError | undefined {
  if (Object.keys(requestInfo.query).length === 0 || requestInfo.hasSuperuserAuth()) {
    return undefined; // superuser or nothing to check
  }

  for (const param of ruleQueryParams) {
    const v = Object.hasOwn(requestInfo.query, param) ? requestInfo.query[param] : undefined;
    if (v === undefined || v === "") {
      continue;
    }

    for (const field of superuserOnlyRuleFields) {
      if (v.includes(field)) {
        return newForbiddenError("Only superusers can filter by " + field, null);
      }
    }
  }

  return undefined;
}

// firstApiError returns the first ApiError from the errors list
// (this is used usually to prevent unnecessary wraping and to allow bubling ApiError from nested hooks)
//
// If no ApiError is found, returns a default "Internal server" error.
export function firstApiError(...errs: unknown[]): ApiError {
  for (const err of errs) {
    if (err === null || err === undefined) {
      continue;
    }

    // quick assert to avoid the reflection checks
    if (err instanceof ApiError) {
      return err;
    }

    // nested/wrapped errors
    const apiErr = errorsAs(err, ApiError);
    if (apiErr) {
      return apiErr;
    }
  }

  return newInternalServerError(
    "",
    new AggregateError(errs.filter((err) => err !== null && err !== undefined)),
  );
}

// -------------------------------------------------------------------

const maxAuthOrigins = 5;

// the "fake" timeout of the auth alert email send
const authAlertSendTimeoutMs = 15_000;

// authAlert stores the auth origin of the request and, for a new origin
// of a record that logged in before, sends the auth alert email first
// (a failed send leaves the origin unsaved, as upstream). Throws on
// failure; the caller only logs it.
async function authAlert(e: RequestEvent, authRecord: Record): Promise<void> {
  // generate fingerprint
  // ---
  const ip = e.realIP();

  // header values hold one char per byte (latin1), so the cut and the
  // hash are over the bytes as upstream's
  let userAgent = e.request.headers.get("User-Agent") ?? "";
  if (userAgent.length > 200) {
    userAgent = userAgent.slice(0, 200) + "...";
  }

  const fingerprint = md5Bytes(ip + userAgent);
  const alertInfo = `${nowDateTime(e.app.clock).toString()} - ${ip} ${userAgent}`;
  // ---

  const origins = findAllAuthOriginsByRecord(e.app, authRecord);

  const isFirstLogin = origins.length === 0;

  let currentOrigin: AuthOrigin | undefined = origins.find((o) => o.fingerprint() === fingerprint);
  if (currentOrigin === undefined) {
    currentOrigin = newAuthOrigin(e.app);
    currentOrigin.setCollectionRef(authRecord.collection().id);
    currentOrigin.setRecordRef(authRecord.id);
    currentOrigin.setFingerprint(fingerprint);
  }

  // send email alert for the new origin auth (skip first login)
  //
  // Note: The "fake" timeout is a temp solution to avoid blocking
  //       for too long when the SMTP server is not accessible (upstream's
  //       mailer has no context cancellation); the send itself goes on.
  if (!isFirstLogin && currentOrigin.isNew() && authRecord.email() !== "") {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Error>((resolve) => {
      timer = setTimeout(
        () => resolve(new Error("auth alert mail send wait timeout reached")),
        authAlertSendTimeoutMs,
      );
    });
    const err = await Promise.race([
      sendRecordAuthAlert(e.app, authRecord, alertInfo).then(
        () => undefined,
        (sendErr: unknown) => (sendErr instanceof Error ? sendErr : new Error(String(sendErr))),
      ),
      timeout,
    ]);
    clearTimeout(timer);
    if (err) {
      throw err;
    }
  }

  // try to keep only up to maxAuthOrigins
  // (pop the last used ones; it is not executed in a transaction to avoid unnecessary locks)
  if (currentOrigin.isNew() && origins.length >= maxAuthOrigins) {
    for (let i = origins.length - 1; i >= maxAuthOrigins - 1; i--) {
      const origin = origins[i] as AuthOrigin;
      try {
        await deleteAuthOrigin(e.app, origin);
      } catch (err) {
        // treat as non-critical error, just log for now
        e.app.logger.error(
          `Failed to delete old AuthOrigin record (authOriginId ${origin.id})`,
          err,
        );
      }
    }
  }

  // create/update the origin fingerprint
  await saveAuthOrigin(e.app, currentOrigin);
}

// security.MD5 of the bytes of a latin1 text (one char per byte)
function md5Bytes(text: string): string {
  const h = new Bun.CryptoHasher("md5");
  h.update(Buffer.from(text, "latin1"));
  return h.digest("hex");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
