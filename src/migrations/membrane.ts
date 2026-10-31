// No upstream file: what goja's Go-to-JS value conversion does for
// plugins/jsvm.
//
// A migration file runs in its own node:vm context (src/migrations/jsvm.ts),
// so its objects, arrays and dates belong to another realm than the app's:
// the internal modules' `instanceof` and prototype checks do not recognize
// them. Every value crossing between the two goes through a Membrane:
//
//   - toVm gives a migration file a Proxy of an internal object; its
//     methods run on the internal object with their arguments converted;
//   - toHost gives the internal modules the object behind such a Proxy, or
//     an app-realm copy of a value the migration file made;
//   - an internal error crossing to a migration file becomes a GoError, as
//     goja throws a Go error, and comes back as the original error when it
//     stops a migration (normalizeException).
//
//   - a Go value without a JS twin takes the shape goja gives it: a byte
//     slice is a real array that is known to be bytes (toVm, toHost), a map
//     with string keys is a plain object, a slice held by a struct is an
//     array whose reads and writes reach the struct (sliceView).
//
// Adapters give single classes the shape goja gives them where the
// internal class differs (src/migrations/go-class.ts and binds*.ts).

import vm from "node:vm";

import { driverError } from "@/collections/driver-error";
import { BoundValue, Float64 } from "@/db/dbx/query";
import { GoJSONArray, GoJSONMap } from "@/migrations/json-values";
import { bytesToText, textToBytes } from "@/tools/types/go-json";
import { JSONRaw } from "@/tools/types/json-raw";

// returned by an adapter's get for a name it does not handle
export const pass = Symbol("pass");

export interface Adapter {
  get?(target: object, key: string, m: Membrane): unknown;
  set?(target: object, key: string, value: unknown, m: Membrane): boolean | typeof pass;
  // what Object.keys and `in` see, for a struct that is not a JS object
  keys?(target: object, m: Membrane): readonly string[];
  // the migration file's object, when it is not a Proxy of the target
  create?(target: object, m: Membrane): object;
}

// A slice a struct holds: Array methods and index writes reach the struct.
export interface SliceSource {
  read(): readonly unknown[];
  write(next: unknown[]): void;
  fromGo?(item: unknown): unknown;
  toGo?(item: unknown): unknown;
  // goja refuses an item of another Go type: a sloppy `list[0] = v` is
  // ignored and a push throws, as for a refused Proxy set
  accepts?(item: unknown): boolean;
  // the Go methods of the slice type
  methods?: { keys: readonly string[]; get(key: string): unknown };
}

type AnyFunction = (...args: unknown[]) => unknown;

interface VmIntrinsics {
  GoError: new (message: string) => Error & { value: unknown };
  TypeError: new (message: string) => Error;
  parse(text: string): unknown;
  objectPrototype: object;
  object(): Record<string, unknown>;
  array(): unknown[];
}

const intrinsicsSource = `(function () {
  class GoError extends Error {
    constructor(message) {
      super(message);
      this.value = undefined;
    }
  }
  Object.defineProperty(GoError.prototype, "name", { value: "GoError", configurable: true, writable: true });
  return { GoError, TypeError, parse: JSON.parse, objectPrototype: Object.prototype, object: () => ({}), array: () => [] };
})()`;

export class Membrane {
  readonly #proxies = new WeakMap<object, object>();
  readonly #targets = new WeakMap<object, object>();
  readonly #hostFunctions = new WeakMap<object, AnyFunction>();
  readonly #goErrors = new WeakMap<object, Error>();
  // the VM arrays that stand for a Go []byte or a types.JSONRaw
  readonly #bytes = new WeakMap<object, "bytes" | "raw">();
  readonly #slices = new WeakMap<object, SliceSource>();
  // set once, before the first value crosses
  adapterFor: (target: object) => Adapter | undefined = () => undefined;
  readonly #unbox: (target: object) => object;
  readonly #box: (target: object) => object;
  readonly vm: VmIntrinsics;

  // box gives the object a Proxy stands on, for a class whose instance a
  // Go assignment (*v = *record) replaces; unbox is its way back.
  constructor(
    context: vm.Context,
    unbox: (target: object) => object,
    box: (target: object) => object = (target) => target,
  ) {
    this.vm = vm.runInContext(intrinsicsSource, context) as VmIntrinsics;
    this.#unbox = unbox;
    this.#box = box;
  }

