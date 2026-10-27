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
