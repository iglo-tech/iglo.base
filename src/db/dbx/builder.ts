// Translated from pocketbase/dbx v1.13.0, whose license follows:
//
// The MIT License (MIT)
//
// Copyright (c) 2016, Qiang Xue
// Copyright (c) 2022-present Gani Georgiev
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software
// and associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software
// is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
// BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

// Upstream: pocketbase/dbx v1.13.0 builder.go

import type { DB } from "@/db/dbx/db";
import { isExpression, sortStrings, type Expression } from "@/db/dbx/expression";
import type { ModelQuery } from "@/db/dbx/model-query";
import { Query, type Executor, type Params } from "@/db/dbx/query";
import type { QueryBuilder } from "@/db/dbx/query-builder";
import type { SelectQuery } from "@/db/dbx/select";
import type { StructModel } from "@/db/dbx/struct";

// Builder supports building SQL statements in a DB-agnostic way.
// Builder mainly provides two sets of query building methods: those building SELECT statements
// and those manipulating DB data or schema (e.g. INSERT statements, CREATE TABLE statements).
export interface Builder {
  // NewQuery creates a new Query object with the given SQL statement.
  // The SQL statement may contain parameter placeholders which can be bound with actual parameter
  // values before the statement is executed.
  newQuery(sql: string): Query;
  // Select returns a new SelectQuery object that can be used to build a SELECT statement.
  // The parameters to this method should be the list column names to be selected.
  // A column name may have an optional alias name. For example, Select("id", "my_name AS name").
  select(...cols: string[]): SelectQuery;
  // ModelQuery returns a new ModelQuery object that can be used to perform model insertion, update, and deletion.
  model(model: StructModel): ModelQuery;

  // GeneratePlaceholder generates an anonymous parameter placeholder with the given parameter ID.
  generatePlaceholder(i: number): string;

  // Quote quotes a string so that it can be embedded in a SQL statement as a string value.
  quote(s: string): string;
  // QuoteSimpleTableName quotes a simple table name.
  // A simple table name does not contain any schema prefix.
  quoteSimpleTableName(s: string): string;
  // QuoteSimpleColumnName quotes a simple column name.
  // A simple column name does not contain any table prefix.
  quoteSimpleColumnName(s: string): string;

  // QueryBuilder returns the query builder supporting the current DB.
  queryBuilder(): QueryBuilder;

  // Insert creates a Query that represents an INSERT SQL statement.
  // The keys of cols are the column names, while the values of cols are the corresponding column
  // values to be inserted.
  insert(table: string, cols: Params): Query;
  // Upsert creates a Query that represents an UPSERT SQL statement.
  upsert(table: string, cols: Params, ...constraints: string[]): Query;
  // Update creates a Query that represents an UPDATE SQL statement.
  // If the "where" expression is nil, the UPDATE SQL statement will have no WHERE clause
  // (be careful in this case as the SQL statement will update ALL rows in the table).
  update(table: string, cols: Params, where: Expression | null): Query;
  // Delete creates a Query that represents a DELETE SQL statement.
  // If the "where" expression is nil, the DELETE SQL statement will have no WHERE clause
  // (be careful in this case as the SQL statement will delete ALL rows in the table).
  delete(table: string, where: Expression | null): Query;

  // CreateTable creates a Query that represents a CREATE TABLE SQL statement.
  // The keys of cols are the column names, while the values of cols are the corresponding column types.
  // The optional "options" parameters will be appended to the generated SQL statement.
  createTable(table: string, cols: Record<string, string>, ...options: string[]): Query;
  // RenameTable creates a Query that can be used to rename a table.
  renameTable(oldName: string, newName: string): Query;
  // DropTable creates a Query that can be used to drop a table.
  dropTable(table: string): Query;
  // TruncateTable creates a Query that can be used to truncate a table.
  truncateTable(table: string): Query;

  // AddColumn creates a Query that can be used to add a column to a table.
  addColumn(table: string, col: string, typ: string): Query;
  // DropColumn creates a Query that can be used to drop a column from a table.
  dropColumn(table: string, col: string): Query;
  // RenameColumn creates a Query that can be used to rename a column in a table.
  renameColumn(table: string, oldName: string, newName: string): Query;
  // AlterColumn creates a Query that can be used to change the definition of a table column.
  alterColumn(table: string, col: string, typ: string): Query;

