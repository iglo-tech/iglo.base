// Upstream: golang.org/x/net v0.61.0 html/parse.go
//
// Insertion modes are module-level functions over a Parser instance, as in Go.
// The Go atom constants are the atom strings from atom.ts: `atom.Body` is
// "body", and "" is the zero atom. Go panics become thrown errors.

import { equalFold } from "@/collections/go-strings";
import { atom, lookup } from "@/tools/html/atom";
import { isSpecialElement, whitespace, whitespaceOrNUL } from "@/tools/html/const";
import { encodeUTF8 } from "@/tools/html/escape";
import { parseDoctype } from "@/tools/html/doctype";
import {
  adjustAttributeNames,
  adjustForeignAttributes,
  breakout,
  htmlIntegrationPoint,
  mathMLAttributeAdjustments,
  mathMLTextIntegrationPoint,
  svgAttributeAdjustments,
  svgTagNameAdjustments,
} from "@/tools/html/foreign";
import {
  CommentNode,
  DocumentNode,
  ElementNode,
  Node,
  TextNode,
  nodeStackContains,
  reparentChildren,
  scopeMarkerNode,
  stackIndex,
  stackInsert,
  stackAt,
  stackPop,
  stackRemove,
  stackTop,
} from "@/tools/html/node";
import {
  CommentToken,
  DoctypeToken,
  EndTagToken,
  EOF,
  ErrorToken,
  SelfClosingTagToken,
  StartTagToken,
  TextToken,
  Tokenizer,
  newTokenizer,
  type Attribute,
  type Token,
  type TokenType,
} from "@/tools/html/token";

export type InsertionMode = (p: Parser) => boolean;

// parser implements the HTML5 parsing algorithm.
export class Parser {
  // tokenizer provides the tokens for the parser.
  tokenizer: Tokenizer;
  // tok is the most recently read token.
  tok: Token = { type: ErrorToken, dataAtom: "", data: "", attr: [] };
  // Self-closing tags like <hr/> are treated as start tags, except that
  // hasSelfClosingToken is set while they are being processed.
  hasSelfClosingToken = false;
  // doc is the document root element.
  doc: Node = new Node({ type: DocumentNode });
  // The stack of open elements (section 12.2.4.2) and active formatting
  // elements (section 12.2.4.3).
  oe: Node[] = [];
  afe: Node[] = [];
  // Element pointers (section 12.2.4.4).
  head: Node | null = null;
  form: Node | null = null;
  // Other parsing state flags (section 12.2.4.5).
  scripting = false;
  framesetOK = false;
  // The stack of template insertion modes
  templateStack: InsertionMode[] = [];
  // im is the current insertion mode.
  im: InsertionMode | null = null;
  // originalIM is the insertion mode to go back to after completing a text
  // or inTableText insertion mode.
  originalIM: InsertionMode | null = null;
  // fosterParenting is whether new elements should be inserted according to
  // the foster parenting rules (section 12.2.6.1).
  fosterParenting = false;
  // quirks is whether the parser is operating in "quirks mode."
  quirks = false;
  // fragment is whether the parser is parsing an HTML fragment.
  fragment = false;
  // context is the context element when parsing an HTML fragment
  // (section 12.4).
  context: Node | null = null;

  constructor(tokenizer: Tokenizer) {
    this.tokenizer = tokenizer;
  }

  top(): Node {
    const n = stackTop(this.oe);
    if (n !== null) {
      return n;
    }
    return this.doc;
  }

  // popUntil pops the stack of open elements at the highest element whose tag
  // is in matchTags, provided there is no higher element in the scope's stop
  // tags (as defined in section 12.2.4.2). It returns whether or not there was
  // such an element. If there was not, popUntil leaves the stack unchanged.
  //
  // For example, the set of stop tags for table scope is: "html", "table". If
  // the stack was:
  // ["html", "body", "font", "table", "b", "i", "u"]
  // then popUntil(tableScope, "font") would return false, but
  // popUntil(tableScope, "i") would return true and the stack would become:
  // ["html", "body", "font", "table", "b"]
  //
  // If an element's tag is in both the stop tags and matchTags, then the stack
  // will be popped and the function returns true (provided, of course, there was
  // no higher element in the stack that was also in the stop tags). For example,
  // popUntil(tableScope, "table") returns true and leaves:
  // ["html", "body", "font"]
  popUntil(s: Scope, ...matchTags: string[]): boolean {
    const i = this.indexOfElementInScope(s, ...matchTags);
    if (i !== -1) {
      this.oe.splice(i);
      return true;
    }
    return false;
  }

  // indexOfElementInScope returns the index in p.oe of the highest element whose
  // tag is in matchTags that is in scope. If no matching element is in scope, it
  // returns -1.
  indexOfElementInScope(s: Scope, ...matchTags: string[]): number {
    for (let i = this.oe.length - 1; i >= 0; i--) {
      const n = stackAt(this.oe, i);
      const tagAtom = n.dataAtom;
      if (n.namespace === "") {
        for (const t of matchTags) {
          if (t === tagAtom) {
            return i;
          }
        }
        switch (s) {
          case Scope.defaultScope:
            // No-op.
            break;
          case Scope.listItemScope:
            if (tagAtom === atom.Ol || tagAtom === atom.Ul) {
              return -1;
            }
            break;
          case Scope.buttonScope:
            if (tagAtom === atom.Button) {
              return -1;
            }
            break;
          case Scope.tableScope:
            if (tagAtom === atom.Html || tagAtom === atom.Table || tagAtom === atom.Template) {
              return -1;
            }
            break;
          default:
            throw new Error(`html: internal error: indexOfElementInScope unknown scope: ${s}`);
        }
      }
      switch (s) {
        case Scope.defaultScope:
        case Scope.listItemScope:
        case Scope.buttonScope:
          for (const t of defaultScopeStopTags.get(n.namespace) ?? []) {
            if (t === tagAtom) {
              return -1;
            }
          }
          break;
      }
    }
    return -1;
  }

  // elementInScope is like popUntil, except that it doesn't modify the stack of
  // open elements.
  elementInScope(s: Scope, ...matchTags: string[]): boolean {
    return this.indexOfElementInScope(s, ...matchTags) !== -1;
  }

  // clearStackToContext pops elements off the stack of open elements until a
  // scope-defined element is found.
  clearStackToContext(s: Scope): void {
    for (let i = this.oe.length - 1; i >= 0; i--) {
      const tagAtom = stackAt(this.oe, i).dataAtom;
      switch (s) {
        case Scope.tableScope:
          if (tagAtom === atom.Html || tagAtom === atom.Table || tagAtom === atom.Template) {
            this.oe.splice(i + 1);
            return;
          }
          break;
        case Scope.tableRowScope:
          if (tagAtom === atom.Html || tagAtom === atom.Tr || tagAtom === atom.Template) {
            this.oe.splice(i + 1);
            return;
          }
          break;
        case Scope.tableBodyScope:
          if (
            tagAtom === atom.Html ||
            tagAtom === atom.Tbody ||
            tagAtom === atom.Tfoot ||
            tagAtom === atom.Thead ||
            tagAtom === atom.Template
          ) {
            this.oe.splice(i + 1);
            return;
          }
          break;
        default:
          throw new Error(`html: internal error: clearStackToContext unknown scope: ${s}`);
      }
    }
  }

  // parseGenericRawTextElement implements the generic raw text element parsing
  // algorithm defined in 12.2.6.2.
  // https://html.spec.whatwg.org/multipage/parsing.html#parsing-elements-that-contain-only-text
  // TODO: Since both RAWTEXT and RCDATA states are treated as tokenizer's part
  // officially, need to make tokenizer consider both states.
  parseGenericRawTextElement(): void {
    this.addElement();
    this.originalIM = this.im;
    this.im = textIM;
  }

  // generateImpliedEndTags pops nodes off the stack of open elements as long as
  // the top node has a tag name of dd, dt, li, optgroup, option, p, rb, rp, rt or rtc.
  // If exceptions are specified, nodes with that name will not be popped off.
  generateImpliedEndTags(...exceptions: string[]): void {
    let i: number;
    loop: for (i = this.oe.length - 1; i >= 0; i--) {
      const n = stackAt(this.oe, i);
      if (n.type !== ElementNode) {
        break;
      }
      switch (n.dataAtom) {
        case atom.Dd:
        case atom.Dt:
        case atom.Li:
        case atom.Optgroup:
        case atom.Option:
        case atom.P:
        case atom.Rb:
        case atom.Rp:
        case atom.Rt:
        case atom.Rtc:
          for (const except of exceptions) {
            if (n.data === except) {
              break loop;
            }
          }
          continue;
      }
      break;
    }

    this.oe.splice(i! + 1);
  }

  // addChild adds a child node n to the top element, and pushes n onto the stack
  // of open elements if it is an element node.
  addChild(n: Node): void {
    if (this.shouldFosterParent()) {
      this.fosterParent(n);
    } else {
      this.top().appendChild(n);
    }

    if (n.type === ElementNode) {
      this.insertOpenElement(n);
    }
  }

  insertOpenElement(n: Node): void {
    this.oe.push(n);
    if (this.oe.length > 512) {
      throw new Error("html: open stack of elements exceeds 512 nodes");
    }
  }

  // shouldFosterParent returns whether the next node to be added should be
  // foster parented.
  shouldFosterParent(): boolean {
    if (this.fosterParenting) {
      switch (this.top().dataAtom) {
        case atom.Table:
        case atom.Tbody:
        case atom.Tfoot:
        case atom.Thead:
        case atom.Tr:
          return true;
      }
    }
    return false;
  }

