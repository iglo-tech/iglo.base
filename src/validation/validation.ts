// Upstream: ozzo-validation v4.4.1 validation.go
//
// Rules are objects with a validate(value) method that return the
// validation error or null (Go's nil). Validatable values have a validate()
// method of their own.
//
// Go decides from the static element type of a map or slice whether to
// validate its elements. JS has no static types, so: an array is a slice
// of a Validatable type (each non-nil Validatable element is validated; Go
// would skip the elements of a []any), a plain object is a map[string]any
// (its elements are not validated, as in Go), and a Map is a map of a
// Validatable type (each Validatable value is validated).
//
// Not ported: the context-aware variants (ValidateWithContext,
// WithContext, RuleWithContext, ValidatableWithContext). Upstream calls
// ValidateStructWithContext once, with no context-aware rules or values,
// where it behaves as ValidateStruct.

import { Errors } from "@/validation/error";

// Rule represents a validation rule.
export interface Rule {
  // Validate validates a value and returns a value if validation fails.
  validate(value: unknown): Error | null;
}

// Validatable is the interface indicating the type implementing it supports
// data validation.
export interface Validatable {
  // Validate validates the data and returns an error if validation fails.
  validate(): Error | null;
}

// RuleFunc represents a validator function. You may wrap it as a Rule by
// calling By().
export type RuleFunc = (value: unknown) => Error | null;

export function isValidatable(value: unknown): value is Validatable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { validate?: unknown }).validate === "function"
  );
}

// Validate validates the given value and returns the validation error, if
// any.
//
// Validate performs validation using the following steps:
//  1. For each rule, call its `Validate()` to validate the value. Return if
//     any error is found.
//  2. If the value being validated implements `Validatable`, call the
//     value's `Validate()`. Return with the validation result.
//  3. If the value being validated is a map/slice/array, and the element
//     type implements `Validatable`, for each element call the element
//     value's `Validate()`. Return with the validation result.
export function Validate(value: unknown, ...rules: Rule[]): Error | null {
  for (const rule of rules) {
    if (rule instanceof SkipRule && rule.skip) {
      return null;
    }
    const err = rule.validate(value);
    if (err !== null) {
      return err;
    }
  }

  if (value === null || value === undefined) {
    return null;
  }

  if (isValidatable(value)) {
    return value.validate();
  }

  if (Array.isArray(value)) {
    return validateSlice(value);
  }
  if (value instanceof Map) {
    return validateMap([...value.entries()]);
  }

  return null;
}

// validateMap validates a map of validatable elements
function validateMap(entries: [unknown, unknown][]): Error | null {
  const errs = new Errors();
  for (const [key, mv] of entries) {
    if (isValidatable(mv)) {
      const err = mv.validate();
      if (err !== null) {
        errs.errors[String(key)] = err;
      }
    }
  }
  if (errs.size > 0) {
    return errs;
  }
  return null;
}

// validateSlice validates a slice/array of validatable elements
function validateSlice(list: readonly unknown[]): Error | null {
  const errs = new Errors();
  for (const [i, ev] of list.entries()) {
    if (isValidatable(ev)) {
      const err = ev.validate();
      if (err !== null) {
        errs.errors[String(i)] = err;
      }
    }
  }
  if (errs.size > 0) {
    return errs;
  }
  return null;
}

class SkipRule implements Rule {
  constructor(readonly skip: boolean) {}

  validate(): Error | null {
    return null;
  }

  // When determines if all rules following it should be skipped.
  when(condition: boolean): SkipRule {
    return new SkipRule(condition);
  }
}

// Skip is a special validation rule that indicates all rules following it
// should be skipped.
export const Skip = new SkipRule(true);

class InlineRule implements Rule {
  constructor(private readonly f: RuleFunc) {}

  validate(value: unknown): Error | null {
    return this.f(value);
  }
}

// By wraps a RuleFunc into a Rule.
export function By(f: RuleFunc): Rule {
  return new InlineRule(f);
}
