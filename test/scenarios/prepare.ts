// Helpers for scenario `prepare` steps (upstream's BeforeTestFunc): they
// change a scenario's fixture copy before any server starts on it, as
// upstream's tests change the test app.

import { Database } from "bun:sqlite";
import { join } from "node:path";

import type { Collection } from "@/collections/collection-model";
import { findCollectionByNameOrId, reloadCachedCollections } from "@/collections/collection-query";
import { saveCollection } from "@/collections/collection-save";

import { openDataDir } from "@test/collections/app";

// Loads a collection of the fixture copy, lets change it and saves it
// (app.Save(col) in upstream's tests).
export function updateCollection(
  dataDir: string,
  nameOrId: string,
  change: (collection: Collection) => void,
): void {
  const app = openDataDir(dataDir);
  try {
    reloadCachedCollections(app);
    const collection = findCollectionByNameOrId(app, nameOrId);
    change(collection);
    saveCollection(app, collection);
  } finally {
    app.cleanup();
  }
}

export interface RateLimitRuleData {
  label: string;
  maxRequests: number;
  duration?: number;
  audience?: string;
}

// Enables the settings' rate limiter with the given rules
// (app.Settings().RateLimits in upstream's tests). The fixture's settings
// row is plain JSON.
export function setRateLimits(dataDir: string, rules: RateLimitRuleData[]): void {
  const db = new Database(join(dataDir, "data.db"));
  try {
    const row = db.query("SELECT value FROM _params WHERE id = 'settings'").get() as {
      value: string | Uint8Array;
    };
    // the fixture stores the value as a BLOB; it is written back as one
    const isBlob = row.value instanceof Uint8Array;
    const text = isBlob ? new TextDecoder().decode(row.value as Uint8Array) : (row.value as string);
    const settings = JSON.parse(text) as { rateLimits: { enabled: boolean; rules: unknown } };
    settings.rateLimits.enabled = true;
    settings.rateLimits.rules = rules.map((r) => ({
      label: r.label,
      audience: r.audience ?? "",
      duration: r.duration ?? 0,
      maxRequests: r.maxRequests,
    }));
    const updated = JSON.stringify(settings);
    db.query("UPDATE _params SET value = ? WHERE id = 'settings'").run(
      isBlob ? new TextEncoder().encode(updated) : updated,
    );
  } finally {
    db.close();
  }
}
