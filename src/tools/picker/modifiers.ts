// Upstream: tools/picker/modifiers.go
//
// Upstream's Modifiers is a package-level registry that init() functions
// fill (the excerpt modifier registers itself). Here the table is fixed
// (no extension surface): the excerpt modifier is the only one. Tests
// pass their own table to pick (upstream's tests register one in init()).

import { goQuote } from "@/fields/field";
import { newExcerptModifier } from "@/tools/picker/excerpt-modifier";
import { Tokenizer } from "@/tools/tokenizer/tokenizer";

export type ModifierFactoryFunc = (...args: string[]) => Modifier;

export interface Modifier {
  // Modify executes the modifier and returns a new modified value
  // (throws on failure).
  modify(value: unknown): unknown;
}

export const Modifiers: ReadonlyMap<string, ModifierFactoryFunc> = new Map([
  ["excerpt", (...args: string[]) => newExcerptModifier(...args)],
]);

// initModifer parses rawModifier ("name(arg1, arg2)") and creates the
// modifier it names. Throws on an unknown modifier or invalid arguments.
export function initModifer(
  rawModifier: string,
  modifiers: ReadonlyMap<string, ModifierFactoryFunc> = Modifiers,
): Modifier {
  const t = Tokenizer.fromString(rawModifier);
  t.setSeparators("(", ")", ",", " ");
  t.ignoreParenthesis(true);

  const parts = t.scanAll();

  if (parts.length === 0) {
    throw new Error(`invalid or empty modifier expression ${goQuote(rawModifier)}`);
  }

  const name = parts[0] as string;
  const args = parts.slice(1);

  const factory = modifiers.get(name);
  if (factory === undefined) {
    throw new Error(`missing or invalid modifier ${goQuote(name)}`);
  }

  return factory(...args);
}
