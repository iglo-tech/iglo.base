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

// Upstream: pocketbase/dbx v1.13.0 query_builder.go

import type { DB } from "@/db/dbx/db";
import type { Expression } from "@/db/dbx/expression";
import { assignOwn, type Params, type Query } from "@/db/dbx/query";

// JoinInfo contains the specification for a JOIN clause.
export interface JoinInfo {
  join: string;
  table: string;
  on: Expression | null;
}

// UnionInfo contains the specification for a UNION clause.
export interface UnionInfo {
  all: boolean;
  query: Query;
}

// QueryBuilder builds different clauses for a SELECT SQL statement.
export interface QueryBuilder {
  // BuildSelect generates a SELECT clause from the given selected column names.
  buildSelect(cols: string[], distinct: boolean, option: string): string;
  // BuildFrom generates a FROM clause from the given tables.
  buildFrom(tables: string[]): string;
  // BuildGroupBy generates a GROUP BY clause from the given group-by columns.
  buildGroupBy(cols: string[]): string;
  // BuildJoin generates a JOIN clause from the given join information.
  buildJoin(joins: JoinInfo[], params: Params): string;
  // BuildWhere generates a WHERE clause from the given expression.
  buildWhere(e: Expression | null, params: Params): string;
  // BuildHaving generates a HAVING clause from the given expression.
  buildHaving(e: Expression | null, params: Params): string;
  // BuildOrderByAndLimit generates the ORDER BY and LIMIT clauses.
  buildOrderByAndLimit(sql: string, cols: string[], limit: number, offset: number): string;
  // BuildUnion generates a UNION clause from the given union information.
  buildUnion(unions: UnionInfo[], params: Params): string;
  // CombineUnion combines the nonempty unionClause with the provided sql string.
  //
  // The unionClause is expected to be the result of BuildUnion.
  // If the unionClause is an empty string it returns the sql argument unmodified.
  //
  // This method exists as a workaround to minimize breaking changes
  // and to allow different SQL builders to specify for example whether
  // they support parenthesis around the UNION SQL queries
  // (SQLite for example will throw a SyntaxError if the UNION parts are wrapped in parenthesis).
  combineUnion(sql: string, unionClause: string): string;
}

// Go's \s (RE2): no \v and no Unicode spaces
const space = "[\\t\\n\\f\\r ]";

// the regexp for columns and tables.
const selectRegex = new RegExp(`(?:${space}+as${space}+|${space}+)([\\w\\-_.]+)$`, "i");

const orderRegex = new RegExp(`${space}+(ASC|DESC)$`, "i");

// 2^63 - 1, printed as Go prints the int64
const maxInt64 = "9223372036854775807";

// BaseQueryBuilder provides a basic implementation of QueryBuilder.
export class BaseQueryBuilder implements QueryBuilder {
  constructor(private readonly database: DB) {}

  // DB returns the DB instance associated with the query builder.
  db(): DB {
    return this.database;
  }

  buildSelect(cols: string[], distinct: boolean, option: string): string {
    let s = "SELECT ";
    if (distinct) {
      s += "DISTINCT ";
    }
    if (option !== "") {
      s += option + " ";
    }
    if (cols.length === 0) {
      return s + "*";
    }

    cols.forEach((col, i) => {
      if (i > 0) {
        s += ", ";
      }
      const matches = selectRegex.exec(col);
      if (matches === null) {
        s += this.database.quoteColumnName(col);
      } else {
        const name = col.slice(0, col.length - matches[0].length);
        const alias = matches[1]!;
        s +=
          this.database.quoteColumnName(name) + " AS " + this.database.quoteSimpleColumnName(alias);
      }
    });

    return s;
  }

  buildFrom(tables: string[]): string {
    if (tables.length === 0) {
      return "";
    }
    return "FROM " + tables.map((table) => this.quoteTableNameAndAlias(table)).join(", ");
  }

  buildJoin(joins: JoinInfo[], params: Params): string {
    if (joins.length === 0) {
      return "";
    }
    const parts: string[] = [];
    for (const join of joins) {
      let sql = join.join + " " + this.quoteTableNameAndAlias(join.table);
      const on = join.on !== null ? join.on.build(this.database, params) : "";
      if (on !== "") {
        sql += " ON " + on;
      }
      parts.push(sql);
    }
    return parts.join(" ");
  }

  buildWhere(e: Expression | null, params: Params): string {
    if (e !== null) {
      const c = e.build(this.database, params);
      if (c !== "") {
        return "WHERE " + c;
      }
    }
    return "";
  }

  buildHaving(e: Expression | null, params: Params): string {
    if (e !== null) {
      const c = e.build(this.database, params);
      if (c !== "") {
        return "HAVING " + c;
      }
    }
    return "";
  }

  buildGroupBy(cols: string[]): string {
    if (cols.length === 0) {
      return "";
    }
    return "GROUP BY " + cols.map((col) => this.database.quoteColumnName(col)).join(", ");
  }

  buildOrderByAndLimit(sql: string, cols: string[], limit: number, offset: number): string {
    const orderBy = this.buildOrderBy(cols);
    if (orderBy !== "") {
      sql += " " + orderBy;
    }
    const limitClause = this.buildLimit(limit, offset);
    if (limitClause !== "") {
      return sql + " " + limitClause;
    }
    return sql;
  }

  buildUnion(unions: UnionInfo[], params: Params): string {
    if (unions.length === 0) {
      return "";
    }
    let sql = "";
    unions.forEach((union, i) => {
      if (i > 0) {
        sql += " ";
      }
      assignOwn(params, union.query.params());
      const u = union.all ? "UNION ALL" : "UNION";
      sql += `${u} (${union.query.sql()})`;
    });
    return sql;
  }

  combineUnion(sql: string, unionClause: string): string {
    if (unionClause === "") {
      return sql;
    }
    return `(${sql}) ${unionClause}`;
  }

  // BuildOrderBy generates the ORDER BY clause.
  buildOrderBy(cols: string[]): string {
    if (cols.length === 0) {
      return "";
    }
    let s = "";
    cols.forEach((col, i) => {
      if (i > 0) {
        s += ", ";
      }
      const matches = orderRegex.exec(col);
      if (matches === null) {
        s += this.database.quoteColumnName(col);
      } else {
        const name = col.slice(0, col.length - matches[0].length);
        s += this.database.quoteColumnName(name) + " " + matches[1]!;
      }
    });
    return "ORDER BY " + s;
  }

  // BuildLimit generates the LIMIT clause.
  buildLimit(limit: number, offset: number): string {
    let limitStr = String(limit);
    if (limit < 0 && offset > 0) {
      // most DBMS requires LIMIT when OFFSET is present
      limitStr = maxInt64;
      limit = 0;
    }

    let sql = "";
    if (limit >= 0) {
      sql = "LIMIT " + limitStr;
    }
    if (offset <= 0) {
      return sql;
    }
    if (sql !== "") {
      sql += " ";
    }
    return sql + "OFFSET " + String(offset);
  }

  private quoteTableNameAndAlias(table: string): string {
    const matches = selectRegex.exec(table);
    if (matches === null) {
      return this.database.quoteTableName(table);
    }
    const name = table.slice(0, table.length - matches[0].length);
    return (
      this.database.quoteTableName(name) + " " + this.database.quoteSimpleTableName(matches[1]!)
    );
  }
}