  // AddPrimaryKey creates a Query that can be used to specify primary key(s) for a table.
  // The "name" parameter specifies the name of the primary key constraint.
  addPrimaryKey(table: string, name: string, ...cols: string[]): Query;
  // DropPrimaryKey creates a Query that can be used to remove the named primary key constraint from a table.
  dropPrimaryKey(table: string, name: string): Query;

  // AddForeignKey creates a Query that can be used to add a foreign key constraint to a table.
  // The length of cols and refCols must be the same as they refer to the primary and referential columns.
  // The optional "options" parameters will be appended to the SQL statement. They can be used to
  // specify options such as "ON DELETE CASCADE".
  addForeignKey(
    table: string,
    name: string,
    cols: string[],
    refCols: string[],
    refTable: string,
    ...options: string[]
  ): Query;
  // DropForeignKey creates a Query that can be used to remove the named foreign key constraint from a table.
  dropForeignKey(table: string, name: string): Query;

  // CreateIndex creates a Query that can be used to create an index for a table.
  createIndex(table: string, name: string, ...cols: string[]): Query;
  // CreateUniqueIndex creates a Query that can be used to create a unique index for a table.
  createUniqueIndex(table: string, name: string, ...cols: string[]): Query;
  // DropIndex creates a Query that can be used to remove the named index from a table.
  dropIndex(table: string, name: string): Query;
}

// BaseBuilder provides a basic implementation of the Builder interface.
export abstract class BaseBuilder implements Builder {
  constructor(
    protected readonly database: DB,
    protected readonly executorValue: Executor,
  ) {}

  abstract select(...cols: string[]): SelectQuery;
  abstract model(model: StructModel): ModelQuery;
  abstract queryBuilder(): QueryBuilder;

  // DB returns the DB instance that this builder is associated with.
  db(): DB {
    return this.database;
  }

  // Executor returns the executor object (a DB instance or a transaction) for executing SQL statements.
  executor(): Executor {
    return this.executorValue;
  }

  newQuery(sql: string): Query {
    return new Query(this.database, this.executorValue, sql);
  }

  generatePlaceholder(_i: number): string {
    return "?";
  }

  quote(s: string): string {
    return "'" + s.replaceAll("'", "''") + "'";
  }

  quoteSimpleTableName(s: string): string {
    if (s.includes('"')) {
      return s;
    }
    return '"' + s + '"';
  }

  quoteSimpleColumnName(s: string): string {
    if (s.includes('"') || s === "*") {
      return s;
    }
    return '"' + s + '"';
  }

  insert(table: string, cols: Params): Query {
    const names = sortStrings(Object.keys(cols));

    const params: Params = {};
    const columns: string[] = [];
    const values: string[] = [];
    for (const name of names) {
      columns.push(this.database.quoteColumnName(name));
      const value = cols[name];
      if (isExpression(value)) {
        values.push(value.build(this.database, params));
      } else {
        const pn = `p${Object.keys(params).length}`;
        values.push(`{:${pn}}`);
        params[pn] = value;
      }
    }

    let sql: string;
    if (names.length === 0) {
      sql = `INSERT INTO ${this.database.quoteTableName(table)} DEFAULT VALUES`;
    } else {
      sql = `INSERT INTO ${this.database.quoteTableName(table)} (${columns.join(", ")}) VALUES (${values.join(", ")})`;
    }

    return this.newQuery(sql).bind(params);
  }

  upsert(_table: string, _cols: Params, ..._constraints: string[]): Query {
    const q = this.newQuery("");
    q.lastError = new Error("Upsert is not supported");
    return q;
  }

  update(table: string, cols: Params, where: Expression | null): Query {
    const names = sortStrings(Object.keys(cols));

    const params: Params = {};
    const lines: string[] = [];
    for (const name of names) {
      const value = cols[name];
      const col = this.database.quoteColumnName(name);
      if (isExpression(value)) {
        lines.push(col + "=" + value.build(this.database, params));
      } else {
        const pn = `p${Object.keys(params).length}`;
        lines.push(`${col}={:${pn}}`);
        params[pn] = value;
      }
    }

    let sql = `UPDATE ${this.database.quoteTableName(table)} SET ${lines.join(", ")}`;
    if (where !== null) {
      const w = where.build(this.database, params);
      if (w !== "") {
        sql += " WHERE " + w;
      }
    }

    return this.newQuery(sql).bind(params);
  }

