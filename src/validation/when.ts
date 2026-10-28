// Upstream: ozzo-validation v4.4.1 when.go

import { Validate, type Rule } from "@/validation/validation";

// When returns a validation rule that executes the given list of rules when
// the condition is true.
export function When(condition: boolean, ...rules: Rule[]): WhenRule {
  return new WhenRule(condition, rules, []);
}

// WhenRule is a validation rule that executes the given list of rules when
// the condition is true.
export class WhenRule implements Rule {
  constructor(
    private readonly condition: boolean,
    private readonly rules: readonly Rule[],
    private readonly elseRules: readonly Rule[],
  ) {}

  // Validate checks if the condition is true and if so, it validates the
  // value using the specified rules.
  validate(value: unknown): Error | null {
    if (this.condition) {
      return Validate(value, ...this.rules);
    }
    return Validate(value, ...this.elseRules);
  }

  // Else returns a validation rule that executes the given list of rules
  // when the condition is false.
  else(...rules: Rule[]): WhenRule {
    return new WhenRule(this.condition, this.rules, rules);
  }
}