  // fosterParent adds a child node according to the foster parenting rules.
  // Section 12.2.6.1, "foster parenting".
  fosterParent(n: Node): void {
    let table: Node | null = null;
    let parent: Node | null = null;
    let prev: Node | null = null;
    let template: Node | null = null;
    let i: number;
    for (i = this.oe.length - 1; i >= 0; i--) {
      if (stackAt(this.oe, i).dataAtom === atom.Table) {
        table = stackAt(this.oe, i);
        break;
      }
    }

    let j: number;
    for (j = this.oe.length - 1; j >= 0; j--) {
      if (stackAt(this.oe, j).dataAtom === atom.Template) {
        template = stackAt(this.oe, j);
        break;
      }
    }

    if (template !== null && (table === null || j > i)) {
      template.appendChild(n);
      return;
    }

    if (table === null) {
      // The foster parent is the html element.
      parent = stackAt(this.oe, 0);
    } else {
      parent = table.parent;
    }
    if (parent === null) {
      parent = stackAt(this.oe, i - 1);
    }

    if (table !== null) {
      prev = table.prevSibling;
    } else {
      prev = parent.lastChild;
    }
    if (prev !== null && prev.type === TextNode && n.type === TextNode) {
      prev.data += n.data;
      return;
    }

    parent.insertBefore(n, table);
  }

  // addText adds text to the preceding node if it is a text node, or else it
  // calls addChild with a new text node.
  addText(text: string): void {
    if (text === "") {
      return;
    }

    if (this.shouldFosterParent()) {
      this.fosterParent(new Node({ type: TextNode, data: text }));
      return;
    }

    const t = this.top();
    const n = t.lastChild;
    if (n !== null && n.type === TextNode) {
      n.data += text;
      return;
    }
    this.addChild(new Node({ type: TextNode, data: text }));
  }

  // addElement adds a child element based on the current token.
  addElement(): void {
    this.addChild(
      new Node({
        type: ElementNode,
        dataAtom: this.tok.dataAtom,
        data: this.tok.data,
        attr: this.tok.attr,
      }),
    );
  }

  // Section 12.2.4.3.
  addFormattingElement(): void {
    const tagAtom = this.tok.dataAtom;
    const attr = this.tok.attr;
    this.addElement();

    // In order to optimize the search, we need the attributes to be sorted, so we
    // can just use slices.Equal.
    attr.sort(attrCompare);

    // Implement the Noah's Ark clause, but with three per family instead of two.
    let identicalElements = 0;
    findIdenticalElements: for (let i = this.afe.length - 1; i >= 0; i--) {
      const n = stackAt(this.afe, i);
      if (n.type === scopeMarkerNode) {
        break;
      }
      if (n.type !== ElementNode) {
        continue;
      }
      if (n.namespace !== "") {
        continue;
      }
      if (n.dataAtom !== tagAtom) {
        continue;
      }
      if (!attrsEqual(n.attr, attr)) {
        continue findIdenticalElements;
      }

      identicalElements++;
      if (identicalElements >= 3) {
        stackRemove(this.afe, n);
      }
    }

    // Sort the attributes to optimize future identical-element searches.
    const top = this.top();
    top.attr.sort(attrCompare);

    this.afe.push(top);
  }

  // Section 12.2.4.3.
  clearActiveFormattingElements(): void {
    for (;;) {
      const n = stackPop(this.afe);
      if (this.afe.length === 0 || n.type === scopeMarkerNode) {
        return;
      }
    }
  }

  // Section 12.2.4.3.
  reconstructActiveFormattingElements(): void {
    let n = stackTop(this.afe);
    if (n === null) {
      return;
    }
    if (n.type === scopeMarkerNode || stackIndex(this.oe, n) !== -1) {
      return;
    }
    let i = this.afe.length - 1;
    while (n.type !== scopeMarkerNode && stackIndex(this.oe, n) === -1) {
      if (i === 0) {
        i = -1;
        break;
      }
      i--;
      n = stackAt(this.afe, i);
    }
    for (;;) {
      i++;
      const clone = stackAt(this.afe, i).clone();
      this.addChild(clone);
      this.afe[i] = clone;
      if (i === this.afe.length - 1) {
        break;
      }
    }
  }

  // Section 12.2.5.
  acknowledgeSelfClosingTag(): void {
    this.hasSelfClosingToken = false;
  }

  // setOriginalIM sets the insertion mode to return to after completing a text or
  // inTableText insertion mode.
  // Section 12.2.4.1, "using the rules for".
  setOriginalIM(): void {
    if (this.originalIM !== null) {
      throw new Error("html: bad parser state: originalIM was set twice");
    }
    this.originalIM = this.im;
  }

  // Section 12.2.4.1, "reset the insertion mode".
  resetInsertionMode(): void {
    for (let i = this.oe.length - 1; i >= 0; i--) {
      let n = stackAt(this.oe, i);
      const last = i === 0;
      if (last && this.context !== null) {
        n = this.context;
      }

      switch (n.dataAtom) {
        case atom.Td:
        case atom.Th:
          // TODO: remove this divergence from the HTML5 spec.
          //
          // See https://bugs.chromium.org/p/chromium/issues/detail?id=829668
          this.im = inCellIM;
          break;
        case atom.Tr:
          this.im = inRowIM;
          break;
        case atom.Tbody:
        case atom.Thead:
        case atom.Tfoot:
          this.im = inTableBodyIM;
          break;
        case atom.Caption:
          this.im = inCaptionIM;
          break;
        case atom.Colgroup:
          this.im = inColumnGroupIM;
          break;
        case atom.Table:
          this.im = inTableIM;
          break;
        case atom.Template:
          // TODO: remove this divergence from the HTML5 spec.
          if (n.namespace !== "") {
            continue;
          }
          this.im = stackTop(this.templateStack);
          break;
        case atom.Head:
          // TODO: remove this divergence from the HTML5 spec.
          //
          // See https://bugs.chromium.org/p/chromium/issues/detail?id=829668
          this.im = inHeadIM;
          break;
        case atom.Body:
          this.im = inBodyIM;
          break;
        case atom.Frameset:
          this.im = inFramesetIM;
          break;
        case atom.Html:
          if (this.head === null) {
            this.im = beforeHeadIM;
          } else {
            this.im = afterHeadIM;
          }
          break;
        default:
          if (last) {
            this.im = inBodyIM;
            return;
          }
          continue;
      }
      return;
    }
  }

  // The adoption agency algorithm, described at
  // https://html.spec.whatwg.org/multipage/syntax.html#adoptionAgency
  //
  // TODO: this is a fairly literal line-by-line translation of that algorithm.
  // Once the code successfully parses the comprehensive test suite, we should
  // refactor this code to be more idiomatic.
  inBodyEndTagFormatting(tagAtom: string, tagName: string): void {
    // Steps 1-2
    const current = stackTop(this.oe)!;
    if (current.data === tagName && stackIndex(this.afe, current) === -1) {
      stackPop(this.oe);
      return;
    }

    // Steps 3-5. The outer loop.
    for (let i = 0; i < 8; i++) {
      // Step 6. Find the formatting element.
      let formattingElement: Node | null = null;
      for (let j = this.afe.length - 1; j >= 0; j--) {
        if (stackAt(this.afe, j).type === scopeMarkerNode) {
          break;
        }
        if (stackAt(this.afe, j).dataAtom === tagAtom) {
          formattingElement = stackAt(this.afe, j);
          break;
        }
      }
      if (formattingElement === null) {
        this.inBodyEndTagOther(tagAtom, tagName);
        return;
      }

      // Step 7. Ignore the tag if formatting element is not in the stack of open elements.
      const feIndex = stackIndex(this.oe, formattingElement);
      if (feIndex === -1) {
        stackRemove(this.afe, formattingElement);
        return;
      }
      // Step 8. Ignore the tag if formatting element is not in the scope.
      if (!this.elementInScope(Scope.defaultScope, tagAtom)) {
        // Ignore the tag.
        return;
      }

      // Step 9. This step is omitted because it's just a parse error but no need to return.

      // Steps 10-11. Find the furthest block.
      let furthestBlock: Node | null = null;
      for (const e of this.oe.slice(feIndex)) {
        if (isSpecialElement(e)) {
          furthestBlock = e;
          break;
        }
      }
      if (furthestBlock === null) {
        let e = stackPop(this.oe);
        while (e !== formattingElement) {
          e = stackPop(this.oe);
        }
        stackRemove(this.afe, e);
        return;
      }

      // Steps 12-13. Find the common ancestor and bookmark node.
      const commonAncestor = stackAt(this.oe, feIndex - 1);
      let bookmark = stackIndex(this.afe, formattingElement);

      // Step 14. The inner loop. Find the lastNode to reparent.
      let lastNode: Node = furthestBlock;
      let node: Node = furthestBlock;
      let x = stackIndex(this.oe, node);
      // Step 14.1.
      let j = 0;
      for (;;) {
        // Step 14.2.
        j++;
        // Step. 14.3.
        x--;
        node = stackAt(this.oe, x);
        // Step 14.4. Go to the next step if node is formatting element.
        if (node === formattingElement) {
          break;
        }
        // Step 14.5. Remove node from the list of active formatting elements if
        // inner loop counter is greater than three and node is in the list of
        // active formatting elements.
        const ni = stackIndex(this.afe, node);
        if (j > 3 && ni > -1) {
          stackRemove(this.afe, node);
          // If any element of the list of active formatting elements is removed,
          // we need to take care whether bookmark should be decremented or not.
          // This is because the value of bookmark may exceed the size of the
          // list by removing elements from the list.
          if (ni <= bookmark) {
            bookmark--;
          }
          continue;
        }
        // Step 14.6. Continue the next inner loop if node is not in the list of
        // active formatting elements.
        if (stackIndex(this.afe, node) === -1) {
          stackRemove(this.oe, node);
          continue;
        }
        // Step 14.7.
        const clone = node.clone();
        this.afe[stackIndex(this.afe, node)] = clone;
        this.oe[stackIndex(this.oe, node)] = clone;
        node = clone;
        // Step 14.8.
        if (lastNode === furthestBlock) {
          bookmark = stackIndex(this.afe, node) + 1;
        }
        // Step 14.9.
        if (lastNode.parent !== null) {
          lastNode.parent.removeChild(lastNode);
        }
        node.appendChild(lastNode);
        // Step 14.10.
        lastNode = node;
      }

      // Step 15. Reparent lastNode to the common ancestor,
      // or for misnested table nodes, to the foster parent.
      if (lastNode.parent !== null) {
        lastNode.parent.removeChild(lastNode);
      }
      switch (commonAncestor.dataAtom) {
        case atom.Table:
        case atom.Tbody:
        case atom.Tfoot:
        case atom.Thead:
        case atom.Tr:
          this.fosterParent(lastNode);
          break;
        default:
          commonAncestor.appendChild(lastNode);
      }

      // Steps 16-18. Reparent nodes from the furthest block's children
      // to a clone of the formatting element.
      const clone = formattingElement.clone();
      reparentChildren(clone, furthestBlock);
      furthestBlock.appendChild(clone);

      // Step 19. Fix up the list of active formatting elements.
      const oldLoc = stackIndex(this.afe, formattingElement);
      if (oldLoc !== -1 && oldLoc < bookmark) {
        // Move the bookmark with the rest of the list.
        bookmark--;
      }
      stackRemove(this.afe, formattingElement);
      stackInsert(this.afe, bookmark, clone);

      // Step 20. Fix up the stack of open elements.
      stackRemove(this.oe, formattingElement);
      stackInsert(this.oe, stackIndex(this.oe, furthestBlock) + 1, clone);
    }
  }

