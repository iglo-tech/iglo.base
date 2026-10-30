// Upstream: plugins/jsvm/binds.go (BindCore, BindDbx, BindSecurity, BindOS,
// BindFilepath, registerFactoryAsConstructor, structConstructor,
// structConstructorUnmarshal)
//
// The globals of a migration file, for one node:vm context. The list of
// provided and missing globals, with the reason for each missing one, is
// in docs/design/01-scope.md. A missing global exists and fails with an
// error that names it.

import { createDecipheriv, type DecipherGCM } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Clock } from "@/app/clock";
import { Collection } from "@/collections/collection-model";
import { FieldsList } from "@/collections/fields-list";
import type { Builder } from "@/db/dbx/builder";
import type { DB } from "@/db/dbx/db";
import {
  and,
  between,
  exists,
  type Expression,
  HashExp,
  inExp,
  isExpression,
  like,
  newExp,
  not,
  notBetween,
  notExists,
  notIn,
  notLike,
  or,
  orLike,
  orNotLike,
} from "@/db/dbx/expression";
import { type Params, Query } from "@/db/dbx/query";
import { SelectQuery } from "@/db/dbx/select";
import { fieldFactory } from "@/fields/fields";
import { AppBinding, appBindingAdapter } from "@/migrations/binds-app";
import { NullShape, QueryModels, RecordSlot } from "@/migrations/binds-query";
import { convertGoToJSName } from "@/migrations/mapper";
import { type Adapter, Membrane, pass } from "@/migrations/membrane";
import { newRecord, Record as RecordModel } from "@/records/record-model";
import {
  newAuthToken,
  newEmailChangeToken,
  newFileToken,
  newPasswordResetToken,
  newStaticAuthToken,
  newVerificationToken,
} from "@/records/record-tokens";
import { Settings, settingsType, unmarshalSettings } from "@/settings/settings-model";
import { equal, hs256, hs512, md5, sha256, sha512 } from "@/tools/security/crypto";
import { encryptSync } from "@/tools/security/encrypt";
import { StdEncoding } from "@/tools/security/base64";
import { newJWT, parseJWT, parseUnverifiedJWT } from "@/tools/security/jwt";
import {
  pseudorandomString,
  pseudorandomStringWithAlphabet,
  randomString,
  randomStringWithAlphabet,
} from "@/tools/security/random";
import { randomStringByRegex } from "@/tools/security/random-by-regex";
import { toStringE } from "@/tools/types/cast";
import { DateTime, nowDateTime, parseDateTime } from "@/tools/types/datetime";
import { decodeValue } from "@/server/json-decode";
import { type FieldType, structOf, unmarshalJSON } from "@/server/unmarshal-request-data";
import { JSONRaw } from "@/tools/types/json-raw";
import { ErrorObject, NewError } from "@/validation/error";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface BindConfig {
  clock: Clock;
  argv: readonly string[];
  cwd: string;
  getenv(name: string): string;
  exit(code: number): never;
}

// the adapters of one context
function adapters(models: QueryModels, clock: Clock): (target: object) => Adapter | undefined {
  const queryAdapter = models.adapter();
  const recordAdapter = newRecordAdapter(clock);

  return (target) => {
    if (target instanceof SelectQuery || target instanceof Query) {
      return queryAdapter;
    }
    if (target instanceof AppBinding) {
      return appBindingAdapter;
    }
    if (target instanceof FieldsList) {
      return fieldsListAdapter;
    }
    if (target instanceof Settings) {
      return settingsAdapter;
    }
    if (target instanceof RecordSlot) {
      return recordSlotAdapter;
    }
    if (target instanceof Collection) {
      return collectionAdapter;
    }
    if (target instanceof JSONRaw) {
      return jsonRawAdapter;
    }
    if (isExpression(target)) {
      return expressionAdapter;
    }
    if (target instanceof ErrorObject) {
      return errorObjectAdapter;
    }
    if (target instanceof RecordModel) {
      return recordAdapter;
    }
    return undefined;
  };
}