  // the internal object behind a Proxy, if v is one
  targetOf(v: unknown): object | undefined {
    if (typeof v !== "object" || v === null) {
      return undefined;
    }
    const target = this.#targets.get(v);
    return target === undefined ? undefined : this.#unbox(target);
  }

  // the object a Proxy stands on (see box)
  boxOf(v: unknown): object | undefined {
    return typeof v === "object" && v !== null ? this.#targets.get(v) : undefined;
  }

  // Marks proxy as the migration file's view of target.
  register(target: object, proxy: object, box: object = target): object {
    this.#proxies.set(target, proxy);
    this.#targets.set(proxy, box);
    return proxy;
  }

  // A value for a migration file.
  toVm(v: unknown): unknown {
    switch (typeof v) {
      case "bigint":
        return Number(v);
      case "function":
        return this.#wrapFunction(v as AnyFunction, undefined);
      case "object":
        if (v === null || this.#targets.has(v) || this.#bytes.has(v) || this.#slices.has(v)) {
          return v;
        }
        if (v instanceof BoundValue) {
          return this.toVm(v.go);
        }
        if (v instanceof Float64) {
          return v.value;
        }
        if (v instanceof Uint8Array && !Buffer.isBuffer(v)) {
          return this.#newBytes(v, "bytes");
        }
        if (v instanceof JSONRaw) {
          return this.#newRaw(v);
        }
        if (Array.isArray(v)) {
          const copy = this.vm.array();
          for (const item of v) {
            copy.push(this.toVm(item));
          }
          return copy;
        }
        if (v instanceof Map) {
          return this.#mapObject(v);
        }
        return this.#proxies.get(v) ?? this.#newProxy(v);
      default:
        return v;
    }
  }

  // A plain copy for a migration file, through its JSON.
  toVmJSON(v: unknown): unknown {
    return this.vm.parse(JSON.stringify(v));
  }

