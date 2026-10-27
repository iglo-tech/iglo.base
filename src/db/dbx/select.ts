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

// Upstream: pocketbase/dbx v1.13.0 select.go
//
// The SELECT resolvers (One, All, Row, Column, Rows) return what they read
// (see query.ts). Go code copies a SelectQuery struct to derive a second
// query from it (tools/search/provider.go); clone() does that here.

import type { Builder } from "@/db/dbx/builder";
import { and, HashExp, or, type Expression } from "@/db/dbx/expression";
import { assignOwn, type Params, type Query, type Row } from "@/db/dbx/query";
import type { JoinInfo, UnionInfo } from "@/db/dbx/query-builder";
import type { Rows } from "@/db/dbx/rows";
import { primaryKeyNames, type StructModel } from "@/db/dbx/struct";

// BuildHookFunc defines a callback function that is executed on Query creation.
export type BuildHookFunc = (q: Query) => void;

// MissingPKError and CompositePKError (model_query.go)
export class MissingPKError extends Error {
  constructor() {
    super("missing primary key declaration");
    this.name = "MissingPKError";
  }
}

export class CompositePKError extends Error {
  constructor() {
    super("composite primary key is not supported");
    this.name = "CompositePKError";
  }
}

// QueryInfo represents a debug/info struct with exported SelectQuery fields.
export interface QueryInfo {
  preFragment: string;
  postFragment: string;
  builder: Builder;
  selects: string[];
  distinct: boolean;
  selectOption: string;
  from: string[];
  where: Expression | null;
  join: JoinInfo[];
  orderBy: string[];
  groupBy: string[];
  having: Expression | null;
  union: UnionInfo[];
  limit: number;
  offset: number;
  params: Params;
  buildHook: BuildHookFunc | null;
}

// SelectQuery represents a DB-agnostic SELECT query.
// It can be built into a DB-specific query by calling the Build() method.
export class SelectQuery {
  private buildHook: BuildHookFunc | null = null;

  private preFragmentSQL = "";
  private postFragmentSQL = "";
  private selects: string[] = [];
  private isDistinct = false;
  private selectOptionSQL = "";
  private fromTables: string[] = [];
  private whereExp: Expression | null = null;
  private joins: JoinInfo[] = [];
  private orderByCols: string[] = [];
  private groupByCols: string[] = [];
  private havingExp: Expression | null = null;
  private unions: UnionInfo[] = [];
  private limitValue = -1;
  private offsetValue = 0;
  private boundParams: Params = {};

  constructor(private readonly builder: Builder) {}

  // a copy of the query; changing one does not change the other
  clone(): SelectQuery {
    const q = new SelectQuery(this.builder);
    q.buildHook = this.buildHook;
    q.preFragmentSQL = this.preFragmentSQL;
    q.postFragmentSQL = this.postFragmentSQL;
    q.selects = [...this.selects];
    q.isDistinct = this.isDistinct;
    q.selectOptionSQL = this.selectOptionSQL;
    q.fromTables = [...this.fromTables];
    q.whereExp = this.whereExp;
    q.joins = [...this.joins];
    q.orderByCols = [...this.orderByCols];
    q.groupByCols = [...this.groupByCols];
    q.havingExp = this.havingExp;
    q.unions = [...this.unions];
    q.limitValue = this.limitValue;
    q.offsetValue = this.offsetValue;
    q.boundParams = { ...this.boundParams };
    return q;
  }

  // WithBuildHook runs the provided hook function with the query created on Build().
  withBuildHook(fn: BuildHookFunc | null): this {
    this.buildHook = fn;
    return this;
  }

  // PreFragment sets SQL fragment that should be prepended before the select query (e.g. WITH clause).
  preFragment(fragment: string): this {
    this.preFragmentSQL = fragment;
    return this;
  }

  // PostFragment sets SQL fragment that should be appended at the end of the main select query.
  //
  // If there is "UNION"/"UNION ALL" clause then the extra UNION queries
  // are appended after the PostFragment.
  postFragment(fragment: string): this {
    this.postFragmentSQL = fragment;
    return this;
  }

  // Select specifies the columns to be selected.
  // Column names will be automatically quoted.
  select(...cols: string[]): this {
    this.selects = cols;
    return this;
  }

