// Upstream: plugins/jsvm/internal/types/generated/types.d.ts (the names and
// the Go types of what a migration file can reach), with how goja converts
// arguments, results and struct fields (Runtime.wrapReflectFunc,
// toReflectValue)
//
// A migration file sees an internal object through its GoClass: the Go
// fields and methods of the class, and nothing else of the internal object.
// A signature says what Go would do with the arguments, so the internal
// method gets what its Go twin gets:
//
//   ""        no arguments          "s,i"    a string and an int
//   "...s"    variadic              ":d"     the result is a time.Duration
//
//   s string (null and undefined are "", anything else String(v))
//   i int    f float64    b bool    d time.Duration (nanoseconds)
//   B []byte (a string, a byte slice or an array of numbers)
//   E dbx.Expression    M core.Model    G core.Field
//   P a map (nil is empty)    L []string    Q a filter, func(q) error
//   a any
//   S a value bound to SQL    D dbx.Params
//   H a dbx.HashExp value     X a dbx.HashExp (nil stays nil)
//
// A missing argument is its Go zero value. A result ":J" is the []byte of a
// marshalJSON, which the internal classes return as text.

import { Collection } from "@/collections/collection-model";
import {
  AuthAlertConfig,
  EmailTemplate,
  MFAConfig,
  OAuth2Config,
  OAuth2KnownFields,
  OAuth2ProviderConfig,
  OTPConfig,
  PasswordAuthConfig,
  TokenConfig,
} from "@/collections/collection-model-auth-options";
import type { Field } from "@/fields/field";
import { isExpression } from "@/db/dbx/expression";
import { BoundValue, Float64 } from "@/db/dbx/query";
import { GoJSONArray, GoJSONMap } from "@/migrations/json-values";
import { type Adapter, type Membrane, toInteger } from "@/migrations/membrane";
import { Record as RecordModel } from "@/records/record-model";
import { Settings } from "@/settings/settings-model";
import { DateTime } from "@/tools/types/datetime";
import type { GoType as JSONElemType } from "@/tools/types/go-json";
import { stringType } from "@/tools/types/go-json";
import { localLocation, lookup, type Location, UTC } from "@/tools/types/go-zoneinfo";

export type GoType =
  | "string"
  | "int"
  | "float"
  | "bool"
  | "any"
  | "datetime"
  | { ptr: GoType }
  // json: the slice is a types.JSONArray of that element
  | { slice: GoType; json?: JSONElemType }
  | { struct: GoClass; make(): object };

export type CustomMethod = (target: never, args: unknown[], m: Membrane) => unknown;

export type Method = string | CustomMethod;

export interface GoClass {
  // in the struct's order: goja lists them first
  fields?: Readonly<Record<string, GoType>>;
  methods: Readonly<Record<string, Method>>;
  // JSON.stringify uses the internal marshalJSON, the Go type's Marshaler
  json?: boolean;
  // String(v) is the Go type's String()
  stringer?: boolean;
}

interface Signature {
  params: string[];
  variadic: string | undefined;
  result: string | undefined;
}

const signatures = new Map<string, Signature>();

function parseSignature(text: string): Signature {
  let signature = signatures.get(text);
  if (signature === undefined) {
    const [args = "", result] = text.split(":");
    const params = args === "" ? [] : args.split(",");
    const last = params.at(-1);
    const variadic = last?.startsWith("...") === true ? last.slice(3) : undefined;
    if (variadic !== undefined) {
      params.pop();
    }
    signature = { params, variadic, result };
    signatures.set(text, signature);
  }
  return signature;
}

function conversionError(m: Membrane, i: number, v: unknown, to: string): Error {
  return new m.vm.TypeError(
    `could not convert function call parameter ${i}: could not convert ${String(v)} to ${to}`,
  );
}

function isModel(v: unknown): boolean {
  return v instanceof RecordModel || v instanceof Collection || v instanceof Settings;
}

export function isField(v: unknown): v is Field {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { prepareValue?: unknown }).prepareValue === "function"
  );
}

