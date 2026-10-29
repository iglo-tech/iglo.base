// Upstream: migrations/1640988000_init.go, migrations/1640988000_aux_init.go
// and migrations/1778828400_normalize_indexes.go, as they run on a fresh
// install
//
// The v0.41.0 end state of a fresh install (03-data-compatibility.md,
// "Migrations"), built the way upstream's system migrations build it: the
// same DDL text (sqlite_schema keeps it, whitespace included) and the
// system collections saved through the collection save path, so the
// `_collections` rows and the record tables equal upstream's.
//
// On a fresh install the other system migrations change nothing:
// 1717233556_v0.23_migrate.go returns early because `_mfas` and
// `_authOrigins` exist, 1717233557 finds the `_collections` type index and
// no delete rules to reset, 1717233558 finds the collection and field ids
// already normalized (the default ids are the same checksums),
// 1717233559 finds `_otps.sentTo`, and 1763020353 finds the new auth alert
// template. 1778828400 finds no missing indexes and only resaves the
// non-system collections (`users`), which changes its `updated`.
//
// Upstream's down migrations are not ported (no `migrate down`, M3.7).

import {
  type Collection,
  newAuthCollection,
  newBaseCollection,
} from "@/collections/collection-model";
import { type CollectionsApp, findAllCollections } from "@/collections/collection-query";
import { saveCollection } from "@/collections/collection-save";
import { wrapError } from "@/collections/view";
import { AutodateField } from "@/fields/autodate";
import { EmailField } from "@/fields/email";
import { FileField } from "@/fields/file";
import { PasswordField } from "@/fields/password";
import { TextField } from "@/fields/text";
import {
  CollectionNameAuthOrigins,
  CollectionNameExternalAuths,
  CollectionNameMFAs,
  CollectionNameOTPs,
} from "@/records/record-auth-refs";
import { CollectionNameSuperusers } from "@/records/record-model-superusers";

// 1640988000_aux_init.go: the `_logs` table in auxiliary.db
export function createLogsTable(txApp: CollectionsApp): void {
  txApp.databases
    .auxDB()
    .newQuery(
      "\n\t\t\t\tCREATE TABLE IF NOT EXISTS {{_logs}} (\n\t\t\t\t\t[[id]]      TEXT PRIMARY KEY DEFAULT ('r'||lower(hex(randomblob(7)))) NOT NULL,\n\t\t\t\t\t[[level]]   INTEGER DEFAULT 0 NOT NULL,\n\t\t\t\t\t[[message]] TEXT DEFAULT \"\" NOT NULL,\n\t\t\t\t\t[[data]]    JSON DEFAULT \"{}\" NOT NULL,\n\t\t\t\t\t[[created]] TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%fZ')) NOT NULL\n\t\t\t\t);\n\n\t\t\t\tCREATE INDEX IF NOT EXISTS idx_logs_level on {{_logs}} ([[level]]);\n\t\t\t\tCREATE INDEX IF NOT EXISTS idx_logs_message on {{_logs}} ([[message]]);\n\t\t\t\tCREATE INDEX IF NOT EXISTS idx_logs_created_hour on {{_logs}} (strftime('%Y-%m-%d %H:00:00', [[created]]));\n\t\t\t",
    )
    .execute();
}

// 1640988000_init.go: `_params`, `_collections` and the system collections
export function createInitSchema(txApp: CollectionsApp): void {
  step("_params exec error", () => createParamsTable(txApp));

  step("_collections exec error", () =>
    txApp.databases
      .db()
      .newQuery(
        '\n\t\t\tCREATE TABLE {{_collections}} (\n\t\t\t\t[[id]]         TEXT PRIMARY KEY DEFAULT (\'r\'||lower(hex(randomblob(7)))) NOT NULL,\n\t\t\t\t[[system]]     BOOLEAN DEFAULT FALSE NOT NULL,\n\t\t\t\t[[type]]       TEXT DEFAULT "base" NOT NULL,\n\t\t\t\t[[name]]       TEXT UNIQUE NOT NULL,\n\t\t\t\t[[fields]]     JSON DEFAULT "[]" NOT NULL,\n\t\t\t\t[[indexes]]    JSON DEFAULT "[]" NOT NULL,\n\t\t\t\t[[listRule]]   TEXT DEFAULT NULL,\n\t\t\t\t[[viewRule]]   TEXT DEFAULT NULL,\n\t\t\t\t[[createRule]] TEXT DEFAULT NULL,\n\t\t\t\t[[updateRule]] TEXT DEFAULT NULL,\n\t\t\t\t[[deleteRule]] TEXT DEFAULT NULL,\n\t\t\t\t[[options]]    JSON DEFAULT "{}" NOT NULL,\n\t\t\t\t[[created]]    TEXT DEFAULT (strftime(\'%Y-%m-%d %H:%M:%fZ\')) NOT NULL,\n\t\t\t\t[[updated]]    TEXT DEFAULT (strftime(\'%Y-%m-%d %H:%M:%fZ\')) NOT NULL\n\t\t\t);\n\n\t\t\tCREATE INDEX IF NOT EXISTS idx__collections_type on {{_collections}} ([[type]]);\n\t\t',
      )
      .execute(),
  );

  step("_mfas error", () => saveCollection(txApp, mfasCollection()));
  step("_otps error", () => saveCollection(txApp, otpsCollection()));
  step("_externalAuths error", () => saveCollection(txApp, externalAuthsCollection()));
  step("_authOrigins error", () => saveCollection(txApp, authOriginsCollection()));
  step("_superusers error", () => saveCollection(txApp, superusersCollection()));
  step("users error", () => saveCollection(txApp, usersCollection()));
}

