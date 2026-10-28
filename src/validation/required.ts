// Upstream: ozzo-validation v4.4.1 required.go

import { NewError, type Error as ValidationError } from "@/validation/error";
import { Indirect, IsEmpty } from "@/validation/util";
import type { Rule } from "@/validation/validation";

// ErrRequired is the error that returns when a value is required.
export const ErrRequired = NewError("validation_required", "cannot be blank");
// ErrNilOrNotEmpty is the error that returns when a value is not nil and is empty.
export const ErrNilOrNotEmpty = NewError("validation_nil_or_not_empty_required", "cannot be blank");

// RequiredRule is a rule that checks if a value is not empty.
export class RequiredRule implements Rule {
  constructor(
    private readonly condition: boolean,
    private readonly skipNil: boolean,
    private readonly err: ValidationError | null = null,
  ) {}

  // Validate checks if the given value is valid or not.
  validate(value: unknown): Error | null {
    if (this.condition) {
      const [v, isNil] = Indirect(value);
      if ((this.skipNil && !isNil && IsEmpty(v)) || (!this.skipNil && (isNil || IsEmpty(v)))) {
        if (this.err !== null) {
          return this.err;
        }
        if (this.skipNil) {
          return ErrNilOrNotEmpty;
        }
        return ErrRequired;
      }
    }
    return null;
  }

  // When sets the condition that determines if the validation should be performed.
  when(condition: boolean): RequiredRule {
    return new RequiredRule(condition, this.skipNil, this.err);
  }

  // Error sets the error message for the rule.
  error(message: string): RequiredRule {
    const err = this.err ?? (this.skipNil ? ErrNilOrNotEmpty : ErrRequired);
    return new RequiredRule(this.condition, this.skipNil, err.setMessage(message));
  }

  // ErrorObject sets the error struct for the rule.
  errorObject(err: ValidationError): RequiredRule {
    return new RequiredRule(this.condition, this.skipNil, err);
  }
}

// Required is a validation rule that checks if a value is not empty.
// A value is considered not empty if
// - integer, float: not zero
// - bool: true
// - string, array, slice, map: len() > 0
// - interface, pointer: not nil and the referenced value is not empty
// - any other types
export const Required = new RequiredRule(true, false);

// NilOrNotEmpty checks if a value is a nil pointer or a value that is not empty.
// NilOrNotEmpty differs from Required in that it treats a nil pointer as valid.
export const NilOrNotEmpty = new RequiredRule(true, true);
