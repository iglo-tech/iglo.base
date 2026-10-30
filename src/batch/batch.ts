// Upstream: apis/batch.go, with core/event_request_batch.go (InternalRequest)
//
// A batch has two phases (D28). Everything asynchronous runs first: reading
// and binding the body, the uploaded files' first bytes (the form spills to
// temporary files, D27, removed by the router when the request ends) and each
// item's request and RequestInfo. Then one transaction runs the items
// synchronously on its app, through the record handlers' single implementation
// (src/apis/record-crud.ts) with txRecordIO.
//
// The OnBatchRequest hook is not ported (no extension surface): its default
// action runs directly. The rate limit rules (`<collection>:<action>`, M4.8)
// are the record handlers' named comments.
//
// Upstream runs the items recursively (each in the previous one's
// optFinalizer) and in a goroutine that the timeout abandons. Here they run
// in a loop:
//   - an error that is not an ApiError passes through the previous item's
//     optFinalizer upstream, which makes it a 500, so only the first item
//     gets ToApiError's 400 (failItem);
//   - the deadline is checked after each item, so a batch past it rolls back
//     with upstream's error, but late; a client that goes away is not noticed
//     while the batch runs (04-api-compatibility.md, Deliberate differences);
//   - a Go panic inside an item ends its goroutine and upstream answers with
//     the timeout error once the deadline passes; a throw here answers
//     the same at once.
//
// Each item is sent through a multipart request upstream, with its regular
// fields as `@jsonPayload` and the outer files as new parts. The result is
// kept without the bytes: the payload text is still marshaled and bound as
// the form value it is (with the URL's query values, as Request.Form holds
// them), and a file is named again from its normalized name. A key of a file
// replaces the same key in the regular fields.

import type { App } from "@/app/app";
import {
  RequestEvent,
  RequestEventKeyInfoContext,
  RequestInfoContextBatch,
  type RequestInfo,
  snakecase,
} from "@/app/event-request";
import {
  collectResult,
  type HandlerStep,
  recordCreate,
  recordDelete,
  type RecordIO,
  recordUpdate,
  txRecordIO,
} from "@/apis/record-crud";
import { firstApiError } from "@/apis/record-helpers";
import { runInTransaction } from "@/db/tx";
import { applyBodyLimit } from "@/middlewares/body-limit";
import { DefaultBodyLimitMiddlewareId } from "@/middlewares/middlewares";
import { findRecordById } from "@/records/record-query";
import { runSync } from "@/records/record-save";
import { type ApiError, newInternalServerError, toApiError } from "@/server/error";
import type { RouterGroup } from "@/server/group";
import type { HandlerResult } from "@/server/handler";
import { setOwn } from "@/server/json-decode";
import { Form } from "@/server/multipart";
import { HttpRequest, type Values } from "@/server/request";
import { bytesReader, RereadableReadCloser } from "@/server/rereadable-read-closer";
import { ResponseWriter } from "@/server/router";
import {
  JSONPayloadKey,
  pointerTo,
  sliceOf,
  structOf,
  type StructField,
} from "@/server/unmarshal-request-data";
import { type File, NewFileFromMultipart } from "@/tools/filesystem/file";
import { pseudorandomString } from "@/tools/security/random";
import { toString } from "@/tools/types/cast";
import { type JSONMarshaler, marshal } from "@/tools/types/go-json";
import { Errors } from "@/validation/error";
import { In } from "@/validation/in";
import { Length } from "@/validation/length";
import { Required } from "@/validation/required";
import { Field as ValidatedField, ValidateStruct } from "@/validation/struct";

