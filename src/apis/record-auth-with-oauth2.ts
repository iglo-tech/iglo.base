// Upstream: apis/record_auth_with_oauth2.go
//
// The OnRecordAuthWithOAuth2Request hook is not ported (no extension
// surface): its default action runs directly.
//
// Network calls never run inside a write transaction (AGENTS.md), and the
// avatar download is upstream's only one there. It runs before the
// transaction here, with the same decision: oauth2CreatePayload runs twice,
// on the app to learn whether a download is wanted and in the transaction,
// as upstream, for the payload. The internal create request is
// prepared before the transaction too (it has awaits), with its body set
// inside. safeHTTPClient and safeFileFromURL are in src/oauth2/safe-file.ts.
//
// Logs: the redirectUrl deprecation warning and the debug line of Apple's
// missing name are not written (application code logs errors only); a
// failed avatar download is.

import type { App } from "@/app/app";
import {
  type RequestEvent,
  RequestEventKeyInfoContext,
  RequestInfoContextOAuth2,
} from "@/app/event-request";
import { findAuthCollection } from "@/apis/record-auth";
import { oauth2RedirectAppleNameStoreKeyPrefix } from "@/apis/record-auth-with-oauth2-redirect";
import { firstApiError, recordAuthResponseWithNewToken } from "@/apis/record-helpers";
import {
  InternalRequest,
  type PreparedItem,
  prepareItem,
  processInternalRequest,
  setItemBody,
} from "@/batch/batch";
import type { Collection } from "@/collections/collection-model";
import type { OAuth2ProviderConfig } from "@/collections/collection-model-auth-options";
import { HashExp, newExp } from "@/db/dbx/expression";
import { runInTransaction } from "@/db/tx";
import { FieldNameEmail } from "@/fields/field";
import { FieldTypeFile } from "@/fields/file";
import { TextField } from "@/fields/text";
import type { AuthUser, BaseProvider } from "@/oauth2/base-provider";
import { initSignInProvider } from "@/oauth2/providers";
import { safeFileFromURL, type SafeFileOptions } from "@/oauth2/safe-file";
import type { Token } from "@/oauth2/token";
import { ExternalAuth, newExternalAuth, saveExternalAuthSync } from "@/records/external-auth-model";
import {
  deleteAllExternalAuthsByRecordSync,
  findFirstExternalAuthByExpr,
} from "@/records/external-auth-query";
import { MFAMethodOAuth2 } from "@/records/mfa-model";
import type { Record } from "@/records/record-model";
import { CollectionNameSuperusers } from "@/records/record-model-superusers";
import {
  findAuthRecordByEmail,
  findRecordById,
  recordQuery,
  type RecordsApp,
} from "@/records/record-query";
import { isNoRows, saveRecordSync } from "@/records/record-save";
import { ApiError } from "@/server/error";
import type { HandlerResult } from "@/server/handler";
import { setOwn } from "@/server/json-decode";
import { structOf } from "@/server/unmarshal-request-data";
import { findSingleColumnUniqueIndex } from "@/tools/dbutils/index";
import { type File, NewFileFromBytes } from "@/tools/filesystem/file";
import { columnify } from "@/tools/inflector/inflector";
import { Length } from "@/validation/length";
import { NewError } from "@/validation/error";
import { Required } from "@/validation/required";
import { Field, ValidateStruct } from "@/validation/struct";
import { By, type RuleFunc } from "@/validation/validation";

// auth.NameApple
const NameApple = "apple";

const providerRequestTimeoutMs = 30_000;

// The test seams of the flow (see newRouter): nothing in the executable sets them.
export interface RecordAuthOptions {
  // OAuth2ProviderConfig.InitProvider
  initProvider?: (config: OAuth2ProviderConfig) => BaseProvider;
  // the options of the avatar download
  avatar?: SafeFileOptions;
}

