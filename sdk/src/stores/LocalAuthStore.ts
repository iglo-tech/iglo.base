// js-sdk v0.28.1 src/stores/LocalAuthStore.ts
import type { LooseObject } from "@sdk/tools/loose";
import { BaseAuthStore, type AuthRecord } from "@sdk/stores/BaseAuthStore";

/**
 * The default token store for browsers with auto fallback
 * to runtime/memory if local storage is undefined (e.g. in node env).
 */
/** The auth data as stored by `save()`; `model` is the legacy name of `record`. */
type StoredAuthData = { token?: string; record?: AuthRecord; model?: AuthRecord };

export class LocalAuthStore extends BaseAuthStore {
  private storageFallback: LooseObject = {};
  private storageKey: string;

  constructor(storageKey = "pocketbase_auth") {
    super();

    this.storageKey = storageKey;

    this._bindStorageEvent();
  }

  /**
   * @inheritdoc
   */
  override get token(): string {
    const data = this._storageGet(this.storageKey) || {};

    return data.token || "";
  }

  /**
   * @inheritdoc
   */
  override get record(): AuthRecord {
    const data = this._storageGet(this.storageKey) || {};

    return data.record || data.model || null;
  }

  /**
   * @deprecated use `record` instead.
   */
  override get model(): AuthRecord {
    return this.record;
  }

  /**
   * @inheritdoc
   */
  override save(token: string, record?: AuthRecord) {
    this._storageSet(this.storageKey, {
      token: token,
      record: record,
    });

    super.save(token, record);
  }

  /**
   * @inheritdoc
   */
  override clear() {
    this._storageRemove(this.storageKey);

    super.clear();
  }

  // ---------------------------------------------------------------
  // Internal helpers:
  // ---------------------------------------------------------------

  /**
   * Retrieves `key` from the browser's local storage
   * (or runtime/memory if local storage is undefined).
   */
  private _storageGet(key: string): StoredAuthData {
    if (typeof window !== "undefined" && window?.localStorage) {
      const rawValue = window.localStorage.getItem(key) || "";
      try {
        return JSON.parse(rawValue) as StoredAuthData;
      } catch {
        // not a json
        return rawValue as StoredAuthData; // not an object, so every property read is undefined
      }
    }

    // fallback
    return this.storageFallback[key] as StoredAuthData;
  }

  /**
   * Stores a new data in the browser's local storage
   * (or runtime/memory if local storage is undefined).
   */
  private _storageSet(key: string, value: unknown) {
    if (typeof window !== "undefined" && window?.localStorage) {
      // store in local storage
      let normalizedVal = value as string;
      if (typeof value !== "string") {
        normalizedVal = JSON.stringify(value);
      }
      window.localStorage.setItem(key, normalizedVal);
    } else {
      // store in fallback
      this.storageFallback[key] = value;
    }
  }

  /**
   * Removes `key` from the browser's local storage and the runtime/memory.
   */
  private _storageRemove(key: string) {
    // delete from local storage
    if (typeof window !== "undefined" && window?.localStorage) {
      window.localStorage?.removeItem(key);
    }

    // delete from fallback
    delete this.storageFallback[key];
  }

  /**
   * Updates the current store state on localStorage change.
   */
  private _bindStorageEvent() {
    if (typeof window === "undefined" || !window?.localStorage || !window.addEventListener) {
      return;
    }

    window.addEventListener("storage", (e) => {
      if (e.key != this.storageKey) {
        return;
      }

      const data = this._storageGet(this.storageKey) || {};

      super.save(data.token || "", data.record || data.model || null);
    });
  }
}