  // AndSelect adds additional columns to be selected.
  // Column names will be automatically quoted.
  andSelect(...cols: string[]): this {
    this.selects = [...this.selects, ...cols];
    return this;
  }

  // Distinct specifies whether to select columns distinctively.
  // By default, distinct is false.
  distinct(v: boolean): this {
    this.isDistinct = v;
    return this;
  }

  // SelectOption specifies additional option that should be append to "SELECT".
  selectOption(option: string): this {
    this.selectOptionSQL = option;
    return this;
  }

  // From specifies which tables to select from.
  // Table names will be automatically quoted.
  from(...tables: string[]): this {
    this.fromTables = tables;
    return this;
  }

  // Where specifies the WHERE condition.
  where(e: Expression | null): this {
    this.whereExp = e;
    return this;
  }

  // AndWhere concatenates a new WHERE condition with the existing one (if any) using "AND".
  andWhere(e: Expression | null): this {
    this.whereExp = and(this.whereExp, e);
    return this;
  }

  // OrWhere concatenates a new WHERE condition with the existing one (if any) using "OR".
  orWhere(e: Expression | null): this {
    this.whereExp = or(this.whereExp, e);
    return this;
  }

  // Join specifies a JOIN clause.
  // The "typ" parameter specifies the JOIN type (e.g. "INNER JOIN", "LEFT JOIN").
  join(typ: string, table: string, on: Expression | null): this {
    this.joins = [...this.joins, { join: typ, table, on }];
    return this;
  }

  // InnerJoin specifies an INNER JOIN clause.
  // This is a shortcut method for Join.
  innerJoin(table: string, on: Expression | null): this {
    return this.join("INNER JOIN", table, on);
  }

  // LeftJoin specifies a LEFT JOIN clause.
  // This is a shortcut method for Join.
  leftJoin(table: string, on: Expression | null): this {
    return this.join("LEFT JOIN", table, on);
  }

  // RightJoin specifies a RIGHT JOIN clause.
  // This is a shortcut method for Join.
  rightJoin(table: string, on: Expression | null): this {
    return this.join("RIGHT JOIN", table, on);
  }

  // OrderBy specifies the ORDER BY clause.
  // Column names will be properly quoted. A column name can contain "ASC" or "DESC" to indicate its ordering direction.
  orderBy(...cols: string[]): this {
    this.orderByCols = cols;
    return this;
  }

  // AndOrderBy appends additional columns to the existing ORDER BY clause.
  // Column names will be properly quoted. A column name can contain "ASC" or "DESC" to indicate its ordering direction.
  andOrderBy(...cols: string[]): this {
    this.orderByCols = [...this.orderByCols, ...cols];
    return this;
  }

  // GroupBy specifies the GROUP BY clause.
  // Column names will be properly quoted.
  groupBy(...cols: string[]): this {
    this.groupByCols = cols;
    return this;
  }

  // AndGroupBy appends additional columns to the existing GROUP BY clause.
  // Column names will be properly quoted.
  andGroupBy(...cols: string[]): this {
    this.groupByCols = [...this.groupByCols, ...cols];
    return this;
  }

  // Having specifies the HAVING clause.
  having(e: Expression | null): this {
    this.havingExp = e;
    return this;
  }

  // AndHaving concatenates a new HAVING condition with the existing one (if any) using "AND".
  andHaving(e: Expression | null): this {
    this.havingExp = and(this.havingExp, e);
    return this;
  }

  // OrHaving concatenates a new HAVING condition with the existing one (if any) using "OR".
  orHaving(e: Expression | null): this {
    this.havingExp = or(this.havingExp, e);
    return this;
  }

  // Union specifies a UNION clause.
  union(q: Query): this {
    this.unions = [...this.unions, { all: false, query: q }];
    return this;
  }

  // UnionAll specifies a UNION ALL clause.
  unionAll(q: Query): this {
    this.unions = [...this.unions, { all: true, query: q }];
    return this;
  }

  // Limit specifies the LIMIT clause.
  // A negative limit means no limit.
  limit(limit: number): this {
    this.limitValue = limit;
    return this;
  }

  // Offset specifies the OFFSET clause.
  // A negative offset means no offset.
  offset(offset: number): this {
    this.offsetValue = offset;
    return this;
  }

