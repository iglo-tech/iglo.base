// Upstream: core/db.go: the generic model query, save and delete SQL paths.
//
// Not ported here: the model hooks and events (D5), validation (the fields
// and collections tasks) and validateCollectionId/validateRecordId (M1).
// Save without validation is upstream's SaveNoValidate; the validating
// Save is added with validation.

import type { Databases } from "@/db/base";
import type { Builder } from "@/db/dbx/builder";
import { HashExp } from "@/db/dbx/expression";
import type { Params } from "@/db/dbx/query";
import type { SelectQuery } from "@/db/dbx/select";
import { isStructModel } from "@/db/dbx/struct";
import type { Model } from "@/db/model";
import { baseLockRetry, defaultMaxLockRetries, execLockRetry } from "@/db/retry";

const idColumn = "id";

// DefaultIdLength is the default length of the generated model id.
export const defaultIdLength = 15;

// DefaultIdAlphabet is the default characters set used for generating the model id.
export const defaultIdAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789";

// DefaultIdRegex specifies the default regex pattern for an id value.
export const defaultIdRegex = /^\w+$/;

// DBExporter defines an interface for custom DB data export.
// Usually used as part of [App.Save].
export interface DBExporter {
  // DBExport returns a key-value map with the data to be used when saving the model in the database.
  dbExport(): Params;
}

function isDBExporter(model: unknown): model is DBExporter {
  return typeof (model as Partial<DBExporter>).dbExport === "function";
}

// GenerateDefaultRandomId generates a default random id string
// (note: the generated random string is not intended for security purposes).
export function generateDefaultRandomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(defaultIdLength));
  let id = "";
  for (const b of bytes) {
    id += defaultIdAlphabet[b % defaultIdAlphabet.length];
  }
  return id;
}

// crc32Checksum generates a stringified crc32 checksum from the provided plain string.
export function crc32Checksum(str: string): string {
  return String(Bun.hash.crc32(str));
}

// ModelQuery creates a new preconfigured select data.db query with preset
// SELECT, FROM and other common fields based on the provided model.
export function modelQuery(app: Databases, m: Model): SelectQuery {
  return modelQueryOn(app, app.concurrentDB(), m);
}

// AuxModelQuery creates a new preconfigured select auxiliary.db query with preset
// SELECT, FROM and other common fields based on the provided model.
export function auxModelQuery(app: Databases, m: Model): SelectQuery {
  return modelQueryOn(app, app.auxConcurrentDB(), m);
}

function modelQueryOn(app: Databases, db: Builder, m: Model): SelectQuery {
  const tableName = m.tableName();

  return db
    .select("{{" + tableName + "}}.*")
    .from(tableName)
    .withBuildHook((query) => {
      query.withExecHook(execLockRetry(defaultMaxLockRetries, (ms) => app.sleep(ms)));
    });
}

// Delete deletes the specified model from the regular app database.
export function deleteModel(app: Databases, model: Model): void {
  deleteFrom(app, model, false);
}

// AuxDelete deletes the specified model from the auxiliary database.
export function auxDeleteModel(app: Databases, model: Model): void {
  deleteFrom(app, model, true);
}

function deleteFrom(app: Databases, model: Model, isForAuxDB: boolean): void {
  const pk = toString(model.lastSavedPK());
  if (pk === "") {
    throw new Error(
      "the model can be deleted only if it is existing and has a non-empty primary key",
    );
  }

  const db = isForAuxDB ? app.auxNonconcurrentDB() : app.nonconcurrentDB();

  baseLockRetry(
    () => {
      db.delete(model.tableName(), new HashExp({ [idColumn]: pk })).execute();
    },
    defaultMaxLockRetries,
    (ms) => app.sleep(ms),
  );
}

// SaveNoValidate saves the specified model into the regular app database without performing validations.
export function saveNoValidate(app: Databases, model: Model): void {
  save(app, model, false);
}

// AuxSaveNoValidate saves the specified model into the auxiliary app database without performing validations.
export function auxSaveNoValidate(app: Databases, model: Model): void {
  save(app, model, true);
}

function save(app: Databases, model: Model, isForAuxDB: boolean): void {
  if (model.isNew()) {
    create(app, model, isForAuxDB);
    return;
  }

  update(app, model, isForAuxDB);
}

function create(app: Databases, model: Model, isForAuxDB: boolean): void {
  const db = isForAuxDB ? app.auxNonconcurrentDB() : app.nonconcurrentDB();

  try {
    baseLockRetry(
      () => {
        if (isDBExporter(model)) {
          const data = model.dbExport();

          // manually add the id to the data if missing
          if (!Object.hasOwn(data, idColumn)) {
            data[idColumn] = model.pk();
          }

          if (toString(data[idColumn]) === "") {
            throw new Error("empty primary key is not allowed when using the DBExporter interface");
          }

          db.insert(model.tableName(), data).execute();
          return;
        }

        db.model(structModelOf(model)).insert();
      },
      defaultMaxLockRetries,
      (ms) => app.sleep(ms),
    );

    model.markAsNotNew();
  } catch (err) {
    model.markAsNew(); // reset "new" state
    throw err;
  }

  const txInfo = app.txInfo();
  if (txInfo !== null) {
    // reset the "new" state if the transaction fails later
    txInfo.onComplete((txErr) => {
      if (txErr !== null) {
        model.markAsNew();
      }
    });
  }
}

function update(app: Databases, model: Model, isForAuxDB: boolean): void {
  const db = isForAuxDB ? app.auxNonconcurrentDB() : app.nonconcurrentDB();

  baseLockRetry(
    () => {
      if (isDBExporter(model)) {
        const data = model.dbExport();

        // note: for now disallow primary key change for consistency with dbx.ModelQuery.Update()
        if (data[idColumn] !== model.lastSavedPK()) {
          throw new Error("primary key change is not allowed");
        }

        db.update(
          model.tableName(),
          data,
          new HashExp({ [idColumn]: model.lastSavedPK() }),
        ).execute();
        return;
      }

      db.model(structModelOf(model)).update();
    },
    defaultMaxLockRetries,
    (ms) => app.sleep(ms),
  );
}

function structModelOf(model: Model) {
  if (!isStructModel(model)) {
    throw new Error(`model of table ${model.tableName()} declares no columns to save`);
  }
  return model;
}

// cast.ToString for the primary key values models use
function toString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}
