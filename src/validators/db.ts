// Upstream: core/validators/db.go

import type { Builder } from "@/db/dbx/builder";
import { HashExp } from "@/db/dbx/expression";
import { isNoRowsError } from "@/db/dbx/rows";
import { Errors, NewError } from "@/validation/error";
import type { RuleFunc } from "@/validation/validation";

// UniqueId checks whether a field string id already exists in the
// specified table.
//
// Example:
//
//	Field("relId", form.relId, By(UniqueId(app.db(), "tbl_example")))
export function UniqueId(db: Builder, tableName: string): RuleFunc {
  return (value) => {
    const v = typeof value === "string" ? value : "";
    if (v === "") {
      return null; // nothing to check
    }

    let foundId = "";
    let failed = false;
    try {
      const row = db
        .select("id")
        .from(tableName)
        .where(new HashExp({ id: v }))
        .limit(1)
        .row();
      foundId = row[0] === null || row[0] === undefined ? "" : String(row[0]);
    } catch (err) {
      failed = !isNoRowsError(err);
    }

    if (failed || foundId !== "") {
      return NewError(
        "validation_invalid_or_existing_id",
        "The model id is invalid or already exists.",
      );
    }

    return null;
  };
}

// NormalizeUniqueIndexError attempts to convert a "unique constraint
// failed" error into a validation.Errors.
//
// The provided err is returned as it is without changes if:
// - err is null
// - err is already validation.Errors
// - err is not "unique constraint failed" error
export function NormalizeUniqueIndexError(
  err: Error | null,
  tableOrAlias: string,
  fieldNames: readonly string[],
): Error | null {
  if (err === null) {
    return err;
  }

  if (err instanceof Errors) {
    return err;
  }

  let msg = err.message.toLowerCase();

  // check for unique constraint failure
  if (msg.includes("unique constraint failed")) {
    // note: extra space to unify multi-columns lookup
    msg = msg.trim().replaceAll(",", " ") + " ";

    const normalizedErrs = new Errors();

    for (const name of fieldNames) {
      // note: extra spaces to exclude table name with suffix matching the current one
      //       OR other fields starting with the current field name
      if (msg.includes((" " + tableOrAlias + "." + name + " ").toLowerCase())) {
        normalizedErrs.errors[name] = NewError("validation_not_unique", "Value must be unique");
      }
    }

    if (normalizedErrs.size > 0) {
      return normalizedErrs;
    }
  }

  return err;
}
