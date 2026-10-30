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
// Adapters give single classes the shape goja gives them where the
// internal class differs (src/migrations/binds*.ts).

import vm from "node:vm";

import { driverError } from "@/collections/driver-error";

// returned by an adapter's get for a name it does not handle
export const pass = Symbol("pass");

export interface Adapter {
  get?(target: object, key: string, m: Membrane): unknown;
  set?(target: object, key: string, value: unknown, m: Membrane): boolean | typeof pass;
}

type AnyFunction = (...args: unknown[]) => unknown;

interface VmIntrinsics {
  GoError: new (message: string) => Error & { value: unknown };
  parse(text: string): unknown;
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
  return { GoError, parse: JSON.parse, object: () => ({}), array: () => [] };
})()`;

export class Membrane {
  readonly #proxies = new WeakMap<object, object>();
  readonly #targets = new WeakMap<object, object>();
  readonly #hostFunctions = new WeakMap<object, AnyFunction>();
  readonly #goErrors = new WeakMap<object, Error>();
  readonly #adapterFor: (target: object) => Adapter | undefined;
  readonly #unbox: (target: object) => object;
  readonly vm: VmIntrinsics;

  constructor(
    context: vm.Context,
    adapterFor: (target: object) => Adapter | undefined,
    unbox: (target: object) => object,
  ) {
    this.vm = vm.runInContext(intrinsicsSource, context) as VmIntrinsics;
    this.#adapterFor = adapterFor;
    this.#unbox = unbox;
  }

  // the object behind a Proxy, if v is one
  targetOf(v: unknown): object | undefined {
    return typeof v === "object" && v !== null ? this.#targets.get(v) : undefined;
  }

  // Marks proxy as the migration file's view of target.
  register(target: object, proxy: object): object {
    this.#proxies.set(target, proxy);
    this.#targets.set(proxy, target);
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
        if (v === null || this.#targets.has(v)) {
          return v;
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
      return this.#unbox(target);
    }

    // what crosses unwrapped: Buffer
    if (v instanceof Uint8Array) {
      return v;
    }

    if (Array.isArray(v)) {
      return v.map((item) => this.toHost(item));
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

  #newProxy(target: object): object {
    const adapter = this.#adapterFor(target);

    const proxy = new Proxy(target, {
      get: (t, key) =>
        this.guard(() => {
          if (typeof key === "string" && adapter?.get !== undefined) {
            const value = adapter.get(t, key, this);
            if (value !== pass) {
              return value;
            }
          }
          return this.member(t, key);
        }),
      set: (t, key, value) =>
        this.guard(() => {
          if (typeof key === "string" && adapter?.set !== undefined) {
            const done = adapter.set(t, key, value, this);
            if (done !== pass) {
              return done;
            }
          }
          return Reflect.set(t, key, this.toHost(value), t);
        }),
    });

    return this.register(target, proxy);
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
