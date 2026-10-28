// Upstream: ozzo-validation v4.4.1 error.go (the pocketbase fork,
// ganigeorgiev.com/pocketbase/ozzo-validation/v4).
//
// Go's Error() is the JS `message`: it is what the API error helpers
// (src/server/error.ts) read, as upstream's router reads Error(). Go's
// Message() (the message before the template is executed) is getMessage().
//
// Errors extends src/server/error.ts's ValidationErrors, so the API error
// helpers recognize it; its `errors` record is Go's map (null-prototype,
// mutable as the Go map is) and its message is computed when read.
//
// ErrorObject.Error() executes the message as a Go text/template with the
// params as data, when there are params. Only the template features the
// upstream messages use are ported (executeTemplate):
//   - text outside actions, copied as is;
//   - `{{.name}}` (and `{{ .name }}`): the param `name`, printed as Go's
//     fmt.Fprint prints it (see printValue); a missing param or a nil one
//     prints "<no value>".
// Any other action, or an unclosed `{{`, throws, as template.Must panics.

import { ValidationErrors } from "@/server/error";
import { DateTime } from "@/tools/types/datetime";
import { compareUTF8, marshal } from "@/tools/types/go-json";

// Error interface represents a validation error (Go's validation.Error).
export interface Error extends globalThis.Error {
  code(): string;
  getMessage(): string;
  setMessage(message: string): Error;
  params(): Record<string, unknown>;
  setParams(params: Record<string, unknown> | null): Error;
}

// Float64 marks a number as a Go float64 for printing: a plain JS number
// prints as a Go int when it is an integer (the thresholds and params
// upstream passes are ints), a Float64 always prints as fmt prints a
// float64 (1e+06, 0.5).
export class Float64 {
  constructor(readonly value: number) {}

  toJSON(): number {
    return this.value;
  }

  marshalJSON(): string {
    return marshal(this.value);
  }
}

// ErrorObject is the default validation error that implements the Error
// interface. It is immutable: the setters return a changed copy, as the Go
// value receivers do.
export class ErrorObject extends globalThis.Error implements Error {
  readonly #code: string;
  readonly #message: string;
  readonly #params: Record<string, unknown> | null;

