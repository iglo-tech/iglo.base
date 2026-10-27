// Helpers for the db tests: in-memory dbx databases with the dbx test
// fixture (dbx testdata/mysql.sql, translated to SQLite), and Databases on
// temporary pb_data directories.

import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Databases } from "@/db/base";
import { newFromDB, type DB } from "@/db/dbx/db";

// dbx testdata/mysql.sql in SQLite syntax: same tables, columns and rows
export const fixtureSQL = `
CREATE TABLE \`customer\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`email\` varchar(128) NOT NULL,
  \`name\` varchar(128),
  \`address\` text,
  \`status\` int DEFAULT 0
);

CREATE TABLE \`user\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`email\` varchar(128) NOT NULL,
  \`created\` date,
  \`updated\` date
);

CREATE TABLE \`item\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`name\` varchar(128) NOT NULL
);

CREATE TABLE \`order\` (
  \`id\` INTEGER PRIMARY KEY AUTOINCREMENT,
  \`customer_id\` int NOT NULL,
  \`created_at\` int NOT NULL,
  \`total\` decimal(10,0) NOT NULL,
  CONSTRAINT \`FK_order_customer_id\` FOREIGN KEY (\`customer_id\`) REFERENCES \`customer\` (\`id\`) ON DELETE CASCADE
);

CREATE TABLE \`order_item\` (
  \`order_id\` int NOT NULL,
  \`item_id\` int NOT NULL,
  \`quantity\` int NOT NULL,
  \`subtotal\` decimal(10,0) NOT NULL,
  PRIMARY KEY (\`order_id\`,\`item_id\`),
  CONSTRAINT \`FK_order_item_order_id\` FOREIGN KEY (\`order_id\`) REFERENCES \`order\` (\`id\`) ON DELETE CASCADE,
  CONSTRAINT \`FK_order_item_item_id\` FOREIGN KEY (\`item_id\`) REFERENCES \`item\` (\`id\`) ON DELETE CASCADE
);

INSERT INTO \`customer\` (email, name, address, status) VALUES ('user1@example.com', 'user1', 'address1', 1);
INSERT INTO \`customer\` (email, name, address, status) VALUES ('user2@example.com', 'user2', NULL, 1);
INSERT INTO \`customer\` (email, name, address, status) VALUES ('user3@example.com', 'user3', 'address3', 2);

INSERT INTO \`user\` (email, created) VALUES ('user1@example.com', '2015-01-02');
INSERT INTO \`user\` (email, created) VALUES ('user2@example.com', date('now'));

INSERT INTO \`item\` (name) VALUES ('The Go Programming Language');
INSERT INTO \`item\` (name) VALUES ('Go in Action');
INSERT INTO \`item\` (name) VALUES ('Go Programming Blueprints');
INSERT INTO \`item\` (name) VALUES ('Building Microservices');
INSERT INTO \`item\` (name) VALUES ('Go Web Programming');

INSERT INTO \`order\` (customer_id, created_at, total) VALUES (1, 1325282384, 110.0);
INSERT INTO \`order\` (customer_id, created_at, total) VALUES (2, 1325334482, 33.0);
INSERT INTO \`order\` (customer_id, created_at, total) VALUES (2, 1325502201, 40.0);

INSERT INTO \`order_item\` (order_id, item_id, quantity, subtotal) VALUES (1, 1, 1, 30.0);
INSERT INTO \`order_item\` (order_id, item_id, quantity, subtotal) VALUES (1, 2, 2, 40.0);
INSERT INTO \`order_item\` (order_id, item_id, quantity, subtotal) VALUES (2, 4, 1, 10.0);
INSERT INTO \`order_item\` (order_id, item_id, quantity, subtotal) VALUES (2, 5, 1, 15.0);
INSERT INTO \`order_item\` (order_id, item_id, quantity, subtotal) VALUES (2, 3, 1, 8.0);
INSERT INTO \`order_item\` (order_id, item_id, quantity, subtotal) VALUES (3, 2, 1, 40.0);
`;

// an empty in-memory SQLite database behind a dbx DB with the "sqlite"
// driver (dbx's getDB uses MySQL, which quotes the same way)
export function getDB(driverName = "sqlite"): DB {
  return newFromDB(new Database(":memory:"), driverName);
}

// getDB with the fixture tables and rows
export function getPreparedDB(): DB {
  const db = getDB();
  db.conn().run(fixtureSQL);
  return db;
}

export function tempDir(prefix = "iglo-base-db-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Databases on a new temporary pb_data directory, with a "demo" table in
// data.db and a "logs" table in auxiliary.db. The busy-retry waits are
// recorded instead of slept, then passed to onSleep.
export function openTempDatabases(onSleep: (ms: number) => void = () => {}): {
  app: Databases;
  dataDir: string;
  sleeps: number[];
} {
  const dataDir = tempDir("iglo-base-pb_data-");
  const sleeps: number[] = [];
  const app = Databases.open({
    dataDir,
    sleep: (ms) => {
      sleeps.push(ms);
      onSleep(ms);
    },
  });
  app
    .nonconcurrentDB()
    .newQuery("CREATE TABLE demo (id TEXT PRIMARY KEY NOT NULL, title TEXT DEFAULT '' NOT NULL)")
    .execute();
  app
    .auxNonconcurrentDB()
    .newQuery("CREATE TABLE logs (id TEXT PRIMARY KEY NOT NULL, message TEXT DEFAULT '' NOT NULL)")
    .execute();
  return { app, dataDir, sleeps };
}
