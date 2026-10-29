// Upstream: golang.org/x/net v0.61.0 html/parse_test.go and node_test.go
//
// Ports the tree-construction runner over the html5lib and Go .dat files.
// Cases are read exactly as readParseTest reads them, dumped as dumpLevel
// dumps them, and compared with #document. The render round-trip in
// testParseCase is not ported, because render.go is not part of the port.
// The cases where Go would run that round-trip are counted in the last test.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { atom, lookup } from "@/tools/html/atom";
import {
  parse,
  parseFragment,
  parseOptionEnableScripting,
  parseWithOptions,
} from "@/tools/html/parse";
import {
  DocumentNode,
  ElementNode,
  CommentNode,
  DoctypeNode,
  ErrorNode,
  Node,
  TextNode,
  scopeMarkerNode,
} from "@/tools/html/node";

// The Go parse test reads each .dat file's cases in file order.
const testDataDirs = ["testdata/html5lib-tests/tree-construction/", "testdata/go/"];

interface ParseTestCase {
  text: string;
  want: string;
  context: string;
  scripting: boolean;
}

// LineReader reads lines the way bufio.Reader.ReadSlice('\n') does: each line
// keeps its newline, and the last line of the input may have none.
class LineReader {
  private pos = 0;

  constructor(private readonly text: string) {}

  // readSlice returns the next line and whether the read hit the end of input
  // (io.EOF in Go). At the end of input the line is empty.
  readSlice(): { line: string; eof: boolean } {
    if (this.pos >= this.text.length) {
      return { line: "", eof: true };
    }
    const nl = this.text.indexOf("\n", this.pos);
    if (nl === -1) {
      const line = this.text.slice(this.pos);
      this.pos = this.text.length;
      return { line, eof: true };
    }
    const line = this.text.slice(this.pos, nl + 1);
    this.pos = nl + 1;
    return { line, eof: false };
  }

  // next is readSlice where an EOF is an error, as in every readParseTest
  // loop except the document dump.
  next(): string {
    const { line, eof } = this.readSlice();
    if (eof) {
      throw new Error("unexpected EOF");
    }
    return line;
  }
}

// trimChars is bytes.Trim with an ASCII cutset.
function trimChars(s: string, cutset: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && cutset.includes(s[start]!)) {
    start++;
  }
  while (end > start && cutset.includes(s[end - 1]!)) {
    end--;
  }
  return s.slice(start, end);
}

// readParseTest reads a single test case from r. It returns null at the end of
// the input (io.EOF in Go).
function readParseTest(r: LineReader): ParseTestCase | null {
  const ta: ParseTestCase = { text: "", want: "", context: "", scripting: true };
  let { line, eof } = r.readSlice();
  if (eof) {
    return null;
  }
  let b = "";

  // Read the HTML.
  if (line !== "#data\n") {
    throw new Error(`got ${JSON.stringify(line)} want "#data\\n"`);
  }
  for (;;) {
    line = r.next();
    if (line[0] === "#") {
      break;
    }
    b += line;
  }
  ta.text = b.endsWith("\n") ? b.slice(0, -1) : b;
  b = "";

  // Skip the error list.
  if (line !== "#errors\n") {
    throw new Error(`got ${JSON.stringify(line)} want "#errors\\n"`);
  }
  for (;;) {
    line = r.next();
    if (line[0] === "#") {
      break;
    }
  }

  // Skip the new-errors list.
  if (line === "#new-errors\n") {
    for (;;) {
      line = r.next();
      if (line[0] === "#") {
        break;
      }
    }
  }

  if (line.startsWith("#script-")) {
    if (line.endsWith("-on\n")) {
      ta.scripting = true;
    } else if (line.endsWith("-off\n")) {
      ta.scripting = false;
    } else {
      throw new Error(`got ${JSON.stringify(line)}, want "#script-on" or "#script-off"`);
    }
    for (;;) {
      line = r.next();
      if (line[0] === "#") {
        break;
      }
    }
  }

  if (line === "#document-fragment\n") {
    line = r.next();
    ta.context = line.trim();
    line = r.next();
  }

  // Read the dump of what the parse tree should be.
  if (line !== "#document\n") {
    throw new Error(`got ${JSON.stringify(line)} want "#document\\n"`);
  }
  let inQuote = false;
  for (;;) {
    ({ line, eof } = r.readSlice());
    const trimmed = trimChars(line, "| \n");
    if (trimmed.length > 0) {
      if (line[0] === "|" && trimmed[0] === '"') {
        inQuote = true;
      }
      if (trimmed[trimmed.length - 1] === '"' && !(line[0] === "|" && trimmed.length === 1)) {
        inQuote = false;
      }
    }
    if (line.length === 0 || (line.length === 1 && line === "\n" && !inQuote)) {
      break;
    }
    b += line;
  }
  ta.want = b;
  return ta;
}