export function bindBatchApi(_app: App, rg: RouterGroup<RequestEvent>): void {
  const sub = rg.group("/batch");
  sub.POST("", batchTransaction).unbind(DefaultBodyLimitMiddlewareId); // the body limit is inlined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const tags = (name: string): Record<string, string> => ({ form: name, json: name });

const internalRequestFields: StructField[] = [
  // map[string]any and map[string]string, checked by internalRequestOf
  { name: "Body", type: "any", tags: tags("body") },
  { name: "Headers", type: "any", tags: tags("headers") },
  { name: "Method", type: "string", tags: tags("method") },
  { name: "URL", type: "string", tags: tags("url") },
];

const batchRequestsFormType = structOf([
  {
    name: "Requests",
    type: sliceOf(pointerTo(structOf(internalRequestFields))),
    tags: tags("requests"),
  },
]);

// core.InternalRequest
class InternalRequest {
  // the files uploaded for this item, by their key
  readonly files = new Map<string, File[]>();

  constructor(
    readonly body: Record<string, unknown>,
    readonly headers: Record<string, string>,
    readonly method: string,
    readonly url: string,
  ) {}

  validate(): Error | null {
    return ValidateStruct(
      ValidatedField("method", this.method, Required, In("GET", "POST", "PUT", "PATCH", "DELETE")),
      ValidatedField("url", this.url, Required, Length(0, 2000)),
    );
  }
}

// the struct bound from JSON as InternalRequest, or an error for what its
// map fields cannot hold
function internalRequestOf(raw: Record<string, unknown>): InternalRequest {
  const body = raw["Body"] ?? {};
  if (!isPlainObject(body)) {
    throw new Error("json: cannot unmarshal into Go map[string]any");
  }

  const headers: Record<string, string> = {};
  const rawHeaders = raw["Headers"] ?? {};
  if (!isPlainObject(rawHeaders)) {
    throw new Error("json: cannot unmarshal into Go map[string]string");
  }
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (v !== null && typeof v !== "string") {
      throw new Error("json: cannot unmarshal into Go string");
    }
    setOwn(headers, k, v ?? "");
  }

  return new InternalRequest(body, headers, toString(raw["Method"]), toString(raw["URL"]));
}

// a file key of an item: "requests.N.field" or "requests[N].field"
const fileKeyRegex = /^requests(?:\.(0|[1-9][0-9]*)|\[(0|[1-9][0-9]*)\])\.([^]*)$/;

async function loadUploadedFiles(
  e: RequestEvent,
  requests: readonly (InternalRequest | null)[],
): Promise<void> {
  for (const [key, headers] of e.request.multipartForm?.file ?? []) {
    const match = fileKeyRegex.exec(key);
    const ir = match === null ? undefined : requests[Number(match[1] ?? match[2])];
    if (match === null || ir === undefined || ir === null) {
      continue;
    }

    const resultKey = match[3] as string;
    delete ir.body[resultKey];

    const files = ir.files.get(resultKey) ?? [];
    ir.files.set(resultKey, files);
    for (const fh of headers) {
      // the item's part is named after the normalized name of the outer one
      const outer = await NewFileFromMultipart(fh);
      files.push(
        await NewFileFromMultipart({
          filename: outer.name,
          size: fh.size,
          content: fh.content,
          tmpfile: fh.tmpfile,
          tmpoff: fh.tmpoff,
        }),
      );
    }
  }
}

