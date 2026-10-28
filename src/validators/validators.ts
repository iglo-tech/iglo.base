// Upstream: core/validators/validators.go
//
// Package validators implements some common custom PocketBase validators.

import { Errors, NewError } from "@/validation/error";

export const ErrUnsupportedValueType = NewError(
  "validation_unsupported_value_type",
  "Invalid or unsupported value type.",
);

// JoinValidationErrors attempts to join the provided validation.Errors
// arguments.
//
// If only one of the arguments is validation.Errors, it returns the first
// non-empty validation.Errors.
//
// If both arguments are not validation.Errors then it returns a combined
// errors.Join error (null when both are null).
export function JoinValidationErrors(errA: Error | null, errB: Error | null): Error | null {
  const okA = errA instanceof Errors;
  const okB = errB instanceof Errors;

  // merge
  if (okA && okB) {
    const result = new Errors({ ...errA.errors, ...errB.errors });
    if (result.size > 0) {
      return result;
    }
  }

  if (okA && errA.size > 0) {
    return errA;
  }

  if (okB && errB.size > 0) {
    return errB;
  }

  return joinErrors(errA, errB);
}

// errors.Join: null when every error is null, else an error whose message
// joins the messages with newlines and whose `errors` are the non-null ones
export class JoinError extends Error {
  constructor(readonly errors: Error[]) {
    super(errors.map((e) => e.message).join("\n"));
    this.name = "JoinError";
  }
}

function joinErrors(...errs: (Error | null)[]): Error | null {
  const list = errs.filter((e): e is Error => e !== null);
  if (list.length === 0) {
    return null;
  }
  return new JoinError(list);
}
