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
  type Dirent,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  type Stats,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Clock } from "@/app/clock";
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
import { FieldsList } from "@/collections/fields-list";
import type { Builder } from "@/db/dbx/builder";
import { DB } from "@/db/dbx/db";
import {
  and,
  between,
  exists,
  type Expression,
  HashExp,
  inExp,
  isExpression,
  like,
  LikeExp,
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
import { Tx } from "@/db/dbx/tx";
import type { Field } from "@/fields/field";
import { fieldFactory } from "@/fields/fields";
import { AppBinding, appBindingAdapter } from "@/migrations/binds-app";
import { NullShape, QueryModels, RecordSlot, RowsCursor } from "@/migrations/binds-query";
import {
  authAlertConfig,
  builderMethods,
  classAdapter,
  collectionClass,
  dateTimeClass,
  dbMethods,
  durationAdapter,
  emailTemplateClass,
  fieldClasses,
  fieldsListMethods,
  fileModeAdapter,
  geoPointClass,
  type GoClass,
  GoDuration,
  GoFileMode,
  goArgs,
  goMethod,
  GoPointer,
  isField,
  type Method,
  mfaConfig,
  oauth2Config,
  oauth2KnownFields,
  oauth2ProviderConfig,
  otpConfig,
  passwordAuthConfig,
  pointerAdapter,
  queryMethods,
  recordMethods,
  selectQueryMethods,
  settingsMethods,
  timeAdapter,
  tokenConfig,
  txMethods,
} from "@/migrations/go-class";
import { convertGoToJSName } from "@/migrations/mapper";
import { type Adapter, Membrane, pass, toInteger } from "@/migrations/membrane";
import { newRecord, Record as RecordModel } from "@/records/record-model";
import {
  newAuthToken,
  newEmailChangeToken,
  newFileToken,
  newPasswordResetToken,
  newStaticAuthToken,
  newVerificationToken,
} from "@/records/record-tokens";
import {
  findRateLimitRule,
  type RateLimitRule,
  rateLimitRuleDurationTime,
  rateLimitRuleString,
  type RateLimitsConfig,
  Settings,
  settingsType,
  unmarshalSettings,
  validateBackups,
  validateBatch,
  validateLogs,
  validateMeta,
  validateRateLimitRule,
  validateRateLimits,
  validateS3,
  validateSMTP,
  validateTrustedProxy,
} from "@/settings/settings-model";
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
import { GeoPoint } from "@/tools/types/geo-point";
import { textToBytes } from "@/tools/types/go-json";
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

// the record methods that need more than the record
function recordClass(clock: Clock, blank: WeakSet<object>, models: QueryModels): GoClass {
  return {
    json: true,
    stringer: true,
    fields: { id: "string" },
    methods: {
      ...recordMethods,
      // Go's zero Record has no collection
      collection: (record: RecordModel, _args, m) =>
        blank.has(record) ? null : m.toVm(record.collection()),
      hookTags: (record: RecordModel, _args, m) =>
        m.toVm([record.collection().name, record.collection().id]),
      getInt64: (record: RecordModel, args, m) => m.toVm(record.getInt(toText(args[0]))),
      unmarshalJSONField: (record: RecordModel, args, m) => {
        const key = goArgs(m, "s", args)[0] as string;
        record.unmarshalJSONField(key);
        if (args.length > 1) {
          unmarshalInto(m, models, record.getString(key), args[1]);
        }
      },
      newAuthToken: (record: RecordModel) => newAuthToken(record, clock),
      newStaticAuthToken: (record: RecordModel, args, m) =>
        newStaticAuthToken(record, goArgs(m, "d", args)[0] as bigint, clock),
      newVerificationToken: (record: RecordModel) => newVerificationToken(record, clock),
      newPasswordResetToken: (record: RecordModel) => newPasswordResetToken(record, clock),
      newEmailChangeToken: (record: RecordModel, args, m) =>
        newEmailChangeToken(record, goArgs(m, "s", args)[0] as string, clock),
      newFileToken: (record: RecordModel) => newFileToken(record, clock),
    },
  };
}

function isFieldsListValue(v: unknown): v is FieldsList | unknown[] {
  return v instanceof FieldsList || Array.isArray(v);
}

// `collection.fields = ...` gets a list or an array of fields; the empty
// rawOptions of a collection that holds none reads as an empty byte slice
const collectionAdapter = classAdapter(collectionClass, {
  get(target, key, m) {
    const raw = (target as Collection).rawOptions as JSONRaw | undefined;
    if (key === "rawOptions" && raw?.marshalJSON() === "null") {
      return m.toVm(new Uint8Array());
    }
    return undefined;
  },
  set(target, key, value, m) {
    if (key !== "fields") {
      return pass;
    }
    const host = m.toHost(value);
    if (!isFieldsListValue(host)) {
      throw new m.vm.TypeError(`Go type conversion error: could not convert ${String(value)}`);
    }
    if (host instanceof FieldsList) {
      (target as Collection).fields = host;
    } else {
      const list = new FieldsList();
      list.setItems(host as Field[]);
      (target as Collection).fields = list;
    }
    return true;
  },
});

// goja exposes a Go slice as an array, with the methods of its type
const fieldsListAdapter: Adapter = {
  create(target, m) {
    const list = target as FieldsList;
    return m.sliceView(
      {
        read: () => list.items(),
        write: (next) => {
          list.setItems(next as Field[]);
        },
        accepts: (item) => isField(m.toHost(item)),
        methods: {
          keys: Object.keys(fieldsListMethods).toSorted(),
          get: (key) => goMethod(m, list, key, fieldsListMethods[key] as Method),
        },
      },
      list,
    );
  },
};

// app.db() is a transaction, whose database the expression quotes with
const expressionMethods: GoClass["methods"] = {
  build: (target: Expression, args, m) => {
    const builder = m.toHost(args[0]) as Builder | null | undefined;
    const db = (builder?.queryBuilder() as unknown as { db(): DB } | undefined)?.db() ?? null;
    return target.build(db as DB, (m.toHost(args[1]) ?? {}) as Params);
  },
};

const expressionAdapter = classAdapter({ methods: expressionMethods });

const likeExpAdapter = classAdapter(
  { fields: { like: "any" }, methods: { ...expressionMethods, escape: "...s", match: "b,b" } },
  {
    get(target, key) {
      return key === "like" ? (target as unknown as { likeOp: string }).likeOp : undefined;
    },
  },
);

// ValidationError: Go's Message and Error methods
const errorObjectAdapter: Adapter = {
  get(target, key) {
    const text = (): string => (target as ErrorObject).message;
    return key === "message" || key === "error" || key === "toString" ? text : pass;
  },
  keys: () => [
    "addParam",
    "code",
    "error",
    "message",
    "params",
    "setCode",
    "setMessage",
    "setParams",
  ],
};

// A Go error value: its text comes from Error(), it has no JS members.
const goErrorAdapter: Adapter = {
  get(target, key) {
    switch (key) {
      case "error":
      case "toString":
        return () => (target as Error).message;
      case "message":
      case "name":
      case "stack":
        return undefined;
      default:
        return pass;
    }
  },
};

const nullShapeZero = {
  string: "",
  int: 0,
  float: 0,
  bool: false,
  array: [],
  object: {},
} as const;

// a pointer to a zero value, until a query fills the model
const nullShapeAdapter: Adapter = {
  get(target, key, m) {
    return key === "toJSON"
      ? () => m.vm.parse(JSON.stringify(nullShapeZero[(target as NullShape).kind]))
      : undefined;
  },
  set: () => false,
  keys: () => [],
};

const rowsAdapter = classAdapter({
  methods: {
    close: "",
    columns: "",
    err: "",
    next: "",
    nextResultSet: "",
    scan: (target: RowsCursor, args) => {
      target.scan(args);
    },
    scanMap: "",
    scanStruct: (target: RowsCursor, args) => {
      target.scanStruct(args[0]);
    },
  },
});

function fieldAdapters(): (field: Field) => Adapter | undefined {
  const byType = new Map<string, Adapter>();
  return (field) => {
    const type = field.type();
    let adapter = byType.get(type);
    const cls = fieldClasses[type];
    if (adapter === undefined && cls !== undefined) {
      adapter = classAdapter(cls);
      byType.set(type, adapter);
    }
    return adapter;
  };
}

// the adapters of one context
function adapters(
  models: QueryModels,
  clock: Clock,
  blank: WeakSet<object>,
): (target: object) => Adapter | undefined {
  const fieldAdapter = fieldAdapters();
  const queryAdapter = classAdapter({ methods: { ...queryMethods, ...models.queryMethods() } }, {});
  const selectAdapter = classAdapter(
    { methods: { ...selectQueryMethods, ...models.selectMethods() } },
    {},
  );
  const recordAdapter = classAdapter(recordClass(clock, blank, models));
  const settingsAdapter = newSettingsAdapter();

  const singles: readonly (readonly [abstract new (...args: never[]) => object, Adapter])[] = [
    [SelectQuery, selectAdapter],
    [Query, queryAdapter],
    [AppBinding, appBindingAdapter],
    [FieldsList, fieldsListAdapter],
    [Settings, settingsAdapter],
    [Collection, collectionAdapter],
    [RecordModel, recordAdapter],
    [DateTime, classAdapter(dateTimeClass)],
    [GeoPoint, classAdapter(geoPointClass)],
    [TokenConfig, classAdapter(tokenConfig)],
    [OTPConfig, classAdapter(otpConfig)],
    [MFAConfig, classAdapter(mfaConfig)],
    [AuthAlertConfig, classAdapter(authAlertConfig)],
    [PasswordAuthConfig, classAdapter(passwordAuthConfig)],
    [OAuth2Config, classAdapter(oauth2Config)],
    [OAuth2KnownFields, classAdapter(oauth2KnownFields)],
    [OAuth2ProviderConfig, classAdapter(oauth2ProviderConfig)],
    [EmailTemplate, classAdapter(emailTemplateClass)],
    [Tx, classAdapter({ methods: { ...builderMethods, ...txMethods } })],
    [DB, classAdapter({ methods: dbMethods })],
    [LikeExp, likeExpAdapter],
    [GoPointer, pointerAdapter],
    [GoDuration, durationAdapter],
    [GoFileMode, fileModeAdapter],
    [Date, timeAdapter],
    [NullShape, nullShapeAdapter],
    [RowsCursor, rowsAdapter],
    [ErrorObject, errorObjectAdapter],
  ];

  return (target) => {
    for (const [type, adapter] of singles) {
      if (target instanceof type) {
        return adapter;
      }
    }
    if (isField(target)) {
      return fieldAdapter(target);
    }
    if (isExpression(target)) {
      return expressionAdapter;
    }
    return target instanceof Error ? goErrorAdapter : undefined;
  };
}

// The Settings keep the Go names: a view of a struct with the JS names.
function structMembers(type: FieldType | undefined): { name: string; type: FieldType }[] {
  if (typeof type !== "object" || type.kind !== "struct") {
    return [];
  }
  return type.fields.flatMap((field) =>
    field.embedded === true ? structMembers(field.type) : [{ name: field.name, type: field.type }],
  );
}

type StructMethods = Readonly<Record<string, (data: never, args: unknown[]) => unknown>>;

const throwing =
  <T>(validate: (c: T) => Error | null) =>
  (data: T): void => {
    const err = validate(data);
    if (err !== null) {
      throw err;
    }
  };

// the Go methods of the settings structs, by the Go name of the member
const settingsStructMethods: Readonly<Record<string, StructMethods>> = {
  SMTP: { validate: throwing(validateSMTP) },
  S3: { validate: throwing(validateS3) },
  Backups: { validate: throwing(validateBackups) },
  Meta: { validate: throwing(validateMeta) },
  Logs: { validate: throwing(validateLogs) },
  Batch: { validate: throwing(validateBatch) },
  TrustedProxy: { validate: throwing(validateTrustedProxy) },
  RateLimits: {
    validate: throwing(validateRateLimits),
    findRateLimitRule: (data: RateLimitsConfig, args) =>
      findRateLimitRule(data, args[0] as string[], ...(args.slice(1) as string[])),
  },
  Rules: {
    validate: throwing(validateRateLimitRule),
    durationTime: (data: RateLimitRule) =>
      new GoDuration(BigInt(rateLimitRuleDurationTime(data)) * 1_000_000n),
    string: (data: RateLimitRule) => rateLimitRuleString(data),
  },
};

function structView(
  m: Membrane,
  settings: Settings,
  data: object,
  type: FieldType | undefined,
  methods: StructMethods = {},
): object {
  const members = structMembers(type).filter(({ name }) => Object.hasOwn(data, name));
  const keys = [
    ...members.map(({ name }) => convertGoToJSName(name)),
    ...Object.keys(methods).toSorted(),
  ];
  const member = (key: string): { name: string; type: FieldType } | undefined =>
    members.find(({ name }) => convertGoToJSName(name) === key);

  const read = (key: string): unknown => {
    const found = member(key);
    if (found !== undefined) {
      return memberView(m, settings, data, found.name, found.type);
    }
    const method = Object.hasOwn(methods, key) ? methods[key] : undefined;
    if (method !== undefined) {
      return (...args: unknown[]) =>
        m.guard(() =>
          m.toVm(
            method(
              data as never,
              args.map((arg) => m.toHost(arg)),
            ),
          ),
        );
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
      return keys.includes(key) ? read(key) : Reflect.get(m.vm.objectPrototype, key);
    },
    set: (t, key, value) => {
      if (typeof key !== "string") {
        return false;
      }
      const found = member(key);
      if (found === undefined) {
        throw new m.vm.GoError(`Field ${key} not found`);
      }
      const holder = t as Record<string, unknown>;
      holder[found.name] = convertValue(value, found.type, holder[found.name]);
      settings.normalize();
      return true;
    },
    ownKeys: () => keys,
    getOwnPropertyDescriptor: (_t, key) =>
      typeof key === "string" && keys.includes(key)
        ? { value: read(key), writable: true, enumerable: true, configurable: true }
        : undefined,
    has: (_t, key) => typeof key === "string" && keys.includes(key),
  });

  return m.register(data, proxy);
}

