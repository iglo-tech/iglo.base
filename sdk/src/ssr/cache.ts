// docs/design/13-ssr.md ("Session cache, check and refresh")
import type { AuthRecord } from "@sdk/stores/BaseAuthStore";
import type { SessionCache, SessionCacheEntry, SessionCacheOptions } from "@sdk/ssr/types";

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_ENTRIES = 10_000;

export async function hashToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b !== undefined) {
      hex += b.toString(16).padStart(2, "0");
    }
  }
  return hex;
}

export function createSessionCache(options?: SessionCacheOptions): SessionCache {
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const clock = options?.clock ?? Date.now;

  const map = new Map<string, SessionCacheEntry>();
  const inFlight = new Map<string, Promise<unknown>>();

  return {
    async get(token: string): Promise<SessionCacheEntry | undefined> {
      if (!token) {
        return undefined;
      }
      const key = await hashToken(token);
      const entry = map.get(key);
      if (!entry) {
        return undefined;
      }
      // LRU refresh: re-insert at tail
      map.delete(key);
      map.set(key, entry);
      return entry;
    },

    async set(token: string, record: AuthRecord, checkedAt?: number): Promise<void> {
      if (!token) {
        return;
      }
      const key = await hashToken(token);
      const timestamp = checkedAt ?? clock();

      if (map.has(key)) {
        map.delete(key);
      } else if (map.size >= maxEntries) {
        const oldestKey = map.keys().next().value;
        if (oldestKey !== undefined) {
          map.delete(oldestKey);
        }
      }

      map.set(key, { record, checkedAt: timestamp });
    },

    async delete(token: string): Promise<void> {
      if (!token) {
        return;
      }
      const key = await hashToken(token);
      map.delete(key);
    },

    clear(): void {
      map.clear();
      inFlight.clear();
    },

    async runSingleFlight<T>(token: string, fn: () => Promise<T>): Promise<T> {
      const key = await hashToken(token);
      const existing = inFlight.get(key);
      if (existing) {
        return existing as Promise<T>;
      }

      const promise = (async () => {
        try {
          return await fn();
        } finally {
          inFlight.delete(key);
        }
      })();

      inFlight.set(key, promise);
      return promise;
    },

    get size(): number {
      return map.size;
    },
    clockOffsetMs: 0,
  };
}

export { DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES };
