// Upstream: golang.org/x/net v0.61.0 html/node.go
//
// The Go nodeStack and insertionModeStack are slices with methods. Here they are
// plain arrays, used with the stack helpers below. The Go methods pop and
// insert map onto Array.prototype.pop and splice at the call sites.

import type { Attribute } from "@/tools/html/token";

// A NodeType is the type of a Node.
export type NodeType = number;

export const ErrorNode = 0;
export const TextNode = 1;
export const DocumentNode = 2;
export const ElementNode = 3;
export const CommentNode = 4;
export const DoctypeNode = 5;
export const RawNode = 6;
export const scopeMarkerNode = 7;

export interface NodeInit {
  type?: NodeType;
  dataAtom?: string;
  data?: string;
  namespace?: string;
  attr?: Attribute[];
}

// A Node consists of a NodeType and some Data (tag name for element nodes,
// content for text) and are part of a tree of Nodes. Element nodes may also
// have a namespace and contain a slice of attributes. Data is unescaped, so
// that it looks like "a<b" rather than "a&lt;b". For element nodes, dataAtom
// is the atom for data, or "" if data is not a known tag name.
//
// An empty namespace implies a "http://www.w3.org/1999/xhtml" namespace.
// Similarly, "math" is short for "http://www.w3.org/1998/Math/MathML", and
// "svg" is short for "http://www.w3.org/2000/svg".
export class Node {
  parent: Node | null = null;
  firstChild: Node | null = null;
  lastChild: Node | null = null;
  prevSibling: Node | null = null;
  nextSibling: Node | null = null;

  type: NodeType;
  dataAtom: string;
  data: string;
  namespace: string;
  attr: Attribute[];

  constructor(init: NodeInit = {}) {
    this.type = init.type ?? ErrorNode;
    this.dataAtom = init.dataAtom ?? "";
    this.data = init.data ?? "";
    this.namespace = init.namespace ?? "";
    this.attr = init.attr ?? [];
  }

  // insertBefore inserts newChild as a child of this node, before oldChild in
  // the list of this node's children. oldChild may be null, in which case
  // newChild is appended to the end.
  insertBefore(newChild: Node, oldChild: Node | null): void {
    if (
      newChild.parent !== null ||
      newChild.prevSibling !== null ||
      newChild.nextSibling !== null
    ) {
      throw new Error("html: InsertBefore called for an attached child Node");
    }
    let prev: Node | null;
    let next: Node | null;
    if (oldChild !== null) {
      prev = oldChild.prevSibling;
      next = oldChild;
    } else {
      prev = this.lastChild;
      next = null;
    }
    if (prev !== null) {
      prev.nextSibling = newChild;
    } else {
      this.firstChild = newChild;
    }
    if (next !== null) {
      next.prevSibling = newChild;
    } else {
      this.lastChild = newChild;
    }
    newChild.parent = this;
    newChild.prevSibling = prev;
    newChild.nextSibling = next;
  }

  // appendChild adds a node c as a child of this node.
  // It will panic if c already has a parent or siblings.
  appendChild(c: Node): void {
    if (c.parent !== null || c.prevSibling !== null || c.nextSibling !== null) {
      throw new Error("html: AppendChild called for an attached child Node");
    }
    const last = this.lastChild;
    if (last !== null) {
      last.nextSibling = c;
    } else {
      this.firstChild = c;
    }
    this.lastChild = c;
    c.parent = this;
    c.prevSibling = last;
  }

  // removeChild removes a node c that is a child of this node. Completely
  // removing c from the tree. It will panic if c is not a child of this node.
  removeChild(c: Node): void {
    if (c.parent !== this) {
      throw new Error("html: RemoveChild called for a non-child Node");
    }
    if (this.firstChild === c) {
      this.firstChild = c.nextSibling;
    }
    if (c.nextSibling !== null) {
      c.nextSibling.prevSibling = c.prevSibling;
    }
    if (this.lastChild === c) {
      this.lastChild = c.prevSibling;
    }
    if (c.prevSibling !== null) {
      c.prevSibling.nextSibling = c.nextSibling;
    }
    c.parent = null;
    c.prevSibling = null;
    c.nextSibling = null;
  }

  clone(): Node {
    return new Node({
      type: this.type,
      dataAtom: this.dataAtom,
      data: this.data,
      attr: this.attr.map((a) => ({ ...a })),
    });
  }
}

export function reparentChildren(dst: Node, src: Node): void {
  for (;;) {
    const child = src.firstChild;
    if (child === null) {
      break;
    }
    src.removeChild(child);
    dst.appendChild(child);
  }
}

// stackTop returns the top element of a stack, or null if it is empty.
export function stackTop<T>(s: readonly T[]): T | null {
  return s.length > 0 ? s[s.length - 1]! : null;
}

// stackIndex returns the index of the topmost occurrence of item in s, or -1.
export function stackIndex<T>(s: readonly T[], item: T): number {
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === item) {
      return i;
    }
  }
  return -1;
}

// stackPop removes and returns the top element. Go's pop panics on an empty
// stack, and the parser turns that panic into an error, so this throws too.
export function stackPop<T>(s: T[]): T {
  if (s.length === 0) {
    throw new RangeError("index out of range [-1]");
  }
  return s.pop()!;
}

// stackAt returns s[i]. Go panics when i is out of range, so this throws too.
export function stackAt<T>(s: readonly T[], i: number): T {
  if (i < 0 || i >= s.length) {
    throw new RangeError(`index out of range [${i}] with length ${s.length}`);
  }
  return s[i]!;
}

// stackInsert inserts item at index i, shifting later elements up.
export function stackInsert<T>(s: T[], i: number, item: T): void {
  s.splice(i, 0, item);
}

// stackRemove removes the topmost occurrence of item from s, if present.
export function stackRemove<T>(s: T[], item: T): void {
  const i = stackIndex(s, item);
  if (i === -1) {
    return;
  }
  s.splice(i, 1);
}

// nodeStackContains reports whether the stack has an HTML element (namespace
// "") with the atom a.
export function nodeStackContains(s: readonly Node[], a: string): boolean {
  for (const n of s) {
    if (n.dataAtom === a && n.namespace === "") {
      return true;
    }
  }
  return false;
}