// a member of a settings struct, as a migration file sees it
function memberView(
  m: Membrane,
  settings: Settings,
  holder: object,
  name: string,
  type: FieldType,
): unknown {
  const fields = holder as Record<string, unknown>;
  const value = fields[name];

  if (Array.isArray(value) || (typeof type === "object" && type.kind === "slice")) {
    const element = elementType(type);
    return m.sliceView({
      read: () => (fields[name] ?? []) as unknown[],
      write: (next) => {
        fields[name] = next;
        settings.normalize();
      },
      fromGo: (item) =>
        typeof item === "object" && item !== null
          ? structView(m, settings, item, element, settingsStructMethods[name])
          : item,
      toGo: (item) => convertValue(item, element, undefined),
    });
  }

  return typeof value === "object" && value !== null
    ? structView(m, settings, value, type, settingsStructMethods[name])
    : value;
}

// a migration file's value as the Go type of the settings member: a struct
// keeps the members the value does not have, as goja's ExportTo does
function convertValue(value: unknown, type: FieldType | undefined, current: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    switch (typeof current) {
      case "string":
        return value === undefined || value === null ? "" : String(value);
      case "number":
        return type === "float64" ? Number(value) : toInteger(value);
      case "boolean":
        return Boolean(value);
      default:
        return value;
    }
  }
  if (type === undefined) {
    return value;
  }
  const holder: Record<string, unknown> = {
    Value: typeof current === "object" && current !== null ? structuredClone(current) : null,
  };
  unmarshalJSON(
    decodeValue(JSON.stringify({ Value: value })),
    holder,
    structOf([{ name: "Value", type, tags: { json: "Value" } }]),
    false,
  );
  return holder.Value;
}