export async function recordAuthWithOAuth2(
  e: RequestEvent,
  options: RecordAuthOptions = {},
): Promise<HandlerResult> {
  const collection = findAuthCollection(e);
  if (collection instanceof ApiError) {
    return collection;
  }

  if (!collection.oauth2.enabled) {
    return e.forbiddenError(
      "The collection is not configured to allow OAuth2 authentication.",
      null,
    );
  }

  let fallbackAuthRecord: Record | undefined;
  if (e.auth !== undefined && e.auth.collection().id === collection.id) {
    fallbackAuthRecord = e.auth;
  }

  e.set(RequestEventKeyInfoContext, RequestInfoContextOAuth2);

  const form: RecordOAuth2LoginForm = {
    CreateData: null,
    Provider: "",
    Code: "",
    CodeVerifier: "",
    RedirectURL: "",
    RedirectUrl: "",
  };
  const bindErr = await e.bindBody(
    form as unknown as { [key: string]: unknown },
    recordOAuth2LoginFormType,
  );
  if (bindErr) {
    return firstApiError(
      bindErr,
      e.badRequestError("An error occurred while loading the submitted data.", bindErr),
    );
  }
  const createData = form.CreateData;
  if (createData !== null && (typeof createData !== "object" || Array.isArray(createData))) {
    return e.badRequestError(
      "An error occurred while loading the submitted data.",
      new Error("json: cannot unmarshal createData into Go map[string]any"),
    );
  }

  if (form.RedirectUrl !== "" && form.RedirectURL === "") {
    form.RedirectURL = form.RedirectUrl;
  }

  const validateErr = validateForm(form, collection);
  if (validateErr) {
    return firstApiError(
      validateErr,
      e.badRequestError("An error occurred while loading the submitted data.", validateErr),
    );
  }

  // exchange token for OAuth2 user info and locate existing ExternalAuth rel
  // ---------------------------------------------------------------

  // load provider configuration
  const [providerConfig, ok] = collection.oauth2.getProviderConfig(form.Provider);
  if (!ok) {
    return e.internalServerError("Missing or invalid provider config.", null);
  }

  let provider: BaseProvider;
  try {
    provider = (options.initProvider ?? initSignInProvider)(providerConfig);
  } catch (err) {
    return firstApiError(
      err,
      e.internalServerError("Failed to init provider " + form.Provider, err),
    );
  }

  provider.signal = AbortSignal.timeout(providerRequestTimeoutMs);
  provider.clock = e.app.clock;
  provider.redirectURL = form.RedirectURL;

  const opts: [string, string][] = [];

  if (provider.pkce) {
    opts.push(["code_verifier", form.CodeVerifier]);
  }

  // fetch token
  let token: Token;
  try {
    token = await provider.fetchToken(form.Code, opts);
  } catch (err) {
    return firstApiError(err, e.badRequestError("Failed to fetch OAuth2 token.", err));
  }

  // fetch external auth user
  let authUser: AuthUser;
  try {
    authUser = await provider.fetchAuthUser(token);
  } catch (err) {
    return firstApiError(err, e.badRequestError("Failed to fetch OAuth2 user.", err));
  }

  // Apple currently returns the user's name only as part of the first redirect data response
  // so we try to assign the [oauth2SubscriptionRedirect] forwarded name.
  if (form.Provider === NameApple && authUser.name === "") {
    const nameKey = oauth2RedirectAppleNameStoreKeyPrefix + form.Code;
    const name = e.app.store.get(nameKey);
    if (typeof name === "string") {
      e.app.store.remove(nameKey);
      authUser.name = name;
    }
  }

  let authRecord: Record | undefined;

  // check for existing relation with the auth collection
  let externalAuthRel: ExternalAuth | undefined;
  try {
    externalAuthRel = findFirstExternalAuthByExpr(
      e.app,
      new HashExp({
        collectionRef: collection.id,
        provider: form.Provider,
        providerId: authUser.id,
      }),
    );
  } catch (err) {
    if (!isNoRows(err)) {
      return e.internalServerError("Failed OAuth2 relation check.", err);
    }
  }

  if (externalAuthRel !== undefined) {
    try {
      authRecord = findRecordById(e.app, collection, externalAuthRel.recordRef());
    } catch (err) {
      return isNoRows(err) ? e.notFoundError("", err) : (err as Error);
    }
  } else if (fallbackAuthRecord !== undefined) {
    // fallback to the logged auth record (if any)
    authRecord = fallbackAuthRecord;
  } else if (authUser.email !== "") {
    // look for an existing auth record by the external auth record's email
    try {
      authRecord = findAuthRecordByEmail(e.app, collection.id, authUser.email);
    } catch (err) {
      if (!isNoRows(err)) {
        return e.internalServerError("Failed OAuth2 auth record check.", err);
      }
    }
  }

  // ---------------------------------------------------------------

  const submit: OAuth2Submit = {
    collection,
    providerName: form.Provider,
    oauth2User: authUser,
    createData,
    record: authRecord,
    isNewRecord: authRecord === undefined,
    avatar: undefined,
    createItem: undefined,
  };

  // what a new record's create needs an await for
  if (submit.isNewRecord && collection.name !== CollectionNameSuperusers) {
    if (oauth2CreatePayload(e.app, submit).avatarField !== "") {
      submit.avatar = await downloadAvatar(e, authUser.avatarURL, options.avatar);
    }
    submit.createItem = await prepareItem(
      e,
      new InternalRequest({}, {}, "POST", "/api/collections/" + collection.name + "/records"),
      RequestInfoContextOAuth2,
    );
  }

  try {
    oauth2Submit(e, submit, externalAuthRel);
  } catch (err) {
    return firstApiError(err, e.badRequestError("Failed to authenticate.", err));
  }

  // @todo revert back to struct after removing the custom auth.AuthUser marshalization
  let meta: { [key: string]: unknown };
  try {
    meta = authUser.toMeta();
  } catch (err) {
    return err as Error;
  }
  meta["isNew"] = submit.isNewRecord;

  return recordAuthResponseWithNewToken(e, submit.record as Record, MFAMethodOAuth2, meta);
}

