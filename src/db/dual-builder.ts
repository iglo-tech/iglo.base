// Upstream: core/db_builder.go
//
// note: expects both builder to use the same driver

import type { Builder } from "@/db/dbx/builder";
import type { Expression } from "@/db/dbx/expression";
import type { ModelQuery } from "@/db/dbx/model-query";
import type { Params, Query } from "@/db/dbx/query";
import type { QueryBuilder } from "@/db/dbx/query-builder";
import type { SelectQuery } from "@/db/dbx/select";
import type { StructModel } from "@/db/dbx/struct";

// dualDBBuilder routes SELECT queries to the concurrent builder and
// everything else to the nonconcurrent one.
export class DualDBBuilder implements Builder {
  constructor(
    readonly concurrentDB: Builder,
    readonly nonconcurrentDB: Builder,
  ) {}

  select(...cols: string[]): SelectQuery {
    return this.concurrentDB.select(...cols);
  }

  model(model: StructModel): ModelQuery {
    return this.nonconcurrentDB.model(model);
  }

  generatePlaceholder(i: number): string {
    return this.concurrentDB.generatePlaceholder(i);
  }

  quote(s: string): string {
    return this.concurrentDB.quote(s);
  }

  quoteSimpleTableName(table: string): string {
    return this.concurrentDB.quoteSimpleTableName(table);
  }

  quoteSimpleColumnName(col: string): string {
    return this.concurrentDB.quoteSimpleColumnName(col);
  }

  queryBuilder(): QueryBuilder {
    return this.concurrentDB.queryBuilder();
  }

  insert(table: string, cols: Params): Query {
    return this.nonconcurrentDB.insert(table, cols);
  }

  upsert(table: string, cols: Params, ...constraints: string[]): Query {
    return this.nonconcurrentDB.upsert(table, cols, ...constraints);
  }

  update(table: string, cols: Params, where: Expression | null): Query {
    return this.nonconcurrentDB.update(table, cols, where);
  }

  delete(table: string, where: Expression | null): Query {
    return this.nonconcurrentDB.delete(table, where);
  }

  createTable(table: string, cols: Record<string, string>, ...options: string[]): Query {
    return this.nonconcurrentDB.createTable(table, cols, ...options);
  }

  renameTable(oldName: string, newName: string): Query {
    return this.nonconcurrentDB.renameTable(oldName, newName);
  }

  dropTable(table: string): Query {
    return this.nonconcurrentDB.dropTable(table);
  }

  truncateTable(table: string): Query {
    return this.nonconcurrentDB.truncateTable(table);
  }

  addColumn(table: string, col: string, typ: string): Query {
    return this.nonconcurrentDB.addColumn(table, col, typ);
  }

  dropColumn(table: string, col: string): Query {
    return this.nonconcurrentDB.dropColumn(table, col);
  }

  renameColumn(table: string, oldName: string, newName: string): Query {
    return this.nonconcurrentDB.renameColumn(table, oldName, newName);
  }

  alterColumn(table: string, col: string, typ: string): Query {
    return this.nonconcurrentDB.alterColumn(table, col, typ);
  }

  addPrimaryKey(table: string, name: string, ...cols: string[]): Query {
    return this.nonconcurrentDB.addPrimaryKey(table, name, ...cols);
  }

  dropPrimaryKey(table: string, name: string): Query {
    return this.nonconcurrentDB.dropPrimaryKey(table, name);
  }

  addForeignKey(
    table: string,
    name: string,
    cols: string[],
    refCols: string[],
    refTable: string,
    ...options: string[]
  ): Query {
    return this.nonconcurrentDB.addForeignKey(table, name, cols, refCols, refTable, ...options);
  }

  dropForeignKey(table: string, name: string): Query {
    return this.nonconcurrentDB.dropForeignKey(table, name);
  }

  createIndex(table: string, name: string, ...cols: string[]): Query {
    return this.nonconcurrentDB.createIndex(table, name, ...cols);
  }

  createUniqueIndex(table: string, name: string, ...cols: string[]): Query {
    return this.nonconcurrentDB.createUniqueIndex(table, name, ...cols);
  }

  dropIndex(table: string, name: string): Query {
    return this.nonconcurrentDB.dropIndex(table, name);
  }

  // NewQuery implements the [dbx.Builder.NewQuery] interface method by
  // routing the SELECT queries to the concurrent builder instance.
  newQuery(str: string): Query {
    // note: technically INSERT/UPDATE/DELETE could also have CTE but since
    // it is rare for now this scase is ignored to avoid unnecessary complicating the checks
    const trimmed = trimLeftSpaces(str);
    if (hasPrefixFold(trimmed, "SELECT") || hasPrefixFold(trimmed, "WITH")) {
      return this.concurrentDB.newQuery(str);
    }

    return this.nonconcurrentDB.newQuery(str);
  }
}

// Go's unicode.IsSpace
const leadingSpaces =
  /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

// note: similar to strings.Space() but without the right trim because it is not needed in our case
export function trimLeftSpaces(str: string): string {
  return str.replace(leadingSpaces, "");
}

// note: the prefix is expected to be ASCII
export function hasPrefixFold(str: string, prefix: string): boolean {
  if (str.length < prefix.length) {
    return false;
  }
  // byte-wise in Go: a non-ASCII character never folds to an ASCII one here
  return asciiLower(str.slice(0, prefix.length)) === asciiLower(prefix);
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}