function elementType(type: FieldType | undefined): FieldType | undefined {
  return typeof type === "object" && type.kind === "slice" ? type.elem : undefined;
}

function newSettingsAdapter(): Adapter {
  const memberOf = (settings: Settings, key: string) =>
    structMembers(settingsType).find(
      ({ name }) =>
        convertGoToJSName(name) === key && Object.hasOwn(settings.settings as object, name),
    );

  const cls: GoClass = {
    json: true,
    stringer: true,
    methods: {
      ...settingsMethods,
      string: (settings: Settings) => String(settings),
      postValidate: (settings: Settings) => {
        const err = settings.validate();
        if (err !== null) {
          throw err;
        }
      },
      dbExport: (settings: Settings, args, m) => {
        const binding = m.toHost(args[0]) as AppBinding | null;
        if (binding === null || binding === undefined) {
          throw new Error("dbExport needs the app");
        }
        return m.toVm(binding.exportSettings(settings));
      },
    },
  };

  const adapter = classAdapter(cls, {
    get(target, key, m) {
      const settings = target as Settings;
      const found = memberOf(settings, key);
      return found === undefined
        ? undefined
        : memberView(m, settings, settings.settings, found.name, found.type);
    },
    set(target, key, value) {
      const settings = target as Settings;
      const found = memberOf(settings, key);
      if (found === undefined) {
        return pass;
      }
      const holder = settings.settings as unknown as Record<string, unknown>;
      holder[found.name] = convertValue(value, found.type, holder[found.name]);
      settings.normalize();
      return true;
    },
  });

  const methodKeys = (adapter.keys as NonNullable<Adapter["keys"]>)(new Settings(), {} as Membrane);
  const memberKeys = structMembers(settingsType).map(({ name }) => convertGoToJSName(name));
  return { ...adapter, keys: () => [...memberKeys, ...methodKeys] };
}

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

