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

// Upstream: pocketbase/dbx v1.13.0 model_query.go
//
// Insert/Update attrs and Exclude take column names (see struct.ts).

import type { Builder } from "@/db/dbx/builder";
import { HashExp } from "@/db/dbx/expression";
import { MissingPKError } from "@/db/dbx/select";
import { structColumns, structPK, type StructModel } from "@/db/dbx/struct";

// ModelQuery represents a query associated with a struct model.
export class ModelQuery {
  private excluded: string[] = [];

  constructor(
    private readonly model: StructModel,
    private readonly builder: Builder,
  ) {}

  // Exclude excludes the specified columns from being inserted/updated into the DB table.
  exclude(...attrs: string[]): this {
    this.excluded = attrs;
    return this;
  }

  // Insert inserts a row in the table using the model associated with this query.
  //
  // By default, it inserts *all* columns into the table, including those nil or empty ones.
  // You may pass a list of the columns to this method to indicate that only those columns should be inserted.
  // You may also call Exclude to exclude some columns from being inserted.
  //
  // If a model has an empty primary key, it is considered auto-incremental and the model
  // is scanned with the generated primary key value after a successful insertion.
  insert(...attrs: string[]): void {
    const cols = structColumns(this.model, attrs, this.excluded);
    let pkName = "";
    for (const [name, value] of Object.entries(structPK(this.model) ?? {})) {
      if (isAutoInc(value)) {
        delete cols[name];
        pkName = name;
        break;
      }
    }

    const query = this.builder.insert(this.model.tableName(), cols);

    if (pkName === "") {
      query.execute();
      return;
    }

    // handle auto-incremental PK
    const result = query.execute();
    this.model.dbScan({ [pkName]: result.lastInsertId });
  }

  // Update updates a row in the table using the model associated with this query.
  // The row being updated has the same primary key as specified by the model.
  //
  // By default, it updates *all* columns in the table, including those nil or empty ones.
  // You may pass a list of the columns to this method to indicate that only those columns should be updated.
  // You may also call Exclude to exclude some columns from being updated.
  update(...attrs: string[]): void {
    const pk = structPK(this.model);
    if (pk === null) {
      throw new MissingPKError();
    }

    const cols = structColumns(this.model, attrs, this.excluded);
    for (const name of Object.keys(pk)) {
      delete cols[name];
    }
    this.builder.update(this.model.tableName(), cols, new HashExp(pk)).execute();
  }

  // Delete deletes a row in the table using the primary key specified by the model associated with this query.
  delete(): void {
    const pk = structPK(this.model);
    if (pk === null) {
      throw new MissingPKError();
    }
    this.builder.delete(this.model.tableName(), new HashExp(pk)).execute();
  }
}

function isAutoInc(value: unknown): boolean {
  return value === null || value === undefined || value === 0 || value === 0n;
}