  // inBodyEndTagOther performs the "any other end tag" algorithm for inBodyIM.
  inBodyEndTagOther(tagAtom: string, tagName: string): void {
    for (let i = this.oe.length - 1; i >= 0; i--) {
      // Two element nodes have the same tag if they have the same Data (a
      // string-typed field). As an optimization, for common HTML tags, each
      // Data string is assigned a unique, non-zero DataAtom (a uint32-typed
      // field), since integer comparison is faster than string comparison.
      // Uncommon (custom) tags get a zero DataAtom.
      //
      // The if condition here is equivalent to (stackAt(p.oe, i).Data == tagName).
      const node = stackAt(this.oe, i);
      if (
        node.namespace === "" &&
        node.dataAtom === tagAtom &&
        (tagAtom !== "" || node.data === tagName)
      ) {
        this.oe.splice(i);
        break;
      }
      if (isSpecialElement(node)) {
        break;
      }
    }
  }

  // Section 12.2.4.2.
  adjustedCurrentNode(): Node {
    if (this.oe.length === 1 && this.fragment && this.context !== null) {
      return this.context;
    }
    return stackTop(this.oe)!;
  }

  // Section 12.2.6.
  inForeignContent(): boolean {
    if (this.oe.length === 0) {
      return false;
    }
    const n = this.adjustedCurrentNode();
    if (n.namespace === "") {
      return false;
    }
    if (mathMLTextIntegrationPoint(n)) {
      if (
        this.tok.type === StartTagToken &&
        this.tok.dataAtom !== atom.Mglyph &&
        this.tok.dataAtom !== atom.Malignmark
      ) {
        return false;
      }
      if (this.tok.type === TextToken) {
        return false;
      }
    }
    if (
      n.namespace === "math" &&
      n.dataAtom === atom.AnnotationXml &&
      this.tok.type === StartTagToken &&
      this.tok.dataAtom === atom.Svg
    ) {
      return false;
    }
    if (
      htmlIntegrationPoint(n) &&
      (this.tok.type === StartTagToken || this.tok.type === TextToken)
    ) {
      return false;
    }
    if (this.tok.type === ErrorToken) {
      return false;
    }
    return true;
  }

  // parseImpliedToken parses a token as though it had appeared in the parser's
  // input.
  parseImpliedToken(t: TokenType, dataAtom: string, data: string): void {
    const realToken = this.tok;
    const selfClosing = this.hasSelfClosingToken;
    this.tok = { type: t, dataAtom, data, attr: [] };
    this.hasSelfClosingToken = false;
    this.parseCurrentToken();
    this.tok = realToken;
    this.hasSelfClosingToken = selfClosing;
  }

  // parseCurrentToken runs the current token through the parsing routines
  // until it is consumed.
  parseCurrentToken(): void {
    if (this.tok.type === SelfClosingTagToken) {
      this.hasSelfClosingToken = true;
      this.tok.type = StartTagToken;
    }

    let consumed = false;
    while (!consumed) {
      if (this.inForeignContent()) {
        consumed = parseForeignContent(this);
      } else {
        consumed = this.im!(this);
      }
    }

    if (this.hasSelfClosingToken) {
      // This is a parse error, but ignore it.
      this.hasSelfClosingToken = false;
    }
  }

  // parse iterates until EOF. Any other tokenizer error causes an early throw.
  // A panic in Go is recovered by parse and returned as an error; here the
  // thrown error propagates to the caller of parse.
  parse(): void {
    // Iterate until EOF. Any other error will cause an early return.
    let err: Error | null = null;
    while (err !== EOF) {
      // CDATA sections are allowed only in foreign content.
      const n = stackTop(this.oe);
      this.tokenizer.setAllowCDATA(n !== null && n.namespace !== "");
      // Read and parse the next token.
      this.tokenizer.next();
      this.tok = this.tokenizer.token();
      if (this.tok.type === ErrorToken) {
        err = this.tokenizer.error();
        if (err !== null && err !== EOF) {
          throw err;
        }
      }
      this.parseCurrentToken();
    }
  }
}

// Scope is the kind of scope popUntil and elementInScope search (section
// 12.2.4.2).
export enum Scope {
  defaultScope,
  listItemScope,
  buttonScope,
  tableScope,
  tableRowScope,
  tableBodyScope,
}

// Stop tags for use in popUntil. These come from section 12.2.4.2.
const defaultScopeStopTags = new Map<string, readonly string[]>([
  [
    "",
    [
      atom.Applet,
      atom.Caption,
      atom.Html,
      atom.Table,
      atom.Td,
      atom.Th,
      atom.Marquee,
      atom.Object,
      atom.Template,
      atom.Select,
    ],
  ],
  ["math", [atom.AnnotationXml, atom.Mi, atom.Mn, atom.Mo, atom.Ms, atom.Mtext]],
  ["svg", [atom.Desc, atom.ForeignObject, atom.Title]],
]);

// attrCompare orders attributes by namespace, then key, then value. It compares
// strings by code point, which orders them the way Go's byte-wise comparison does.
function attrCompare(a: Attribute, b: Attribute): number {
  return (
    compareStrings(a.namespace, b.namespace) ||
    compareStrings(a.key, b.key) ||
    compareStrings(a.val, b.val)
  );
}

// compareStrings is cmp.Compare for strings: byte-wise UTF-8 order, which is
// code point order.
function compareStrings(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(j)!;
    if (ca !== cb) {
      return ca < cb ? -1 : 1;
    }
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i < a.length) {
    return 1;
  }
  if (j < b.length) {
    return -1;
  }
  return 0;
}

// attrsEqual is slices.Equal for attribute slices.
function attrsEqual(a: Attribute[], b: Attribute[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.namespace !== y.namespace || x.key !== y.key || x.val !== y.val) {
      return false;
    }
  }
  return true;
}

// trimLeft is strings.TrimLeft with an ASCII cutset.
function trimLeft(s: string, cutset: string): string {
  let i = 0;
  while (i < s.length && cutset.includes(s[i]!)) {
    i++;
  }
  return s.slice(i);
}

// copyAttributes copies attributes of src not found on dst to dst.
function copyAttributes(dst: Node, src: Token): void {
  if (src.attr.length === 0) {
    return;
  }
  const attr = new Map<string, string>();
  for (const t of dst.attr) {
    attr.set(t.key, t.val);
  }
  for (const t of src.attr) {
    if (!attr.has(t.key)) {
      dst.attr.push({ ...t });
      attr.set(t.key, t.val);
    }
  }
}

