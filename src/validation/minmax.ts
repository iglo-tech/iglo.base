// Upstream: ozzo-validation v4.4.1 minmax.go
//
// The threshold's type picks the comparison, as its reflect kind does in
// Go: an integral number or a bigint is a Go int (the value must be an
// integer, see ToInt), a Float64 is a float64 (the value any number), a
// DateTime is a time.Time (the value must be a DateTime too). A plain
// non-integral number threshold is a float64 as well. Anything else is
// "type not supported".
//
// The error's threshold param of a time threshold is a GoTime: it prints
// and marshals as Go's time.Time (String and RFC 3339 JSON).

import { DateTime } from "@/tools/types/datetime";
import { appendInt, fieldsOf } from "@/tools/types/go-time";
import { Float64, NewError, type Error as ValidationError } from "@/validation/error";
import { Indirect, IsEmpty, ToFloat, ToInt, kindOf } from "@/validation/util";
import type { Rule } from "@/validation/validation";

// ErrMinGreaterEqualThanRequired is the error that returns when a value is less than a specified threshold.
export const ErrMinGreaterEqualThanRequired = NewError(
  "validation_min_greater_equal_than_required",
  "must be no less than {{.threshold}}",
);
// ErrMaxLessEqualThanRequired is the error that returns when a value is greater than a specified threshold.
export const ErrMaxLessEqualThanRequired = NewError(
  "validation_max_less_equal_than_required",
  "must be no greater than {{.threshold}}",
);
// ErrMinGreaterThanRequired is the error that returns when a value is less than or equal to a specified threshold.
export const ErrMinGreaterThanRequired = NewError(
  "validation_min_greater_than_required",
  "must be greater than {{.threshold}}",
);
// ErrMaxLessThanRequired is the error that returns when a value is greater than or equal to a specified threshold.
export const ErrMaxLessThanRequired = NewError(
  "validation_max_less_than_required",
  "must be less than {{.threshold}}",
);

const greaterThan = 0;
const greaterEqualThan = 1;
const lessThan = 2;
const lessEqualThan = 3;

// Min returns a validation rule that checks if a value is greater or equal
// than the specified value. By calling Exclusive, the rule will check if
// the value is strictly greater than the specified value. Note that the
// value being checked and the threshold value must be of the same type.
// Only int, uint, float and time.Time types are supported. An empty value
// is considered valid. Please use the Required rule to make sure a value
// is not empty.
export function Min(min: unknown): ThresholdRule {
  return new ThresholdRule(min, greaterEqualThan, ErrMinGreaterEqualThanRequired);
}

// Max returns a validation rule that checks if a value is less or equal
// than the specified value. By calling Exclusive, the rule will check if
// the value is strictly less than the specified value. Note that the value
// being checked and the threshold value must be of the same type. Only
// int, uint, float and time.Time types are supported. An empty value is
// considered valid. Please use the Required rule to make sure a value is
// not empty.
export function Max(max: unknown): ThresholdRule {
  return new ThresholdRule(max, lessEqualThan, ErrMaxLessEqualThanRequired);
}

// ThresholdRule is a validation rule that checks if a value satisfies the
// specified threshold requirement.
export class ThresholdRule implements Rule {
  constructor(
    private readonly threshold: unknown,
    private readonly operator: number,
    private readonly err: ValidationError,
  ) {}

  // Exclusive sets the comparison to exclude the boundary value.
  exclusive(): ThresholdRule {
    if (this.operator === greaterEqualThan) {
      return new ThresholdRule(this.threshold, greaterThan, ErrMinGreaterThanRequired);
    } else if (this.operator === lessEqualThan) {
      return new ThresholdRule(this.threshold, lessThan, ErrMaxLessThanRequired);
    }
    return this;
  }