// goja exposes a Go slice as an array: index access and the Array methods
const fieldsListAdapter: Adapter = {
  get(target, key, m) {
    const list = target as FieldsList;
    if (/^(0|[1-9][0-9]*)$/.test(key)) {
      return m.toVm(list.at(Number(key)));
    }
    if (key in list) {
      return pass;
    }
    if (key in Array.prototype) {
      return m.member(list.toArray(), key);
    }
    return pass;
  },
};

// app.db() is a transaction, whose database the expression quotes with
const expressionAdapter: Adapter = {
  get(target, key, m) {
    if (key !== "build") {
      return pass;
    }
    return (db: unknown, params: unknown) =>
      m.guard(() =>
        (target as Expression).build(
          ((m.toHost(db) as Builder).queryBuilder() as unknown as { db(): DB }).db(),
          (m.toHost(params) ?? {}) as Params,
        ),
      );
  },
};

// goja exposes the Go byte slice
const jsonRawAdapter: Adapter = {
  get(target, key, m) {
    if (key !== "toJSON") {
      return pass;
    }
    return () => m.toVm(toBytesValue(m, m.toVm(target)));
  },
};

// ValidationError: Go's Message and Error methods
const errorObjectAdapter: Adapter = {
  get(target, key) {
    const text = (): string => (target as ErrorObject).message;
    return key === "message" || key === "error" || key === "toString" ? text : pass;
  },
};

// missing arguments are Go's zero values
const collectionAdapter: Adapter = {
  get(target, key, m) {
    if (key !== "addIndex") {
      return pass;
    }
    const collection = target as Collection;
    return (name: string, unique: unknown, columnsExpr: string, optWhereExpr?: string) => {
      m.guard(() => {
        collection.addIndex(name, unique === true, columnsExpr, optWhereExpr ?? "");
      });
    };
  },
};

const newRecordAdapter = (clock: Clock): Adapter => ({
  get(target, key, m) {
    const record = target as RecordModel;
    switch (key) {
      case "getInt64":
        return (name: string) => m.guard(() => m.toVm(record.getInt(name)));
      case "newAuthToken":
        return () => m.guard(() => newAuthToken(record, clock));
      case "newStaticAuthToken":
        return (secDuration: number) =>
          m.guard(() => newStaticAuthToken(record, BigInt(secDuration) * 1_000_000_000n, clock));
      case "newVerificationToken":
        return () => m.guard(() => newVerificationToken(record, clock));
      case "newPasswordResetToken":
        return () => m.guard(() => newPasswordResetToken(record, clock));
      case "newEmailChangeToken":
        return (email: string) => m.guard(() => newEmailChangeToken(record, email, clock));
      case "newFileToken":
        return () => m.guard(() => newFileToken(record, clock));
      default:
        return pass;
    }
  },
});

const recordSlotAdapter: Adapter = {
  get(target, key, m) {
    const slot = target as RecordSlot;
    if (slot.record !== null) {
      return (m.toVm(slot.record) as Record<string, unknown>)[key];
    }
    return key === "id" ? "" : pass;
  },
  set(target, key, value, m) {
    const slot = target as RecordSlot;
    if (slot.record === null) {
      return pass;
    }
    return Reflect.set(slot.record, key, m.toHost(value), slot.record);
  },
};