// the value a Go function gets for one argument
function convertArg(m: Membrane, code: string, v: unknown, i: number, missing: boolean): unknown {
  switch (code) {
    case "s":
      return v === undefined || v === null ? "" : String(v);
    case "i":
      return toInteger(v);
    case "f":
      return v === undefined ? 0 : Number(v);
    case "b":
      return Boolean(v);
    case "d":
      return BigInt(toInteger(v));
    case "B": {
      if (missing || v === null || v === undefined) {
        return new Uint8Array();
      }
      const bytes = m.toBytes(v);
      if (bytes === undefined) {
        throw conversionError(m, i, v, "[]uint8");
      }
      return bytes;
    }
    case "E": {
      if (v === undefined || v === null) {
        return null;
      }
      const host = m.toHost(v);
      if (!isExpression(host)) {
        throw conversionError(m, i, v, "dbx.Expression");
      }
      return host;
    }
    case "M": {
      if (v === undefined || v === null) {
        return null;
      }
      const host = m.toHost(v);
      if (!isModel(host)) {
        throw conversionError(m, i, v, "core.Model");
      }
      return host;
    }
    case "G": {
      const host = m.toHost(v);
      if (!isField(host)) {
        throw conversionError(m, i, v, "core.Field");
      }
      return host;
    }
    case "P":
      return (v === undefined || v === null ? {} : m.toHost(v)) as object;
    case "S":
      return toSql(m, v);
    case "H":
      return hashValue(m, v);
    case "D":
      return sqlParams(m, v, (item) => toSql(m, item));
    case "X":
      return v === undefined || v === null ? null : sqlParams(m, v, (item) => hashValue(m, item));
    case "L": {
      const items = m.toHost(v);
      return Array.isArray(items) ? items.map((item) => convertArg(m, "s", item, i, false)) : [];
    }
    case "Q":
      return filterFunc(m, v, i);
    default:
      return m.toHost(v);
  }
}

// func(q *dbx.SelectQuery) error
function filterFunc(m: Membrane, fn: unknown, i: number): unknown {
  if (fn === undefined || fn === null) {
    return null;
  }
  if (typeof fn !== "function") {
    throw conversionError(m, i, fn, "func(*dbx.SelectQuery) error");
  }
  return (q: unknown) => {
    throwResult(m, (fn as (q: unknown) => unknown)(m.toVm(q)));
  };
}

// goja's conversion of a JS function's result to Go's `error`
export function throwResult(m: Membrane, result: unknown): void {
  if (result === undefined || result === null) {
    return;
  }
  const hostError = m.targetOf(result);
  if (hostError instanceof Error) {
    throw hostError;
  }
  throw new Error(`could not convert ${String(result)} to error`);
}

export function goArgs(m: Membrane, signature: string, args: readonly unknown[]): unknown[] {
  const { params, variadic } = parseSignature(signature);
  const converted = params.map((code, i) => convertArg(m, code, args[i], i, i >= args.length));
  if (variadic !== undefined) {
    for (let i = params.length; i < args.length; i++) {
      converted.push(convertArg(m, variadic, args[i], i, false));
    }
  }
  return converted;
}

function goResult(m: Membrane, signature: string, value: unknown): unknown {
  switch (parseSignature(signature).result) {
    case "d":
      return m.toVm(new GoDuration(value as number | bigint));
    case "J":
      return m.toVm(new TextEncoder().encode(String(value)));
    default:
      return m.toVm(value);
  }
}

export function goMethod(
  m: Membrane,
  target: object,
  key: string,
  method: Method,
): (...args: unknown[]) => unknown {
  if (typeof method === "function") {
    return (...args) => m.guard(() => method(target as never, args, m));
  }
  return (...args) =>
    m.guard(() => {
      const fn = (target as Record<string, unknown>)[key] as (...a: unknown[]) => unknown;
      return goResult(m, method, fn.apply(target, goArgs(m, method, args)));
    });
}

// *string and *float64 fields: goja wraps the pointer, so a value is an
// object that compares and prints as the value (`==`, never `===`).
export class GoPointer {
  constructor(
    readonly value: string | number | boolean,
    readonly float = false,
  ) {}
}

export const pointerAdapter: Adapter = {
  get(target, key) {
    const { value } = target as GoPointer;
    switch (key) {
      case "valueOf":
      case "toJSON":
        return () => value;
      case "toString":
        return () => String(value);
      case "length":
        return 0;
      default:
        return undefined;
    }
  },
  set: () => false,
  keys: () => [],
};