  // A value for the internal modules.
  toHost(v: unknown): unknown {
    if (typeof v === "function") {
      return this.#hostFunction(v as AnyFunction);
    }
    if (typeof v !== "object" || v === null) {
      return v;
    }

    const target = this.#targets.get(v);
    if (target !== undefined) {
      const host = this.#unbox(target);
      if (host instanceof GoJSONArray) {
        return [...host.items];
      }
      return host instanceof GoJSONMap ? host.data : host;
    }

    const bytes = this.#bytes.get(v);
    if (bytes !== undefined) {
      const data = bytesOf(v as unknown[]);
      return bytes === "bytes" ? data : new JSONRaw(bytesToText(data));
    }

    const slice = this.#slices.get(v);
    if (slice !== undefined) {
      return [...slice.read()];
    }

    // what crosses unwrapped: Buffer
    if (v instanceof Uint8Array) {
      return v;
    }

    if (Array.isArray(v)) {
      return Array.from(v as unknown[], (item) => this.toHost(item));
    }

    switch (Object.prototype.toString.call(v)) {
      case "[object Date]":
        return new Date((v as Date).getTime());
      case "[object Uint8Array]":
        return new Uint8Array(v as Uint8Array);
      case "[object Map]":
        return new Map(
          [...(v as Map<unknown, unknown>)].map(([k, item]) => [this.toHost(k), this.toHost(item)]),
        );
      case "[object Set]":
        return new Set([...(v as Set<unknown>)].map((item) => this.toHost(item)));
      case "[object Error]":
      case "[object Promise]":
        return v;
    }

    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(v)) {
      Object.defineProperty(copy, key, {
        value: this.toHost((v as Record<string, unknown>)[key]),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return copy;
  }

  // Bytes for an argument Go types as []byte: a string, a byte slice or an
  // array of numbers. Undefined for anything else.
  toBytes(v: unknown): Uint8Array | undefined {
    if (typeof v === "string") {
      return textToBytes(v);
    }
    const host = this.toHost(v);
    if (host instanceof Uint8Array) {
      return host;
    }
    if (host instanceof JSONRaw) {
      return textToBytes(host.bytes());
    }
    return Array.isArray(host) ? bytesOf(host) : undefined;
  }

  // Runs internal code for a migration file: an internal error becomes a
  // GoError. Anything else (an exception of the migration file passing
  // through) is thrown as it is.
  guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof Error) {
        throw this.goError(driverError(err) as Error);
      }
      throw err;
    }
  }

  goError(err: Error): Error {
    const goError = new this.vm.GoError(err.message);
    goError.value = this.toVm(err);
    this.#goErrors.set(goError, err);
    return goError;
  }

  // the internal error a GoError stands for
  hostError(e: unknown): Error | undefined {
    return typeof e === "object" && e !== null ? this.#goErrors.get(e) : undefined;
  }

  // The array a migration file sees for a slice a struct holds. Its target
  // is a VM array, so it is an array to the file and the Array methods run
  // on this Proxy, through the traps below; callbacks get the fromGo view.
  sliceView(source: SliceSource, host?: object): unknown[] {
    const fromGo = source.fromGo ?? ((item: unknown) => this.toVm(item));
    const toGo = source.toGo ?? ((item: unknown) => this.toHost(item));

    const proxy = new Proxy(this.vm.array(), {
      get: (t, key, receiver) => {
        if (key === "length") {
          return source.read().length;
        }
        if (isIndex(key)) {
          return fromGo(source.read()[Number(key)]);
        }
        if (typeof key === "string" && source.methods?.keys.includes(key) === true) {
          return source.methods.get(key);
        }
        // a Stringer prints with its String method
        if ((key as unknown) === "toString" && source.methods?.keys.includes("string") === true) {
          return source.methods.get("string");
        }
        return Reflect.get(t, key, receiver) as unknown;
      },
      set: (_t, key, value) =>
        this.guard(() => {
          if (isIndex(key) && source.accepts?.(value) === false) {
            return false;
          }
          const next = [...source.read()];
          if (key === "length") {
            const length = toInteger(value);
            for (let i = next.length; i < length; i++) {
              next.push(null);
            }
            next.length = length;
          } else if (isIndex(key)) {
            const index = Number(key);
            for (let i = next.length; i < index; i++) {
              next.push(null);
            }
            next[index] = toGo(value);
          } else {
            return false;
          }
          source.write(next);
          return true;
        }),
      has: (t, key) =>
        (isIndex(key) && Number(key) < source.read().length) ||
        (typeof key === "string" && source.methods?.keys.includes(key) === true) ||
        key in t,
      // a Go slice has no holes; the Array methods cut it with `length`
      deleteProperty: () => true,
      ownKeys: () => [
        ...source.read().map((_item, i) => String(i)),
        ...(source.methods?.keys ?? []),
        "length",
      ],
      getOwnPropertyDescriptor: (t, key) => {
        if (isIndex(key) && Number(key) < source.read().length) {
          return {
            value: fromGo(source.read()[Number(key)]),
            writable: true,
            enumerable: true,
            configurable: true,
          };
        }
        if (key === "length") {
          return { ...Reflect.getOwnPropertyDescriptor(t, key), value: source.read().length };
        }
        if (typeof key === "string" && source.methods?.keys.includes(key) === true) {
          return {
            value: source.methods.get(key),
            writable: false,
            enumerable: true,
            configurable: true,
          };
        }
        return undefined;
      },
    });

    if (host === undefined) {
      this.#slices.set(proxy, source);
    } else {
      this.register(host, proxy);
    }
    return proxy;
  }

  // The named member of an internal object, as a migration file sees it.
  member(target: object, key: string | symbol): unknown {
    const value: unknown = Reflect.get(target, key, target);

    if (typeof key === "string" && key === "toJSON" && value === undefined) {
      const marshal = (target as { marshalJSON?: unknown }).marshalJSON;
      if (typeof marshal === "function") {
        return this.#wrapFunction(() => this.vm.parse(String(marshal.call(target))), undefined);
      }
    }

    if (typeof value === "function") {
      return this.#wrapFunction(value as AnyFunction, target);
    }

    // a Proxy must report these as they are
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    if (descriptor !== undefined && !descriptor.configurable && !descriptor.writable) {
      return value;
    }

    return this.toVm(value);
  }

  #newBytes(data: Uint8Array, kind: "bytes" | "raw"): unknown[] {
    const array = this.vm.array();
    for (const byte of data) {
      array.push(byte);
    }
    this.#bytes.set(array, kind);
    return array;
  }

  // types.JSONRaw: a byte slice with the Go methods of its type
  #newRaw(raw: JSONRaw): unknown[] {
    const array = this.#newBytes(textToBytes(raw.bytes()), "raw");
    const current = (): JSONRaw => this.toHost(array) as JSONRaw;
    const replace = (next: JSONRaw): void => {
      array.length = 0;
      for (const byte of textToBytes(next.bytes())) {
        array.push(byte);
      }
    };
    const methods: Record<string, (...args: unknown[]) => unknown> = {
      string: () => current().string(),
      toString: () => current().string(),
      marshalJSON: () => this.toVm(textToBytes(current().marshalJSON())),
      value: () => this.toVm(current().value()),
      unmarshalJSON: (b) => {
        const next = new JSONRaw();
        next.unmarshalJSON(this.toBytes(b) ?? null);
        replace(next);
      },
      scan: (value) => {
        const next = new JSONRaw();
        next.scan(this.toHost(value));
        replace(next);
      },
    };
    for (const [name, value] of Object.entries(methods)) {
      Object.defineProperty(array, name, { value, enumerable: false });
    }
    return array;
  }

  // A Go map with string keys is a plain object. goja lists no keys of a
  // map with pointer keys (FindCollectionReferences).
  #mapObject(map: ReadonlyMap<unknown, unknown>): object {
    const object = this.vm.object();
    for (const [key, value] of map) {
      if (typeof key === "string") {
        Object.defineProperty(object, key, {
          value: this.toVm(value),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    return object;
  }

  #newProxy(target: object): object {
    const adapter = this.adapterFor(target);

    if (adapter?.create !== undefined) {
      return adapter.create(target, this);
    }

    const box = this.#box(target);

    const proxy = new Proxy(box, {
      get: (t, key) =>
        this.guard(() => {
          const host = this.#unbox(t);
          if (typeof key === "string" && adapter?.get !== undefined) {
            const value = adapter.get(host, key, this);
            if (value !== pass) {
              return value;
            }
          }
          return this.member(host, key);
        }),
      set: (t, key, value) =>
        this.guard(() => {
          const host = this.#unbox(t);
          if (typeof key === "string" && adapter?.set !== undefined) {
            const done = adapter.set(host, key, value, this);
            if (done !== pass) {
              return done;
            }
          }
          return Reflect.set(host, key, this.toHost(value), host);
        }),
      ...(adapter?.keys === undefined ? {} : this.#keyTraps(adapter)),
    });

    if (box !== target) {
      this.#proxies.set(box, proxy);
    }
    return this.register(target, proxy, box);
  }

  // what a struct's keys look like: goja lists its fields and methods
  #keyTraps(adapter: Adapter): ProxyHandler<object> {
    const keys = adapter.keys as NonNullable<Adapter["keys"]>;
    return {
      has: (t, key) => typeof key === "string" && keys(this.#unbox(t), this).includes(key),
      ownKeys: (t) => [...keys(this.#unbox(t), this)],
      getOwnPropertyDescriptor: (t, key) => {
        const host = this.#unbox(t);
        if (typeof key !== "string" || !keys(host, this).includes(key)) {
          return undefined;
        }
        return {
          value: adapter.get?.(host, key, this),
          writable: true,
          enumerable: true,
          configurable: true,
        };
      },
    };
  }

  #wrapFunction(fn: AnyFunction, self: object | undefined): AnyFunction {
    return (...args) =>
      this.guard(() =>
        this.toVm(
          fn.apply(
            self,
            args.map((arg) => this.toHost(arg)),
          ),
        ),
      );
  }

  // an internal module's callback that runs a function of the migration file
  #hostFunction(fn: AnyFunction): AnyFunction {
    let wrapped = this.#hostFunctions.get(fn);
    if (wrapped === undefined) {
      wrapped = (...args) => this.toHost(fn(...args.map((arg) => this.toVm(arg))));
      this.#hostFunctions.set(fn, wrapped);
    }
    return wrapped;
  }
}

function isIndex(key: string | symbol): key is string {
  return typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key);
}

// goja's ToInteger
export function toInteger(v: unknown): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : 0;
}

// goja converts each element to a Go uint8
function bytesOf(items: readonly unknown[]): Uint8Array {
  return Uint8Array.from(items, (item) => toInteger(item) & 0xff);
}
