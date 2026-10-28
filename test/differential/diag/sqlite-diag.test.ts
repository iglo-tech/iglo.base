// TEMPORARY diagnostic for the macOS reference job (M1.7 fix round 1)
import { Database, SQLiteError } from "bun:sqlite";
import { test } from "bun:test";

function attempt(db: Database, label: string, sql: string): void {
  try {
    db.run(sql);
    console.log(`DIAG ${label}: ok`);
  } catch (err) {
    const e = err as SQLiteError;
    console.log(
      `DIAG ${label}: threw`,
      JSON.stringify({
        name: e?.name,
        message: e?.message,
        errno: e?.errno,
        code: e?.code,
        isSQLiteError: err instanceof SQLiteError,
        keys: Object.getOwnPropertyNames(e ?? {}),
      }),
    );
  }
}

test("sqlite diagnostics", () => {
  const db = new Database(":memory:");
  console.log("DIAG platform", process.platform, Bun.version);
  console.log("DIAG version", JSON.stringify(db.query("select sqlite_version() v").get()));
  console.log(
    "DIAG legacy_alter_table",
    JSON.stringify(db.query("PRAGMA legacy_alter_table").get()),
  );
  console.log("DIAG trusted_schema", JSON.stringify(db.query("PRAGMA trusted_schema").get()));
  console.log(
    "DIAG compile_options",
    JSON.stringify(
      db
        .query("PRAGMA compile_options")
        .all()
        .map((r) => Object.values(r as object)[0]),
    ),
  );
  db.run("create table posts (id text primary key, title text, meta text)");
  db.run("create view v1 as select id, title from posts");
  db.run("create view v2 as select * from (select id, title from v1)");
  attempt(
    db,
    "rename column used by view of view",
    "alter table posts rename column title to title_tmp",
  );
  console.log("DIAG schema after", JSON.stringify(db.query("select sql from sqlite_master").all()));
  attempt(db, "rename back", "alter table posts rename column title_tmp to title");
  attempt(db, "rename table", "alter table posts rename to articles");
  console.log(
    "DIAG schema after table rename",
    JSON.stringify(db.query("select sql from sqlite_master").all()),
  );
  attempt(db, "drop column meta", "alter table articles drop column meta");
  attempt(db, "select from broken view", "select * from v2");
  db.run("PRAGMA legacy_alter_table = OFF");
  db.run("create table t2 (a text, b text)");
  db.run("create view vt2 as select a from t2");
  attempt(db, "legacy OFF: rename column used by view", "alter table t2 rename column a to c");
  db.close();
});