// -------------------------------------------------------------------

const tags = (name: string): { form: string; json: string } => ({ form: name, json: name });

const recordOAuth2LoginFormType = structOf([
  // map[string]any, checked after the bind
  { name: "CreateData", type: "any", tags: tags("createData") },
  { name: "Provider", type: "string", tags: tags("provider") },
  { name: "Code", type: "string", tags: tags("code") },
  { name: "CodeVerifier", type: "string", tags: tags("codeVerifier") },
  { name: "RedirectURL", type: "string", tags: tags("redirectURL") },
  { name: "RedirectUrl", type: "string", tags: tags("redirectUrl") },
]);

interface RecordOAuth2LoginForm {
  // Additional data that will be used for creating a new auth record
  // if an existing OAuth2 account doesn't exist.
  CreateData: { [key: string]: unknown } | null;

  // The name of the OAuth2 client provider (eg. "google")
  Provider: string;

  // The authorization code returned from the initial request.
  Code: string;

  // The optional PKCE code verifier as part of the code_challenge sent with the initial request.
  CodeVerifier: string;

  // The redirect url sent with the initial request.
  RedirectURL: string;

  // @todo
  // deprecated: use RedirectURL instead
  // RedirectUrl will be removed after dropping v0.22 support
  RedirectUrl: string;
}

function validateForm(form: RecordOAuth2LoginForm, collection: Collection): Error | null {
  const checkProviderName: RuleFunc = (value) => {
    const name = typeof value === "string" ? value : "";

    const [, ok] = collection.oauth2.getProviderConfig(name);
    if (!ok) {
      return NewError(
        "validation_invalid_provider",
        "Provider with name {{.name}} is missing or is not enabled.",
      ).setParams({ name });
    }

    return null;
  };

  return ValidateStruct(
    Field("provider", form.Provider, Required, Length(0, 100), By(checkProviderName)),
    Field("code", form.Code, Required),
  );
}