// 1778828400_normalize_indexes.go on a fresh install: no index is missing
// from a collection's list, so every non-system, non-view collection is
// only resaved
export function resaveNonSystemCollections(txApp: CollectionsApp): void {
  for (const collection of findAllCollections(txApp)) {
    // existing system collection indexes can't be modified and view don't have indexes
    if (collection.system || collection.isView()) {
      continue;
    }

    // resave to trigger indexes normalization
    saveCollection(txApp, collection);
  }
}

// Go's fmt.Errorf("<prefix>: %w", err)
function step(prefix: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    throw wrapError(prefix, err);
  }
}

function createParamsTable(txApp: CollectionsApp): void {
  txApp.databases
    .db()
    .newQuery(
      "\n\t\tCREATE TABLE {{_params}} (\n\t\t\t[[id]]      TEXT PRIMARY KEY DEFAULT ('r'||lower(hex(randomblob(7)))) NOT NULL,\n\t\t\t[[value]]   JSON DEFAULT NULL,\n\t\t\t[[created]] TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%fZ')) NOT NULL,\n\t\t\t[[updated]] TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%fZ')) NOT NULL\n\t\t);\n\t",
    )
    .execute();
}

const ownerRefRule =
  "@request.auth.id != '' && recordRef = @request.auth.id && collectionRef = @request.auth.collectionId";

function addRefFields(col: Collection): void {
  col.fields.add(new TextField({ name: "collectionRef", system: true, required: true }));
  col.fields.add(new TextField({ name: "recordRef", system: true, required: true }));
}

function addAutodateFields(col: Collection, system: boolean): void {
  col.fields.add(new AutodateField({ name: "created", system, onCreate: true }));
  col.fields.add(new AutodateField({ name: "updated", system, onCreate: true, onUpdate: true }));
}

function mfasCollection(): Collection {
  const col = newBaseCollection(CollectionNameMFAs);
  col.system = true;

  col.listRule = ownerRefRule;
  col.viewRule = ownerRefRule;

  addRefFields(col);
  col.fields.add(new TextField({ name: "method", system: true, required: true }));
  addAutodateFields(col, true);
  col.addIndex("idx_mfas_collectionRef_recordRef", false, "collectionRef,recordRef", "");

  return col;
}

function otpsCollection(): Collection {
  const col = newBaseCollection(CollectionNameOTPs);
  col.system = true;

  col.listRule = ownerRefRule;
  col.viewRule = ownerRefRule;

  addRefFields(col);
  col.fields.add(
    new PasswordField({
      name: "password",
      system: true,
      hidden: true,
      required: true,
      cost: 8, // low cost for better performance and because it is not critical
    }),
  );
  col.fields.add(new TextField({ name: "sentTo", system: true, hidden: true }));
  addAutodateFields(col, true);
  col.addIndex("idx_otps_collectionRef_recordRef", false, "collectionRef, recordRef", "");

  return col;
}

function authOriginsCollection(): Collection {
  const col = newBaseCollection(CollectionNameAuthOrigins);
  col.system = true;

  col.listRule = ownerRefRule;
  col.viewRule = ownerRefRule;
  col.deleteRule = ownerRefRule;

  addRefFields(col);
  col.fields.add(new TextField({ name: "fingerprint", system: true, required: true }));
  addAutodateFields(col, true);
  col.addIndex("idx_authOrigins_unique_pairs", true, "collectionRef, recordRef, fingerprint", "");

  return col;
}

function externalAuthsCollection(): Collection {
  const col = newBaseCollection(CollectionNameExternalAuths);
  col.system = true;

  col.listRule = ownerRefRule;
  col.viewRule = ownerRefRule;
  col.deleteRule = ownerRefRule;

  addRefFields(col);
  col.fields.add(new TextField({ name: "provider", system: true, required: true }));
  col.fields.add(new TextField({ name: "providerId", system: true, required: true }));
  addAutodateFields(col, true);
  col.addIndex("idx_externalAuths_record_provider", true, "collectionRef, recordRef, provider", "");
  col.addIndex(
    "idx_externalAuths_collection_provider",
    true,
    "collectionRef, provider, providerId",
    "",
  );

  return col;
}

function superusersCollection(): Collection {
  const superusers = newAuthCollection(CollectionNameSuperusers);
  superusers.system = true;
  superusers.fields.add(new EmailField({ name: "email", system: true, required: true }));
  addAutodateFields(superusers, true);
  superusers.authToken.duration = 86400; // 1 day

  return superusers;
}

function usersCollection(): Collection {
  const users = newAuthCollection("users", "_pb_users_auth_");

  const ownerRule = "id = @request.auth.id";
  users.listRule = ownerRule;
  users.viewRule = ownerRule;
  users.createRule = "";
  users.updateRule = ownerRule;
  users.deleteRule = ownerRule;

  users.fields.add(new TextField({ name: "name", max: 255 }));
  users.fields.add(
    new FileField({
      name: "avatar",
      maxSelect: 1,
      mimeTypes: ["image/jpeg", "image/png", "image/svg+xml", "image/gif", "image/webp"],
    }),
  );
  addAutodateFields(users, false);
  users.oauth2.mappedFields.name = "name";
  users.oauth2.mappedFields.avatarURL = "avatar";

  return users;
}