// goja gives only the objects `new` made the constructor's prototype: a field
// a list holds is no `instanceof TextField`.
function constructor(m: Membrane, name: string, build: (...args: unknown[]) => unknown): unknown {
  const instances = new WeakSet();
  const fn = function (...args: unknown[]): unknown {
    const instance = m.guard(() => build(...args));
    if (typeof instance === "object" && instance !== null) {
      instances.add(instance);
    }
    return instance;
  };
  Object.defineProperty(fn, "name", { value: name });
  Object.defineProperty(fn, Symbol.hasInstance, {
    value: (v: unknown) => typeof v === "object" && v !== null && instances.has(v),
  });
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
  blank: WeakSet<object>,
  c: BindConfig,
): void {
  scope.readerToString = (r: unknown) => {
    throw new m.vm.TypeError(
      `could not convert function call parameter 0: could not convert ${String(r)} to io.Reader`,
    );
  };
  Object.defineProperty(scope, "toString", {
    value: (raw: unknown) => toStringValue(m, raw),
    writable: true,
    enumerable: true,
    configurable: true,
  });
  scope.toBytes = (raw: unknown) => m.toVm(toBytesValue(m, raw));

  scope.sleep = (milliseconds: unknown) => {
    Bun.sleepSync(Math.max(toInteger(milliseconds), 0));
  };

  scope.arrayOf = (model: unknown) => models.arrayOf(model);

  scope.unmarshal = (data: unknown, dst: unknown) => {
    m.guard(() => {
      unmarshalInto(m, models, stringify(data) ?? "null", dst);
    });
  };

  scope.DynamicModel = constructor(m, "DynamicModel", (shape) => models.newDynamicModel(shape));

  // nullable helpers usually used as DynamicModel shape values
  scope.nullString = () => m.toVm(new NullShape("string"));
  scope.nullFloat = () => m.toVm(new NullShape("float"));
  scope.nullInt = () => m.toVm(new NullShape("int"));
  scope.nullBool = () => m.toVm(new NullShape("bool"));
  scope.nullArray = () => m.toVm(new NullShape("array"));
  scope.nullObject = () => m.toVm(new NullShape("object"));

  scope.Record = constructor(m, "Record", (collection, data) => {
    const target = m.targetOf(collection);
    if (!(target instanceof Collection)) {
      // Go's zero Record: a query gives it a collection
      const record = newRecord(new Collection());
      blank.add(record);
      return m.toVm(record);
    }
    const record = newRecord(target);
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      record.load(m.toHost(data) as Record<string, unknown>);
    }
    return m.toVm(record);
  });

  scope.Collection = constructor(m, "Collection", (data) => {
    const collection = new Collection();
    unmarshalIgnoringErrors(data, (raw) => collection.unmarshalJSON(raw));
    return m.toVm(collection);
  });

  scope.FieldsList = constructor(m, "FieldsList", (data) => {
    const list = new FieldsList();
    unmarshalIgnoringErrors(data, (raw) => list.unmarshalJSON(raw));
    return m.toVm(list);
  });

  scope.Field = constructor(m, "Field", (data) => {
    const list = new FieldsList();
    unmarshalIgnoringErrors([data], (raw) => list.unmarshalJSON(raw));
    return list.length === 0 ? undefined : m.toVm(list.at(0));
  });

  for (const [name, type] of namedFields) {
    const factory = fieldFactory(type);
    if (factory === undefined) {
      continue;
    }
    scope[name] = constructor(m, name, (data) => {
      const field = factory();
      unmarshalIgnoringErrors(data, (raw) => field.unmarshalJSON(raw));
      return m.toVm(field);
    });
  }

  scope.DateTime = constructor(m, "DateTime", (rawDate, locName) => {
    if (typeof locName === "string" && locName !== "" && rawDate !== "") {
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
  });

  scope.ValidationError = constructor(m, "ValidationError", (code, message) =>
    m.toVm(NewError(toText(code), toText(message))),
  );

  const noUse = "it has no use in a migration";
  for (const name of ["Context", "Middleware", "Cookie", "SubscriptionMessage", "RequestInfo"]) {
    scope[name] = missing(m, name, noUse, true);
  }
  scope.Command = missing(m, "Command", "iglo.base has no custom console commands", true);
  scope.Timezone = missing(m, "Timezone", "time zones are not bound", true);
  scope.MailerMessage = missing(m, "MailerMessage", "no mail is sent from a migration", true);
}

