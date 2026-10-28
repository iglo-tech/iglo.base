// Upstream: ozzo-validation v4.4.1 each.go
//
// The iterables are arrays (slices), plain objects and Maps (maps). A nil
// (null or undefined) is a typed nil slice or map here, which has no
// elements; Go's untyped nil is not iterable.

import { Errors } from "@/validation/error";
import { isMap } from "@/validation/util";
import { Validate, type Rule } from "@/validation/validation";

// Each returns a validation rule that loops through an iterable (map, slice
// or array) and validates each value inside with the provided rules. An
// empty iterable is considered valid. Use the Required rule to make sure
// the iterable is not empty.
export function Each(...rules: Rule[]): EachRule {
  return new EachRule(rules);
}

// EachRule is a validation rule that validates elements in a map/slice/array
// using the specified list of rules.
export class EachRule implements Rule {
  constructor(private readonly rules: readonly Rule[]) {}

  // Validate loops through the given iterable and calls the Ozzo Validate()
  // method for each value.
  validate(value: unknown): Error | null {
    const errs = new Errors();

    if (value === null || value === undefined) {
      return null;
    }
    if (Array.isArray(value)) {
      for (const [i, val] of value.entries()) {
        const err = Validate(val, ...this.rules);
        if (err !== null) {
          errs.errors[String(i)] = err;
        }
      }
    } else if (value instanceof Map || isMap(value)) {
      const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
      for (const [k, val] of entries) {
        const err = Validate(val, ...this.rules);
        if (err !== null) {
          errs.errors[String(k)] = err;
        }
      }
    } else {
      return new Error("must be an iterable (map, slice or array)");
    }

    if (errs.size > 0) {
      return errs;
    }
    return null;
  }
}