// @todo evaluate if it is still worth keeping as this exists only for backward-compatibility with pre v0.23 versions
function oldCanAssignUsername(app: RecordsApp, collection: Collection, username: string): boolean {
  const field = collection.fields.getByName(collection.oauth2.mappedFields.username);
  if (field === null) {
    return false;
  }

  // ensure that the value matches the pattern of the username field (if text)
  if (field instanceof TextField && field.validatePlainValue(username) !== null) {
    return false;
  }

  // ensure that username is unique
  const [index, hasUnique] = findSingleColumnUniqueIndex(collection.indexes, field.getName());
  if (hasUnique) {
    // it is not required because collection fields are already sanitized
    // but normalize as an extra precaution in case of a custom validator
    const colName = columnify(field.getName());

    const expr =
      (index.columns[0]?.collate ?? "").toLowerCase() === "nocase"
        ? // case-insensitive search
          newExp("[[" + colName + "]] = {:username} COLLATE NOCASE", { username })
        : new HashExp({ [colName]: username });

    let exists = 0;
    try {
      [exists = 0] = recordQuery(app, collection)
        .select("(1)")
        .andWhere(expr)
        .limit(1)
        .row() as number[];
    } catch {
      // a failed read leaves it 0, as upstream ignores the error
    }
    if (exists > 0) {
      return false;
    }
  }

  return true;
}

// RecordAuthWithOAuth2RequestEvent, with what the transaction needs prepared
interface OAuth2Submit {
  collection: Collection;
  providerName: string;
  oauth2User: AuthUser;
  createData: { [key: string]: unknown } | null;
  record: Record | undefined;
  isNewRecord: boolean;
  // the downloaded avatar, for the mapped file field
  avatar: File | undefined;
  // the prepared internal create request
  createItem: PreparedItem | undefined;
}

// the create payload of a new record; avatarField is the mapped file field
// when the avatar should be downloaded into it
function oauth2CreatePayload(
  app: RecordsApp,
  s: OAuth2Submit,
): { payload: { [key: string]: unknown }; avatarField: string } {
  const payload: { [key: string]: unknown } = {};
  for (const [k, v] of Object.entries(s.createData ?? {})) {
    setOwn(payload, k, v);
  }
  const has = (key: string): boolean => Object.hasOwn(payload, key);

  // assign the OAuth2 user email only if the user hasn't submitted one
  // (ignore empty/invalid values for consistency with the OAuth2->existing user update flow)
  const email = has(FieldNameEmail) ? payload[FieldNameEmail] : undefined;
  if (typeof email !== "string" || email === "") {
    payload[FieldNameEmail] = s.oauth2User.email;
  }

  const mapped = s.collection.oauth2.mappedFields;

  // map known fields (unless the field was explicitly submitted as part of CreateData)
  if (!has(mapped.id) && mapped.id !== "") {
    setOwn(payload, mapped.id, s.oauth2User.id);
  }
  if (!has(mapped.name) && mapped.name !== "") {
    setOwn(payload, mapped.name, s.oauth2User.name);
  }
  if (
    !has(mapped.username) &&
    // no explicit username payload value and existing OAuth2 mapping
    mapped.username !== "" &&
    // extra checks for backward compatibility with earlier versions
    oldCanAssignUsername(app, s.collection, s.oauth2User.username)
  ) {
    setOwn(payload, mapped.username, s.oauth2User.username);
  }

  let avatarField = "";
  if (
    !has(mapped.avatarURL) &&
    // no explicit avatar payload value and existing OAuth2 mapping
    mapped.avatarURL !== "" &&
    // non-empty OAuth2 avatar url
    s.oauth2User.avatarURL !== ""
  ) {
    const mappedField = s.collection.fields.getByName(mapped.avatarURL);
    if (mappedField !== null && mappedField.type() === FieldTypeFile) {
      // download the avatar if the mapped field is a file
      avatarField = mapped.avatarURL;
    } else {
      // otherwise - assign the url string
      setOwn(payload, mapped.avatarURL, s.oauth2User.avatarURL);
    }
  }

  return { payload, avatarField };
}

// the extra checks of the download are not required because the OAuth2 APIs are trusted vendor
// but are here to minimize the impact in case the provider is vulnerable
async function downloadAvatar(
  e: RequestEvent,
  url: string,
  options: SafeFileOptions | undefined,
): Promise<File | undefined> {
  try {
    const file = await safeFileFromURL(url, options);
    // the internal request's multipart part, named after the file's normalized name
    return await NewFileFromBytes(await file.reader.bytes(), file.name);
  } catch (err) {
    e.app.logger.error("Failed to retrieve OAuth2 avatar", err);
    return undefined;
  }
}