// NB! When the request is submitted as multipart/form-data,
// the regular fields data is expected to be submitted as serialized
// json under the @jsonPayload field and file keys need to follow the
// pattern "requests.N.fileField" or  requests[N].fileField.
async function batchTransaction(e: RequestEvent): Promise<HandlerResult> {
  const settings = e.app.settings.Batch;
  const maxRequests = Number(settings.MaxRequests);
  if (!settings.Enabled || maxRequests <= 0) {
    return e.forbiddenError("Batch requests are not allowed.", null);
  }

  let txTimeoutSeconds = Number(settings.Timeout);
  if (txTimeoutSeconds <= 0) {
    txTimeoutSeconds = 3; // for now always limit
  }

  let maxBodySize = BigInt(settings.MaxBodySize);
  if (maxBodySize <= 0) {
    maxBodySize = 128n << 20n;
  }

  const limitErr = applyBodyLimit(e, maxBodySize);
  if (limitErr) {
    return limitErr;
  }

  // load base requests data
  const form: Record<string, unknown> = {};
  const bindErr = await e.bindBody(form, batchRequestsFormType);
  if (bindErr) {
    return e.badRequestError("Failed to read the submitted batch data.", bindErr);
  }

  let requests: (InternalRequest | null)[];
  try {
    requests = ((form["Requests"] ?? []) as (Record<string, unknown> | null)[]).map((raw) =>
      raw === null ? null : internalRequestOf(raw),
    );
  } catch (err) {
    return e.badRequestError("Failed to read the submitted batch data.", err);
  }

  // load uploaded files into each request item
  // note: expects the files to be under "requests.N.fileField" or "requests[N].fileField" format
  // 		 (the other regular fields must be put under `@jsonPayload` as serialized json)
  if ((e.request.headers.get("Content-Type") ?? "").startsWith("multipart/form-data")) {
    try {
      await loadUploadedFiles(e, requests);
    } catch (err) {
      return e.badRequestError("Failed to read the submitted batch files data.", err);
    }
  }

  // a null item: Go's nil pointer panic in the form validation
  if (requests.length <= maxRequests && requests.includes(null)) {
    return e.internalServerError("", new Error("batch request item is null"));
  }

  // validate batch request form
  const validationErr = ValidateStruct(
    ValidatedField("requests", requests, Required, Length(0, maxRequests)),
  );
  if (validationErr !== null) {
    return e.badRequestError("Invalid batch request data.", validationErr);
  }

  const items: PreparedItem[] = [];
  for (const ir of requests) {
    items.push(await prepareItem(e, ir as InternalRequest));
  }

  let results: BatchResults;
  try {
    results = processBatch(e, items, txTimeoutSeconds);
  } catch (err) {
    return firstApiError(err, e.badRequestError("Batch transaction failed.", err));
  }

  return e.json(200, results);
}

// -------------------------------------------------------------------
// phase 1: an item's request

type HandlerFactory = (e: RequestEvent, io: RecordIO) => HandlerStep;

// a valid batch action
interface BatchAction {
  upsert: boolean;
  handler: HandlerFactory;
  collection: string;
  id: string;
  query: string;
}

// ValidBatchActions: Go's `.` is every character but "\n"
//
// Note: when adding new routes make sure that their middlewares are inlined!
const validBatchActions: readonly [RegExp, boolean, HandlerFactory][] = [
  // "upsert" handler
  [
    /^PUT \/api\/collections\/(?<collection>[^/?]+)\/records(?<query>\?[^\n]*)?$/,
    true,
    recordCreate,
  ],
  [/^POST \/api\/collections\/(?<collection>[^/?]+)\/records(\?[^\n]*)?$/, false, recordCreate],
  [
    /^PATCH \/api\/collections\/(?<collection>[^/?]+)\/records\/(?<id>[^/?]+)(\?[^\n]*)?$/,
    false,
    recordUpdate,
  ],
  [
    /^DELETE \/api\/collections\/(?<collection>[^/?]+)\/records\/(?<id>[^/?]+)(\?[^\n]*)?$/,
    false,
    recordDelete,
  ],
];

function findBatchAction(ir: InternalRequest): BatchAction | null {
  const full = ir.method.toUpperCase() + " " + ir.url;

  for (const [re, upsert, handler] of validBatchActions) {
    const groups = re.exec(full)?.groups;
    if (groups !== undefined) {
      return {
        upsert,
        handler,
        collection: groups["collection"] as string,
        id: groups["id"] ?? "",
        query: groups["query"] ?? "",
      };
    }
  }

  return null;
}

const invalidEscapeRegex = /%(?![0-9a-fA-F]{2})/;

// the query of a batch item's URL, as http.NewRequest parses it: fails for
// control characters and for bad escapes outside of the query
function parseItemURL(url: string): { escapedPath: string; rawQuery: string } | Error {
  // oxlint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(url)) {
    return new Error("net/url: invalid control character in URL");
  }

  const hash = url.indexOf("#");
  const fragment = hash < 0 ? "" : url.slice(hash + 1);
  const rest = hash < 0 ? url : url.slice(0, hash);

  const q = rest.indexOf("?");
  const escapedPath = q < 0 ? rest : rest.slice(0, q);

  if (invalidEscapeRegex.test(escapedPath) || invalidEscapeRegex.test(fragment)) {
    return new Error("invalid URL escape");
  }

  return { escapedPath, rawQuery: q < 0 ? "" : rest.slice(q + 1) };
}