  delete(table: string, where: Expression | null): Query {
    let sql = "DELETE FROM " + this.database.quoteTableName(table);
    const params: Params = {};
    if (where !== null) {
      const w = where.build(this.database, params);
      if (w !== "") {
        sql += " WHERE " + w;
      }
    }
    return this.newQuery(sql).bind(params);
  }

  createTable(table: string, cols: Record<string, string>, ...options: string[]): Query {
    const names = sortStrings(Object.keys(cols));
    const columns = names.map((name) => this.database.quoteColumnName(name) + " " + cols[name]);

    let sql = `CREATE TABLE ${this.database.quoteTableName(table)} (${columns.join(", ")})`;
    for (const opt of options) {
      sql += " " + opt;
    }

    return this.newQuery(sql);
  }

  renameTable(oldName: string, newName: string): Query {
    return this.newQuery(
      `RENAME TABLE ${this.database.quoteTableName(oldName)} TO ${this.database.quoteTableName(newName)}`,
    );
  }

  dropTable(table: string): Query {
    return this.newQuery("DROP TABLE " + this.database.quoteTableName(table));
  }

  truncateTable(table: string): Query {
    return this.newQuery("TRUNCATE TABLE " + this.database.quoteTableName(table));
  }

  addColumn(table: string, col: string, typ: string): Query {
    return this.newQuery(
      `ALTER TABLE ${this.database.quoteTableName(table)} ADD ${this.database.quoteColumnName(col)} ${typ}`,
    );
  }

  dropColumn(table: string, col: string): Query {
    return this.newQuery(
      `ALTER TABLE ${this.database.quoteTableName(table)} DROP COLUMN ${this.database.quoteColumnName(col)}`,
    );
  }

  renameColumn(table: string, oldName: string, newName: string): Query {
    return this.newQuery(
      `ALTER TABLE ${this.database.quoteTableName(table)} RENAME COLUMN ${this.database.quoteColumnName(oldName)} TO ${this.database.quoteColumnName(newName)}`,
    );
  }

  alterColumn(table: string, col: string, typ: string): Query {
    const quoted = this.database.quoteColumnName(col);
    return this.newQuery(
      `ALTER TABLE ${this.database.quoteTableName(table)} CHANGE ${quoted} ${quoted} ${typ}`,
    );
  }

  addPrimaryKey(table: string, name: string, ...cols: string[]): Query {
    return this.newQuery(
      `ALTER TABLE ${this.database.quoteTableName(table)} ADD CONSTRAINT ${this.database.quoteColumnName(name)} PRIMARY KEY (${this.quoteColumns(cols)})`,
    );
  }

  dropPrimaryKey(table: string, name: string): Query {
    return this.newQuery(
      `ALTER TABLE ${this.database.quoteTableName(table)} DROP CONSTRAINT ${this.database.quoteColumnName(name)}`,
    );
  }

  addForeignKey(
    table: string,
    name: string,
    cols: string[],
    refCols: string[],
    refTable: string,
    ...options: string[]
  ): Query {
    let sql = `ALTER TABLE ${this.database.quoteTableName(table)} ADD CONSTRAINT ${this.database.quoteColumnName(name)} FOREIGN KEY (${this.quoteColumns(cols)}) REFERENCES ${this.database.quoteTableName(refTable)} (${this.quoteColumns(refCols)})`;
    for (const opt of options) {
      sql += " " + opt;
    }
    return this.newQuery(sql);
  }

  dropForeignKey(table: string, name: string): Query {
    return this.newQuery(
      `ALTER TABLE ${this.database.quoteTableName(table)} DROP CONSTRAINT ${this.database.quoteColumnName(name)}`,
    );
  }

