// Upstream: ozzo-validation v4.4.1 struct.go
//
// Go finds a field by its pointer and names its error after the field's
// `json` tag (or the Go field name). JS has neither, so a field is given as
// its error name and its current value: Field(name, value, ...rules). The
// struct itself is not passed (Go's nil struct pointer is valid: skip the
// call). An embedded (anonymous) struct field, whose Errors Go merges into
// the parent's, is Embedded(value, ...rules).
//
// Not ported: ErrStructPointer, ErrFieldPointer and ErrFieldNotFound, the
// reflection errors for a bad struct or field pointer, which cannot happen
// here.

import { Errors, InternalError } from "@/validation/error";
import { Validate, type Rule } from "@/validation/validation";

// FieldRules represents a rule set associated with a struct field.
export class FieldRules {
  constructor(
    readonly name: string,
    readonly value: unknown,
    readonly rules: readonly Rule[],
    readonly anonymous = false,
  ) {}
}

// ValidateStruct validates a struct by checking the specified struct fields
// against the corresponding validation rules.
// For example,
//
//	ValidateStruct(
//	  Field("name", value.name, Required),
//	  Field("value", value.value, Required, Length(5, 10)),
//	)
//	// value: the length must be between 5 and 10.
//
// An error will be returned if validation fails.
export function ValidateStruct(...fields: FieldRules[]): Error | null {
  const errs = new Errors();

  for (const fr of fields) {
    const err = Validate(fr.value, ...fr.rules);
    if (err !== null) {
      if (err instanceof InternalError) {
        return err;
      }
      if (fr.anonymous && err instanceof Errors) {
        // merge errors from anonymous struct field
        for (const [name, value] of Object.entries(err.errors)) {
          errs.errors[name] = value;
        }
        continue;
      }
      errs.errors[fr.name] = err;
    }
  }

  if (errs.size > 0) {
    return errs;
  }
  return null;
}

// Field specifies a struct field (its error name and value) and the
// corresponding validation rules.
export function Field(name: string, value: unknown, ...rules: Rule[]): FieldRules {
  return new FieldRules(name, value, rules);
}

// Embedded specifies an embedded (anonymous) struct field: its Errors are
// merged into the struct's; any other error is reported under name.
export function Embedded(name: string, value: unknown, ...rules: Rule[]): FieldRules {
  return new FieldRules(name, value, rules, true);
}
