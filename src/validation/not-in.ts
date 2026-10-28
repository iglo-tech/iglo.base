// Upstream: ozzo-validation v4.4.1 not_in.go
//
// Go compares with == on interface values: === here.

import { NewError, type Error as ValidationError } from "@/validation/error";
import { Indirect, IsEmpty } from "@/validation/util";
import type { Rule } from "@/validation/validation";

// ErrNotInInvalid is the error that returns when a value is in a list.
export const ErrNotInInvalid = NewError("validation_not_in_invalid", "must not be in list");

// NotIn returns a validation rule that checks if a value is absent from
// the given list of values. Note that the value being checked and the
// possible range of values must be of the same type. An empty value is
// considered valid. Use the Required rule to make sure a value is not
// empty.
export function NotIn(...values: unknown[]): NotInRule {
  return new NotInRule(values, ErrNotInInvalid);
}

// NotInRule is a validation rule that checks if a value is absent from the
// given list of values.
export class NotInRule implements Rule {
  constructor(
    private readonly elements: readonly unknown[],
    private readonly err: ValidationError,
  ) {}

  // Validate checks if the given value is valid or not.
  validate(value: unknown): Error | null {
    const [v, isNil] = Indirect(value);
    if (isNil || IsEmpty(v)) {
      return null;
    }

    for (const e of this.elements) {
      if (e === v) {
        return this.err;
      }
    }
    return null;
  }

  // Error sets the error message for the rule.
  error(message: string): NotInRule {
    return new NotInRule(this.elements, this.err.setMessage(message));
  }

  // ErrorObject sets the error struct for the rule.
  errorObject(err: ValidationError): NotInRule {
    return new NotInRule(this.elements, err);
  }
}