interface PreparedItem {
  ir: InternalRequest;
  action: BatchAction | null;
  // the failure of building the item's request (http.NewRequest, the
  // payload's json.Marshal)
  requestErr: Error | null;
  request: HttpRequest | null;
  requestInfo: RequestInfo | Error;
}

async function prepareItem(base: RequestEvent, ir: InternalRequest): Promise<PreparedItem> {
  const action = findBatchAction(ir);
  const noRequest = new Error("the batch item has no request");

  if (action === null) {
    return { ir, action, requestErr: null, request: null, requestInfo: noRequest };
  }

  const url = parseItemURL(ir.url);
  if (url instanceof Error) {
    return { ir, action, requestErr: url, request: null, requestInfo: noRequest };
  }

  // the base headers, then the item's. Authorization has no effect: the auth
  // state comes from the base event. Content-Type is the generated one below,
  // whatever the item sent: rules read it.
  const headers = new Headers(base.request.headers);
  const itemHeaders = Object.entries(ir.headers).filter(([k]) => {
    const key = k.toLowerCase();
    return key !== "authorization" && snakecase(key) !== "content_type";
  });
  for (const [k, v] of itemHeaders) {
    try {
      headers.set(k, v);
    } catch {
      // not a value Headers can hold: Go's can, so it stays in the RequestInfo below
    }
  }
  headers.set("Content-Type", "multipart/form-data; boundary=" + pseudorandomString(60));

  let payload: string;
  try {
    payload = marshal(ir.body);
  } catch (err) {
    const requestErr = err instanceof Error ? err : new Error(String(err));
    return { ir, action, requestErr, request: null, requestInfo: noRequest };
  }

  const request = new HttpRequest({
    method: ir.method.toUpperCase(),
    host: base.request.host,
    escapedPath: url.escapedPath,
    rawQuery: url.rawQuery,
    headers,
    body: new RereadableReadCloser(bytesReader("")),
    contentLength: payload.length,
    remoteAddr: base.request.remoteAddr,
    tls: base.request.tls,
  });

  request.setPathValue("collection", action.collection);
  if (action.id !== "") {
    request.setPathValue("id", action.id);
  }

  // Request.Form: the query values, then the multipart ones
  const parseErr = await request.parseForm();
  appendFormValue(request.form as Values, JSONPayloadKey, payload);
  request.multipartForm = new Form();

  // the event of this phase only reads the request; the item runs on one
  // with the transaction's app
  const event = newItemEvent(base.app, base, request);
  const requestInfo = parseErr ?? (await event.requestInfo());
  if (!(requestInfo instanceof Error)) {
    for (const [k, v] of itemHeaders) {
      setOwn(requestInfo.headers, snakecase(k.toLowerCase()), v);
    }
  }

  return { ir, action, requestErr: null, request, requestInfo };
}

function appendFormValue(form: Values, key: string, value: string): void {
  const values = form.get(key);
  if (values !== undefined) {
    values.push(value);
  } else {
    form.set(key, [value]);
  }
}

function newItemEvent(app: App, base: RequestEvent, request: HttpRequest): RequestEvent {
  const event = new RequestEvent(app, new ItemResponseWriter(), request);
  event.auth = base.auth;
  event.setAll(base.getAll());
  event.set(RequestEventKeyInfoContext, RequestInfoContextBatch);
  return event;
}

// httptest.ResponseRecorder: the body as the text the handler wrote
class ItemResponseWriter extends ResponseWriter {
  body = "";

  override write(data: Uint8Array | string): Error | undefined {
    if (!this.written()) {
      this.writeHeader(200);
    }
    this.body += typeof data === "string" ? data : new TextDecoder().decode(data);
    return undefined;
  }
}

// -------------------------------------------------------------------
// phase 2: the transaction

