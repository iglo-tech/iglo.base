// Upstream: core/validators/equal.go
//
// Equal compares with Go's == on the (dereferenced) values: === here, with
// null and undefined (Go's nil pointers) equal to each other.

import { NewError } from "@/validation/error";
import type { RuleFunc } from "@/validation/validation";

// Equal checks whether the validated value matches another one from the
// same type.
//
// It expects the compared values to be from the same type and works with
// booleans, numbers, strings and their pointer variants.
//
// If one of the value is pointer, the comparison is based on its
// underlying value (when possible to determine).
//
// Note that empty/zero values are also compared (this differ from other
// validation.RuleFunc).
//
// Example:
//
//	Field("passwordConfirm", form.passwordConfirm, By(Equal(form.password)))
export function Equal<T>(valueToCompare: T): RuleFunc {
  return (value) => {
    if (compareValues(value, valueToCompare)) {
      return null;
    }
    return NewError("validation_values_mismatch", "Values don't match.");
  };
}

function compareValues(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  return (a === null || a === undefined) && (b === null || b === undefined);
}
