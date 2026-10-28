// Upstream: ozzo-validation v4.4.1 date.go
//
// time.Parse is src/tools/types/go-time.ts's parse, placed in its location
// as Go does (parsedTime). The min and max bounds are DateTimes (Go's
// time.Time).

import { DateTime } from "@/tools/types/datetime";
import { parse } from "@/tools/types/go-time";
import { parsedTime } from "@/tools/types/go-zoneinfo";
import { NewError, type Error as ValidationError } from "@/validation/error";
import { EnsureString, Indirect, IsEmpty } from "@/validation/util";
import type { Rule } from "@/validation/validation";

// ErrDateInvalid is the error that returns in case of an invalid date.
export const ErrDateInvalid = NewError("validation_date_invalid", "must be a valid date");
// ErrDateOutOfRange is the error that returns in case of an invalid date.
export const ErrDateOutOfRange = NewError(
  "validation_date_out_of_range",
  "the date is out of range",
);

// Date returns a validation rule that checks if a string value is in a
// format that can be parsed into a date. The format of the date should be
// specified as the layout parameter which accepts the same value as that
// for time.Parse. For example,
//
//	Date(time.ANSIC)
//	Date("02 Jan 06 15:04 MST")
//	Date("2006-01-02")
//
// By calling Min() and/or Max(), you can let the Date rule to check if a
// parsed date value is within the specified date range.
//
// An empty value is considered valid. Use the Required rule to make sure a
// value is not empty.
export function Date(layout: string): DateRule {
  return new DateRule(layout, new DateTime(), new DateTime(), ErrDateInvalid, ErrDateOutOfRange);
}

// DateRule is a validation rule that validates date/time string values.
export class DateRule implements Rule {
  constructor(
    private readonly layout: string,
    private readonly minTime: DateTime,
    private readonly maxTime: DateTime,
    private readonly err: ValidationError,
    private readonly rangeErr: ValidationError,
  ) {}

  // Error sets the error message that is used when the value being
  // validated is not a valid date.
  error(message: string): DateRule {
    return this.with({ err: this.err.setMessage(message) });
  }

  // ErrorObject sets the error struct that is used when the value being
  // validated is not a valid date.
  errorObject(err: ValidationError): DateRule {
    return this.with({ err });
  }

  // RangeError sets the error message that is used when the value being
  // validated is out of the specified Min/Max date range.
  rangeError(message: string): DateRule {
    return this.with({ rangeErr: this.rangeErr.setMessage(message) });
  }

  // RangeErrorObject sets the error struct that is used when the value
  // being validated is out of the specified Min/Max date range.
  rangeErrorObject(err: ValidationError): DateRule {
    return this.with({ rangeErr: err });
  }

  // Min sets the minimum date range. A zero value means skipping the
  // minimum range validation.
  min(min: DateTime): DateRule {
    return this.with({ minTime: min });
  }

  // Max sets the maximum date range. A zero value means skipping the
  // maximum range validation.
  max(max: DateTime): DateRule {
    return this.with({ maxTime: max });
  }

  // Validate checks if the given value is a valid date.
  validate(value: unknown): Error | null {
    const [v, isNil] = Indirect(value);
    if (isNil || IsEmpty(v)) {
      return null;
    }

    const [str, err] = EnsureString(v);
    if (err !== null) {
      return err;
    }

    let date: DateTime;
    try {
      const [instant, loc] = parsedTime(parse(this.layout, str));
      date = DateTime.fromInstant(instant, loc);
    } catch {
      return this.err;
    }

    if (
      (!this.minTime.isZero() && this.minTime.after(date)) ||
      (!this.maxTime.isZero() && date.after(this.maxTime))
    ) {
      return this.rangeErr;
    }

    return null;
  }

  private with(
    changes: Partial<{
      minTime: DateTime;
      maxTime: DateTime;
      err: ValidationError;
      rangeErr: ValidationError;
    }>,
  ): DateRule {
    return new DateRule(
      this.layout,
      changes.minTime ?? this.minTime,
      changes.maxTime ?? this.maxTime,
      changes.err ?? this.err,
      changes.rangeErr ?? this.rangeErr,
    );
  }
}