// time.Duration
export class GoDuration {
  readonly ns: number;

  constructor(ns: number | bigint) {
    this.ns = Number(ns);
  }

  string(): string {
    return formatDuration(this.ns);
  }
}

function trimFloat(v: number): string {
  return String(Number(v.toFixed(9)));
}

// time.Duration.String
function formatDuration(ns: number): string {
  if (ns === 0) {
    return "0s";
  }
  const sign = ns < 0 ? "-" : "";
  const abs = Math.abs(ns);
  if (abs < 1e3) {
    return `${sign}${abs}ns`;
  }
  if (abs < 1e6) {
    return `${sign}${trimFloat(abs / 1e3)}µs`;
  }
  if (abs < 1e9) {
    return `${sign}${trimFloat(abs / 1e6)}ms`;
  }
  const hours = Math.floor(abs / 3.6e12);
  const minutes = Math.floor((abs % 3.6e12) / 6e10);
  const seconds = trimFloat((abs % 6e10) / 1e9);
  const prefix = hours > 0 ? `${hours}h${minutes}m` : minutes > 0 ? `${minutes}m` : "";
  return `${sign}${prefix}${seconds}s`;
}

const durationUnits: Readonly<Record<string, number>> = {
  hours: 3.6e12,
  minutes: 6e10,
  seconds: 1e9,
};

export const durationAdapter: Adapter = {
  get(target, key) {
    const duration = target as GoDuration;
    if (Object.hasOwn(durationUnits, key)) {
      return () => duration.ns / (durationUnits[key] as number);
    }
    switch (key) {
      case "valueOf":
      case "toJSON":
      case "nanoseconds":
        return () => duration.ns;
      case "microseconds":
        return () => Math.trunc(duration.ns / 1e3);
      case "milliseconds":
        return () => Math.trunc(duration.ns / 1e6);
      case "string":
      case "toString":
        return () => duration.string();
      default:
        return undefined;
    }
  },
  set: () => false,
  keys: () => [],
};

// fs.FileMode
export class GoFileMode {
  constructor(readonly mode: number) {}
}

export const fileModeAdapter: Adapter = {
  get(target, key) {
    const { mode } = target as GoFileMode;
    switch (key) {
      case "valueOf":
      case "toJSON":
        return () => mode;
      case "toString":
        return () => String(mode);
      case "isDir":
        return () => mode >= 2 ** 31;
      case "isRegular":
        return () => mode < 2 ** 19;
      case "perm":
        return () => mode % 512;
      default:
        return undefined;
    }
  },
  set: () => false,
  keys: () => [],
};

// A Date as Go's time.Time: what a migration reads of a stat or a DateTime.
// The rest of time.Time needs Go's layouts and locations (01-scope.md).
export const timeAdapter: Adapter = {
  get(target, key) {
    const date = target as Date;
    switch (key) {
      case "unix":
        return () => Math.floor(date.getTime() / 1000);
      case "unixMilli":
        return () => date.getTime();
      case "year":
        return () => date.getUTCFullYear();
      case "month":
        return () => date.getUTCMonth() + 1;
      case "day":
        return () => date.getUTCDate();
      case "hour":
        return () => date.getUTCHours();
      case "minute":
        return () => date.getUTCMinutes();
      case "second":
        return () => date.getUTCSeconds();
      case "toJSON":
        return () => date.toISOString();
      default:
        return undefined;
    }
  },
  set: () => false,
  keys: () => [],
};

// time.Time.String, which the SQLite driver stores
function timeText(date: Date, location: Location): string {
  const { name, offset } = lookup(location, Math.floor(date.getTime() / 1000));
  const shifted = new Date(date.getTime() + offset * 1000).toISOString();
  const [day = "", time = ""] = shifted.replace("Z", "").split("T");
  const minutes = Math.abs(offset) / 60;
  const zone = `${String(Math.trunc(minutes / 60)).padStart(2, "0")}${String(minutes % 60).padStart(2, "0")}`;
  return `${day} ${time.replace(/\.?0+$/, "")} ${offset < 0 ? "-" : "+"}${zone} ${name}`;
}