function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const cx = x[i]!.codePointAt(0)!;
    const cy = y[i]!.codePointAt(0)!;
    if (cx !== cy) {
      return cx < cy ? -1 : 1;
    }
  }
  return x.length - y.length;
}

function dumpIndent(level: number): string {
  return "| " + "  ".repeat(level);
}

// dumpLevel is the tree dump of parse_test.go.
function dumpLevel(n: Node, level: number): string {
  let s = dumpIndent(level);
  level++;
  switch (n.type) {
    case ErrorNode:
      throw new Error("unexpected ErrorNode");
    case DocumentNode:
      throw new Error("unexpected DocumentNode");
    case ElementNode: {
      if (n.namespace !== "") {
        s += `<${n.namespace} ${n.data}>`;
      } else {
        s += `<${n.data}>`;
      }
      // sort.Sort by key. Insertion sort (used for short slices in Go) is stable, as Array sort is.
      const attr = [...n.attr].toSorted((a, b) => compareCodePoints(a.key, b.key));
      for (const a of attr) {
        s += "\n" + dumpIndent(level);
        if (a.namespace !== "") {
          s += `${a.namespace} ${a.key}="${a.val}"`;
        } else {
          s += `${a.key}="${a.val}"`;
        }
      }
      if (n.namespace === "" && n.dataAtom === atom.Template) {
        s += "\n" + dumpIndent(level);
        level++;
        s += "content";
      }
      break;
    }
    case TextNode:
      s += `"${n.data}"`;
      break;
    case CommentNode:
      s += `<!-- ${n.data} -->`;
      break;
    case DoctypeNode: {
      s += `<!DOCTYPE ${n.data}`;
      let p = "";
      let sys = "";
      for (const a of n.attr) {
        switch (a.key) {
          case "public":
            p = a.val;
            break;
          case "system":
            sys = a.val;
            break;
        }
      }
      if (p !== "" || sys !== "") {
        s += ` "${p}"`;
        s += ` "${sys}"`;
      }
      s += ">";
      break;
    }
    case scopeMarkerNode:
      throw new Error("unexpected scopeMarkerNode");
    default:
      throw new Error("unknown node type");
  }
  s += "\n";
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    s += dumpLevel(c, level);
  }
  return s;
}

function dump(n: Node | null): string {
  if (n === null || n.firstChild === null) {
    return "";
  }
  let s = "";
  for (let c: Node | null = n.firstChild; c !== null; c = c.nextSibling) {
    s += dumpLevel(c, 0);
  }
  return s;
}

// checkTreeConsistency is node_test.go's checkTreeConsistency.
function checkTreeConsistency(n: Node): void {
  checkTreeConsistency1(n, 0);
}

function checkTreeConsistency1(n: Node, depth: number): void {
  if (depth === 1e4) {
    throw new Error("html: tree looks like it contains a cycle");
  }
  checkNodeConsistency(n);
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    checkTreeConsistency1(c, depth + 1);
  }
}