  createIndex(table: string, name: string, ...cols: string[]): Query {
    return this.newQuery(
      `CREATE INDEX ${this.database.quoteColumnName(name)} ON ${this.database.quoteTableName(table)} (${this.quoteColumns(cols)})`,
    );
  }

  createUniqueIndex(table: string, name: string, ...cols: string[]): Query {
    return this.newQuery(
      `CREATE UNIQUE INDEX ${this.database.quoteColumnName(name)} ON ${this.database.quoteTableName(table)} (${this.quoteColumns(cols)})`,
    );
  }

  dropIndex(table: string, name: string): Query {
    return this.newQuery(
      `DROP INDEX ${this.database.quoteColumnName(name)} ON ${this.database.quoteTableName(table)}`,
    );
  }

  // quoteColumns quotes a list of columns and concatenates them with commas.
  protected quoteColumns(cols: string[]): string {
    return cols.map((col) => this.database.quoteColumnName(col)).join(", ");
  }
}

// EmbeddedBuilder forwards the Builder methods to a builder, as Go's DB and
// Tx structs do by embedding the Builder interface.
export abstract class EmbeddedBuilder implements Builder {
  abstract builder: Builder;

  newQuery(sql: string): Query {
    return this.builder.newQuery(sql);
  }
  select(...cols: string[]): SelectQuery {
    return this.builder.select(...cols);
  }
  model(model: StructModel): ModelQuery {
    return this.builder.model(model);
  }
  generatePlaceholder(i: number): string {
    return this.builder.generatePlaceholder(i);
  }
  quote(s: string): string {
    return this.builder.quote(s);
  }
  quoteSimpleTableName(s: string): string {
    return this.builder.quoteSimpleTableName(s);
  }
  quoteSimpleColumnName(s: string): string {
    return this.builder.quoteSimpleColumnName(s);
  }
  queryBuilder(): QueryBuilder {
    return this.builder.queryBuilder();
  }
  insert(table: string, cols: Params): Query {
    return this.builder.insert(table, cols);
  }
  upsert(table: string, cols: Params, ...constraints: string[]): Query {
    return this.builder.upsert(table, cols, ...constraints);
  }
  update(table: string, cols: Params, where: Expression | null): Query {
    return this.builder.update(table, cols, where);
  }
  delete(table: string, where: Expression | null): Query {
    return this.builder.delete(table, where);
  }
  createTable(table: string, cols: Record<string, string>, ...options: string[]): Query {
    return this.builder.createTable(table, cols, ...options);
  }
  renameTable(oldName: string, newName: string): Query {
    return this.builder.renameTable(oldName, newName);
  }
  dropTable(table: string): Query {
    return this.builder.dropTable(table);
  }
  truncateTable(table: string): Query {
    return this.builder.truncateTable(table);
  }
  addColumn(table: string, col: string, typ: string): Query {
    return this.builder.addColumn(table, col, typ);
  }
  dropColumn(table: string, col: string): Query {
    return this.builder.dropColumn(table, col);
  }
  renameColumn(table: string, oldName: string, newName: string): Query {
    return this.builder.renameColumn(table, oldName, newName);
  }
  alterColumn(table: string, col: string, typ: string): Query {
    return this.builder.alterColumn(table, col, typ);
  }
  addPrimaryKey(table: string, name: string, ...cols: string[]): Query {
    return this.builder.addPrimaryKey(table, name, ...cols);
  }
  dropPrimaryKey(table: string, name: string): Query {
    return this.builder.dropPrimaryKey(table, name);
  }
  addForeignKey(
    table: string,
    name: string,
    cols: string[],
    refCols: string[],
    refTable: string,
    ...options: string[]
  ): Query {
    return this.builder.addForeignKey(table, name, cols, refCols, refTable, ...options);
  }
  dropForeignKey(table: string, name: string): Query {
    return this.builder.dropForeignKey(table, name);
  }
  createIndex(table: string, name: string, ...cols: string[]): Query {
    return this.builder.createIndex(table, name, ...cols);
  }
  createUniqueIndex(table: string, name: string, ...cols: string[]): Query {
    return this.builder.createUniqueIndex(table, name, ...cols);
  }
  dropIndex(table: string, name: string): Query {
    return this.builder.dropIndex(table, name);
  }
}
