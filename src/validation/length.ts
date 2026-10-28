// Upstream: ozzo-validation v4.4.1 length.go
//
// Length counts what Go's len counts: the UTF-8 bytes of a string, the
// elements of a slice or map. RuneLength counts a string's runes.

import { NewError, type Error as ValidationError } from "@/validation/error";
import { Indirect, IsEmpty, LengthOfValue, runeCount } from "@/validation/util";
import type { Rule } from "@/validation/validation";

// ErrLengthTooLong is the error that returns in case of too long length.
export const ErrLengthTooLong = NewError(
  "validation_length_too_long",
  "the length must be no more than {{.max}}",
);
// ErrLengthTooShort is the error that returns in case of too short length.
export const ErrLengthTooShort = NewError(
  "validation_length_too_short",
  "the length must be no less than {{.min}}",
);
// ErrLengthInvalid is the error that returns in case of an invalid length.
export const ErrLengthInvalid = NewError(
  "validation_length_invalid",
  "the length must be exactly {{.min}}",
);
// ErrLengthOutOfRange is the error that returns in case of out of range length.
export const ErrLengthOutOfRange = NewError(
  "validation_length_out_of_range",
  "the length must be between {{.min}} and {{.max}}",
);
// ErrLengthEmptyRequired is the error that returns in case of non-empty value.
export const ErrLengthEmptyRequired = NewError(
  "validation_length_empty_required",
  "the value must be empty",
);

// Length returns a validation rule that checks if a value's length is
// within the specified range. If max is 0, it means there is no upper
// bound for the length. This rule should only be used for validating
// strings, slices, maps, and arrays. An empty value is considered valid.
// Use the Required rule to make sure a value is not empty.
export function Length(min: number, max: number): LengthRule {
  return new LengthRule(buildLengthRuleError(min, max), min, max, false);
}

// RuneLength returns a validation rule that checks if a string's rune
// length is within the specified range. If max is 0, it means there is no
// upper bound for the length. This rule should only be used for validating
// strings, slices, maps, and arrays. An empty value is considered valid.
// Use the Required rule to make sure a value is not empty. If the value
// being validated is not a string, the rule works the same as Length.
export function RuneLength(min: number, max: number): LengthRule {
  return new LengthRule(buildLengthRuleError(min, max), min, max, true);
}

// LengthRule is a validation rule that checks if a value's length is
// within the specified range.
export class LengthRule implements Rule {
  constructor(
    private readonly err: ValidationError,
    private readonly min: number,
    private readonly max: number,
    private readonly rune: boolean,
  ) {}

  // Validate checks if the given value is valid or not.
  validate(value: unknown): Error | null {
    const [v, isNil] = Indirect(value);
    if (isNil || IsEmpty(v)) {
      return null;
    }

    let l: number;
    if (typeof v === "string" && this.rune) {
      l = runeCount(v);
    } else {
      const [n, err] = LengthOfValue(v);
      if (err !== null) {
        return err;
      }
      l = n;
    }

    if (
      (this.min > 0 && l < this.min) ||
      (this.max > 0 && l > this.max) ||
      (this.min === 0 && this.max === 0 && l > 0)
    ) {
      return this.err;
    }

    return null;
  }

  // Error sets the error message for the rule.
  error(message: string): LengthRule {
    return new LengthRule(this.err.setMessage(message), this.min, this.max, this.rune);
  }

  // ErrorObject sets the error struct for the rule.
  errorObject(err: ValidationError): LengthRule {
    return new LengthRule(err, this.min, this.max, this.rune);
  }
}

function buildLengthRuleError(min: number, max: number): ValidationError {
  let err: ValidationError;
  if (min === 0 && max > 0) {
    err = ErrLengthTooLong;
  } else if (min > 0 && max === 0) {
    err = ErrLengthTooShort;
  } else if (min > 0 && max > 0) {
    if (min === max) {
      err = ErrLengthInvalid;
    } else {
      err = ErrLengthOutOfRange;
    }
  } else {
    err = ErrLengthEmptyRequired;
  }

  return err.setParams({ min, max });
}