// Section 12.2.6.4.7.
function inBodyIM(p: Parser): boolean {
  switch (p.tok.type) {
    case TextToken: {
      let d = p.tok.data;
      const n = stackTop(p.oe)!;
      switch (n.dataAtom) {
        case atom.Pre:
        case atom.Listing:
          if (n.firstChild === null) {
            // Ignore a newline at the start of a <pre> block.
            if (d !== "" && d[0] === "\r") {
              d = d.slice(1);
            }
            if (d !== "" && d[0] === "\n") {
              d = d.slice(1);
            }
          }
          break;
      }
      d = d.replaceAll("\x00", "");
      if (d === "") {
        return true;
      }
      p.reconstructActiveFormattingElements();
      p.addText(d);
      if (p.framesetOK && trimLeft(d, whitespace) !== "") {
        // There were non-whitespace characters inserted.
        p.framesetOK = false;
      }
      break;
    }
    case StartTagToken:
      switch (p.tok.dataAtom) {
        case atom.Html:
          if (nodeStackContains(p.oe, atom.Template)) {
            return true;
          }
          copyAttributes(stackAt(p.oe, 0), p.tok);
          break;
        case atom.Base:
        case atom.Basefont:
        case atom.Bgsound:
        case atom.Link:
        case atom.Meta:
        case atom.Noframes:
        case atom.Script:
        case atom.Style:
        case atom.Template:
        case atom.Title:
          return inHeadIM(p);
        case atom.Body:
          if (nodeStackContains(p.oe, atom.Template)) {
            return true;
          }
          if (p.oe.length >= 2) {
            const body = stackAt(p.oe, 1);
            if (body.type === ElementNode && body.dataAtom === atom.Body) {
              p.framesetOK = false;
              copyAttributes(body, p.tok);
            }
          }
          break;
        case atom.Frameset: {
          if (!p.framesetOK || p.oe.length < 2 || stackAt(p.oe, 1).dataAtom !== atom.Body) {
            // Ignore the token.
            return true;
          }
          const body = stackAt(p.oe, 1);
          if (body.parent !== null) {
            body.parent.removeChild(body);
          }
          p.oe.splice(1);
          p.addElement();
          p.im = inFramesetIM;
          return true;
        }
        case atom.Address:
        case atom.Article:
        case atom.Aside:
        case atom.Blockquote:
        case atom.Center:
        case atom.Details:
        case atom.Dialog:
        case atom.Dir:
        case atom.Div:
        case atom.Dl:
        case atom.Fieldset:
        case atom.Figcaption:
        case atom.Figure:
        case atom.Footer:
        case atom.Header:
        case atom.Hgroup:
        case atom.Main:
        case atom.Menu:
        case atom.Nav:
        case atom.Ol:
        case atom.P:
        case atom.Search:
        case atom.Section:
        case atom.Summary:
        case atom.Ul:
          p.popUntil(Scope.buttonScope, atom.P);
          p.addElement();
          break;
        case atom.H1:
        case atom.H2:
        case atom.H3:
        case atom.H4:
        case atom.H5:
        case atom.H6: {
          p.popUntil(Scope.buttonScope, atom.P);
          const n = p.top();
          switch (n.dataAtom) {
            case atom.H1:
            case atom.H2:
            case atom.H3:
            case atom.H4:
            case atom.H5:
            case atom.H6:
              stackPop(p.oe);
              break;
          }
          p.addElement();
          break;
        }
        case atom.Pre:
        case atom.Listing:
          p.popUntil(Scope.buttonScope, atom.P);
          p.addElement();
          // The newline, if any, will be dealt with by the TextToken case.
          p.framesetOK = false;
          break;
        case atom.Form:
          if (p.form !== null && !nodeStackContains(p.oe, atom.Template)) {
            // Ignore the token
            return true;
          }
          p.popUntil(Scope.buttonScope, atom.P);
          p.addElement();
          if (!nodeStackContains(p.oe, atom.Template)) {
            p.form = p.top();
          }
          break;
        case atom.Li:
          p.framesetOK = false;
          for (let i = p.oe.length - 1; i >= 0; i--) {
            const node = stackAt(p.oe, i);
            if (node.dataAtom === atom.Li) {
              p.oe.splice(i);
              break;
            }
            if (
              node.dataAtom === atom.Address ||
              node.dataAtom === atom.Div ||
              node.dataAtom === atom.P
            ) {
              continue;
            }
            if (!isSpecialElement(node)) {
              continue;
            }
            break;
          }
          p.popUntil(Scope.buttonScope, atom.P);
          p.addElement();
          break;
        case atom.Dd:
        case atom.Dt:
          p.framesetOK = false;
          for (let i = p.oe.length - 1; i >= 0; i--) {
            const node = stackAt(p.oe, i);
            if (node.dataAtom === atom.Dd || node.dataAtom === atom.Dt) {
              p.oe.splice(i);
              break;
            }
            if (
              node.dataAtom === atom.Address ||
              node.dataAtom === atom.Div ||
              node.dataAtom === atom.P
            ) {
              continue;
            }
            if (!isSpecialElement(node)) {
              continue;
            }
            break;
          }
          p.popUntil(Scope.buttonScope, atom.P);
          p.addElement();
          break;
        case atom.Plaintext:
          p.popUntil(Scope.buttonScope, atom.P);
          p.addElement();
          break;
        case atom.Button:
          if (p.elementInScope(Scope.defaultScope, atom.Button)) {
            p.generateImpliedEndTags();
            p.popUntil(Scope.defaultScope, atom.Button);
          }
          p.reconstructActiveFormattingElements();
          p.addElement();
          p.framesetOK = false;
          break;
        case atom.A:
          for (
            let i = p.afe.length - 1;
            i >= 0 && stackAt(p.afe, i).type !== scopeMarkerNode;
            i--
          ) {
            const n = stackAt(p.afe, i);
            if (n.type === ElementNode && n.dataAtom === atom.A) {
              p.inBodyEndTagFormatting(atom.A, "a");
              stackRemove(p.oe, n);
              stackRemove(p.afe, n);
              break;
            }
          }
          p.reconstructActiveFormattingElements();
          p.addFormattingElement();
          break;
        case atom.B:
        case atom.Big:
        case atom.Code:
        case atom.Em:
        case atom.Font:
        case atom.I:
        case atom.S:
        case atom.Small:
        case atom.Strike:
        case atom.Strong:
        case atom.Tt:
        case atom.U:
          p.reconstructActiveFormattingElements();
          p.addFormattingElement();
          break;
        case atom.Nobr:
          p.reconstructActiveFormattingElements();
          if (p.elementInScope(Scope.defaultScope, atom.Nobr)) {
            p.inBodyEndTagFormatting(atom.Nobr, "nobr");
            p.reconstructActiveFormattingElements();
          }
          p.addFormattingElement();
          break;
        case atom.Applet:
        case atom.Marquee:
        case atom.Object:
          p.reconstructActiveFormattingElements();
          p.addElement();
          p.afe.push(new Node({ type: scopeMarkerNode }));
          p.framesetOK = false;
          break;
        case atom.Table:
          if (!p.quirks) {
            p.popUntil(Scope.buttonScope, atom.P);
          }
          p.addElement();
          p.framesetOK = false;
          p.im = inTableIM;
          return true;
        case atom.Area:
        case atom.Br:
        case atom.Embed:
        case atom.Img:
        case atom.Keygen:
        case atom.Wbr:
          p.reconstructActiveFormattingElements();
          p.addElement();
          stackPop(p.oe);
          p.acknowledgeSelfClosingTag();
          p.framesetOK = false;
          break;
        case atom.Input:
          if (p.fragment && p.context!.dataAtom === atom.Select) {
            // Ignore the token.
            return true;
          }
          p.popUntil(Scope.defaultScope, atom.Select);
          p.reconstructActiveFormattingElements();
          p.addElement();
          stackPop(p.oe);
          p.acknowledgeSelfClosingTag();
          if (p.tok.dataAtom === atom.Input) {
            for (const t of p.tok.attr) {
              if (t.key === "type") {
                if (equalFold(t.val, "hidden")) {
                  // Skip setting framesetOK = false
                  return true;
                }
              }
            }
          }
          p.framesetOK = false;
          break;
        case atom.Param:
        case atom.Source:
        case atom.Track:
          p.addElement();
          stackPop(p.oe);
          p.acknowledgeSelfClosingTag();
          break;
        case atom.Hr:
          if (p.elementInScope(Scope.buttonScope, atom.P)) {
            p.generateImpliedEndTags("p");
            p.popUntil(Scope.defaultScope, atom.P);
          }
          if (p.elementInScope(Scope.defaultScope, atom.Select)) {
            p.generateImpliedEndTags();
          }
          p.addElement();
          stackPop(p.oe);
          p.acknowledgeSelfClosingTag();
          p.framesetOK = false;
          break;
        case atom.Image:
          p.tok.dataAtom = atom.Img;
          p.tok.data = atom.Img;
          return false;
        case atom.Textarea:
          p.addElement();
          p.setOriginalIM();
          p.framesetOK = false;
          p.im = textIM;
          break;
        case atom.Xmp:
          p.popUntil(Scope.buttonScope, atom.P);
          p.reconstructActiveFormattingElements();
          p.framesetOK = false;
          p.parseGenericRawTextElement();
          break;
        case atom.Iframe:
          p.framesetOK = false;
          p.parseGenericRawTextElement();
          break;
        case atom.Noembed:
          p.parseGenericRawTextElement();
          break;
        case atom.Noscript:
          if (p.scripting) {
            p.parseGenericRawTextElement();
            return true;
          }
          p.reconstructActiveFormattingElements();
          p.addElement();
          // Don't let the tokenizer go into raw text mode when scripting is disabled.
          p.tokenizer.nextIsNotRawText();
          break;
        case atom.Select:
          if (p.fragment && p.context!.dataAtom === atom.Select) {
            // Ignore the token.
            return true;
          } else if (p.popUntil(Scope.defaultScope, atom.Select)) {
            return true;
          }
          p.reconstructActiveFormattingElements();
          p.addElement();
          p.framesetOK = false;
          return true;
        case atom.Option:
          if (p.elementInScope(Scope.defaultScope, atom.Select)) {
            p.generateImpliedEndTags("optgroup");
            // If oe has option element in scope, parse error?
          } else if (p.top().dataAtom === atom.Option) {
            stackPop(p.oe);
          }
          p.reconstructActiveFormattingElements();
          p.addElement();
          break;
        case atom.Optgroup:
          if (p.elementInScope(Scope.defaultScope, atom.Select)) {
            p.generateImpliedEndTags();
            // If oe has option or optgroup element in scope, parse error?
          } else if (p.top().dataAtom === atom.Option) {
            stackPop(p.oe);
          }
          p.reconstructActiveFormattingElements();
          p.addElement();
          break;
        case atom.Rb:
        case atom.Rtc:
          if (p.elementInScope(Scope.defaultScope, atom.Ruby)) {
            p.generateImpliedEndTags();
          }
          p.addElement();
          break;
        case atom.Rp:
        case atom.Rt:
          if (p.elementInScope(Scope.defaultScope, atom.Ruby)) {
            p.generateImpliedEndTags("rtc");
          }
          p.addElement();
          break;
        case atom.Math:
        case atom.Svg:
          p.reconstructActiveFormattingElements();
          if (p.tok.dataAtom === atom.Math) {
            adjustAttributeNames(p.tok.attr, mathMLAttributeAdjustments);
          } else {
            adjustAttributeNames(p.tok.attr, svgAttributeAdjustments);
          }
          adjustForeignAttributes(p.tok.attr);
          p.addElement();
          p.top().namespace = p.tok.data;
          if (p.hasSelfClosingToken) {
            stackPop(p.oe);
            p.acknowledgeSelfClosingTag();
          }
          return true;
        case atom.Caption:
        case atom.Col:
        case atom.Colgroup:
        case atom.Frame:
        case atom.Head:
        case atom.Tbody:
        case atom.Td:
        case atom.Tfoot:
        case atom.Th:
        case atom.Thead:
        case atom.Tr:
          // Ignore the token.
          break;
        default:
          p.reconstructActiveFormattingElements();
          p.addElement();
      }
      break;
    case EndTagToken:
      switch (p.tok.dataAtom) {
        case atom.Body:
          if (p.elementInScope(Scope.defaultScope, atom.Body)) {
            p.im = afterBodyIM;
          }
          break;
        case atom.Html:
          if (p.elementInScope(Scope.defaultScope, atom.Body)) {
            p.parseImpliedToken(EndTagToken, atom.Body, atom.Body);
            return false;
          }
          return true;
        case atom.Address:
        case atom.Article:
        case atom.Aside:
        case atom.Blockquote:
        case atom.Button:
        case atom.Center:
        case atom.Details:
        case atom.Dialog:
        case atom.Dir:
        case atom.Div:
        case atom.Dl:
        case atom.Fieldset:
        case atom.Figcaption:
        case atom.Figure:
        case atom.Footer:
        case atom.Header:
        case atom.Hgroup:
        case atom.Listing:
        case atom.Main:
        case atom.Menu:
        case atom.Nav:
        case atom.Ol:
        case atom.Pre:
        case atom.Search:
        case atom.Section:
        case atom.Select:
        case atom.Summary:
        case atom.Ul:
          if (!p.elementInScope(Scope.defaultScope, p.tok.dataAtom)) {
            // Ignore the token.
            return true;
          }
          p.generateImpliedEndTags();
          p.popUntil(Scope.defaultScope, p.tok.dataAtom);
          break;
        case atom.Form:
          if (nodeStackContains(p.oe, atom.Template)) {
            const i = p.indexOfElementInScope(Scope.defaultScope, atom.Form);
            if (i === -1) {
              // Ignore the token.
              return true;
            }
            p.generateImpliedEndTags();
            if (stackAt(p.oe, i).dataAtom !== atom.Form) {
              // Ignore the token.
              return true;
            }
            p.popUntil(Scope.defaultScope, atom.Form);
          } else {
            const node = p.form;
            p.form = null;
            const i = p.indexOfElementInScope(Scope.defaultScope, atom.Form);
            if (node === null || i === -1 || stackAt(p.oe, i) !== node) {
              // Ignore the token.
              return true;
            }
            p.generateImpliedEndTags();
            stackRemove(p.oe, node);
          }
          break;
        case atom.P:
          if (!p.elementInScope(Scope.buttonScope, atom.P)) {
            p.parseImpliedToken(StartTagToken, atom.P, atom.P);
          }
          p.popUntil(Scope.buttonScope, atom.P);
          break;
        case atom.Li:
          p.popUntil(Scope.listItemScope, atom.Li);
          break;
        case atom.Dd:
        case atom.Dt:
          p.popUntil(Scope.defaultScope, p.tok.dataAtom);
          break;
        case atom.H1:
        case atom.H2:
        case atom.H3:
        case atom.H4:
        case atom.H5:
        case atom.H6:
          p.popUntil(Scope.defaultScope, atom.H1, atom.H2, atom.H3, atom.H4, atom.H5, atom.H6);
          break;
        case atom.A:
        case atom.B:
        case atom.Big:
        case atom.Code:
        case atom.Em:
        case atom.Font:
        case atom.I:
        case atom.Nobr:
        case atom.S:
        case atom.Small:
        case atom.Strike:
        case atom.Strong:
        case atom.Tt:
        case atom.U:
          p.inBodyEndTagFormatting(p.tok.dataAtom, p.tok.data);
          break;
        case atom.Applet:
        case atom.Marquee:
        case atom.Object:
          if (p.popUntil(Scope.defaultScope, p.tok.dataAtom)) {
            p.clearActiveFormattingElements();
          }
          break;
        case atom.Br:
          p.tok.type = StartTagToken;
          return false;
        case atom.Template:
          return inHeadIM(p);
        default:
          p.inBodyEndTagOther(p.tok.dataAtom, p.tok.data);
      }
      break;
    case CommentToken:
      p.addChild(new Node({ type: CommentNode, data: p.tok.data }));
      break;
    case ErrorToken:
      // TODO: remove this divergence from the HTML5 spec.
      if (p.templateStack.length > 0) {
        p.im = inTemplateIM;
        return false;
      }
      for (const e of p.oe) {
        switch (e.dataAtom) {
          case atom.Dd:
          case atom.Dt:
          case atom.Li:
          case atom.Optgroup:
          case atom.Option:
          case atom.P:
          case atom.Rb:
          case atom.Rp:
          case atom.Rt:
          case atom.Rtc:
          case atom.Tbody:
          case atom.Td:
          case atom.Tfoot:
          case atom.Th:
          case atom.Thead:
          case atom.Tr:
          case atom.Body:
          case atom.Html:
            break;
          default:
            return true;
        }
      }
      break;
  }

  return true;
}