  // Validate checks if the given value is valid or not.
  validate(value: unknown): Error | null {
    const [v, isNil] = Indirect(value);
    if (isNil || IsEmpty(v)) {
      return null;
    }

    const t = this.threshold;
    let param: unknown = t;
    if (typeof t === "bigint" || (typeof t === "number" && Number.isInteger(t))) {
      const [n, err] = ToInt(v);
      if (err !== null) {
        return err;
      }
      if (this.compare(BigInt(t), n)) {
        return null;
      }
    } else if (typeof t === "number" || t instanceof Float64) {
      const [f, err] = ToFloat(v);
      if (err !== null) {
        return err;
      }
      if (this.compare(typeof t === "number" ? t : t.value, f)) {
        return null;
      }
    } else if (t instanceof DateTime) {
      if (!(v instanceof DateTime)) {
        return new Error(`cannot convert ${goTypeName(v)} to time.Time`);
      }
      if (v.isZero() || this.compareTime(t, v)) {
        return null;
      }
      param = new GoTime(t);
    } else {
      return new Error(`type not supported: ${goTypeName(t)}`);
    }

    return this.err.setParams({ threshold: param });
  }

  // Error sets the error message for the rule.
  error(message: string): ThresholdRule {
    return new ThresholdRule(this.threshold, this.operator, this.err.setMessage(message));
  }

  // ErrorObject sets the error struct for the rule.
  errorObject(err: ValidationError): ThresholdRule {
    return new ThresholdRule(this.threshold, this.operator, err);
  }

  private compare<T extends number | bigint>(threshold: T, value: T): boolean {
    switch (this.operator) {
      case greaterThan:
        return value > threshold;
      case greaterEqualThan:
        return value >= threshold;
      case lessThan:
        return value < threshold;
      default:
        return value <= threshold;
    }
  }

  private compareTime(threshold: DateTime, value: DateTime): boolean {
    switch (this.operator) {
      case greaterThan:
        return value.after(threshold);
      case greaterEqualThan:
        return value.after(threshold) || value.equal(threshold);
      case lessThan:
        return value.before(threshold);
      default:
        return value.before(threshold) || value.equal(threshold);
    }
  }
}

// the Go type name of a value (reflect.Type's String) for error messages
function goTypeName(value: unknown): string {
  if (value instanceof DateTime) {
    return "time.Time";
  }
  if (value === null || value === undefined) {
    return "<nil>";
  }
  return kindOf(value);
}

// GoTime is a DateTime printed and marshaled as Go's time.Time: String()
// is "2006-01-02 15:04:05.999999999 -0700 MST" and the JSON is RFC 3339
// with nanoseconds. The zone abbreviation is "UTC" for a zero offset; other
// offsets have no name here, so they print as Go prints an unnamed zone
// ("+0200").
export class GoTime {
  constructor(readonly t: DateTime) {}

  string(): string {
    const offset = this.t.zoneOffset();
    const name = offset === 0 ? "UTC" : zoneText(offset, "");
    return `${this.wallClock(offset, " ")} ${zoneText(offset, "")} ${name}`;
  }

  toString(): string {
    return this.string();
  }

  toJSON(): string {
    const offset = this.t.zoneOffset();
    return this.wallClock(offset, "T") + (offset === 0 ? "Z" : zoneText(offset, ":"));
  }

  marshalJSON(): string {
    return JSON.stringify(this.toJSON());
  }

  private wallClock(offset: number, sep: string): string {
    const { sec, nsec } = this.t.instant();
    const f = fieldsOf({ sec: sec + offset, nsec: 0 });
    let s =
      `${appendInt(f.year, 4)}-${appendInt(f.month, 2)}-${appendInt(f.day, 2)}${sep}` +
      `${appendInt(f.hour, 2)}:${appendInt(f.min, 2)}:${appendInt(f.sec, 2)}`;
    if (nsec !== 0) {
      s += "." + String(nsec).padStart(9, "0").replace(/0+$/, "");
    }
    return s;
  }
}

// the zone offset as Go's -0700 (sep "") or -07:00 (sep ":")
function zoneText(offset: number, sep: string): string {
  const zone = Math.trunc(offset / 60);
  const abs = Math.abs(zone);
  return `${zone < 0 ? "-" : "+"}${appendInt(Math.floor(abs / 60), 2)}${sep}${appendInt(abs % 60, 2)}`;
}
