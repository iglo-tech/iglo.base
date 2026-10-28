// Upstream: ozzo-validation v4.4.1 string.go

import { NewError, type Error as ValidationError } from "@/validation/error";
import { EnsureString, Indirect, IsEmpty } from "@/validation/util";
import type { Rule } from "@/validation/validation";

type stringValidator = (str: string) => boolean;

// StringRule is a rule that checks a string variable using a specified
// stringValidator.
export class StringRule implements Rule {
  constructor(
    private readonly validator: stringValidator,
    private readonly err: ValidationError,
  ) {}

  // Error sets the error message for the rule.
  error(message: string): StringRule {
    return new StringRule(this.validator, this.err.setMessage(message));
  }

  // ErrorObject sets the error struct for the rule.
  errorObject(err: ValidationError): StringRule {
    return new StringRule(this.validator, err);
  }

  // Validate checks if the given value is valid or not.
  validate(value: unknown): Error | null {
    const [v, isNil] = Indirect(value);
    if (isNil || IsEmpty(v)) {
      return null;
    }

    const [str, err] = EnsureString(v);
    if (err !== null) {
      return err;
    }

    if (this.validator(str)) {
      return null;
    }

    return this.err;
  }
}

// NewStringRule creates a new validation rule using a function that takes
// a string value and returns a bool. The rule returned will use the
// function to check if a given string or byte slice is valid or not. An
// empty value is considered to be valid. Please use the Required rule to
// make sure a value is not empty.
export function NewStringRule(validator: stringValidator, message: string): StringRule {
  return new StringRule(validator, NewError("", message));
}

// NewStringRuleWithError creates a new validation rule using a function
// that takes a string value and returns a bool. The rule returned will use
// the function to check if a given string or byte slice is valid or not.
// An empty value is considered to be valid. Please use the Required rule
// to make sure a value is not empty.
export function NewStringRuleWithError(
  validator: stringValidator,
  err: ValidationError,
): StringRule {
  return new StringRule(validator, err);
}