  // Bind specifies the parameter values to be bound to the query.
  bind(params: Params): this {
    this.boundParams = params;
    return this;
  }

  // AndBind appends additional parameters to be bound to the query.
  andBind(params: Params): this {
    if (Object.keys(this.boundParams).length === 0) {
      this.boundParams = params;
    } else {
      assignOwn(this.boundParams, params);
    }
    return this;
  }

  // Build builds the SELECT query and returns an executable Query object.
  build(): Query {
    const params: Params = { ...this.boundParams };

    const qb = this.builder.queryBuilder();

    const clauses = [
      this.preFragmentSQL,
      qb.buildSelect(this.selects, this.isDistinct, this.selectOptionSQL),
      qb.buildFrom(this.fromTables),
      qb.buildJoin(this.joins, params),
      qb.buildWhere(this.whereExp, params),
      qb.buildGroupBy(this.groupByCols),
      qb.buildHaving(this.havingExp, params),
    ];

    let sql = clauses.filter((clause) => clause !== "").join(" ");

    sql = qb.buildOrderByAndLimit(sql, this.orderByCols, this.limitValue, this.offsetValue);

    if (this.postFragmentSQL !== "") {
      sql += " " + this.postFragmentSQL;
    }

    sql = qb.combineUnion(sql, qb.buildUnion(this.unions, params));

    const query = this.builder.newQuery(sql).bind(params);

    if (this.buildHook !== null) {
      this.buildHook(query);
    }

    return query;
  }

  // One executes the SELECT query and returns the first row of the result:
  // the row object, or the given model populated with it.
  //
  // If the query does not specify a "from" clause, the method uses the
  // model's table name.
  //
  // Note that when the query has no rows in the result set, a NoRowsError is thrown.
  one<T = Row>(a?: StructModel): T {
    if (this.fromTables.length === 0 && a !== undefined) {
      this.fromTables = [a.tableName()];
    }
    return this.build().one<T>(a);
  }

  // Model selects the row with the specified primary key and populates the model with the row data.
  //
  // If the query does not specify a "from" clause, it will use the model to
  // determine which table to select data from. It will also use the model
  // to infer the name of the primary key column. Only simple primary key is supported.
  // For composite primary keys, please use Where() to specify the filtering condition.
  model(pk: unknown, model: StructModel): void {
    const pkNames = primaryKeyNames(model);
    if (pkNames.length === 1) {
      this.andWhere(new HashExp({ [pkNames[0]!]: pk })).one(model);
      return;
    }
    if (pkNames.length === 0) {
      throw new MissingPKError();
    }
    throw new CompositePKError();
  }

  // All executes the SELECT query and returns all rows of the result: row
  // objects, or models created by the factory and populated with the rows.
  //
  // If the query does not specify a "from" clause, the method uses the
  // table name of the factory's models.
  all<T = Row>(factory?: () => StructModel): T[] {
    if (this.fromTables.length === 0 && factory !== undefined) {
      this.fromTables = [factory().tableName()];
    }
    return this.build().all<T>(factory);
  }

  // Rows builds and executes the SELECT query and returns a Rows object for data retrieval purpose.
  // This is a shortcut to SelectQuery.Build().Rows()
  rows(): Rows {
    return this.build().rows();
  }

  // Row builds and executes the SELECT query and returns the values of the first row.
  // This is a shortcut to SelectQuery.Build().Row()
  row(): unknown[] {
    return this.build().row();
  }

  // Column builds and executes the SELECT statement and returns the first column of the result.
  // This is a shortcut to SelectQuery.Build().Column()
  column<T = unknown>(): T[] {
    return this.build().column<T>();
  }

  // Info exports common SelectQuery fields allowing to inspect the
  // current select query options.
  info(): QueryInfo {
    return {
      builder: this.builder,
      preFragment: this.preFragmentSQL,
      postFragment: this.postFragmentSQL,
      selects: this.selects,
      distinct: this.isDistinct,
      selectOption: this.selectOptionSQL,
      from: this.fromTables,
      where: this.whereExp,
      join: this.joins,
      orderBy: this.orderByCols,
      groupBy: this.groupByCols,
      having: this.havingExp,
      union: this.unions,
      limit: this.limitValue,
      offset: this.offsetValue,
      params: this.boundParams,
      buildHook: this.buildHook,
    };
  }
}
