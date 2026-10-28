// Upstream: ozzo-validation v4.4.1 in.go
//
// reflect.DeepEqual is deepEqual: primitives by ===, NaN never equal, a
// number and a bigint never equal (different Go types), arrays, Uint8Arrays
// and plain objects (Go maps) element by element, other objects by
// identity.

import { NewError, type Error as ValidationError } from "@/validation/error";
import { Indirect, IsEmpty, isMap } from "@/validation/util";
import type { Rule } from "@/validation/validation";

// ErrInInvalid is the error that returns in case of an invalid value for "in" rule.
export const ErrInInvalid = NewError("validation_in_invalid", "must be a valid value");

// In returns a validation rule that checks if a value can be found in the
// given list of values. reflect.DeepEqual() will be used to determine if
// two values are equal. For more details please refer to
// https://golang.org/pkg/reflect/#DeepEqual An empty value is considered
// valid. Use the Required rule to make sure a value is not empty.
export function In(...values: unknown[]): InRule {
  return new InRule(values, ErrInInvalid);
}

// InRule is a validation rule that validates if a value can be found in the
// given list of values.
export class InRule implements Rule {
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
      if (deepEqual(e, v)) {
        return null;
      }
    }

    return this.err;
  }

  // Error sets the error message for the rule.
  error(message: string): InRule {
    return new InRule(this.elements, this.err.setMessage(message));
  }

  // ErrorObject sets the error struct for the rule.
  errorObject(err: ValidationError): InRule {
    return new InRule(this.elements, err);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  if (isMap(a) && isMap(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
    );
  }
  return false;
}