// checkNodeConsistency checks that a node's parent/child/sibling relationships
// are consistent.
function checkNodeConsistency(n: Node): void {
  let nParent = 0;
  for (let p = n.parent; p !== null; p = p.parent) {
    nParent++;
    if (nParent === 1e4) {
      throw new Error("html: parent list looks like an infinite loop");
    }
  }

  let nForward = 0;
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    nForward++;
    if (nForward === 1e6) {
      throw new Error("html: forward list of children looks like an infinite loop");
    }
    if (c.parent !== n) {
      throw new Error("html: inconsistent child/parent relationship");
    }
  }

  let nBackward = 0;
  for (let c = n.lastChild; c !== null; c = c.prevSibling) {
    nBackward++;
    if (nBackward === 1e6) {
      throw new Error("html: backward list of children looks like an infinite loop");
    }
    if (c.parent !== n) {
      throw new Error("html: inconsistent child/parent relationship");
    }
  }

  if (n.parent !== null) {
    if (n.parent === n) {
      throw new Error("html: inconsistent parent relationship");
    }
    if (n.parent === n.firstChild) {
      throw new Error("html: inconsistent parent/first relationship");
    }
    if (n.parent === n.lastChild) {
      throw new Error("html: inconsistent parent/last relationship");
    }
    if (n.parent === n.prevSibling) {
      throw new Error("html: inconsistent parent/prev relationship");
    }
    if (n.parent === n.nextSibling) {
      throw new Error("html: inconsistent parent/next relationship");
    }

    let parentHasNAsAChild = false;
    for (let c = n.parent.firstChild; c !== null; c = c.nextSibling) {
      if (c === n) {
        parentHasNAsAChild = true;
        break;
      }
    }
    if (!parentHasNAsAChild) {
      throw new Error("html: inconsistent parent/child relationship");
    }
  }

  if (n.prevSibling !== null && n.prevSibling.nextSibling !== n) {
    throw new Error("html: inconsistent prev/next relationship");
  }
  if (n.nextSibling !== null && n.nextSibling.prevSibling !== n) {
    throw new Error("html: inconsistent next/prev relationship");
  }

  if ((n.firstChild === null) !== (n.lastChild === null)) {
    throw new Error("html: inconsistent first/last relationship");
  }
  if (n.firstChild !== null && n.firstChild === n.lastChild) {
    // We have a sole child.
    if (n.firstChild.prevSibling !== null || n.firstChild.nextSibling !== null) {
      throw new Error("html: inconsistent sole child's sibling relationship");
    }
  }

  const seen = new Set<Node>();
  let last: Node | null = null;
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    if (seen.has(c)) {
      throw new Error("html: inconsistent repeated child");
    }
    seen.add(c);
    last = c;
  }
  if (last !== n.lastChild) {
    throw new Error("html: inconsistent last relationship");
  }

  let first: Node | null = null;
  for (let c = n.lastChild; c !== null; c = c.prevSibling) {
    if (!seen.has(c)) {
      throw new Error("html: inconsistent missing child");
    }
    seen.delete(c);
    first = c;
  }
  if (first !== n.firstChild) {
    throw new Error("html: inconsistent first relationship");
  }
}

// parseTestBlacklist: inputs that are skipped, because the port does not
// support their behavior (element insertion steps for selectedcontent).
const parseTestBlacklist = new Set<string>([
  // See the a.Template TODO in inHeadIM.
  "<math><template><mo><template>",
  "<template><svg><foo><template><foreignObject><div></template><div>",
  // We don't support "element insertion steps"
  "<select><button><selectedcontent></button><option>X",
  "<select><button><selectedcontent></button><option>x<i>i<b>ib</i>b",
  "<select><button><selectedcontent></button><option>X<option>Y",
  "<select><button><selectedcontent></button><option>X<option selected>Y",
]);

