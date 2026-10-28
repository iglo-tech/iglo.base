// fmt's %v of fexpr's Token, Expr and ExprGroup values, which upstream's
// fexpr tests compare: a struct prints its fields in order inside {},
// separated by spaces, a slice its items inside [], and a nil interface
// <nil>.

import type { Expr, ExprGroup } from "@/search/fexpr/parser";
import type { Token } from "@/search/fexpr/scanner";

export function printToken(t: Token): string {
  const meta = t.meta === null ? "<nil>" : "[" + t.meta.map(printToken).join(" ") + "]";
  return `{${meta} ${t.type} ${t.literal}}`;
}

export function printExpr(e: Expr): string {
  return `{${printToken(e.left)} ${e.op} ${printToken(e.right)}}`;
}

export function printGroups(groups: readonly ExprGroup[] | null): string {
  return "[" + (groups ?? []).map(printGroup).join(" ") + "]";
}

function printGroup(g: ExprGroup): string {
  let item: string;
  if (Array.isArray(g.item)) {
    item = printGroups(g.item);
  } else if ("op" in g.item) {
    item = printExpr(g.item);
  } else {
    item = printGroup(g.item);
  }
  return `{${item} ${g.join}}`;
}