// The Settings keep the Go names: a view of a struct with the JS names.
function structView(
  m: Membrane,
  settings: Settings,
  data: object,
  type: FieldType | undefined,
): object {
  const member = (key: string): { name: string; type: FieldType | undefined } | undefined => {
    for (const name of Object.keys(data)) {
      if (convertGoToJSName(name) === key) {
        return { name, type: memberType(type, name) };
      }
    }
    return undefined;
  };

  const proxy = new Proxy(data, {
    get: (t, key) => {
      if (typeof key !== "string") {
        return Reflect.get(t, key, t);
      }
      if (key === "toJSON") {
        return undefined;
      }
      const found = member(key);
      if (found === undefined) {
        return undefined;
      }
      const value = (t as Record<string, unknown>)[found.name];
      return memberView(m, settings, value, found.type);
    },
    set: (t, key, value) => {
      if (typeof key !== "string") {
        return false;
      }
      const found = member(key);
      if (found === undefined) {
        throw new m.vm.GoError(`Field ${key} not found`);
      }
      (t as Record<string, unknown>)[found.name] = convertValue(value, found.type);
      settings.normalize();
      return true;
    },
    ownKeys: (t) =>
      Reflect.ownKeys(t).map((k) => (typeof k === "string" ? convertGoToJSName(k) : k)),
    getOwnPropertyDescriptor: (t, key) => {
      const found = typeof key === "string" ? member(key) : undefined;
      return found === undefined
        ? undefined
        : {
            value: Reflect.get(t, found.name, t),
            writable: true,
            enumerable: true,
            configurable: true,
          };
    },
    has: (_t, key) => typeof key === "string" && member(key) !== undefined,
  });

  return m.register(data, proxy);
}

function memberView(
  m: Membrane,
  settings: Settings,
  value: unknown,
  type: FieldType | undefined,
): unknown {
  if (Array.isArray(value)) {
    return listView(m, settings, value, type);
  }
  return typeof value === "object" && value !== null ? structView(m, settings, value, type) : value;
}

function listView(
  m: Membrane,
  settings: Settings,
  list: unknown[],
  type: FieldType | undefined,
): object {
  const element = elementType(type);
  const proxy = new Proxy(list, {
    get: (t, key) => {
      const value: unknown = Reflect.get(t, key, t);
      if (typeof value === "object" && value !== null) {
        return structView(m, settings, value, element);
      }
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const items =
            key === "push" || key === "unshift"
              ? args.map((arg) => convertValue(arg, element))
              : args;
          const result = (value as (...a: unknown[]) => unknown).apply(t, items);
          settings.normalize();
          return result;
        };
      }
      return value;
    },
  });
  return m.register(list, proxy);
}

// a migration file's object or array as the Go type of the settings member
function convertValue(value: unknown, type: FieldType | undefined): unknown {
  if (type === undefined || typeof value !== "object" || value === null) {
    return value;
  }
  const holder: Record<string, unknown> = { Value: null };
  unmarshalJSON(
    decodeValue(JSON.stringify({ Value: value })),
    holder,
    structOf([{ name: "Value", type, tags: { json: "Value" } }]),
    false,
  );
  return holder.Value;
}

