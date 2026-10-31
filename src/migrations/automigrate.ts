// Upstream: plugins/migratecmd/automigrate.go
//
// Upstream binds automigrateOnCollectionChange to the collection create,
// update and delete request hooks. There are no hooks here (D5):
// src/apis/collection.ts calls it directly around its default action, as
// the hook's e.Next() runs it. The action writes the response, so an error
// here cannot change it, as upstream's hook runs after the response too.
//
// A collection import writes nothing, as upstream, whose import request
// has no such hook.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { App } from "@/app/app";
import type { Collection } from "@/collections/collection-model";
import { findCollectionByNameOrId } from "@/collections/collection-query";
import { wrapError } from "@/collections/view";
import { NoRowsError } from "@/db/dbx/rows";
import { runInTransaction } from "@/db/tx";
import { ErrNoRows } from "@/server/error";
import { ErrEmptyTemplate, jsDiffTemplate } from "@/migrations/templates";
import { DefaultMigrationsTable } from "@/migrations/migrations-runner";

// next is the request's default action: it returns the error of the
// action (a handler's result), or undefined.
export async function automigrateOnCollectionChange(
  app: App,
  collection: Collection,
  next: () => Promise<Error | undefined> | Error | undefined,
): Promise<Error | undefined> {
  const dir = app.automigrateDir;
  if (dir === undefined) {
    return next();
  }

  try {
    let old: Collection | null = null;
    if (!collection.isNew()) {
      try {
        old = findCollectionByNameOrId(app, collection.id);
      } catch (findErr) {
        // the body changed the id: the router answers sql.ErrNoRows with a 404
        return findErr instanceof NoRowsError ? ErrNoRows : (findErr as Error);
      }
    }

    const err = await next();
    if (err !== undefined) {
      return err;
    }

    let newCollection: Collection | null = null;
    try {
      newCollection = findCollectionByNameOrId(app, collection.id);
    } catch (findErr) {
      if (!(findErr instanceof NoRowsError)) {
        throw findErr;
      }
    }

    writeMigration(app, dir, newCollection, old);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function writeMigration(
  app: App,
  dir: string,
  newCollection: Collection | null,
  old: Collection | null,
): void {
  // for now exclude OAuth2 configs from the migration
  if (old?.isAuth()) {
    old.oauth2.providers = null;
  }
  if (newCollection?.isAuth()) {
    newCollection.oauth2.providers = null;
  }

  let template: string;
  try {
    template = jsDiffTemplate(newCollection, old);
  } catch (err) {
    if (err === ErrEmptyTemplate) {
      return; // no changes
    }
    throw wrapError("failed to resolve template", err);
  }

  let action: string;
  if (newCollection === null) {
    action = "deleted_" + normalizeCollectionName((old as Collection).name);
  } else if (old === null) {
    action = "created_" + normalizeCollectionName(newCollection.name);
  } else {
    action = "updated_" + normalizeCollectionName(old.name);
  }

  const now = app.clock.now().getTime();
  const name = `${Math.floor(now / 1000)}_${action}.js`;
  const filePath = join(dir, name);

  runInTransaction(app.databases, (txDatabases) => {
    // insert the migration entry
    txDatabases
      .db()
      .insert(DefaultMigrationsTable, {
        file: name,
        // use microseconds for more granular applied time in case
        // multiple collection changes happens at the ~exact time
        applied: now * 1000,
      })
      .execute();

    // ensure that the local migrations dir exist
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      throw wrapError("failed to create migration dir", err);
    }

    try {
      writeFileSync(filePath, template, { mode: 0o644 });
    } catch (err) {
      throw wrapError("failed to save automigrate file", err);
    }
  });
}

function normalizeCollectionName(name: string): string {
  // adds an extra "_" suffix to the name in case the collection ends
  // with "test" to prevent accidentally resulting in "_test.go"/"_test.js" files
  if (name.toLowerCase().endsWith("test")) {
    return name + "_";
  }

  return name;
}
