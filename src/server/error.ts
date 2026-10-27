// Upstream: tools/router/error.go, with inflector.Sentenize and UcFirst
// (tools/inflector/inflector.go) and Go's errors.Is/errors.As over the
// `cause` chain.
//
// The validation error types (ozzo-validation in upstream) are matched
// structurally: a SafeErrorItem has code() and a message, ValidationErrors
// is the field → error map. The field validators that create them land with
// their owning tasks (M1.x).

// SafeErrorItem defines a common error interface for a printable public safe error.
export interface SafeErrorItem {
  // Code represents a fixed unique identifier of the error (usually used as translation key).
  code(): string;
  // the default English human readable error message that will be returned
  readonly message: string;
}

// SafeErrorParamsResolver defines an optional interface for specifying dynamic error parameters.
export interface SafeErrorParamsResolver {
  params(): Record<string, unknown>;
}

// SafeErrorResolver defines an error interface for resolving the public safe error fields.
export interface SafeErrorResolver {
  resolve(errData: Record<string, unknown>): unknown;
}

// ValidationErrors is ozzo-validation's validation.Errors: a field name →
// error map that is itself an error.
export class ValidationErrors extends Error {
  constructor(readonly errors: Record<string, unknown>) {
    super(
      Object.keys(errors)
        .toSorted()
        .map((key) => `${key}: ${errorText(errors[key])}`)
        .join("; ") + (Object.keys(errors).length > 0 ? "." : ""),
    );
    this.name = "ValidationErrors";
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

// sql.ErrNoRows: the database layer (M0.4) returns this sentinel when a
// query has no rows; ToApiError turns it into a 404.
export const ErrNoRows = new Error("sql: no rows in result set");

// ApiError defines the struct for a basic api error response.
export class ApiError extends Error {
  readonly #rawData: unknown;
  readonly data: Record<string, unknown>;
  readonly status: number;

  constructor(status: number, message: string, rawData: unknown, data: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.#rawData = rawData;
  }

  // RawData returns the unformatted error data (could be an internal error, text, etc.)
  rawData(): unknown {
    return this.#rawData;
  }

  // Is reports whether the current ApiError wraps the target.
  is(target: unknown): boolean {
    if (this.#rawData instanceof Error) {
      return errorsIs(this.#rawData, target);
    }
    return target instanceof ApiError && target === this;
  }

  // the JSON body, with upstream's field order and json.Deterministic
  // (sorted map keys)
  toJSON(): { data: unknown; message: string; status: number } {
    return { data: sortKeys(this.data), message: this.message, status: this.status };
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).toSorted()) {
      sorted[key] = sortKeys(value[key]);
    }
    return sorted;
  }
  return value;
}

// errors.Is: walks err and its `cause` chain, comparing by identity and
// calling is(target) where defined.
export function errorsIs(err: unknown, target: unknown): boolean {
  if (err === undefined || err === null || target === undefined || target === null) {
    return err === target;
  }
  for (let current: unknown = err; current !== undefined && current !== null;) {
    if (current === target) {
      return true;
    }
    const is: unknown = (current as { is?: unknown }).is;
    if (typeof is === "function" && (is as (t: unknown) => boolean).call(current, target)) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

// errors.As: the first error in err's `cause` chain that is an instance of type.
export function errorsAs<E extends Error>(
  err: unknown,
  type: abstract new (...args: never[]) => E,
): E | undefined {
  for (let current: unknown = err; current !== undefined && current !== null;) {
    if (current instanceof type) {
      return current;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

// http.StatusText for the codes ApiError is created with.
export function statusText(status: number): string {
  return statusTexts.get(status) ?? "";
}

const statusTexts = new Map<number, string>([
  [100, "Continue"],
  [101, "Switching Protocols"],
  [102, "Processing"],
  [103, "Early Hints"],
  [200, "OK"],
  [201, "Created"],
  [202, "Accepted"],
  [203, "Non-Authoritative Information"],
  [204, "No Content"],
  [205, "Reset Content"],
  [206, "Partial Content"],
  [207, "Multi-Status"],
  [208, "Already Reported"],
  [226, "IM Used"],
  [300, "Multiple Choices"],
  [301, "Moved Permanently"],
  [302, "Found"],
  [303, "See Other"],
  [304, "Not Modified"],
  [305, "Use Proxy"],
  [307, "Temporary Redirect"],
  [308, "Permanent Redirect"],
  [400, "Bad Request"],
  [401, "Unauthorized"],
  [402, "Payment Required"],
  [403, "Forbidden"],
  [404, "Not Found"],
  [405, "Method Not Allowed"],
  [406, "Not Acceptable"],
  [407, "Proxy Authentication Required"],
  [408, "Request Timeout"],
  [409, "Conflict"],
  [410, "Gone"],
  [411, "Length Required"],
  [412, "Precondition Failed"],
  [413, "Request Entity Too Large"],
  [414, "Request URI Too Long"],
  [415, "Unsupported Media Type"],
  [416, "Requested Range Not Satisfiable"],
  [417, "Expectation Failed"],
  [418, "I'm a teapot"],
  [421, "Misdirected Request"],
  [422, "Unprocessable Entity"],
  [423, "Locked"],
  [424, "Failed Dependency"],
  [425, "Too Early"],
  [426, "Upgrade Required"],
  [428, "Precondition Required"],
  [429, "Too Many Requests"],
  [431, "Request Header Fields Too Large"],
  [451, "Unavailable For Legal Reasons"],
  [500, "Internal Server Error"],
  [501, "Not Implemented"],
  [502, "Bad Gateway"],
  [503, "Service Unavailable"],
  [504, "Gateway Timeout"],
  [505, "HTTP Version Not Supported"],
  [506, "Variant Also Negotiates"],
  [507, "Insufficient Storage"],
  [508, "Loop Detected"],
  [510, "Not Extended"],
  [511, "Network Authentication Required"],
]);

// inflector.UcFirst converts the first character of a string into uppercase.
function ucFirst(str: string): string {
  if (str === "") {
    return "";
  }
  const first = String.fromCodePoint(str.codePointAt(0) as number);
  return first.toUpperCase() + str.slice(first.length);
}

// inflector.Sentenize converts and normalizes string into a sentence.
export function sentenize(str: string): string {
  str = goTrimSpace(str);
  if (str === "") {
    return "";
  }
  str = ucFirst(str);
  const lastChar = str[str.length - 1];
  if (lastChar !== "." && lastChar !== "?" && lastChar !== "!") {
    return `${str}.`;
  }
  return str;
}

// strings.TrimSpace (Unicode White_Space)
function goTrimSpace(str: string): string {
  return str.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, "");
}

// NewApiError creates and returns new normalized ApiError instance.
export function newApiError(status: number, message: string, rawErrData: unknown): ApiError {
  if (message === "") {
    message = statusText(status);
  }
  return new ApiError(
    status,
    goTrimSpace(sentenize(message)),
    rawErrData,
    safeErrorsData(rawErrData),
  );
}

// NewNotFoundError creates and returns 404 ApiError.
export function newNotFoundError(message: string, rawErrData: unknown): ApiError {
  return newApiError(404, message || "The requested resource wasn't found.", rawErrData);
}

// NewBadRequestError creates and returns 400 ApiError.
export function newBadRequestError(message: string, rawErrData: unknown): ApiError {
  return newApiError(
    400,
    message || "Something went wrong while processing your request.",
    rawErrData,
  );
}

// NewForbiddenError creates and returns 403 ApiError.
export function newForbiddenError(message: string, rawErrData: unknown): ApiError {
  return newApiError(403, message || "You are not allowed to perform this request.", rawErrData);
}

// NewUnauthorizedError creates and returns 401 ApiError.
export function newUnauthorizedError(message: string, rawErrData: unknown): ApiError {
  return newApiError(401, message || "Missing or invalid authentication.", rawErrData);
}

// NewInternalServerError creates and returns 500 ApiError.
export function newInternalServerError(message: string, rawErrData: unknown): ApiError {
  return newApiError(
    500,
    message || "Something went wrong while processing your request.",
    rawErrData,
  );
}

export function newTooManyRequestsError(message: string, rawErrData: unknown): ApiError {
  return newApiError(429, message || "Too Many Requests.", rawErrData);
}

// fs.ErrNotExist: Node's file system errors carry the ENOENT code.
function isNotExist(err: unknown): boolean {
  for (let current: unknown = err; current !== undefined && current !== null;) {
    if ((current as { code?: unknown }).code === "ENOENT") {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

// ToApiError wraps err into ApiError instance (if not already).
export function toApiError(err: Error): ApiError {
  const apiErr = errorsAs(err, ApiError);
  if (apiErr) {
    return apiErr;
  }
  // no ApiError found -> assign a generic one
  if (errorsIs(err, ErrNoRows) || isNotExist(err)) {
    return newNotFoundError("", err);
  }
  return newBadRequestError("", err);
}

// -------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function safeErrorsData(data: unknown): Record<string, unknown> {
  if (data instanceof ValidationErrors) {
    return resolveSafeErrorsData(data.errors);
  }
  if (data instanceof Error) {
    const validationErrors = errorsAs(data, ValidationErrors);
    if (validationErrors) {
      return resolveSafeErrorsData(validationErrors.errors);
    }
    return {}; // not nil to ensure that is json serialized as object
  }
  if (data instanceof Map) {
    return resolveSafeErrorsData(Object.fromEntries(data) as Record<string, unknown>);
  }
  if (isPlainObject(data)) {
    return resolveSafeErrorsData(data);
  }
  return {}; // not nil to ensure that is json serialized as object
}

function resolveSafeErrorsData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, err] of Object.entries(data)) {
    if (isNestedError(err)) {
      result[name] = safeErrorsData(err);
    } else {
      result[name] = resolveSafeErrorItem(err);
    }
  }
  return result;
}

function isNestedError(err: unknown): boolean {
  return (
    err instanceof ValidationErrors ||
    err instanceof Map ||
    (isPlainObject(err) && !isSafeErrorItem(err))
  );
}

function isSafeErrorItem(err: unknown): err is SafeErrorItem {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { code?: unknown }).code === "function" &&
    typeof (err as { message?: unknown }).message === "string"
  );
}

// resolveSafeErrorItem extracts from each validation error its
// public safe error code and message.
function resolveSafeErrorItem(err: unknown): unknown {
  const data: Record<string, unknown> = {};

  if (isSafeErrorItem(err)) {
    // extract the specific error code and message
    data.code = err.code();
    data.message = sentenize(err.message);
  } else {
    // fallback to the default public safe values
    data.code = "validation_invalid_value";
    data.message = "Invalid value.";
  }

  const params = (err as Partial<SafeErrorParamsResolver> | null)?.params;
  if (typeof params === "function") {
    const p = params.call(err);
    if (Object.keys(p).length > 0) {
      data.params = p;
    }
  }

  const resolve = (err as Partial<SafeErrorResolver> | null)?.resolve;
  if (typeof resolve === "function") {
    return resolve.call(err, data);
  }

  return data;
}
