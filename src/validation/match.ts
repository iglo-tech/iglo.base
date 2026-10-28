// Upstream: ozzo-validation v4.4.1 match.go
//
// The pattern is a Go regexp (src/tools/regexp).

import type { Regexp } from "@/tools/regexp/regexp";
import { NewError, type Error as ValidationError } from "@/validation/error";
import { Indirect, StringOrBytes } from "@/validation/util";
import type { Rule } from "@/validation/validation";

// ErrMatchInvalid is the error that returns in case of invalid format.
export const ErrMatchInvalid = NewError("validation_match_invalid", "must be in a valid format");

// Match returns a validation rule that checks if a value matches the
// specified regular expression. This rule should only be used for
// validating strings and byte slices, or a validation error will be
// reported. An empty value is considered valid. Use the Required rule to
// make sure a value is not empty.
export function Match(re: Regexp): MatchRule {
  return new MatchRule(re, ErrMatchInvalid);
}

// MatchRule is a validation rule that checks if a value matches the
// specified regular expression.
export class MatchRule implements Rule {
  constructor(
    private readonly re: Regexp,
    private readonly err: ValidationError,
  ) {}

  // Validate checks if the given value is valid or not.
  validate(value: unknown): Error | null {
    const [v, isNil] = Indirect(value);
    if (isNil) {
      return null;
    }

    const [isString, str, isBytes, bs] = StringOrBytes(v);
    if (isString && (str === "" || this.re.matchString(str))) {
      return null;
    } else if (isBytes && bs !== null && (bs.length === 0 || this.re.match(bs))) {
      return null;
    }
    return this.err;
  }

  // Error sets the error message for the rule.
  error(message: string): MatchRule {
    return new MatchRule(this.re, this.err.setMessage(message));
  }

  // ErrorObject sets the error struct for the rule.
  errorObject(err: ValidationError): MatchRule {
    return new MatchRule(this.re, err);
  }
}
