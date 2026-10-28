// Upstream: core/record_field_resolver_replace_expr.go

import type { DB } from "@/db/dbx/db";
import type { Expression } from "@/db/dbx/expression";
import type { Params } from "@/db/dbx/query";

// replaceWithExpression defines a custom expression that will replace
// a placeholder identifier found in "old" with the result of "new".
export class ReplaceWithExpression implements Expression {
  constructor(
    readonly placeholder: string,
    readonly old: Expression | null,
    readonly replacement: Expression | null, // Go's new
  ) {}

  // Build converts the expression into a SQL fragment.
  //
  // Implements [dbx.Expression] interface.
  build(db: DB, params: Params): string {
    if (this.placeholder === "" || this.old === null || this.replacement === null) {
      return "0=1";
    }

    const oldResult = this.old.build(db, params);
    const newResult = this.replacement.build(db, params);

    // a function replacer, so "$" in the SQL (json paths) is literal
    return oldResult.replaceAll(this.placeholder, () => newResult);
  }
}
