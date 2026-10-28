// Upstream: tools/store/store.go
//
// Upstream guards the map with a sync.RWMutex for goroutines. JS runs the
// store's methods on one thread without interleaving, so there is no lock;
// GetOrSet's double-checked locking reduces to a single lookup.
//
// Keys and values are compared and stored as a JS Map does (SameValueZero),
// which matches Go's == for the comparable key types used (strings and
// numbers). Get returns undefined where Go returns T's zero value.

import { type GoType, anyType, marshal, unmarshalMapInto } from "@/tools/types/go-json";

// The number of removals after which the map is copied, so the old one can
// be garbage collected (Go maps never shrink; kept to mirror upstream).
export const ShrinkThreshold = 200;

// Store is an in-memory key-value data store.
export class Store<K, T> {
  private data = new Map<K, T>();
  private deleted = 0;

  // New: a store with a shallow copy of data (if any)
  constructor(data?: ReadonlyMap<K, T>) {
    this.reset(data);
  }

  // Reset clears the store and replaces its data with a shallow copy of
  // newData.
  reset(newData?: ReadonlyMap<K, T>): void {
    this.data = new Map(newData ?? []);
    this.deleted = 0;
  }

  // Length returns the current number of elements in the store.
  length(): number {
    return this.data.size;
  }

  // RemoveAll removes all the existing store entries.
  removeAll(): void {
    this.reset();
  }

  // Remove removes a single entry from the store (a missing key is a
  // no-op, but still counts towards ShrinkThreshold, as upstream).
  remove(key: K): void {
    this.data.delete(key);
    this.deleted++;
    if (this.deleted >= ShrinkThreshold) {
      this.data = new Map(this.data);
      this.deleted = 0;
    }
  }

  // Has checks if an element with the key exists.
  has(key: K): boolean {
    return this.data.has(key);
  }

  // Get returns a single element value from the store (undefined if the key
  // is not set).
  get(key: K): T | undefined {
    return this.data.get(key);
  }

  // GetOk is Get that also reports whether the key exists.
  getOk(key: K): [T | undefined, boolean] {
    return [this.data.get(key), this.data.has(key)];
  }

  // GetAll returns a shallow copy of the current store data.
  getAll(): Map<K, T> {
    return new Map(this.data);
  }

  // Keys returns all of the store keys.
  keys(): K[] {
    return [...this.data.keys()];
  }

  // Values returns all of the store values.
  values(): T[] {
    return [...this.data.values()];
  }

  // Set sets (or overwrites) the value for key.
  set(key: K, value: T): void {
    this.data.set(key, value);
  }

  // SetFunc sets (or overwrites) the value for key with the result of fn,
  // which receives the old value (undefined if there is none).
  setFunc(key: K, fn: (old: T | undefined) => T): void {
    this.data.set(key, fn(this.data.get(key)));
  }

  // GetOrSet retrieves the existing value for key or stores and returns a
  // new one from setFunc.
  getOrSet(key: K, setFunc: () => T): T {
    if (this.data.has(key)) {
      return this.data.get(key) as T;
    }
    const v = setFunc();
    this.data.set(key, v);
    return v;
  }

  // SetIfLessThanLimit is Set, except that it skips adding a new key when
  // the store already has maxAllowedElements elements (and returns false).
  setIfLessThanLimit(key: K, value: T, maxAllowedElements: number): boolean {
    if (!this.data.has(key) && this.data.size >= maxAllowedElements) {
      return false;
    }
    this.data.set(key, value);
    return true;
  }

  // UnmarshalJSON imports a JSON object into the store (string keys);
  // matching entries are overwritten, the others kept. The values are
  // decoded as Go's json v2 decodes T, named by valueType.
  unmarshalJSON(data: string | Uint8Array, valueType: GoType = anyType): void {
    const raw = unmarshalMapInto(data, valueType, {}) ?? {};
    for (const [k, v] of Object.entries(raw)) {
      this.data.set(k as K, v as T);
    }
  }

  // MarshalJSON exports the store data as a JSON object (keys as strings,
  // sorted; Go's map order is unspecified).
  marshalJSON(): string {
    return marshal(new Map([...this.data].map(([k, v]) => [String(k), v])));
  }
}