function unsupportedType(go: unknown): string {
  if (Array.isArray(go)) {
    return "[]interface {}, a slice of interface";
  }
  if (typeof go === "function") {
    return "func(goja.FunctionCall) goja.Value, a func";
  }
  if (go instanceof RecordModel) {
    return "core.Record, a struct";
  }
  if (go instanceof Collection) {
    return "core.Collection, a struct";
  }
  if (go instanceof Settings) {
    return "core.Settings, a struct";
  }
  const name = (go as object).constructor.name;
  return name === "Object" ? "map[string]interface {}, a map" : `core.${name}, a struct`;
}

function unsupported(go: unknown): BoundValue {
  return new BoundValue(go, (position) => {
    throw new Error(
      `sql: converting argument $${position} type: unsupported type ${unsupportedType(go)}`,
    );
  });
}

// What goja exports and database/sql binds for a value of a migration file.
// The value stays a param of its Go type, so params() still gives it.
export function toSql(m: Membrane, v: unknown): unknown {
  if (typeof v === "function") {
    return unsupported(v);
  }
  // goja holds an integral number as an int64
  if (typeof v === "number" && Number.isInteger(v) && !Number.isSafeInteger(v)) {
    return Math.abs(v) < 2 ** 63 ? BigInt(v) : v;
  }
  if (typeof v !== "object" || v === null) {
    return v ?? null;
  }

  const target = m.targetOf(v);
  const go = target ?? m.toHost(v);

  if (go instanceof Uint8Array || isExpression(go)) {
    return go;
  }
  if (go instanceof GoPointer) {
    return go.float ? new Float64(go.value as number) : new BoundValue(go, () => go.value);
  }
  if (go instanceof GoDuration) {
    return new BoundValue(go, () => go.ns);
  }
  if (go instanceof GoFileMode) {
    return new BoundValue(go, () => go.mode);
  }
  if (go instanceof Date) {
    // goja exports a JS Date in the local zone
    return new BoundValue(go, () => timeText(go, target === undefined ? localLocation() : UTC));
  }
  if (typeof (go as { value?: unknown }).value === "function") {
    const valuer = go as { value(): string | Uint8Array | null };
    return new BoundValue(go, () => valuer.value());
  }
  return unsupported(go);
}

// a value of a dbx.HashExp: a plain slice is an IN list, any other value a
// single parameter (a JSONArray has a driver value, so it is one)
function hashValue(m: Membrane, v: unknown): unknown {
  const sql = toSql(m, v);
  if (sql instanceof BoundValue && Array.isArray(sql.go) && m.targetOf(v) === undefined) {
    return Array.from(v as unknown[], (item) => toSql(m, item));
  }
  return sql;
}