// Section 12.2.6.4.8.
function textIM(p: Parser): boolean {
  switch (p.tok.type) {
    case ErrorToken:
      stackPop(p.oe);
      break;
    case TextToken: {
      let d = p.tok.data;
      const n = stackTop(p.oe)!;
      if (n.dataAtom === atom.Textarea && n.firstChild === null) {
        // Ignore a newline at the start of a <textarea> block.
        if (d !== "" && d[0] === "\r") {
          d = d.slice(1);
        }
        if (d !== "" && d[0] === "\n") {
          d = d.slice(1);
        }
      }
      if (d === "") {
        return true;
      }
      p.addText(d);
      return true;
    }
    case EndTagToken:
      stackPop(p.oe);
      break;
  }
  p.im = p.originalIM;
  p.originalIM = null;
  return p.tok.type === EndTagToken;
}

// Section 12.2.6.4.9.
function inTableIM(p: Parser): boolean {
  switch (p.tok.type) {
    case TextToken:
      p.tok.data = p.tok.data.replaceAll("\x00", "");
      switch (stackTop(p.oe)!.dataAtom) {
        case atom.Table:
        case atom.Tbody:
        case atom.Tfoot:
        case atom.Thead:
        case atom.Tr:
          if (trimLeft(p.tok.data, whitespace) === "") {
            p.addText(p.tok.data);
            return true;
          }
          break;
      }
      break;
    case StartTagToken:
      switch (p.tok.dataAtom) {
        case atom.Caption:
          p.clearStackToContext(Scope.tableScope);
          p.afe.push(new Node({ type: scopeMarkerNode }));
          p.addElement();
          p.im = inCaptionIM;
          return true;
        case atom.Colgroup:
          p.clearStackToContext(Scope.tableScope);
          p.addElement();
          p.im = inColumnGroupIM;
          return true;
        case atom.Col:
          p.parseImpliedToken(StartTagToken, atom.Colgroup, atom.Colgroup);
          return false;
        case atom.Tbody:
        case atom.Tfoot:
        case atom.Thead:
          p.clearStackToContext(Scope.tableScope);
          p.addElement();
          p.im = inTableBodyIM;
          return true;
        case atom.Td:
        case atom.Th:
        case atom.Tr:
          p.parseImpliedToken(StartTagToken, atom.Tbody, atom.Tbody);
          return false;
        case atom.Table:
          if (p.popUntil(Scope.tableScope, atom.Table)) {
            p.resetInsertionMode();
            return false;
          }
          // Ignore the token.
          return true;
        case atom.Style:
        case atom.Script:
        case atom.Template:
          return inHeadIM(p);
        case atom.Input:
          for (const t of p.tok.attr) {
            if (t.key === "type" && equalFold(t.val, "hidden")) {
              p.addElement();
              stackPop(p.oe);
              return true;
            }
          }
          // Otherwise drop down to the default action.
          break;
        case atom.Form:
          if (nodeStackContains(p.oe, atom.Template) || p.form !== null) {
            // Ignore the token.
            return true;
          }
          p.addElement();
          p.form = stackPop(p.oe);
          break;
      }
      break;
    case EndTagToken:
      switch (p.tok.dataAtom) {
        case atom.Table:
          if (p.popUntil(Scope.tableScope, atom.Table)) {
            p.resetInsertionMode();
            return true;
          }
          // Ignore the token.
          return true;
        case atom.Body:
        case atom.Caption:
        case atom.Col:
        case atom.Colgroup:
        case atom.Html:
        case atom.Tbody:
        case atom.Td:
        case atom.Tfoot:
        case atom.Th:
        case atom.Thead:
        case atom.Tr:
          // Ignore the token.
          return true;
        case atom.Template:
          return inHeadIM(p);
      }
      break;
    case CommentToken:
      p.addChild(new Node({ type: CommentNode, data: p.tok.data }));
      return true;
    case DoctypeToken:
      // Ignore the token.
      return true;
    case ErrorToken:
      return inBodyIM(p);
  }

  p.fosterParenting = true;
  try {
    return inBodyIM(p);
  } finally {
    p.fosterParenting = false;
  }
}

// Section 12.2.6.4.11.
function inCaptionIM(p: Parser): boolean {
  switch (p.tok.type) {
    case StartTagToken:
      switch (p.tok.dataAtom) {
        case atom.Caption:
        case atom.Col:
        case atom.Colgroup:
        case atom.Tbody:
        case atom.Td:
        case atom.Tfoot:
        case atom.Thead:
        case atom.Tr:
          if (!p.popUntil(Scope.tableScope, atom.Caption)) {
            // Ignore the token.
            return true;
          }
          p.clearActiveFormattingElements();
          p.im = inTableIM;
          return false;
      }
      break;
    case EndTagToken:
      switch (p.tok.dataAtom) {
        case atom.Caption:
          if (p.popUntil(Scope.tableScope, atom.Caption)) {
            p.clearActiveFormattingElements();
            p.im = inTableIM;
          }
          return true;
        case atom.Table:
          if (!p.popUntil(Scope.tableScope, atom.Caption)) {
            // Ignore the token.
            return true;
          }
          p.clearActiveFormattingElements();
          p.im = inTableIM;
          return false;
        case atom.Body:
        case atom.Col:
        case atom.Colgroup:
        case atom.Html:
        case atom.Tbody:
        case atom.Td:
        case atom.Tfoot:
        case atom.Th:
        case atom.Thead:
        case atom.Tr:
          // Ignore the token.
          return true;
      }
      break;
  }
  return inBodyIM(p);
}

// Section 12.2.6.4.12.
function inColumnGroupIM(p: Parser): boolean {
  switch (p.tok.type) {
    case TextToken: {
      const s = trimLeft(p.tok.data, whitespace);
      if (s.length < p.tok.data.length) {
        // Add the initial whitespace to the current node.
        p.addText(p.tok.data.slice(0, p.tok.data.length - s.length));
        if (s === "") {
          return true;
        }
        p.tok.data = s;
      }
      break;
    }
    case CommentToken:
      p.addChild(new Node({ type: CommentNode, data: p.tok.data }));
      return true;
    case DoctypeToken:
      // Ignore the token.
      return true;
    case StartTagToken:
      switch (p.tok.dataAtom) {
        case atom.Html:
          return inBodyIM(p);
        case atom.Col:
          p.addElement();
          stackPop(p.oe);
          p.acknowledgeSelfClosingTag();
          return true;
        case atom.Template:
          return inHeadIM(p);
      }
      break;
    case EndTagToken:
      switch (p.tok.dataAtom) {
        case atom.Colgroup:
          if (stackTop(p.oe)!.dataAtom === atom.Colgroup) {
            stackPop(p.oe);
            p.im = inTableIM;
          }
          return true;
        case atom.Col:
          // Ignore the token.
          return true;
        case atom.Template:
          return inHeadIM(p);
      }
      break;
    case ErrorToken:
      return inBodyIM(p);
  }
  if (stackTop(p.oe)!.dataAtom !== atom.Colgroup) {
    return true;
  }
  stackPop(p.oe);
  p.im = inTableIM;
  return false;
}

