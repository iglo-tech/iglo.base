// Upstream: ozzo-validation v4.4.1 absent.go

import { NewError, type Error as ValidationError } from "@/validation/error";
import { Indirect, IsEmpty } from "@/validation/util";
import type { Rule } from "@/validation/validation";

// ErrNil is the error that returns when a value is not nil.
export const ErrNil = NewError("validation_nil", "must be blank");
// ErrEmpty is the error that returns when a not nil value is not empty.
export const ErrEmpty = NewError("validation_empty", "must be blank");

export class AbsentRule implements Rule {
  constructor(
    private readonly condition: boolean,
    private readonly skipNil: boolean,
    private readonly err: ValidationError | null = null,
  ) {}

  // Validate checks if the given value is valid or not.
  validate(value: unknown): Error | null {
    if (this.condition) {
      const [v, isNil] = Indirect(value);
      if ((!this.skipNil && !isNil) || (this.skipNil && !isNil && !IsEmpty(v))) {
        if (this.err !== null) {
          return this.err;
        }
        if (this.skipNil) {
          return ErrEmpty;
        }
        return ErrNil;
      }
    }
    return null;
  }

  // When sets the condition that determines if the validation should be performed.
  when(condition: boolean): AbsentRule {
    return new AbsentRule(condition, this.skipNil, this.err);
  }

  // Error sets the error message for the rule.
  error(message: string): AbsentRule {
    const err = this.err ?? (this.skipNil ? ErrEmpty : ErrNil);
    return new AbsentRule(this.condition, this.skipNil, err.setMessage(message));
  }

  // ErrorObject sets the error struct for the rule.
  errorObject(err: ValidationError): AbsentRule {
    return new AbsentRule(this.condition, this.skipNil, err);
  }
}

// Nil is a validation rule that checks if a value is nil.
// It is the opposite of NotNil rule
export const Nil = new AbsentRule(true, false);

// Empty checks if a not nil value is empty.
export const Empty = new AbsentRule(true, true);
