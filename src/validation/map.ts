// Upstream: ozzo-validation v4.4.1 map.go
//
// A map is a plain object (string keys) or a Map. A plain object's keys
// are strings, so a non-string key is the wrong type for it. A nil (null
// or undefined) is a typed nil map, which is valid; anything else is not a
// map (an InternalError).

import { Errors, InternalError, NewError } from "@/validation/error";
import { isMap } from "@/validation/util";
import { Validate, type Rule } from "@/validation/validation";

// ErrNotMap is the error that the value being validated is not a map.
export const ErrNotMap = new Error("only a map can be validated");

// ErrKeyWrongType is the error returned in case of an incorrect key type.
export const ErrKeyWrongType = NewError("validation_key_wrong_type", "key not the correct type");

// ErrKeyMissing is the error returned in case of a missing key.
export const ErrKeyMissing = NewError("validation_key_missing", "required key is missing");

// ErrKeyUnexpected is the error returned in case of an unexpected key.
export const ErrKeyUnexpected = NewError("validation_key_unexpected", "key not expected");

// KeyRules represents a rule set associated with a map key.
export class KeyRules {
  constructor(
    readonly key: unknown,
    readonly rules: readonly Rule[],
    readonly isOptional = false,
  ) {}

  // Optional configures the rule to ignore the key if missing.
  optional(): KeyRules {
    return new KeyRules(this.key, this.rules, true);
  }
}

// Map returns a validation rule that checks the keys and values of a map.
// This rule should only be used for validating maps, or a validation error
// will be reported. Use Key() to specify map keys that need to be
// validated. Each Key() call specifies a single key which can be associated
// with multiple rules. For example,
//
//	Map(
//	  Key("Name", Required),
//	  Key("Value", Required, Length(5, 10)),
//	)
//
// A nil value is considered valid. Use the Required rule to make sure a
// map value is present.
export function Map(...keys: KeyRules[]): MapRule {
  return new MapRule(keys, false);
}

// MapRule represents a rule set associated with a map.
export class MapRule implements Rule {
  constructor(
    private readonly keys: readonly KeyRules[],
    private readonly extraKeysAllowed: boolean,
  ) {}

  // AllowExtraKeys configures the rule to ignore extra keys.
  allowExtraKeys(): MapRule {
    return new MapRule(this.keys, true);
  }

  // Validate checks if the given value is valid or not.
  validate(m: unknown): Error | null {
    if (m === null || m === undefined) {
      // treat a nil map as valid
      return null;
    }
    const isObject = isMap(m);
    if (!isObject && !(m instanceof globalThis.Map)) {
      // must be a map
      return new InternalError(ErrNotMap);
    }
    const entries: [unknown, unknown][] = isObject ? Object.entries(m) : [...m.entries()];
    const values = new globalThis.Map<unknown, unknown>(entries);

    const errs = new Errors();

    const extraKeys = new Set<unknown>();
    if (!this.extraKeysAllowed) {
      for (const [k] of entries) {
        extraKeys.add(k);
      }
    }

    for (const kr of this.keys) {
      let err: Error | null = null;
      if (isObject && typeof kr.key !== "string") {
        err = ErrKeyWrongType;
      } else if (!values.has(kr.key)) {
        if (!kr.isOptional) {
          err = ErrKeyMissing;
        }
      } else {
        err = Validate(values.get(kr.key), ...kr.rules);
      }
      if (err !== null) {
        if (err instanceof InternalError) {
          return err;
        }
        errs.errors[getErrorKeyName(kr.key)] = err;
      }
      if (!this.extraKeysAllowed) {
        extraKeys.delete(kr.key);
      }
    }

    if (!this.extraKeysAllowed) {
      for (const key of extraKeys) {
        errs.errors[getErrorKeyName(key)] = ErrKeyUnexpected;
      }
    }

    if (errs.size > 0) {
      return errs;
    }
    return null;
  }
}

// Key specifies a map key and the corresponding validation rules.
export function Key(key: unknown, ...rules: Rule[]): KeyRules {
  return new KeyRules(key, rules);
}

function getErrorKeyName(key: unknown): string {
  return String(key);
}
