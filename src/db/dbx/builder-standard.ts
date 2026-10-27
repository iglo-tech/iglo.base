// Upstream: pocketbase/dbx v1.13.0 builder_standard.go

import { BaseBuilder } from "@/db/dbx/builder";
import type { DB } from "@/db/dbx/db";
import { ModelQuery } from "@/db/dbx/model-query";
import type { Executor } from "@/db/dbx/query";
import { BaseQueryBuilder, type QueryBuilder } from "@/db/dbx/query-builder";
import { SelectQuery } from "@/db/dbx/select";
import type { StructModel } from "@/db/dbx/struct";

// StandardBuilder is the builder that is used by DB for an unknown driver.
export class StandardBuilder extends BaseBuilder {
  private readonly qb: BaseQueryBuilder;

  constructor(db: DB, executor: Executor) {
    super(db, executor);
    this.qb = new BaseQueryBuilder(db);
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
}