function oauth2Submit(
  e: RequestEvent,
  s: OAuth2Submit,
  optExternalAuth: ExternalAuth | undefined,
): void {
  runInTransaction(e.app.databases, (txDatabases) => {
    const txApp: App = { ...e.app, databases: txDatabases };

    if (s.record === undefined) {
      // extra check to prevent creating a superuser record via
      // OAuth2 in case the method is used by another action
      if (s.collection.name === CollectionNameSuperusers) {
        throw new Error("superusers are not allowed to sign-up with OAuth2");
      }

      const { payload, avatarField } = oauth2CreatePayload(txApp, s);

      const created = sendOAuth2RecordCreateRequest(txApp, e, s, payload, avatarField);

      s.record = created;

      if (created.email() === s.oauth2User.email && !created.verified()) {
        // mark as verified as long as it matches the OAuth2 data (even if the email is empty)
        created.setVerified(true);
        saveRecordSync(txApp, created);
      }
    } else {
      const record = s.record;
      let needUpdate = false;

      const isLoggedAuthRecord =
        e.auth !== undefined &&
        e.auth.id === record.id &&
        e.auth.collection().id === record.collection().id;

      // prevent pre-hijacking with password auth
      //
      // reset the unverified user password in case the record was precreated by a malicious actor
      if (!isLoggedAuthRecord && !record.verified()) {
        needUpdate = true;
        record.setRandomPassword();
      }

      // prevent pre-hijacking with different OAuth2 provider
      //
      // delete all other previous OAuth2 record links for the cases
      // when the user was precreated by malicious OAuth2 auth with custom payload data
      //
      // while this would be also done automatically on unverified -> verified upgrade,
      // doing it manually here ensures that a single unverified record could have
      // max 1 OAuth2 link to prevent further abuse when mixed with other auth flows
      if (!record.verified()) {
        deleteAllExternalAuthsByRecordSync(txApp, record);
        optExternalAuth = undefined; // clear to allow recreate below
      }

      // update the existing auth record empty email if the data.OAuth2User has one
      // (this is in case previously the auth record was created
      // with an OAuth2 provider that didn't return an email address)
      if (record.email() === "" && s.oauth2User.email !== "") {
        needUpdate = true;
        record.setEmail(s.oauth2User.email);
      }

      // update the existing auth record verified state
      // (only if the auth record doesn't have an email or the auth record email match with the one in data.OAuth2User)
      if (!record.verified() && (record.email() === "" || record.email() === s.oauth2User.email)) {
        needUpdate = true;
        record.setVerified(true);
      }

      if (needUpdate) {
        saveRecordSync(txApp, record);
      }
    }

    // create ExternalAuth relation if missing
    if (optExternalAuth === undefined) {
      const rel = newExternalAuth(txApp);
      rel.setCollectionRef(s.record.collection().id);
      rel.setRecordRef(s.record.id);
      rel.setProvider(s.providerName);
      rel.setProviderId(s.oauth2User.id);

      try {
        saveExternalAuthSync(txApp, rel);
      } catch (err) {
        throw new Error(`failed to save linked rel: ${(err as Error).message}`, { cause: err });
      }
    }
  });
}

function sendOAuth2RecordCreateRequest(
  txApp: App,
  e: RequestEvent,
  s: OAuth2Submit,
  payload: { [key: string]: unknown },
  avatarField: string,
): Record {
  const item = s.createItem as PreparedItem;
  setItemBody(item, payload);
  if (avatarField !== "" && s.avatar !== undefined) {
    item.ir.files.set(avatarField, [s.avatar]);
  }

  let createdRecord: Record | undefined;
  const response = processInternalRequest(txApp, e, item, (io) => ({
    ...io,
    enrich: (event, record) => {
      createdRecord = record;
      return io.enrich(event, record);
    },
  }));
  if (response instanceof Error) {
    throw response;
  }

  if (response.status !== 200 || createdRecord === undefined) {
    throw new Error("failed to create OAuth2 auth record");
  }

  return createdRecord;
}