function memberType(type: FieldType | undefined, name: string): FieldType | undefined {
  if (typeof type !== "object" || type.kind !== "struct") {
    return undefined;
  }
  for (const field of type.fields) {
    if (field.name === name) {
      return field.type;
    }
    if (field.embedded === true) {
      const found = memberType(field.type, name);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function elementType(type: FieldType | undefined): FieldType | undefined {
  return typeof type === "object" && type.kind === "slice" ? type.elem : undefined;
}
const settingsAdapter: Adapter = {
  get(target, key, m) {
    const settings = target as Settings;
    for (const name of Object.keys(settings.settings)) {
      if (convertGoToJSName(name) === key) {
        const value = (settings.settings as unknown as Record<string, unknown>)[name];
        return memberView(m, settings, value, memberType(settingsType, name));
      }
    }
    return pass;
  },
  set(target, key, value) {
    const settings = target as Settings;
    for (const name of Object.keys(settings.settings)) {
      if (convertGoToJSName(name) === key) {
        const type = memberType(settingsType, name);
        (settings.settings as unknown as Record<string, unknown>)[name] = convertValue(value, type);
        settings.normalize();
        return true;
      }
    }
    return pass;
  },
};

// A global upstream has that iglo.base does not: it exists, and using it
// fails with an error that names it.
function missing(m: Membrane, name: string, reason: string, callable: boolean): object {
  const fail = (): never => {
    throw new m.vm.GoError(`${name} is not available in iglo.base migrations: ${reason}`);
  };
  const target = callable ? function () {} : {};
  return new Proxy(target, { get: fail, set: fail, apply: fail, construct: fail, has: fail });
}

function stringify(v: unknown): string | undefined {
  return JSON.stringify(v);
}

function constructor(
  m: Membrane,
  name: string,
  build: (...args: unknown[]) => unknown,
  isInstance: (v: unknown) => boolean,
): unknown {
  const fn = function (...args: unknown[]): unknown {
    return m.guard(() => build(...args));
  };
  Object.defineProperty(fn, "name", { value: name });
  Object.defineProperty(fn, Symbol.hasInstance, { value: isInstance });
  return fn;
}

const namedFields: readonly (readonly [string, string])[] = Object.freeze([
  ["NumberField", "number"],
  ["BoolField", "bool"],
  ["TextField", "text"],
  ["URLField", "url"],
  ["EmailField", "email"],
  ["EditorField", "editor"],
  ["PasswordField", "password"],
  ["DateField", "date"],
  ["AutodateField", "autodate"],
  ["JSONField", "json"],
  ["RelationField", "relation"],
  ["SelectField", "select"],
  ["FileField", "file"],
  ["GeoPointField", "geoPoint"],
]);

// BindCore
function bindCore(
  scope: Record<string, unknown>,
  m: Membrane,
  models: QueryModels,
  c: BindConfig,
): void {
  const hostInstance = (type: abstract new (...args: never[]) => unknown) => (v: unknown) =>
    m.targetOf(v) instanceof type;

  scope.readerToString = (r: unknown) => toStringValue(m, r);
  Object.defineProperty(scope, "toString", {
    value: (raw: unknown) => toStringValue(m, raw),
    writable: true,
    enumerable: true,
    configurable: true,
  });
  scope.toBytes = (raw: unknown) => m.toVm(toBytesValue(m, raw));

  scope.sleep = (milliseconds: number) => {
    Bun.sleepSync(milliseconds);
  };

  scope.arrayOf = (model: unknown) => models.arrayOf(model);

  scope.unmarshal = (data: unknown, dst: unknown) => {
    m.guard(() => {
      unmarshalInto(m, models, stringify(data) ?? "null", dst);
    });
  };

  scope.DynamicModel = constructor(
    m,
    "DynamicModel",
    (shape) => models.newDynamicModel(shape),
    (v) => models.isDynamicModel(v),
  );

  // nullable helpers usually used as DynamicModel shape values
  scope.nullString = () => m.toVm(new NullShape("string"));
  scope.nullFloat = () => m.toVm(new NullShape("float"));
  scope.nullInt = () => m.toVm(new NullShape("int"));
  scope.nullBool = () => m.toVm(new NullShape("bool"));
  scope.nullArray = () => m.toVm(new NullShape("array"));
  scope.nullObject = () => m.toVm(new NullShape("object"));

  scope.Record = constructor(
    m,
    "Record",
    (collection, data) => {
      const target = m.targetOf(collection);
      if (!(target instanceof Collection)) {
        return m.toVm(new RecordSlot());
      }
      const record = newRecord(target);
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        record.load(m.toHost(data) as Record<string, unknown>);
      }
      return m.toVm(record);
    },
    (v) => {
      const target = m.targetOf(v);
      return target instanceof RecordModel || target instanceof RecordSlot;
    },
  );

  scope.Collection = constructor(
    m,
    "Collection",
    (data) => {
      const collection = new Collection();
      unmarshalIgnoringErrors(data, (raw) => collection.unmarshalJSON(raw));
      return m.toVm(collection);
    },
    hostInstance(Collection),
  );

  scope.FieldsList = constructor(
    m,
    "FieldsList",
    (data) => {
      const list = new FieldsList();
      unmarshalIgnoringErrors(data, (raw) => list.unmarshalJSON(raw));
      return m.toVm(list);
    },
    hostInstance(FieldsList),
  );

  scope.Field = constructor(
    m,
    "Field",
    (data) => {
      const list = new FieldsList();
      unmarshalIgnoringErrors([data], (raw) => list.unmarshalJSON(raw));
      return list.length === 0 ? undefined : m.toVm(list.at(0));
    },
    () => false,
  );

  for (const [name, type] of namedFields) {
    const factory = fieldFactory(type);
    if (factory === undefined) {
      continue;
    }
    scope[name] = constructor(
      m,
      name,
      (data) => {
        const field = factory();
        unmarshalIgnoringErrors(data, (raw) => field.unmarshalJSON(raw));
        return m.toVm(field);
      },
      (v) => {
        const target = m.targetOf(v) as { type?: () => string } | undefined;
        return typeof target?.type === "function" && target.type() === type;
      },
    );
  }

  scope.DateTime = constructor(
    m,
    "DateTime",
    (rawDate, locName) => {
      if (typeof locName === "string" && locName !== "") {
        throw new Error("DateTime with a location is not available in iglo.base migrations");
      }
      if (typeof rawDate === "string" && rawDate !== "") {
        try {
          return m.toVm(parseDateTime(rawDate));
        } catch {
          return m.toVm(new DateTime());
        }
      }
      return m.toVm(nowDateTime(c.clock));
    },
    hostInstance(DateTime),
  );

  scope.ValidationError = constructor(
    m,
    "ValidationError",
    (code, message) => m.toVm(NewError(toText(code), toText(message))),
    () => false,
  );

  const noUse = "it has no use in a migration";
  for (const name of ["Context", "Middleware", "Cookie", "SubscriptionMessage", "RequestInfo"]) {
    scope[name] = missing(m, name, noUse, true);
  }
  scope.Command = missing(m, "Command", "iglo.base has no custom console commands", true);
  scope.Timezone = missing(m, "Timezone", "time zones are not bound", true);
  scope.MailerMessage = missing(m, "MailerMessage", "no mail is sent from a migration", true);
}

function toText(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// structConstructorUnmarshal: a value that does not fit is ignored
function unmarshalIgnoringErrors(data: unknown, decode: (raw: string) => void): void {
  if (data === undefined || data === null) {
    return;
  }
  try {
    const raw = stringify(data);
    if (raw !== undefined) {
      decode(raw);
    }
  } catch {
    // ignored, as upstream
  }
}

function unmarshalInto(m: Membrane, models: QueryModels, raw: string, dst: unknown): void {
  let target = m.targetOf(dst);
  if (target instanceof RecordSlot) {
    target = target.record ?? undefined;
  }

  if (target instanceof Settings) {
    unmarshalSettings(raw, target);
    return;
  }

  if (typeof (target as { unmarshalJSON?: unknown } | undefined)?.unmarshalJSON === "function") {
    (target as unknown as { unmarshalJSON(b: string): void }).unmarshalJSON(raw);
    return;
  }

  if (typeof dst === "object" && dst !== null) {
    const decoded = m.vm.parse(raw) as Record<string, unknown>;
    if (!models.isDynamicModel(dst)) {
      Object.assign(dst, decoded);
      return;
    }
    for (const key of Object.keys(dst)) {
      if (Object.hasOwn(decoded, key)) {
        (dst as Record<string, unknown>)[key] = decoded[key];
      }
    }
  }
}

function toStringValue(m: Membrane, raw: unknown): string {
  const value = m.toHost(raw);
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof JSONRaw) {
    return value.string();
  }
  try {
    return toStringE(value);
  } catch {
    // as a last attempt try to json encode the value
    return stringify(raw) ?? "";
  }
}

function toBytesValue(m: Membrane, raw: unknown): number[] {
  const value = m.toHost(raw);
  if (value === null || value === undefined) {
    return [];
  }
  if (value instanceof JSONRaw) {
    return [...encoder.encode(value.string())];
  }
  if (value instanceof Uint8Array) {
    return [...value];
  }
  if (Array.isArray(value) && value.every((v) => Number.isInteger(v) && v >= 0 && v < 256)) {
    return value as number[];
  }
  return [...encoder.encode(toStringValue(m, raw))];
}

// BindDbx
function bindDbx(scope: Record<string, unknown>, m: Membrane): void {
  scope.$dbx = m.toVm({
    exp: newExp,
    hashExp: (data: Record<string, unknown>) => new HashExp(data),
    not,
    and,
    or,
    in: inExp,
    notIn,
    like,
    orLike,
    notLike,
    orNotLike,
    exists,
    notExists,
    between,
    notBetween,
  });
}

// security.Decrypt on the synchronous path
function decryptSync(cipherText: string, key: string): string {
  const raw = encoder.encode(key);
  const cipherBytes = StdEncoding.decodeString(cipherText);
  if (cipherBytes.length < 12 + 16) {
    throw new Error("cipher: message authentication failed");
  }
  try {
    const decipher = createDecipheriv(
      `aes-${raw.length * 8}-gcm`,
      raw,
      cipherBytes.subarray(0, 12),
    ) as DecipherGCM;
    decipher.setAuthTag(cipherBytes.subarray(cipherBytes.length - 16));
    const plain = Buffer.concat([
      decipher.update(cipherBytes.subarray(12, cipherBytes.length - 16)),
      decipher.final(),
    ]);
    return decoder.decode(plain);
  } catch (err) {
    throw new Error("cipher: message authentication failed", { cause: err });
  }
}

// BindSecurity
function bindSecurity(scope: Record<string, unknown>, m: Membrane, c: BindConfig): void {
  scope.$security = m.toVm({
    // crypto
    md5,
    sha256,
    sha512,
    hs256,
    hs512,
    equal,

    // random
    randomString,
    randomStringByRegex,
    randomStringWithAlphabet,
    pseudorandomString,
    pseudorandomStringWithAlphabet,

    // jwt
    parseUnverifiedJWT: (token: string) => parseUnverifiedJWT(token, c.clock),
    parseJWT: (token: string, verificationKey: string) => parseJWT(token, verificationKey, c.clock),
    createJWT: (payload: Record<string, unknown>, signingKey: string, secDuration: number) =>
      newJWT(payload, signingKey, BigInt(Math.trunc(secDuration)) * 1_000_000_000n, c.clock),

    // encryption
    encrypt: (data: string | Uint8Array, key: string) =>
      encryptSync(typeof data === "string" ? encoder.encode(data) : data, key),
    decrypt: decryptSync,
  });
}

function toBytes(data: string | Uint8Array | number[]): Uint8Array {
  if (typeof data === "string") {
    return encoder.encode(data);
  }
  return Array.isArray(data) ? Uint8Array.from(data) : data;
}

// BindOS: the file and environment helpers; the rest fails with its name
function bindOS(scope: Record<string, unknown>, m: Membrane, c: BindConfig): void {
  const os: Record<string, unknown> = {
    args: [...c.argv],
    exit: (code: number) => c.exit(code ?? 0),
    getenv: (name: string) => c.getenv(name),
    stat: (name: string) => {
      const info = statSync(name);
      return {
        name: () => path.basename(name),
        size: () => info.size,
        mode: () => info.mode,
        modTime: () => info.mtime,
        isDir: () => info.isDirectory(),
      };
    },
    readFile: (name: string) => [...readFileSync(name)],
    writeFile: (name: string, data: string | Uint8Array | number[], perm?: number) => {
      writeFileSync(name, toBytes(data), {
        mode: perm ?? 0o644,
      });
    },
    readDir: (name: string) =>
      readdirSync(name, { withFileTypes: true })
        .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((entry) => ({ name: () => entry.name, isDir: () => entry.isDirectory() })),
    tempDir: () => tmpdir(),
    truncate: (name: string, size: number) => {
      truncateSync(name, size);
    },
    getwd: () => c.cwd,
    mkdir: (name: string, perm?: number) => {
      mkdirSync(name, { mode: perm ?? 0o777 });
    },
    mkdirAll: (name: string, perm?: number) => {
      mkdirSync(name, { mode: perm ?? 0o777, recursive: true });
    },
    rename: (from: string, to: string) => {
      renameSync(from, to);
    },
    remove: (name: string) => {
      if (statSync(name).isDirectory()) {
        rmdirSync(name);
      } else {
        unlinkSync(name);
      }
    },
    removeAll: (name: string) => {
      rmSync(name, { recursive: true, force: true });
    },
  };

  const reason = "processes and file handles are not bound";
  for (const name of ["exec", "cmd", "dirFS", "openRoot", "openInRoot"]) {
    os[name] = (): never => {
      throw new Error(`$os.${name} is not available in iglo.base migrations: ${reason}`);
    };
  }

  scope.$os = m.toVm(os);
}

// filepath.Clean
function clean(p: string): string {
  if (p === "") {
    return ".";
  }
  const normalized = path.posix.normalize(p);
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

// BindFilepath: the pure helpers; the rest fails with its name
function bindFilepath(scope: Record<string, unknown>, m: Membrane): void {
  const filepath: Record<string, unknown> = {
    base: (p: string) => (p === "" ? "." : path.posix.basename(p) || "/"),
    clean,
    dir: (p: string) => clean(p.slice(0, p.lastIndexOf("/") + 1)),
    ext: (p: string) => {
      const base = p.slice(p.lastIndexOf("/") + 1);
      const dot = base.lastIndexOf(".");
      return dot === -1 ? "" : base.slice(dot);
    },
    fromSlash: (p: string) => p,
    toSlash: (p: string) => p,
    isAbs: (p: string) => path.posix.isAbsolute(p),
    join: (...parts: string[]) => {
      const used = parts.filter((part) => part !== "");
      return used.length === 0 ? "" : clean(used.join("/"));
    },
    rel: (base: string, target: string) => path.posix.relative(base, target) || ".",
    split: (p: string) => {
      const i = p.lastIndexOf("/") + 1;
      return [p.slice(0, i), p.slice(i)];
    },
    splitList: (p: string) => (p === "" ? [] : p.split(":")),
  };

  for (const name of ["glob", "match", "walk", "walkDir"]) {
    filepath[name] = (): never => {
      throw new Error(`$filepath.${name} is not available in iglo.base migrations`);
    };
  }

  scope.$filepath = m.toVm(filepath);
}

// the globals upstream gives a migration file that iglo.base leaves out
function bindMissing(scope: Record<string, unknown>, m: Membrane): void {
  const network = "no network calls run inside a write transaction";
  scope.$http = missing(m, "$http", network, false);
  scope.FormData = missing(m, "FormData", network, true);
  scope.$mails = missing(m, "$mails", network, false);

  scope.$template = missing(m, "$template", "only hooks render templates", false);
  scope.$filesystem = missing(m, "$filesystem", "file bindings are not provided", false);

  const forms = "they are upstream's internals";
  for (const name of [
    "AppleClientSecretCreateForm",
    "RecordUpsertForm",
    "TestEmailSendForm",
    "TestS3FilesystemForm",
  ]) {
    scope[name] = missing(m, name, forms, true);
  }
}

// Sets the globals on a context's sandbox object and returns the membrane
// of that context.
export function bindAll(
  sandbox: Record<string, unknown>,
  context: import("node:vm").Context,
  c: BindConfig,
): Membrane {
  const m = new Membrane(context, (target) =>
    target instanceof RecordSlot ? (target.record ?? target) : target,
  );
  const models = new QueryModels(m);
  m.adapterFor = adapters(models, c.clock);

  bindCore(sandbox, m, models, c);
  bindDbx(sandbox, m);
  bindSecurity(sandbox, m, c);
  bindOS(sandbox, m, c);
  bindFilepath(sandbox, m);
  bindMissing(sandbox, m);

  return m;
}