// a map of values for SQL; a map goja holds as a Go value reads as its data
function sqlParams(
  m: Membrane,
  v: unknown,
  value: (item: unknown) => unknown,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (typeof v !== "object" || v === null) {
    return params;
  }
  const target = m.targetOf(v);
  const source = (target instanceof GoJSONMap ? target.data : (target ?? v)) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(source)) {
    const item = source[key];
    Object.defineProperty(params, key, {
      // a Go map's values are internal ones, and keep their Go types;
      // params() hands out values that are already bound
      value:
        target === undefined
          ? value(item)
          : item instanceof BoundValue || item instanceof Float64
            ? item
            : value(m.toVm(item)),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return params;
}

// Go's assignment to a struct field, as goja converts the value.
export function toGo(m: Membrane, value: unknown, type: GoType, current: unknown): unknown {
  if (typeof type === "object") {
    if ("ptr" in type) {
      return value === undefined || value === null ? null : toGo(m, value, type.ptr, null);
    }
    if ("slice" in type) {
      const elem = type.slice;
      const items = m.toHost(value);
      return Array.isArray(items) ? items.map((item) => toGo(m, item, elem, null)) : [];
    }
    return assignStruct(m, value, type, current);
  }
  switch (type) {
    case "string":
      return value === undefined || value === null ? "" : String(value);
    case "int":
      return toInteger(value);
    case "float":
      return Number(value);
    case "bool":
      return Boolean(value);
    case "datetime": {
      const host = m.toHost(value);
      return host instanceof DateTime ? host : new DateTime();
    }
    default:
      return m.toHost(value);
  }
}

// A map or a struct assigned to a struct field: its members over the old
// value of the field.
function assignStruct(
  m: Membrane,
  value: unknown,
  type: { struct: GoClass; make(): object },
  current: unknown,
): object {
  const target = typeof current === "object" && current !== null ? current : type.make();
  const fields = type.struct.fields ?? {};
  for (const [name, fieldType] of Object.entries(fields)) {
    const member =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[name]
        : undefined;
    if (member !== undefined) {
      const holder = target as Record<string, unknown>;
      holder[name] = toGo(m, member, fieldType, holder[name]);
    }
  }
  return target;
}

function fromGo(m: Membrane, holder: object, name: string, type: GoType): unknown {
  const fields = holder as Record<string, unknown>;
  const value = fields[name];

  if (typeof type === "object") {
    if ("ptr" in type) {
      return value === null || value === undefined
        ? null
        : m.toVm(new GoPointer(value as string | number | boolean, type.ptr === "float"));
    }
    if ("slice" in type) {
      if (type.json !== undefined) {
        return m.toVm(new GoJSONArray(fields, name, type.json));
      }
      const elem = type.slice;
      return m.sliceView({
        read: () => (fields[name] ?? []) as unknown[],
        write: (next) => {
          fields[name] = next;
        },
        toGo: (item) => toGo(m, item, elem, null),
      });
    }
  }

  return m.toVm(value);
}

// the adapter of a class: its Go fields and methods, and no other member
export function classAdapter(cls: GoClass, overrides: Partial<Adapter> = {}): Adapter {
  const fields = cls.fields ?? {};
  const keys = [...Object.keys(fields), ...Object.keys(cls.methods).toSorted()];

  return {
    keys: () => keys,
    get(target, key, m) {
      const override = overrides.get?.(target, key, m);
      if (override !== undefined) {
        return override;
      }
      if (Object.hasOwn(cls.methods, key)) {
        return goMethod(m, target, key, cls.methods[key] as Method);
      }
      if (Object.hasOwn(fields, key)) {
        return fromGo(m, target, key, fields[key] as GoType);
      }
      if (key === "toJSON") {
        return cls.json === true
          ? () => m.vm.parse((target as { marshalJSON(): string }).marshalJSON())
          : undefined;
      }
      if (key === "toString" && cls.stringer === true) {
        return () => String(target);
      }
      if (key in m.vm.objectPrototype) {
        return Reflect.get(m.vm.objectPrototype, key) as unknown;
      }
      return undefined;
    },
    set(target, key, value, m) {
      const override = overrides.set?.(target, key, value, m);
      if (override === true) {
        return true;
      }
      if (!Object.hasOwn(fields, key)) {
        return false; // goja ignores it
      }
      const holder = target as Record<string, unknown>;
      holder[key] = toGo(m, value, fields[key] as GoType, holder[key]);
      return true;
    },
  };
}

// -------------------------------------------------------------------
// the classes

const baseModel: Readonly<Record<string, Method>> = {
  isNew: "",
  lastSavedPK: "",
  markAsNew: "",
  markAsNotNew: "",
  pk: "",
  postScan: "",
};

export const recordMethods: Readonly<Record<string, Method>> = {
  ...baseModel,
  baseFilesPath: "",
  clone: "",
  collection: "",
  customData: "",
  dbExport: "a",
  email: "",
  emailVisibility: "",
  expand: "",
  expandedAll: "s",
  expandedOne: "s",
  fieldsData: "",
  findFileFieldByFile: "s",
  fresh: "",
  get: "s",
  getBool: "s",
  getDateTime: "s",
  getFloat: "s",
  getGeoPoint: "s",
  getInt: "s",
  getRaw: "s",
  getString: "s",
  getStringSlice: "s",
  getUnsavedFiles: "s",
  getUploadedFiles: "s",
  hide: "...s",
  ignoreEmailVisibility: "b",
  ignoreUnchangedFields: "b",
  isSuperuser: "",
  load: "P",
  marshalJSON: ":J",
  mergeExpand: "P",
  original: "",
  publicExport: "",
  refreshTokenKey: "",
  replaceModifiers: "P",
  set: "s,a",
  setEmail: "s",
  setEmailVisibility: "b",
  setExpand: "P",
  setIfFieldExists: "s,a",
  setPassword: "s",
  setRandomPassword: "",
  setRaw: "s,a",
  setTokenKey: "s",
  setVerified: "b",
  tableName: "",
  tokenKey: "",
  unhide: "...s",
  unmarshalJSON: "B",
  validatePassword: "s",
  verified: "",
  withCustomData: "b",
};

const validate: CustomMethod = (target: { validate(): Error | null }) => {
  const err = target.validate();
  if (err !== null) {
    throw err;
  }
};

const durationTime = { durationTime: ":d" };

const structOf = <T extends object>(struct: GoClass, make: () => T): GoType => ({ struct, make });

export const emailTemplateClass: GoClass = {
  fields: { subject: "string", body: "string" },
  methods: { validate, resolve: "P" },
};
const emailTemplate = structOf(emailTemplateClass, () => new EmailTemplate());

export const tokenConfig: GoClass = {
  fields: { secret: "string", duration: "int" },
  methods: { ...durationTime, validate },
};
const tokenConfigType = structOf(tokenConfig, () => new TokenConfig());

const stringSlice: GoType = { slice: "string" };

export const authAlertConfig: GoClass = {
  fields: { enabled: "bool", emailTemplate },
  methods: { validate },
};

export const otpConfig: GoClass = {
  fields: { enabled: "bool", duration: "int", length: "int", emailTemplate },
  methods: { ...durationTime, validate },
};

export const mfaConfig: GoClass = {
  fields: { enabled: "bool", duration: "int", rule: "string" },
  methods: { ...durationTime, validate },
};

export const passwordAuthConfig: GoClass = {
  fields: { enabled: "bool", identityFields: stringSlice },
  methods: { validate },
};

export const oauth2ProviderConfig: GoClass = {
  fields: {
    pkce: { ptr: "bool" },
    name: "string",
    clientId: "string",
    clientSecret: "string",
    authURL: "string",
    tokenURL: "string",
    userInfoURL: "string",
    displayName: "string",
    extra: "any",
  },
  methods: { validate },
};

export const oauth2KnownFields: GoClass = {
  fields: { id: "string", name: "string", username: "string", avatarURL: "string" },
  methods: {},
};

export const oauth2Config: GoClass = {
  fields: {
    providers: { slice: structOf(oauth2ProviderConfig, () => new OAuth2ProviderConfig()) },
    mappedFields: structOf(oauth2KnownFields, () => new OAuth2KnownFields()),
    enabled: "bool",
  },
  methods: { validate, unmarshalJSON: "B", getProviderConfig: "s" },
};

const rule: GoType = { ptr: "string" };

// types.JSONArray[string]
const indexes: GoType = { slice: "string", json: stringType };

// plain fields of core.Collection; `fields` is its FieldsList
export const collectionClass: GoClass = {
  json: true,
  stringer: true,
  fields: {
    id: "string",
    listRule: rule,
    viewRule: rule,
    createRule: rule,
    updateRule: rule,
    deleteRule: rule,
    rawOptions: "any",
    name: "string",
    type: "string",
    fields: "any",
    indexes,
    created: "datetime",
    updated: "datetime",
    system: "bool",
    viewQuery: "string",
    authRule: rule,
    manageRule: rule,
    authAlert: structOf(authAlertConfig, () => new AuthAlertConfig()),
    oauth2: structOf(oauth2Config, () => new OAuth2Config()),
    passwordAuth: structOf(passwordAuthConfig, () => new PasswordAuthConfig()),
    mfa: structOf(mfaConfig, () => new MFAConfig()),
    otp: structOf(otpConfig, () => new OTPConfig()),
    authToken: tokenConfigType,
    passwordResetToken: tokenConfigType,
    emailChangeToken: tokenConfigType,
    verificationToken: tokenConfigType,
    fileToken: tokenConfigType,
    verificationTemplate: emailTemplate,
    resetPasswordTemplate: emailTemplate,
    confirmEmailChangeTemplate: emailTemplate,
  },
  methods: {
    ...baseModel,
    addIndex: "s,b,s,s",
    baseFilesPath: "",
    dbExport: "",
    getIndex: "s",
    integrityChecks: "b",
    isAuth: "",
    isBase: "",
    isView: "",
    marshalJSON: ":J",
    removeIndex: "s",
    string: "",
    tableName: "",
    unmarshalJSON: "B",
  },
};

export const dateTimeClass: GoClass = {
  json: true,
  stringer: true,
  methods: {
    add: "i",
    addDate: "i,i,i",
    after: "a",
    before: "a",
    compare: "a",
    equal: "a",
    isZero: "",
    marshalJSON: ":J",
    scan: "a",
    string: "",
    sub: "a:d",
    time: "",
    unix: "",
    unmarshalJSON: "B",
    value: "",
  },
};

export const geoPointClass: GoClass = {
  stringer: true,
  fields: { lon: "float", lat: "float" },
  methods: { asMap: "", scan: "a", string: "", value: "" },
};

const fieldMethods: Readonly<Record<string, Method>> = {
  columnType: "a",
  getHidden: "",
  getId: "",
  getName: "",
  getSystem: "",
  setHidden: "b",
  setId: "s",
  setName: "s",
  setSystem: "b",
  type: "",
};

// the fields' `(value, error)` results and `error` results
function tuple(key: "prepareValue" | "driverValue", params: number): CustomMethod {
  return (target: Record<string, (...a: unknown[]) => [unknown, Error | null]>, args, m) => {
    const hostArgs = Array.from({ length: params }, (_v, i) => m.toHost(args[i]));
    const fn = target[key] as (...a: unknown[]) => [unknown, Error | null];
    const [value, err] = fn.apply(target, hostArgs);
    if (err !== null) {
      throw err;
    }
    // a multiple value is a types.JSONArray[string]
    return m.toVm(Array.isArray(value) ? GoJSONArray.of(value, stringType) : value);
  };
}

const errorResult =
  (key: "validateValue" | "validateSettings"): CustomMethod =>
  (target: Record<string, (app: unknown, other: unknown) => Error | null>, args, m) => {
    // Go's ctx is the first argument; the app binding stands for the app
    const binding = m.toHost(args[1]) as { app?: unknown } | null;
    const err = (target[key] as (app: unknown, other: unknown) => Error | null).call(
      target,
      binding?.app ?? binding,
      m.toHost(args[2]),
    );
    if (err !== null) {
      throw err;
    }
  };

const stringSliceField: GoType = { slice: "string" };

// the fields every field type has, around its own
const fieldClass = (
  own: Readonly<Record<string, GoType>>,
  methods: Readonly<Record<string, Method>> = {},
  help = true,
): GoClass => ({
  fields: {
    name: "string",
    id: "string",
    system: "bool",
    hidden: "bool",
    presentable: "bool",
    ...(help ? { help: "string" } : {}),
    ...own,
  },
  methods: {
    ...fieldMethods,
    prepareValue: tuple("prepareValue", 2),
    validateValue: errorResult("validateValue"),
    validateSettings: errorResult("validateSettings"),
    ...methods,
  },
});

const setter = { findSetter: "s" };
const multiple = { isMultiple: "" };
const driverValue = { driverValue: tuple("driverValue", 1) };
const maxBody = { calculateMaxBodySize: "" };
const required = { required: "bool" } as const;

export const fieldClasses: Readonly<Record<string, GoClass>> = {
  number: fieldClass(
    { min: { ptr: "float" }, max: { ptr: "float" }, onlyInt: "bool", ...required },
    setter,
  ),
  bool: fieldClass(required),
  text: fieldClass(
    {
      min: "int",
      max: "int",
      pattern: "string",
      autogeneratePattern: "string",
      ...required,
      primaryKey: "bool",
    },
    { ...setter, validatePlainValue: "s" },
  ),
  url: fieldClass({
    exceptDomains: stringSliceField,
    onlyDomains: stringSliceField,
    ...required,
  }),
  email: fieldClass({
    exceptDomains: stringSliceField,
    onlyDomains: stringSliceField,
    ...required,
  }),
  editor: fieldClass({ maxSize: "int", convertURLs: "bool", ...required }, maxBody),
  password: fieldClass(
    { pattern: "string", min: "int", max: "int", cost: "int", ...required },
    { ...driverValue, ...setter, findGetter: "s" },
  ),
  date: fieldClass({ min: "datetime", max: "datetime", ...required }),
  autodate: fieldClass({ onCreate: "bool", onUpdate: "bool" }, setter, false),
  json: fieldClass({ maxSize: "int", ...required }, maxBody),
  relation: fieldClass(
    {
      collectionId: "string",
      cascadeDelete: "bool",
      minSelect: "int",
      maxSelect: "int",
      ...required,
    },
    { ...multiple, ...driverValue, ...setter },
  ),
  select: fieldClass(
    { values: stringSliceField, maxSelect: "int", ...required },
    { ...multiple, ...driverValue, ...setter },
  ),
  file: fieldClass(
    {
      maxSize: "int",
      maxSelect: "int",
      mimeTypes: stringSliceField,
      thumbs: stringSliceField,
      protected: "bool",
      ...required,
    },
    { ...multiple, ...driverValue, ...maxBody, ...setter, findGetter: "s" },
  ),
  geoPoint: fieldClass(required),
};

// types.JSONMap and types.JSONArray
export const jsonMapClass: GoClass = {
  json: true,
  stringer: true,
  methods: { get: "s", marshalJSON: ":J", scan: "a", set: "s,a", string: "", value: "" },
};

export const jsonArrayMethods: Readonly<Record<string, Method>> = {
  marshalJSON: ":J",
  scan: "a",
  string: "",
  value: "",
};

export const fieldsListMethods: Readonly<Record<string, Method>> = {
  add: "...G",
  addAt: "i,...G",
  addMarshaledJSON: "B",
  addMarshaledJSONAt: "i,B",
  asMap: "",
  clone: "",
  fieldNames: "",
  getById: "s",
  getByName: "s",
  marshalJSON: ":J",
  removeById: "s",
  removeByName: "s",
  scan: "a",
  string: "",
  unmarshalJSON: "B",
  value: "",
};

// the Query and SelectQuery executors are in binds-query.ts
export const queryMethods: Readonly<Record<string, Method>> = {
  bind: "D",
  close: "",
  params: "",
  prepare: "",
  sql: "",
  withAllHook: "a",
  withExecHook: "a",
  withOneHook: "a",
};

export const selectQueryMethods: Readonly<Record<string, Method>> = {
  andBind: "D",
  andGroupBy: "...s",
  andHaving: "E",
  andOrderBy: "...s",
  andSelect: "...s",
  andWhere: "E",
  bind: "D",
  build: "",
  distinct: "b",
  from: "...s",
  groupBy: "...s",
  having: "E",
  info: "",
  innerJoin: "s,E",
  join: "s,s,E",
  leftJoin: "s,E",
  limit: "i",
  offset: "i",
  orHaving: "E",
  orWhere: "E",
  orderBy: "...s",
  postFragment: "s",
  preFragment: "s",
  rightJoin: "s,E",
  select: "...s",
  selectOption: "s",
  union: "a",
  unionAll: "a",
  where: "E",
  withBuildHook: "a",
};

export const txMethods: Readonly<Record<string, Method>> = {
  commit: "",
  rollback: "",
};

export const builderMethods: Readonly<Record<string, Method>> = {
  addColumn: "s,s,s",
  addForeignKey: "s,s,a,a,s,...s",
  addPrimaryKey: "s,s,...s",
  alterColumn: "s,s,s",
  createIndex: "s,s,...s",
  createTable: "s,P,...s",
  createUniqueIndex: "s,s,...s",
  delete: "s,E",
  dropColumn: "s,s",
  dropForeignKey: "s,s",
  dropIndex: "s,s",
  dropPrimaryKey: "s,s",
  dropTable: "s",
  generatePlaceholder: "i",
  insert: "s,D",
  model: "a",
  newQuery: "s",
  queryBuilder: "",
  quote: "s",
  quoteSimpleColumnName: "s",
  quoteSimpleTableName: "s",
  renameColumn: "s,s,s",
  renameTable: "s,s",
  select: "...s",
  truncateTable: "s",
  update: "s,D,E",
  upsert: "s,D,...s",
};

export const dbMethods: Readonly<Record<string, Method>> = {
  ...builderMethods,
  driverName: "",
  quoteColumnName: "s",
  quoteTableName: "s",
};

export const settingsMethods: Readonly<Record<string, Method>> = {
  clone: "",
  isNew: "",
  lastSavedPK: "",
  markAsNew: "",
  markAsNotNew: "",
  marshalJSON: ":J",
  merge: "a",
  pk: "",
  postScan: "",
  tableName: "",
};