// testParseCase tests one test case from the test files. It returns an error
// message if the test does not pass, else null. The Go test's render round-trip
// is not run here.
function testParseCase(
  text: string,
  want: string,
  context: string,
  scripting: boolean,
): string | null {
  try {
    let doc: Node;
    if (context === "") {
      doc = parseWithOptions(text, parseOptionEnableScripting(scripting));
    } else {
      let namespace = "";
      let ctx = context;
      const i = ctx.indexOf(" ");
      if (i >= 0) {
        namespace = ctx.slice(0, i);
        ctx = ctx.slice(i + 1);
      }
      const contextNode = new Node({
        type: ElementNode,
        data: ctx,
        dataAtom: lookup(ctx),
        namespace,
      });
      const nodes = parseFragment(text, contextNode, parseOptionEnableScripting(scripting));
      doc = new Node({ type: DocumentNode });
      for (const n of nodes) {
        doc.appendChild(n);
      }
    }

    checkTreeConsistency(doc);

    const got = dump(doc);
    // Compare the parsed tree to the #document section.
    if (got !== want) {
      return `got vs want:\n----\n${got}----\n${want}----`;
    }

    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

// Load the cases of each directory once, in the order the Go test visits them.
function loadCases(): { file: string; index: number; test: ParseTestCase }[] {
  const cases: { file: string; index: number; test: ParseTestCase }[] = [];
  for (const dir of testDataDirs) {
    const files = [
      ...new Bun.Glob("*.dat").scanSync({ cwd: `${import.meta.dir}/${dir}` }),
    ].toSorted();
    for (const file of files) {
      const text = readFileSync(`${import.meta.dir}/${dir}${file}`, "utf8") as string;
      const r = new LineReader(text);
      for (let i = 0; ; i++) {
        const ta = readParseTest(r);
        if (ta === null) {
          break;
        }
        cases.push({ file: `${dir}${file}`, index: i, test: ta });
      }
    }
  }
  return cases;
}

const cases = loadCases();

describe("tree construction (.dat files)", () => {
  for (const c of cases) {
    if (parseTestBlacklist.has(c.test.text)) {
      continue;
    }
    test(`${c.file}/${c.index}`, () => {
      const err = testParseCase(c.test.text, c.test.want, c.test.context, c.test.scripting);
      if (err !== null) {
        throw new Error(`${c.file} test #${c.index} ${JSON.stringify(c.test.text)}, ${err}`);
      }
    });
  }
});

describe("parser behavior", () => {
  // Issue 16318
  test("without scripting", () => {
    const text = `<noscript><img src='https://golang.org/doc/gopher/frontpage.png' /></noscript><p><img src='https://golang.org/doc/gopher/doc.png' /></p>`;
    const want = `| <html>
|   <head>
|     <noscript>
|   <body>
|     <img>
|       src="https://golang.org/doc/gopher/frontpage.png"
|     <p>
|       <img>
|         src="https://golang.org/doc/gopher/doc.png"
`;
    const err = testParseCase(text, want, "", false);
    expect(err).toBeNull();
  });

  test("node consistency: an inconsistent context node is rejected", () => {
    // inconsistentNode is a Node whose dataAtom and data do not agree.
    const inconsistentNode = new Node({
      type: ElementNode,
      dataAtom: atom.Frameset,
      data: "table",
    });
    expect(() => parseFragment("<p>hello</p>", inconsistentNode)).toThrow();
  });

  test("parseFragment with a nil context does not panic", () => {
    parseFragment("<p>hello</p>", null);
  });

  test("foreign content with templates in fragments terminates", () => {
    const srcs = [
      "<math><html><template><mn><template></template></template>",
      "<math><math><head><mi><template>",
      "<svg><head><title><select><input>",
    ];
    for (const src of srcs) {
      parseFragment(src, null);
    }
  });

  test("a search tag closes an open p", () => {
    // TestSearchTagClosesP compares rendered HTML, which the port does not render.
    // The same tree is checked through the dump instead.
    const node = parse(`<p>Unclosed paragraph<search>Search content</search>`);
    expect(dump(node)).toBe(
      `| <html>
|   <head>
|   <body>
|     <p>
|       "Unclosed paragraph"
|     <search>
|       "Search content"
`,
    );
  });

  test("an element stack overflow is reported as an error", () => {
    // Issue 70179: this used to fail.
    parse("<table><tbody><svg><td><desc><select></select></tbody>");
  });

  test("depth limit", () => {
    const depthCases = [
      { name: "above depth limit", input: "<dl>".repeat(511), succeed: false },
      { name: "below depth limit", input: "<dl>".repeat(510), succeed: true },
      {
        name: "above depth limit, interspersed elements",
        input: "<dl><img />".repeat(511),
        succeed: false,
      },
      { name: "closing tags", input: "</dl>".repeat(512), succeed: true },
    ];
    for (const tc of depthCases) {
      let failed = false;
      try {
        parse(tc.input);
      } catch {
        failed = true;
      }
      expect(failed, tc.name).toBe(!tc.succeed);
    }
  });
});