// Section 12.2.6.4.13.
function inTableBodyIM(p: Parser): boolean {
  switch (p.tok.type) {
    case StartTagToken:
      switch (p.tok.dataAtom) {
        case atom.Tr:
          p.clearStackToContext(Scope.tableBodyScope);
          p.addElement();
          p.im = inRowIM;
          return true;
        case atom.Td:
        case atom.Th:
          p.parseImpliedToken(StartTagToken, atom.Tr, atom.Tr);
          return false;
        case atom.Caption:
        case atom.Col:
        case atom.Colgroup:
        case atom.Tbody:
        case atom.Tfoot:
        case atom.Thead:
          if (p.popUntil(Scope.tableScope, atom.Tbody, atom.Thead, atom.Tfoot)) {
            p.im = inTableIM;
            return false;
          }
          // Ignore the token.
          return true;
      }
      break;
    case EndTagToken:
      switch (p.tok.dataAtom) {
        case atom.Tbody:
        case atom.Tfoot:
        case atom.Thead:
          if (p.elementInScope(Scope.tableScope, p.tok.dataAtom)) {
            p.clearStackToContext(Scope.tableBodyScope);
            stackPop(p.oe);
            p.im = inTableIM;
          }
          return true;
        case atom.Table:
          if (p.popUntil(Scope.tableScope, atom.Tbody, atom.Thead, atom.Tfoot)) {
            p.im = inTableIM;
            return false;
          }
          // Ignore the token.
          return true;
        case atom.Body:
        case atom.Caption:
        case atom.Col:
        case atom.Colgroup:
        case atom.Html:
        case atom.Td:
        case atom.Th:
        case atom.Tr:
          // Ignore the token.
          return true;
      }
      break;
    case CommentToken:
      p.addChild(new Node({ type: CommentNode, data: p.tok.data }));
      return true;
  }

  return inTableIM(p);
}

// Section 13.2.6.4.14.
function inRowIM(p: Parser): boolean {
  switch (p.tok.type) {
    case StartTagToken:
      switch (p.tok.dataAtom) {
        case atom.Td:
        case atom.Th:
          p.clearStackToContext(Scope.tableRowScope);
          p.addElement();
          p.afe.push(new Node({ type: scopeMarkerNode }));
          p.im = inCellIM;
          return true;
        case atom.Caption:
        case atom.Col:
        case atom.Colgroup:
        case atom.Tbody:
        case atom.Tfoot:
        case atom.Thead:
        case atom.Tr:
          if (p.elementInScope(Scope.tableScope, atom.Tr)) {
            p.clearStackToContext(Scope.tableRowScope);
            stackPop(p.oe);
            p.im = inTableBodyIM;
            return false;
          }
          // Ignore the token.
          return true;
      }
      break;
    case EndTagToken:
      switch (p.tok.dataAtom) {
        case atom.Tr:
          if (p.elementInScope(Scope.tableScope, atom.Tr)) {
            p.clearStackToContext(Scope.tableRowScope);
            stackPop(p.oe);
            p.im = inTableBodyIM;
            return true;
          }
          // Ignore the token.
          return true;
        case atom.Table:
          if (p.elementInScope(Scope.tableScope, atom.Tr)) {
            p.clearStackToContext(Scope.tableRowScope);
            stackPop(p.oe);
            p.im = inTableBodyIM;
            return false;
          }
          // Ignore the token.
          return true;
        case atom.Tbody:
        case atom.Tfoot:
        case atom.Thead:
          if (
            p.elementInScope(Scope.tableScope, p.tok.dataAtom) &&
            p.elementInScope(Scope.tableScope, atom.Tr)
          ) {
            p.clearStackToContext(Scope.tableRowScope);
            stackPop(p.oe);
            p.im = inTableBodyIM;
            return false;
          }
          // Ignore the token.
          return true;
        case atom.Body:
        case atom.Caption:
        case atom.Col:
        case atom.Colgroup:
        case atom.Html:
        case atom.Td:
        case atom.Th:
          // Ignore the token.
          return true;
      }
      break;
  }

  return inTableIM(p);
}

// Section 12.2.6.4.15.
function inCellIM(p: Parser): boolean {
  switch (p.tok.type) {
    case StartTagToken:
      switch (p.tok.dataAtom) {
        case atom.Caption:
        case atom.Col:
        case atom.Colgroup:
        case atom.Tbody:
        case atom.Td:
        case atom.Tfoot:
        case atom.Th:
        case atom.Thead:
        case atom.Tr:
          if (p.popUntil(Scope.tableScope, atom.Td, atom.Th)) {
            // Close the cell and reprocess.
            p.clearActiveFormattingElements();
            p.im = inRowIM;
            return false;
          }
          // Ignore the token.
          return true;
      }
      break;
    case EndTagToken:
      switch (p.tok.dataAtom) {
        case atom.Td:
        case atom.Th:
          if (!p.popUntil(Scope.tableScope, p.tok.dataAtom)) {
            // Ignore the token.
            return true;
          }
          p.clearActiveFormattingElements();
          p.im = inRowIM;
          return true;
        case atom.Body:
        case atom.Caption:
        case atom.Col:
        case atom.Colgroup:
        case atom.Html:
          // Ignore the token.
          return true;
        case atom.Table:
        case atom.Tbody:
        case atom.Tfoot:
        case atom.Thead:
        case atom.Tr:
          if (!p.elementInScope(Scope.tableScope, p.tok.dataAtom)) {
            // Ignore the token.
            return true;
          }
          // Close the cell and reprocess.
          if (p.popUntil(Scope.tableScope, atom.Td, atom.Th)) {
            p.clearActiveFormattingElements();
          }
          p.im = inRowIM;
          return false;
      }
      break;
  }
  return inBodyIM(p);
}

// Section 12.2.6.4.18.
function inTemplateIM(p: Parser): boolean {
  switch (p.tok.type) {
    case TextToken:
    case CommentToken:
    case DoctypeToken:
      return inBodyIM(p);
    case StartTagToken:
      switch (p.tok.dataAtom) {
        case atom.Base:
        case atom.Basefont:
        case atom.Bgsound:
        case atom.Link:
        case atom.Meta:
        case atom.Noframes:
        case atom.Script:
        case atom.Style:
        case atom.Template:
        case atom.Title:
          return inHeadIM(p);
        case atom.Caption:
        case atom.Colgroup:
        case atom.Tbody:
        case atom.Tfoot:
        case atom.Thead:
          stackPop(p.templateStack);
          p.templateStack.push(inTableIM);
          p.im = inTableIM;
          return false;
        case atom.Col:
          stackPop(p.templateStack);
          p.templateStack.push(inColumnGroupIM);
          p.im = inColumnGroupIM;
          return false;
        case atom.Tr:
          stackPop(p.templateStack);
          p.templateStack.push(inTableBodyIM);
          p.im = inTableBodyIM;
          return false;
        case atom.Td:
        case atom.Th:
          stackPop(p.templateStack);
          p.templateStack.push(inRowIM);
          p.im = inRowIM;
          return false;
        default:
          stackPop(p.templateStack);
          p.templateStack.push(inBodyIM);
          p.im = inBodyIM;
          return false;
      }
    case EndTagToken:
      switch (p.tok.dataAtom) {
        case atom.Template:
          return inHeadIM(p);
        default:
          // Ignore the token.
          return true;
      }
    case ErrorToken:
      if (!nodeStackContains(p.oe, atom.Template)) {
        // Ignore the token.
        return true;
      }
      // TODO: remove this divergence from the HTML5 spec.
      //
      // See https://bugs.chromium.org/p/chromium/issues/detail?id=829668
      p.generateImpliedEndTags();
      for (let i = p.oe.length - 1; i >= 0; i--) {
        const n = stackAt(p.oe, i);
        if (n.namespace === "" && n.dataAtom === atom.Template) {
          p.oe.splice(i);
          break;
        }
      }
      p.clearActiveFormattingElements();
      stackPop(p.templateStack);
      p.resetInsertionMode();
      return false;
  }
  return false;
}

// Section 12.2.6.4.19.
function afterBodyIM(p: Parser): boolean {
  switch (p.tok.type) {
    case ErrorToken:
      // Stop parsing.
      return true;
    case TextToken: {
      const s = trimLeft(p.tok.data, whitespace);
      if (s.length === 0) {
        // It was all whitespace.
        return inBodyIM(p);
      }
      break;
    }
    case StartTagToken:
      if (p.tok.dataAtom === atom.Html) {
        return inBodyIM(p);
      }
      break;
    case EndTagToken:
      if (p.tok.dataAtom === atom.Html) {
        if (!p.fragment) {
          p.im = afterAfterBodyIM;
        }
        return true;
      }
      break;
    case CommentToken:
      // The comment is attached to the <html> element.
      if (p.oe.length < 1 || stackAt(p.oe, 0).dataAtom !== atom.Html) {
        throw new Error(
          "html: bad parser state: <html> element not found, in the after-body insertion mode",
        );
      }
      stackAt(p.oe, 0).appendChild(new Node({ type: CommentNode, data: p.tok.data }));
      return true;
  }
  p.im = inBodyIM;
  return false;
}

// keepWhitespaceOnly is strings.Map with a mapping that keeps only the
// ASCII whitespace characters the frameset modes allow.
function keepWhitespaceOnly(s: string): string {
  return s.replace(/[^ \t\n\f\r]/g, "");
}

