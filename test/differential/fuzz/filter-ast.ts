// The filter tree the generator builds and the shrinker cuts down. Operands
// stay printed text: the generator controls their spelling.

export type FilterNode =
  | { k: "cond"; left: string; op: string; right: string; gap: string }
  | { k: "join"; op: "&&" | "||"; items: FilterNode[]; gap: string }
  | { k: "paren"; inner: FilterNode }
  // text that is not a well-formed tree: invalid forms, comments, mutations
  | { k: "raw"; text: string };

export function printFilter(node: FilterNode): string {
  switch (node.k) {
    case "cond":
      return `${node.left}${node.gap}${node.op}${node.gap}${node.right}`;
    case "join":
      return node.items.map(printFilter).join(`${node.gap}${node.op}${node.gap}`);
    case "paren":
      return `(${printFilter(node.inner)})`;
    case "raw":
      return node.text;
  }
}