  constructor(code: string, message: string, params: Record<string, unknown> | null = null) {
    super();
    this.name = "ErrorObject";
    this.#code = code;
    this.#message = message;
    this.#params = params;
    // ozzo's Error() executes the template on every call against the same
    // params map, so the message follows later changes to params()
    Object.defineProperty(this, "message", {
      get: () => errorText(this.#message, this.#params),
      configurable: true,
      enumerable: false,
    });
  }

  // SetCode set the error's translation code.
  setCode(code: string): Error {
    return new ErrorObject(code, this.#message, this.#params);
  }

  // Code get the error's translation code.
  code(): string {
    return this.#code;
  }

  // SetParams set the error's params.
  setParams(params: Record<string, unknown> | null): Error {
    return new ErrorObject(this.#code, this.#message, params);
  }

  // AddParam add parameter to the error's parameters.
  addParam(name: string, value: unknown): Error {
    return new ErrorObject(this.#code, this.#message, { ...this.#params, [name]: value });
  }

  // Params returns the error's params ({} for Go's nil map).
  params(): Record<string, unknown> {
    return this.#params ?? {};
  }

  // SetMessage set the error's message.
  setMessage(message: string): Error {
    return new ErrorObject(this.#code, message, this.#params);
  }

  // Message return the error's message.
  getMessage(): string {
    return this.#message;
  }

  // Error returns the error message.
  error(): string {
    return this.message;
  }
}

function errorText(message: string, params: Record<string, unknown> | null): string {
  if (params === null || Object.keys(params).length === 0) {
    return message;
  }
  return executeTemplate(message, params);
}

// InternalError represents an error that should NOT be treated as a
// validation error.
export class InternalError extends globalThis.Error {
  constructor(readonly err: globalThis.Error) {
    super(err.message);
    this.name = "InternalError";
  }

  // InternalError returns the actual error that it wraps around.
  internalError(): globalThis.Error {
    return this.err;
  }
}

// NewInternalError wraps a given error into an InternalError.
export function NewInternalError(err: globalThis.Error): InternalError {
  return new InternalError(err);
}

// Errors represents the validation errors that are indexed by struct field
// names, map or slice keys. values are Error or Errors (for map, slice and
// array error value is Errors).
export class Errors extends ValidationErrors {
  declare readonly errors: Record<string, globalThis.Error | null>;

  constructor(errors: Record<string, globalThis.Error | null> = {}) {
    super(Object.assign(Object.create(null) as Record<string, globalThis.Error | null>, errors));
    this.name = "Errors";
    // the map is mutable, so the text is computed when read
    Object.defineProperty(this, "message", {
      configurable: true,
      enumerable: false,
      get: () => this.error(),
    });
  }

  // the number of entries (Go's len)
  get size(): number {
    return Object.keys(this.errors).length;
  }

  // Error returns the error string of Errors.
  error(): string {
    const keys = Object.keys(this.errors);
    if (keys.length === 0) {
      return "";
    }
    keys.sort(compareUTF8);

    let s = "";
    for (const [i, key] of keys.entries()) {
      if (i > 0) {
        s += "; ";
      }
      const err = this.errors[key];
      if (err instanceof Errors) {
        s += `${key}: (${err.error()})`;
      } else {
        s += `${key}: ${err === null || err === undefined ? "<nil>" : err.message}`;
      }
    }
    s += ".";
    return s;
  }

  // MarshalJSON converts the Errors into a valid JSON.
  marshalJSON(): string {
    // a null-prototype object, so that a "__proto__" key stays a member
    const errs: Record<string, unknown> = Object.create(null);
    for (const [key, err] of Object.entries(this.errors)) {
      if (err instanceof Errors) {
        errs[key] = err;
      } else {
        errs[key] = err === null || err === undefined ? null : err.message;
      }
    }
    return marshal(errs, { legacy: true });
  }

  // Filter removes all nils from Errors and returns back the updated Errors
  // as an error. If the length of Errors becomes 0, it will return null.
  filter(): Errors | null {
    for (const [key, value] of Object.entries(this.errors)) {
      if (value === null || value === undefined) {
        delete this.errors[key];
      }
    }
    if (this.size === 0) {
      return null;
    }
    return this;
  }
}

// NewError create new validation error.
export function NewError(code: string, message: string): Error {
  return new ErrorObject(code, message);
}

// -------------------------------------------------------------------
// text/template subset

const actionPattern = /^\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*$/;

function executeTemplate(text: string, data: Record<string, unknown>): string {
  let out = "";
  let i = 0;
  for (;;) {
    const open = text.indexOf("{{", i);
    if (open < 0) {
      return out + text.slice(i);
    }
    out += text.slice(i, open);
    const close = text.indexOf("}}", open + 2);
    if (close < 0) {
      throw new globalThis.Error("template: err:1: unclosed action");
    }
    const action = text.slice(open + 2, close);
    const m = actionPattern.exec(action);
    if (m === null) {
      throw new globalThis.Error(`template: err: unsupported action {{${action}}}`);
    }
    const name = m[1] as string;
    const value = Object.hasOwn(data, name) ? data[name] : undefined;
    out += value === null || value === undefined ? "<no value>" : printValue(value);
    i = close + 2;
  }
}

// fmt.Fprint of a template value (%v): strings as they are, integers and
// Float64 as Go prints them, arrays as "[a b]", errors by their message,
// values with a Go String() method (string()) by it, plain objects as Go
// maps ("map[k:v]", sorted keys).
export function printValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "<nil>";
  }
  switch (typeof value) {
    case "string":
      return value;
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return value.toString();
    case "number":
      return Number.isInteger(value) ? integerText(value) : formatFloatV(value);
    default:
      break;
  }
  if (value instanceof Float64) {
    return formatFloatV(value.value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => printValue(v)).join(" ") + "]";
  }
  if (value instanceof globalThis.Error) {
    return value.message;
  }
  if (value instanceof DateTime) {
    return value.string();
  }
  const str = (value as { string?: unknown }).string;
  if (typeof str === "function") {
    return String(str.call(value));
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).toSorted(compareUTF8);
    const record = value as Record<string, unknown>;
    return "map[" + keys.map((k) => `${k}:${printValue(record[k])}`).join(" ") + "]";
  }
  return String(value);
}

function integerText(n: number): string {
  // -0 is an int 0; integers beyond 2^53 print their exact digits
  return n === 0 ? "0" : BigInt(n).toString();
}

// strconv.FormatFloat(f, 'g', -1, 64), which fmt's %v uses for a float64
// (internal/strconv fmtEFG): the shortest digits, in %e form when the
// decimal exponent is < -4 or >= 6 (the precision used for this decision
// when the digits are the shortest), with at least two exponent digits.
export function formatFloatV(f: number): string {
  if (Number.isNaN(f)) {
    return "NaN";
  }
  if (f === Infinity) {
    return "+Inf";
  }
  if (f === -Infinity) {
    return "-Inf";
  }
  if (f === 0) {
    return Object.is(f, -0) ? "-0" : "0";
  }
  // the shortest decimal digits and the decimal exponent
  const [mantissa, expText] = Math.abs(f).toExponential().split("e") as [string, string];
  const digits = mantissa.replace(".", "");
  const exp = Number(expText);
  const sign = f < 0 ? "-" : "";

  if (exp < -4 || exp >= 6) {
    const frac = digits.length > 1 ? "." + digits.slice(1) : "";
    const e = Math.abs(exp);
    return `${sign}${digits[0]}${frac}e${exp < 0 ? "-" : "+"}${e < 10 ? "0" : ""}${e}`;
  }
  const dp = exp + 1; // digits before the decimal point
  if (dp <= 0) {
    return `${sign}0.${"0".repeat(-dp)}${digits}`;
  }
  if (dp >= digits.length) {
    return sign + digits + "0".repeat(dp - digits.length);
  }
  return `${sign}${digits.slice(0, dp)}.${digits.slice(dp)}`;
}