// Section 12.2.6.4.20.
function inFramesetIM(p: Parser): boolean {
  switch (p.tok.type) {
    case CommentToken:
      p.addChild(new Node({ type: CommentNode, data: p.tok.data }));
      break;
    case TextToken: {
      // Ignore all text but whitespace.
      const s = keepWhitespaceOnly(p.tok.data);
      if (s !== "") {
        p.addText(s);
      }
      break;
    }
    case StartTagToken:
      switch (p.tok.dataAtom) {
        case atom.Html:
          return inBodyIM(p);
        case atom.Frameset:
          p.addElement();
          break;
        case atom.Frame:
          p.addElement();
          stackPop(p.oe);
          p.acknowledgeSelfClosingTag();
          break;
        case atom.Noframes:
          return inHeadIM(p);
      }
      break;
    case EndTagToken:
      switch (p.tok.dataAtom) {
        case atom.Frameset:
          if (stackTop(p.oe)!.dataAtom !== atom.Html) {
            stackPop(p.oe);
            if (stackTop(p.oe)!.dataAtom !== atom.Frameset) {
              p.im = afterFramesetIM;
              return true;
            }
          }
          break;
      }
      break;
    default:
      // Ignore the token.
      break;
  }
  return true;
}

// Section 12.2.6.4.21.
function afterFramesetIM(p: Parser): boolean {
  switch (p.tok.type) {
    case CommentToken:
      p.addChild(new Node({ type: CommentNode, data: p.tok.data }));
      break;
    case TextToken: {
      // Ignore all text but whitespace.
      const s = keepWhitespaceOnly(p.tok.data);
      if (s !== "") {
        p.addText(s);
      }
      break;
    }
    case StartTagToken:
      switch (p.tok.dataAtom) {
        case atom.Html:
          return inBodyIM(p);
        case atom.Noframes:
          return inHeadIM(p);
      }
      break;
    case EndTagToken:
      switch (p.tok.dataAtom) {
        case atom.Html:
          p.im = afterAfterFramesetIM;
          return true;
      }
      break;
    default:
      // Ignore the token.
      break;
  }
  return true;
}

// Section 12.2.6.4.22.
function afterAfterBodyIM(p: Parser): boolean {
  switch (p.tok.type) {
    case ErrorToken:
      // Stop parsing.
      return true;
    case TextToken: {
      const s = trimLeft(p.tok.data, whitespace);
      if (s.length === 0) {
        // It was all whitespace.
        return inBodyIM(p);
      }
      break;
    }
    case StartTagToken:
      if (p.tok.dataAtom === atom.Html) {
        return inBodyIM(p);
      }
      break;
    case CommentToken:
      p.doc.appendChild(new Node({ type: CommentNode, data: p.tok.data }));
      return true;
    case DoctypeToken:
      return inBodyIM(p);
  }
  p.im = inBodyIM;
  return false;
}

// Section 12.2.6.4.23.
function afterAfterFramesetIM(p: Parser): boolean {
  switch (p.tok.type) {
    case CommentToken:
      p.doc.appendChild(new Node({ type: CommentNode, data: p.tok.data }));
      break;
    case TextToken: {
      // Ignore all text but whitespace.
      const s = keepWhitespaceOnly(p.tok.data);
      if (s !== "") {
        p.tok.data = s;
        return inBodyIM(p);
      }
      break;
    }
    case StartTagToken:
      switch (p.tok.dataAtom) {
        case atom.Html:
          return inBodyIM(p);
        case atom.Noframes:
          return inHeadIM(p);
      }
      break;
    case DoctypeToken:
      return inBodyIM(p);
    default:
      // Ignore the token.
      break;
  }
  return true;
}

function ignoreTheRemainingTokens(_p: Parser): boolean {
  return true;
}

// Section 12.2.6.4.2.
function beforeHTMLIM(p: Parser): boolean {
  switch (p.tok.type) {
    case DoctypeToken:
      // Ignore the token.
      return true;
    case TextToken:
      p.tok.data = trimLeft(p.tok.data, whitespace);
      if (p.tok.data.length === 0) {
        // It was all whitespace, so ignore it.
        return true;
      }
      break;
    case StartTagToken:
      if (p.tok.dataAtom === atom.Html) {
        p.addElement();
        p.im = beforeHeadIM;
        return true;
      }
      break;
    case EndTagToken:
      switch (p.tok.dataAtom) {
        case atom.Head:
        case atom.Body:
        case atom.Html:
        case atom.Br:
          p.parseImpliedToken(StartTagToken, atom.Html, atom.Html);
          return false;
        default:
          // Ignore the token.
          return true;
      }
    case CommentToken:
      p.doc.appendChild(new Node({ type: CommentNode, data: p.tok.data }));
      return true;
  }
  p.parseImpliedToken(StartTagToken, atom.Html, atom.Html);
  return false;
}

// Section 12.2.6.4.3.
function beforeHeadIM(p: Parser): boolean {
  switch (p.tok.type) {
    case TextToken:
      p.tok.data = trimLeft(p.tok.data, whitespace);
      if (p.tok.data.length === 0) {
        // It was all whitespace, so ignore it.
        return true;
      }
      break;
    case StartTagToken:
      switch (p.tok.dataAtom) {
        case atom.Head:
          p.addElement();
          p.head = p.top();
          p.im = inHeadIM;
          return true;
        case atom.Html:
          return inBodyIM(p);
      }
      break;
    case EndTagToken:
      switch (p.tok.dataAtom) {
        case atom.Head:
        case atom.Body:
        case atom.Html:
        case atom.Br:
          p.parseImpliedToken(StartTagToken, atom.Head, atom.Head);
          return false;
        default:
          // Ignore the token.
          return true;
      }
    case CommentToken:
      p.addChild(new Node({ type: CommentNode, data: p.tok.data }));
      return true;
    case DoctypeToken:
      // Ignore the token.
      return true;
  }

  p.parseImpliedToken(StartTagToken, atom.Head, atom.Head);
  return false;
}

// Section 12.2.6.4.4.
function inHeadIM(p: Parser): boolean {
  switch (p.tok.type) {
    case TextToken: {
      const s = trimLeft(p.tok.data, whitespace);
      if (s.length < p.tok.data.length) {
        // Add the initial whitespace to the current node.
        p.addText(p.tok.data.slice(0, p.tok.data.length - s.length));
        if (s === "") {
          return true;
        }
        p.tok.data = s;
      }
      break;
    }
    case StartTagToken:
      switch (p.tok.dataAtom) {
        case atom.Html:
          return inBodyIM(p);
        case atom.Base:
        case atom.Basefont:
        case atom.Bgsound:
        case atom.Link:
        case atom.Meta:
          p.addElement();
          stackPop(p.oe);
          p.acknowledgeSelfClosingTag();
          return true;
        case atom.Noscript:
          if (p.scripting) {
            p.parseGenericRawTextElement();
            return true;
          }
          p.addElement();
          p.im = inHeadNoscriptIM;
          // Don't let the tokenizer go into raw text mode when scripting is disabled.
          p.tokenizer.nextIsNotRawText();
          return true;
        case atom.Script:
        case atom.Title:
          p.addElement();
          p.setOriginalIM();
          p.im = textIM;
          return true;
        case atom.Noframes:
        case atom.Style:
          p.parseGenericRawTextElement();
          return true;
        case atom.Head:
          // Ignore the token.
          return true;
        case atom.Template:
          // TODO: remove this divergence from the HTML5 spec.
          //
          // We don't handle all of the corner cases when mixing foreign
          // content (i.e. <math> or <svg>) with <template>. Without this
          // early return, we can get into an infinite loop, possibly because
          // of the "TODO... further divergence" a little below.
          //
          // As a workaround, if we are mixing foreign content and templates,
          // just ignore the rest of the HTML. Foreign content is rare and a
          // relatively old HTML feature. Templates are also rare and a
          // relatively new HTML feature. Their combination is very rare.
          for (const e of p.oe) {
            if (e.namespace !== "") {
              p.im = ignoreTheRemainingTokens;
              return true;
            }
          }

          p.addElement();
          p.afe.push(new Node({ type: scopeMarkerNode }));
          p.framesetOK = false;
          p.im = inTemplateIM;
          p.templateStack.push(inTemplateIM);
          return true;
      }
      break;
    case EndTagToken:
      switch (p.tok.dataAtom) {
        case atom.Head:
          stackPop(p.oe);
          p.im = afterHeadIM;
          return true;
        case atom.Body:
        case atom.Html:
        case atom.Br:
          p.parseImpliedToken(EndTagToken, atom.Head, atom.Head);
          return false;
        case atom.Template:
          if (!nodeStackContains(p.oe, atom.Template)) {
            return true;
          }
          // TODO: remove this further divergence from the HTML5 spec.
          //
          // See https://bugs.chromium.org/p/chromium/issues/detail?id=829668
          p.generateImpliedEndTags();
          for (let i = p.oe.length - 1; i >= 0; i--) {
            const n = stackAt(p.oe, i);
            if (n.namespace === "" && n.dataAtom === atom.Template) {
              p.oe.splice(i);
              break;
            }
          }
          p.clearActiveFormattingElements();
          stackPop(p.templateStack);
          p.resetInsertionMode();
          return true;
        default:
          // Ignore the token.
          return true;
      }
    case CommentToken:
      p.addChild(new Node({ type: CommentNode, data: p.tok.data }));
      return true;
    case DoctypeToken:
      // Ignore the token.
      return true;
  }

  p.parseImpliedToken(EndTagToken, atom.Head, atom.Head);
  return false;
}

