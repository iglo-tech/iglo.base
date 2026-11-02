// Helpers for the ported validation tables.
//
//   - expectValidationErrors is tests.TestValidationErrors
//     (tests/validation_errors.go): the result is null or a
//     validation.Errors with exactly the expected top-level keys.
//   - pendingTest runs a case that needs a later task as test.failing: it
//     passes while the case fails, and fails once the case passes, so that
//     the marker is removed with the task.

import { expect, test } from "bun:test";

import { errorsAs } from "@/server/error";
import { Errors } from "@/validation/error";

export function expectValidationErrors(
  result: Error | null,
  expectedErrors: readonly string[],
): void {
  // errors.As: a joined or wrapped validation.Errors counts
  const errs = result === null ? null : (errorsAs(result, Errors) ?? null);
  if (result !== null && errs === null) {
    throw new Error(
      `Failed to parse errors, expected to find validation.Errors, got ${result.name}\n${result.message}`,
    );
  }

  const keys = errs === null ? [] : Object.keys(errs.errors);
  expect(keys.toSorted()).toEqual([...expectedErrors].toSorted());
}

export interface Pending {
  task: string;
  reason: string;
}

// test(name, fn), or test.failing when the case is pending on a later task
export function caseTest(name: string, pending: Pending | undefined, fn: () => void): void {
  if (pending === undefined) {
    test(name, fn);
    return;
  }
  test.failing(`${name} (pending on ${pending.task}: ${pending.reason})`, fn);
}
