// Upstream: tools/search/multi_match_subquery.go

import type { DB } from "@/db/dbx/db";
import type { Expression } from "@/db/dbx/expression";
import { assignOwn, type Params } from "@/db/dbx/query";

// Join defines common fields required for a single SQL JOIN clause.
export interface Join {
  tableName: string;
  tableAlias: string;
  on?: Expression | null;
}

// MultiMatchSubquery defines a multi-match record subquery expression.
export class MultiMatchSubquery implements Expression {
  targetTableAlias = "";
  fromTableName = "";
  fromTableAlias = "";
  valueIdentifier = "";
  joins: Join[] = [];
  params: Params = {};

  constructor(init: Partial<MultiMatchSubquery> = {}) {
    Object.assign(this, init);
  }

  // Build converts the expression into a SQL fragment.
  //
  // Implements [dbx.Expression] interface.
  build(db: DB, params: Params): string {
    if (this.targetTableAlias === "" || this.fromTableName === "" || this.fromTableAlias === "") {
      return "0=1";
    }

    // merge by updating the parent params
    // (Go's nil params case, which uses m.Params, cannot occur here)
    assignOwn(params, this.params);

    let mergedJoins = "";
    for (const [i, j] of this.joins.entries()) {
      if (i > 0) {
        mergedJoins += " ";
      }
      mergedJoins += "LEFT JOIN ";
      mergedJoins += db.quoteTableName(j.tableName);
      mergedJoins += " ";
      mergedJoins += db.quoteTableName(j.tableAlias);
      if (j.on !== undefined && j.on !== null) {
        mergedJoins += " ON ";
        mergedJoins += j.on.build(db, params);
      }
    }

    return `SELECT ${db.quoteColumnName(this.valueIdentifier)} as [[multiMatchValue]] FROM ${db.quoteTableName(this.fromTableName)} ${db.quoteTableName(this.fromTableAlias)} ${mergedJoins} WHERE ${db.quoteColumnName(this.fromTableAlias + ".id")} = ${db.quoteColumnName(this.targetTableAlias + ".id")}`;
  }
}