// Section 12.2.6.4.5.
function inHeadNoscriptIM(p: Parser): boolean {
  switch (p.tok.type) {
    case DoctypeToken:
      // Ignore the token.
      return true;
    case StartTagToken:
      switch (p.tok.dataAtom) {
        case atom.Html:
          return inBodyIM(p);
        case atom.Basefont:
        case atom.Bgsound:
        case atom.Link:
        case atom.Meta:
        case atom.Noframes:
        case atom.Style:
          return inHeadIM(p);
        case atom.Head:
          // Ignore the token.
          return true;
        case atom.Noscript:
          // Don't let the tokenizer go into raw text mode even when a <noscript>
          // tag is in "in head noscript" insertion mode.
          p.tokenizer.nextIsNotRawText();
          // Ignore the token.
          return true;
      }
      break;
    case EndTagToken:
      switch (p.tok.dataAtom) {
        case atom.Noscript:
        case atom.Br:
          break;
        default:
          // Ignore the token.
          return true;
      }
      break;
    case TextToken: {
      const s = trimLeft(p.tok.data, whitespace);
      if (s.length === 0) {
        // It was all whitespace.
        return inHeadIM(p);
      }
      break;
    }
    case CommentToken:
      return inHeadIM(p);
  }
  stackPop(p.oe);
  if (stackTop(p.oe)!.dataAtom !== atom.Head) {
    throw new Error("html: the new current node will be a head element.");
  }
  p.im = inHeadIM;
  if (p.tok.dataAtom === atom.Noscript) {
    return true;
  }
  return false;
}

// Section 12.2.6.4.6.
function afterHeadIM(p: Parser): boolean {
  switch (p.tok.type) {
    case TextToken: {
      const s = trimLeft(p.tok.data, whitespace);
      if (s.length < p.tok.data.length) {
        // Add the initial whitespace to the current node.
        p.addText(p.tok.data.slice(0, p.tok.data.length - s.length));
        if (s === "") {
          return true;
        }
        p.tok.data = s;
      }
      break;
    }
    case StartTagToken:
      switch (p.tok.dataAtom) {
        case atom.Html:
          return inBodyIM(p);
        case atom.Body:
          p.addElement();
          p.framesetOK = false;
          p.im = inBodyIM;
          return true;
        case atom.Frameset:
          p.addElement();
          p.im = inFramesetIM;
          return true;
        case atom.Base:
        case atom.Basefont:
        case atom.Bgsound:
        case atom.Link:
        case atom.Meta:
        case atom.Noframes:
        case atom.Script:
        case atom.Style:
        case atom.Template:
        case atom.Title:
          p.insertOpenElement(p.head!);
          try {
            return inHeadIM(p);
          } finally {
            stackRemove(p.oe, p.head!);
          }
        case atom.Head:
          // Ignore the token.
          return true;
      }
      break;
    case EndTagToken:
      switch (p.tok.dataAtom) {
        case atom.Body:
        case atom.Html:
        case atom.Br:
          // Drop down to creating an implied <body> tag.
          break;
        case atom.Template:
          return inHeadIM(p);
        default:
          // Ignore the token.
          return true;
      }
      break;
    case CommentToken:
      p.addChild(new Node({ type: CommentNode, data: p.tok.data }));
      return true;
    case DoctypeToken:
      // Ignore the token.
      return true;
  }

  p.parseImpliedToken(StartTagToken, atom.Body, atom.Body);
  p.framesetOK = true;
  if (p.tok.type === ErrorToken) {
    // Stop parsing.
    return true;
  }
  return false;
}

// Section 13.2.6.5
function parseForeignContent(p: Parser): boolean {
  switch (p.tok.type) {
    case TextToken:
      if (p.framesetOK) {
        p.framesetOK = trimLeft(p.tok.data, whitespaceOrNUL) === "";
      }
      p.tok.data = p.tok.data.replaceAll("\x00", "�");
      p.addText(p.tok.data);
      break;
    case CommentToken:
      p.addChild(new Node({ type: CommentNode, data: p.tok.data }));
      break;
    case StartTagToken: {
      let b = breakout.has(p.tok.data);
      if (p.tok.dataAtom === atom.Font) {
        for (const attr of p.tok.attr) {
          if (attr.key === "color" || attr.key === "face" || attr.key === "size") {
            b = true;
            break;
          }
        }
      }
      if (b) {
        for (let i = p.oe.length - 1; i >= 0; i--) {
          const n = stackAt(p.oe, i);
          if (n.namespace === "" || htmlIntegrationPoint(n) || mathMLTextIntegrationPoint(n)) {
            p.oe.splice(i + 1);
            break;
          }
        }
        return p.im!(p);
      }
      const current = p.adjustedCurrentNode();
      const namespace = current.namespace;
      switch (current.namespace) {
        case "math":
          adjustAttributeNames(p.tok.attr, mathMLAttributeAdjustments);
          break;
        case "svg": {
          // Adjust SVG tag names. The tokenizer lower-cases tag names, but
          // SVG wants e.g. "foreignObject" with a capital second "O".
          const x = svgTagNameAdjustments.get(p.tok.data) ?? "";
          if (x !== "") {
            p.tok.dataAtom = lookup(x);
            p.tok.data = x;
          }
          adjustAttributeNames(p.tok.attr, svgAttributeAdjustments);
          break;
        }
        default:
          throw new Error("html: bad parser state: unexpected namespace");
      }
      adjustForeignAttributes(p.tok.attr);
      p.addElement();
      p.top().namespace = namespace;
      if (namespace !== "") {
        // Don't let the tokenizer go into raw text mode in foreign content
        // (e.g. in an SVG <title> tag).
        p.tokenizer.nextIsNotRawText();
      }
      if (p.hasSelfClosingToken) {
        stackPop(p.oe);
        p.acknowledgeSelfClosingTag();
      }
      break;
    }
    case EndTagToken: {
      if (equalFold(stackTop(p.oe)!.data, p.tok.data)) {
        stackPop(p.oe);
        return true;
      }
      for (let i = p.oe.length - 1; i >= 0; i--) {
        if (equalFold(stackAt(p.oe, i).data, p.tok.data)) {
          p.oe.splice(i);
          return true;
        }
        if (i > 0 && stackAt(p.oe, i - 1).namespace === "") {
          break;
        }
      }
      return p.im!(p);
    }
  }
  return true;
}

// ParseOption configures a parser.
export type ParseOption = (p: Parser) => void;

// parseOptionEnableScripting configures the scripting flag.
// https://html.spec.whatwg.org/multipage/webappapis.html#enabling-and-disabling-scripting
//
// By default, scripting is enabled.
export function parseOptionEnableScripting(enable: boolean): ParseOption {
  return (p) => {
    p.scripting = enable;
  };
}

// parseWithOptions is parse, with options. It throws if the input cannot be parsed,
// for example when it is nested deeper than 512 elements.
//
// The input is assumed to be UTF-8 encoded.
export function parseWithOptions(input: string, ...opts: ParseOption[]): Node {
  const p = new Parser(newTokenizer(encodeUTF8(input)));
  p.scripting = true;
  p.framesetOK = true;
  p.im = initialIM;

  for (const f of opts) {
    f(p);
  }

  p.parse();
  return p.doc;
}

// parse returns the parse tree for the HTML in input.
//
// It implements the HTML5 parsing algorithm
// (https://html.spec.whatwg.org/multipage/syntax.html#tree-construction),
// which is very complicated. The resultant tree can contain implicitly created
// nodes that have no explicit <tag> listed in the input, and nodes' parents can
// differ from the nesting implied by a naive processing of start and end
// <tag>s. Conversely, explicit <tag>s in the input can be silently dropped,
// with no corresponding node in the resulting tree.
//
// parse rejects HTML that is nested deeper than 512 elements.
//
// The input is assumed to be UTF-8 encoded.
export function parse(input: string): Node {
  return parseWithOptions(input);
}

// parseFragmentWithOptions is parseFragment, with options.
export function parseFragmentWithOptions(
  input: string,
  context: Node | null,
  ...opts: ParseOption[]
): Node[] {
  let contextTag = "";
  if (context !== null) {
    if (context.type !== ElementNode) {
      throw new Error("html: ParseFragment of non-element Node");
    }
    // The next check isn't just context.dataAtom === context.data because
    // it is valid to pass an element whose tag isn't a known atom. For example,
    // dataAtom == "" and data = "tagfromthefuture" is perfectly consistent.
    if (context.dataAtom !== lookup(context.data)) {
      throw new Error(
        `html: inconsistent Node: DataAtom=${JSON.stringify(context.dataAtom)}, Data=${JSON.stringify(context.data)}`,
      );
    }
    contextTag = context.dataAtom;
  }
  const bytes = encodeUTF8(input);
  const p = new Parser(
    context !== null && context.namespace !== ""
      ? newTokenizer(bytes)
      : new Tokenizer(bytes, contextTag),
  );
  p.scripting = true;
  p.fragment = true;
  p.context = context;

  for (const f of opts) {
    f(p);
  }

  const root = new Node({ type: ElementNode, dataAtom: atom.Html, data: atom.Html });
  p.doc.appendChild(root);
  p.oe = [root];
  if (context !== null && context.dataAtom === atom.Template) {
    p.templateStack.push(inTemplateIM);
  }
  p.resetInsertionMode();

  for (let n = context; n !== null; n = n.parent) {
    if (n.type === ElementNode && n.dataAtom === atom.Form) {
      p.form = n;
      break;
    }
  }

  p.parse();

  const parent = context !== null ? root : p.doc;

  const result: Node[] = [];
  for (let c = parent.firstChild; c !== null;) {
    const next = c.nextSibling;
    parent.removeChild(c);
    result.push(c);
    c = next;
  }
  return result;
}

// parseFragment parses a fragment of HTML and returns the nodes that were
// found. If the fragment is the innerHTML for an existing element, pass that
// element in context.
//
// It has the same intricacies as parse.
export function parseFragment(input: string, context: Node | null, ...opts: ParseOption[]): Node[] {
  return parseFragmentWithOptions(input, context, ...opts);
}

// initialIM is the initial insertion mode.
// Section 12.2.6.4.1.
function initialIM(p: Parser): boolean {
  switch (p.tok.type) {
    case TextToken:
      p.tok.data = trimLeft(p.tok.data, whitespace);
      if (p.tok.data.length === 0) {
        // It was all whitespace, so ignore it.
        return true;
      }
      break;
    case CommentToken:
      p.doc.appendChild(new Node({ type: CommentNode, data: p.tok.data }));
      return true;
    case DoctypeToken: {
      const [n, quirks] = parseDoctype(p.tok.data);
      p.doc.appendChild(n);
      p.quirks = quirks;
      p.im = beforeHTMLIM;
      return true;
    }
  }
  p.quirks = true;
  p.im = beforeHTMLIM;
  return false;
}
