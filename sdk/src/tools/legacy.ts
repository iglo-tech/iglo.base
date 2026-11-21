// js-sdk v0.28.1 src/tools/legacy.ts
import type { LooseObject } from "@sdk/tools/loose";
import type { SendOptions } from "@sdk/tools/options";

export function normalizeLegacyOptionsArgs(
  legacyWarn: string,
  baseOptions: SendOptions,
  bodyOrOptions?: unknown,
  query?: unknown,
): SendOptions {
  const hasBodyOrOptions = bodyOrOptions !== undefined;
  const hasQuery = query !== undefined;

  if (!hasQuery && !hasBodyOrOptions) {
    return baseOptions;
  }

  if (hasQuery) {
    console.warn(legacyWarn);
    baseOptions.body = Object.assign(
      {},
      baseOptions.body as LooseObject,
      bodyOrOptions as LooseObject,
    );
    baseOptions.query = Object.assign({}, baseOptions.query, query);

    return baseOptions;
  }

  return Object.assign(baseOptions, bodyOrOptions);
}