// BatchRequestResult: {"body", "status"}, with the body as the item wrote it
interface BatchRequestResult {
  body: string;
  status: number;
}

class BatchResults implements JSONMarshaler {
  constructor(readonly results: readonly BatchRequestResult[]) {}

  marshalJSON(): string {
    const items = this.results.map(
      (result) => `{"body":${result.body === "" ? "null" : result.body},"status":${result.status}}`,
    );
    return `[${items.join(",")}]`;
  }
}

// note: we don't return 408 Reques Timeout error because
// some browsers perform automatic retry behind the scenes
// which are hard to debug and unnecessary
const errBatchTimeout = new Error("batch transaction timeout");

function processBatch(
  e: RequestEvent,
  items: readonly PreparedItem[],
  timeoutSeconds: number,
): BatchResults {
  const results: BatchRequestResult[] = [];

  runInTransaction(e.app.databases, (txDatabases) => {
    const txApp: App = { ...e.app, databases: txDatabases };
    const deadline = e.app.clock.now().getTime() + timeoutSeconds * 1000;

    for (const [i, item] of items.entries()) {
      let result: BatchRequestResult | Error;
      try {
        result = processInternalRequest(txApp, e, item);
      } catch (err) {
        e.app.logger.error("Batch item failed unexpectedly", err);
        result = errBatchTimeout;
      }
      if (result === errBatchTimeout) {
        throw result;
      }
      if (result instanceof Error) {
        throw failItem(i, result);
      }

      results.push(result);

      if (e.app.clock.now().getTime() >= deadline) {
        throw errBatchTimeout;
      }
    }
  });

  return new BatchResults(results);
}

// the error of the batch for a failed item. Upstream's failing index is the
// failed item's: failedIndex stays 0 for the first item and is set once for
// a later one.
function failItem(index: number, err: Error): Errors {
  return new Errors({
    requests: new Errors({
      [String(index)]: new BatchResponseError(
        // the previous item's optFinalizer error
        index === 0 ? toApiError(err) : firstApiError(err, newInternalServerError("", err)),
      ),
    }),
  });
}

function processInternalRequest(
  txApp: App,
  base: RequestEvent,
  item: PreparedItem,
): BatchRequestResult | Error {
  const { action, ir, request, requestInfo, requestErr } = item;
  if (action === null) {
    return new Error("unknown batch request action");
  }
  if (requestErr !== null || request === null) {
    return requestErr ?? new Error("the batch item has no request");
  }

  const handler = resolveHandler(txApp, action, ir, request, requestInfo);

  const event = newItemEvent(txApp, base, request);

  const out: { value?: HandlerResult } = {};
  runSync(collectResult(handler(event, txRecordIO(requestInfo, ir.files)), out));
  if (out.value instanceof Error) {
    return out.value;
  }

  const response = event.response as ItemResponseWriter;
  return { body: response.body, status: response.status() || 200 };
}

// the "upsert" action decides here, with what the earlier items wrote
function resolveHandler(
  txApp: App,
  action: BatchAction,
  ir: InternalRequest,
  request: HttpRequest,
  requestInfo: RequestInfo | Error,
): HandlerFactory {
  if (!action.upsert) {
    return action.handler;
  }

  const setMethod = (method: string): void => {
    request.method = method;
    if (!(requestInfo instanceof Error)) {
      requestInfo.method = method;
    }
  };

  const id = toString(Object.hasOwn(ir.body, "id") ? ir.body["id"] : "");
  if (id !== "") {
    try {
      findRecordById(txApp, action.collection, id);
      // update
      request.setPathValue("id", id); // required for the path value
      setMethod("PATCH");
      return recordUpdate;
    } catch {
      // not found: create
    }
  }

  setMethod("POST");
  return recordCreate;
}

// -------------------------------------------------------------------

export class BatchResponseError extends Error {
  constructor(readonly err: ApiError) {
    super("Batch request failed.");
    this.name = "BatchResponseError";
  }

  code(): string {
    return "batch_request_failed";
  }

  resolve(errData: Record<string, unknown>): unknown {
    errData["response"] = this.err;
    return errData;
  }
}
