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

// Upstream: pocketbase/dbx v1.13.0 builder_sqlite.go

import { BaseBuilder } from "@/db/dbx/builder";
import type { DB } from "@/db/dbx/db";
import { ModelQuery } from "@/db/dbx/model-query";
import type { Executor, Params, Query } from "@/db/dbx/query";
import { BaseQueryBuilder, type QueryBuilder, type UnionInfo } from "@/db/dbx/query-builder";
import { SelectQuery } from "@/db/dbx/select";
import type { StructModel } from "@/db/dbx/struct";

// SqliteQueryBuilder is the query builder for SQLite databases.
export class SqliteQueryBuilder extends BaseQueryBuilder {
  // BuildUnion generates a UNION clause from the given union information.
  //
  // This is similar to BaseQueryBuilder.BuildUnion but without the parenthesis wrapping.
  override buildUnion(unions: UnionInfo[], params: Params): string {
    if (unions.length === 0) {
      return "";
    }

    let sql = "";

    unions.forEach((union, i) => {
      if (i > 0) {
        sql += " ";
      }

      Object.assign(params, union.query.params());

      const u = union.all ? "UNION ALL" : "UNION";

      sql += `${u} ${union.query.sql()}`;
    });

    return sql;
  }

  // CombineUnion combines the nonempty unionClause with the provided sql string.
  //
  // This is similar to BaseQueryBuilder.CombineUnion but without the parenthesis wrapping.
  override combineUnion(sql: string, unionClause: string): string {
    if (unionClause === "") {
      return sql;
    }

    return `${sql} ${unionClause}`;
  }
}

// SqliteBuilder is the builder for SQLite databases.
export class SqliteBuilder extends BaseBuilder {
  private readonly qb: SqliteQueryBuilder;

  constructor(db: DB, executor: Executor) {
    super(db, executor);
    this.qb = new SqliteQueryBuilder(db);
  }

  // QueryBuilder returns the query builder supporting the current DB.
  queryBuilder(): QueryBuilder {
    return this.qb;
  }

  // Select returns a new SelectQuery object that can be used to build a SELECT statement.
  // The parameters to this method should be the list column names to be selected.
  // A column name may have an optional alias name. For example, Select("id", "my_name AS name").
  select(...cols: string[]): SelectQuery {
    return new SelectQuery(this).select(...cols);
  }

  // Model returns a new ModelQuery object that can be used to perform model-based DB operations.
  model(model: StructModel): ModelQuery {
    return new ModelQuery(model, this);
  }

  // QuoteSimpleTableName quotes a simple table name.
  // A simple table name does not contain any schema prefix.
  override quoteSimpleTableName(s: string): string {
    if (s.includes("`")) {
      return s;
    }
    return "`" + s + "`";
  }

  // QuoteSimpleColumnName quotes a simple column name.
  // A simple column name does not contain any table prefix.
  override quoteSimpleColumnName(s: string): string {
    if (s.includes("`") || s === "*") {
      return s;
    }
    return "`" + s + "`";
  }

  // DropIndex creates a Query that can be used to remove the named index from a table.
  override dropIndex(_table: string, name: string): Query {
    return this.newQuery(`DROP INDEX ${this.database.quoteColumnName(name)}`);
  }

  // TruncateTable creates a Query that can be used to truncate a table.
  override truncateTable(table: string): Query {
    return this.newQuery("DELETE FROM " + this.database.quoteTableName(table));
  }

  // RenameTable creates a Query that can be used to rename a table.
  override renameTable(oldName: string, newName: string): Query {
    return this.newQuery(
      `ALTER TABLE ${this.database.quoteTableName(oldName)} RENAME TO ${this.database.quoteTableName(newName)}`,
    );
  }

  // AlterColumn creates a Query that can be used to change the definition of a table column.
  override alterColumn(_table: string, _col: string, _typ: string): Query {
    return this.failedQuery("SQLite does not support altering column");
  }

  // AddPrimaryKey creates a Query that can be used to specify primary key(s) for a table.
  override addPrimaryKey(_table: string, _name: string, ..._cols: string[]): Query {
    return this.failedQuery("SQLite does not support adding primary key");
  }

  // DropPrimaryKey creates a Query that can be used to remove the named primary key constraint from a table.
  override dropPrimaryKey(_table: string, _name: string): Query {
    return this.failedQuery("SQLite does not support dropping primary key");
  }

  // AddForeignKey creates a Query that can be used to add a foreign key constraint to a table.
  override addForeignKey(
    _table: string,
    _name: string,
    _cols: string[],
    _refCols: string[],
    _refTable: string,
    ..._options: string[]
  ): Query {
    return this.failedQuery("SQLite does not support adding foreign keys");
  }

  // DropForeignKey creates a Query that can be used to remove the named foreign key constraint from a table.
  override dropForeignKey(_table: string, _name: string): Query {
    return this.failedQuery("SQLite does not support dropping foreign keys");
  }

  private failedQuery(message: string): Query {
    const q = this.newQuery("");
    q.lastError = new Error(message);
    return q;
  }
}