function jsonKind(v: unknown): string {
  if (Array.isArray(v)) {
    return "JSON array";
  }
  switch (typeof v) {
    case "string":
      return "JSON string";
    case "number":
      return "JSON number";
    case "boolean":
      return "JSON boolean";
    default:
      return v === null ? "JSON null" : "JSON object";
  }
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

// What json.Unmarshal(raw, &dst) reaches. goja hands a JS object or array
// over as a copy, so the file's own values never change: only a Go value
// behind the binding (a model, or what arrayOf made) takes the data.
function unmarshalInto(m: Membrane, models: QueryModels, raw: string, dst: unknown): void {
  const target = m.targetOf(dst);

  if (target instanceof DateTime) {
    return; // a value, not a pointer
  }

  if (target instanceof Settings) {
    unmarshalSettings(raw, target);
    return;
  }

  if (typeof (target as { unmarshalJSON?: unknown } | undefined)?.unmarshalJSON === "function") {
    (target as unknown as { unmarshalJSON(b: string): void }).unmarshalJSON(raw);
    return;
  }

  if (typeof dst !== "object" || dst === null) {
    return;
  }

  const decoded = m.vm.parse(raw);

  if (models.isDynamicModel(dst)) {
    models.unmarshalModel(dst, decoded, "");
  } else if (models.isArrayOf(dst)) {
    models.unmarshalArray(dst as unknown[], decoded, (data) => {
      const model = models.modelOf(dst);
      const host = m.targetOf(model);
      if (host instanceof Collection) {
        const collection = new Collection();
        collection.unmarshalJSON(data);
        return m.toVm(collection);
      }
      if (isField(host)) {
        const factory = fieldFactory(host.type());
        const field = factory?.();
        field?.unmarshalJSON(data);
        return m.toVm(field);
      }
      throw new Error("the arrayOf() model cannot be unmarshaled in iglo.base migrations");
    });
  } else if (Array.isArray(dst) ? !Array.isArray(decoded) : false) {
    throw new Error(`json: cannot unmarshal ${jsonKind(decoded)} into Go []interface {}`);
  } else if (!Array.isArray(dst) && (typeof decoded !== "object" || Array.isArray(decoded))) {
    throw new Error(`json: cannot unmarshal ${jsonKind(decoded)} into Go map[string]interface {}`);
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

// cast.ToUint8SliceE of an array; undefined when an element does not cast
function castBytes(items: readonly unknown[]): Uint8Array | undefined {
  const bytes = new Uint8Array(items.length);
  for (const [i, item] of items.entries()) {
    const n =
      typeof item === "boolean"
        ? Number(item)
        : item === null || item === undefined
          ? 0
          : typeof item === "string" && /^[+-]?\d+$/.test(item)
            ? Number(item)
            : item;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      return undefined;
    }
    bytes[i] = Math.trunc(n) & 0xff;
  }
  return bytes;
}

function toBytesValue(m: Membrane, raw: unknown): Uint8Array {
  const value = m.toHost(raw);
  if (value === null || value === undefined) {
    return new Uint8Array();
  }
  if (typeof value === "string") {
    return textToBytes(value);
  }
  if (value instanceof JSONRaw) {
    return textToBytes(value.bytes());
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  const bytes = Array.isArray(value) ? castBytes(value) : undefined;
  return bytes ?? textToBytes(toStringValue(m, raw));
}

// A namespace object of goja: Go functions with their signatures.
function goNamespace(
  m: Membrane,
  functions: Readonly<Record<string, unknown>>,
  signatures: Readonly<Record<string, string>>,
): object {
  const namespace = m.vm.object();
  for (const [name, value] of Object.entries(functions)) {
    const signature = signatures[name];
    namespace[name] =
      signature === undefined ? m.toVm(value) : goMethod(m, functions, name, signature);
  }
  return namespace;
}

// BindDbx
function bindDbx(scope: Record<string, unknown>, m: Membrane): void {
  scope.$dbx = goNamespace(
    m,
    {
      exp: newExp,
      hashExp: (data: Record<string, unknown> | null | undefined) =>
        data === null || data === undefined ? null : new HashExp(data),
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
    },
    {
      exp: "s,...P",
      hashExp: "a",
      not: "E",
      and: "...E",
      or: "...E",
      in: "s,...a",
      notIn: "s,...a",
      like: "s,...s",
      orLike: "s,...s",
      notLike: "s,...s",
      orNotLike: "s,...s",
      exists: "E",
      notExists: "E",
      between: "s,a,a",
      notBetween: "s,a,a",
    },
  );
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
  scope.$security = goNamespace(
    m,
    {
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
      parseJWT: (token: string, verificationKey: string) =>
        parseJWT(token, verificationKey, c.clock),
      createJWT: (payload: Record<string, unknown>, signingKey: string, secDuration: number) =>
        newJWT(payload, signingKey, BigInt(secDuration) * 1_000_000_000n, c.clock),

      // encryption
      encrypt: (data: Uint8Array, key: string) => encryptSync(data, key),
      decrypt: decryptSync,
    },
    {
      md5: "s",
      sha256: "s",
      sha512: "s",
      hs256: "s,s",
      hs512: "s,s",
      equal: "s,s",
      randomString: "i",
      randomStringByRegex: "s,...i",
      randomStringWithAlphabet: "i,s",
      pseudorandomString: "i",
      pseudorandomStringWithAlphabet: "i,s",
      parseUnverifiedJWT: "s",
      parseJWT: "s,s",
      createJWT: "a,s,i",
      encrypt: "B,s",
      decrypt: "s,s",
    },
  );
}

const goErrnoTexts: Readonly<Record<string, string>> = {
  EACCES: "permission denied",
  EEXIST: "file exists",
  EISDIR: "is a directory",
  ENOENT: "no such file or directory",
  ENOTDIR: "not a directory",
  ENOTEMPTY: "directory not empty",
  EPERM: "operation not permitted",
};

// Runs a file operation: its error is os.PathError's text.
function osCall<T>(op: string, name: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    throw new Error(`${op} ${name}: ${goErrnoTexts[code] ?? (err as Error).message}`, {
      cause: err,
    });
  }
}

// fs.FileMode
function goFileMode(info: Stats | Dirent): GoFileMode {
  const perm = "mode" in info ? info.mode & 0o777 : 0;
  if (info.isDirectory()) {
    return new GoFileMode(perm + 2 ** 31);
  }
  return new GoFileMode(info.isSymbolicLink() ? perm + 2 ** 27 : perm);
}

function fileInfo(name: string, info: Stats): Record<string, unknown> {
  return {
    name: () => path.basename(name),
    size: () => info.size,
    mode: () => goFileMode(info),
    modTime: () => info.mtime,
    isDir: () => info.isDirectory(),
    sys: () => null,
  };
}

// BindOS: the file and environment helpers; the rest fails with its name
function bindOS(scope: Record<string, unknown>, m: Membrane, c: BindConfig): void {
  const os: Record<string, unknown> = {
    args: [...c.argv],
    exit: (code: number) => c.exit(code),
    getenv: (name: string) => c.getenv(name),
    stat: (name: string) =>
      fileInfo(
        name,
        osCall("stat", name, () => statSync(name)),
      ),
    readFile: (name: string) => osCall("open", name, () => new Uint8Array(readFileSync(name))),
    writeFile: (name: string, data: Uint8Array, perm: number) => {
      osCall("open", name, () => {
        writeFileSync(name, data, { mode: perm });
      });
    },
    readDir: (name: string) =>
      osCall("open", name, () =>
        readdirSync(name, { withFileTypes: true })
          .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map((entry) => {
            const entryPath = path.join(name, entry.name);
            return {
              name: () => entry.name,
              isDir: () => entry.isDirectory(),
              type: () => goFileMode(entry),
              info: () =>
                fileInfo(
                  entry.name,
                  osCall("lstat", entryPath, () => lstatSync(entryPath)),
                ),
            };
          }),
      ),
    tempDir: () => tmpdir(),
    truncate: (name: string, size: number) => {
      osCall("truncate", name, () => {
        truncateSync(name, size);
      });
    },
    getwd: () => c.cwd,
    mkdir: (name: string, perm: number) => {
      osCall("mkdir", name, () => mkdirSync(name, { mode: perm }));
    },
    mkdirAll: (name: string, perm: number) => {
      osCall("mkdir", name, () => mkdirSync(name, { mode: perm, recursive: true }));
    },
    rename: (from: string, to: string) => {
      osCall(`rename ${from}`, to, () => {
        renameSync(from, to);
      });
    },
    remove: (name: string) => {
      osCall("remove", name, () => {
        if (lstatSync(name).isDirectory()) {
          rmdirSync(name);
        } else {
          unlinkSync(name);
        }
      });
    },
    removeAll: (name: string) => {
      if (name !== "") {
        osCall("unlinkat", name, () => {
          rmSync(name, { recursive: true, force: true });
        });
      }
    },
  };

  const reason = "processes and file handles are not bound";
  for (const name of ["exec", "cmd", "dirFS", "openRoot", "openInRoot"]) {
    os[name] = (): never => {
      throw new Error(`$os.${name} is not available in iglo.base migrations: ${reason}`);
    };
  }

  scope.$os = goNamespace(m, os, {
    exit: "i",
    getenv: "s",
    stat: "s",
    readFile: "s",
    writeFile: "s,B,i",
    readDir: "s",
    truncate: "s,i",
    mkdir: "s,i",
    mkdirAll: "s,i",
    rename: "s,s",
    remove: "s",
    removeAll: "s",
  });
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
    rel: (base: string, target: string) => {
      if (path.posix.isAbsolute(base) !== path.posix.isAbsolute(target)) {
        throw new Error(`Rel: can't make ${target} relative to ${base}`);
      }
      return path.posix.relative(clean(base), clean(target)) || ".";
    },
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

  scope.$filepath = goNamespace(m, filepath, {
    base: "s",
    clean: "s",
    dir: "s",
    ext: "s",
    fromSlash: "s",
    toSlash: "s",
    isAbs: "s",
    join: "...s",
    rel: "s,s",
    split: "s",
    splitList: "s",
  });
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
  const m = new Membrane(
    context,
    (target) => (target instanceof RecordSlot ? target.record : target),
    (target) => (target instanceof RecordModel ? new RecordSlot(target) : target),
  );
  const blank = new WeakSet<object>();
  const models = new QueryModels(m, blank);
  m.adapterFor = adapters(models, c.clock, blank);

  bindCore(sandbox, m, models, blank, c);
  bindDbx(sandbox, m);
  bindSecurity(sandbox, m, c);
  bindOS(sandbox, m, c);
  bindFilepath(sandbox, m);
  bindMissing(sandbox, m);

  return m;
}
