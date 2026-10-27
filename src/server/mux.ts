// Upstream: Go 1.27.2 net/http ServeMux, which tools/router BuildMux relies
// on: pattern.go (parsing, precedence, conflicts), routing_tree.go
// (matching), server.go (findHandler, matchOrRedirect, exactMatch,
// cleanPath, stripHostPort, urlFromEscaped, Redirect, Error) and
// net/url's PathUnescape. PocketBase v0.41.0 is built with Go 1.27.2.
//
// Patterns are "[METHOD ][HOST]/[PATH]" with {name}, {name...} and {$}
// wildcards. The most specific pattern wins; conflicting patterns are
// rejected at registration. GET patterns also match HEAD. Requests with
// unclean paths (".", "..", repeated slashes) and subtree roots without
// their trailing slash are redirected with 307.

interface Segment {
  // literal or wildcard name or "/" for "/{$}"
  s: string;
  wild: boolean;
  // "..." wildcard
  multi: boolean;
}

export class Pattern {
  constructor(
    // original string
    readonly str: string,
    readonly method: string,
    readonly host: string,
    // The representation of a path differs from the surface syntax, which
    // simplifies most algorithms: a trailing slash is a multi wildcard with
    // an empty name, and "/{$}" is a literal "/" segment.
    readonly segments: readonly Segment[],
  ) {}

  toString(): string {
    return this.str;
  }

  lastSegment(): Segment {
    return this.segments[this.segments.length - 1] as Segment;
  }

  // wildcard names, in the order their matches are recorded
  wildcardNames(): string[] {
    return this.segments.filter((s) => s.wild && s.s !== "").map((s) => s.s);
  }
}

// validMethod: a non-empty RFC 9110 token
function validMethod(method: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(method);
}

// parsePattern parses a string into a Pattern.
export function parsePattern(s: string): Pattern {
  if (s.length === 0) {
    throw new Error("empty pattern");
  }
  let off = 0; // offset into string
  const fail = (message: string): Error => new Error(`at offset ${off}: ${message}`);

  let method = s;
  let rest = "";
  let found = false;
  const sep = s.search(/[ \t]/);
  if (sep >= 0) {
    method = s.slice(0, sep);
    rest = s.slice(sep + 1).replace(/^[ \t]+/, "");
    found = true;
  }
  if (!found) {
    rest = method;
    method = "";
  }
  if (method !== "" && !validMethod(method)) {
    throw fail(`invalid method ${goQuote(method)}`);
  }

  if (found) {
    off = method.length + 1;
  }
  const i = rest.indexOf("/");
  if (i < 0) {
    throw fail("host/path missing /");
  }
  const host = rest.slice(0, i);
  rest = rest.slice(i);
  const j = host.indexOf("{");
  if (j >= 0) {
    off += j;
    throw fail("host contains '{' (missing initial '/'?)");
  }
  // At this point, rest is the path.
  off += i;

  // An unclean path with a method that is not CONNECT can never match,
  // because paths are cleaned before matching.
  if (method !== "" && method !== "CONNECT" && rest !== cleanPath(rest)) {
    throw fail("non-CONNECT pattern with unclean path can never match");
  }

  const segments: Segment[] = [];
  const seenNames = new Set<string>(); // remember wildcard names to catch dups
  while (rest.length > 0) {
    // Invariant: rest[0] == '/'.
    rest = rest.slice(1);
    off = s.length - rest.length;
    if (rest.length === 0) {
      // Trailing slash.
      segments.push({ s: "", wild: true, multi: true });
      break;
    }
    let k = rest.indexOf("/");
    if (k < 0) {
      k = rest.length;
    }
    let seg = rest.slice(0, k);
    rest = rest.slice(k);
    const brace = seg.indexOf("{");
    if (brace < 0) {
      // Literal.
      seg = pathUnescape(seg);
      segments.push({ s: seg, wild: false, multi: false });
      continue;
    }
    // Wildcard.
    if (brace !== 0) {
      throw fail("bad wildcard segment (must start with '{')");
    }
    if (seg[seg.length - 1] !== "}") {
      throw fail("bad wildcard segment (must end with '}')");
    }
    let name = seg.slice(1, -1);
    if (name === "$") {
      if (rest.length !== 0) {
        throw fail("{$} not at end");
      }
      segments.push({ s: "/", wild: false, multi: false });
      break;
    }
    const multi = name.endsWith("...");
    if (multi) {
      name = name.slice(0, -3);
    }
    if (multi && rest.length !== 0) {
      throw fail("{...} wildcard not at end");
    }
    if (name === "") {
      throw fail("empty wildcard");
    }
    if (!isValidWildcardName(name)) {
      throw fail(`bad wildcard name ${goQuote(name)}`);
    }
    if (seenNames.has(name)) {
      throw fail(`duplicate wildcard name ${goQuote(name)}`);
    }
    seenNames.add(name);
    segments.push({ s: name, wild: true, multi });
  }
  return new Pattern(s, method, host, segments);
}

function isValidWildcardName(s: string): boolean {
  if (s === "") {
    return false;
  }
  // Valid Go identifier.
  let i = 0;
  for (const c of s) {
    if (!/\p{L}/u.test(c) && c !== "_" && (i === 0 || !/\p{Nd}/u.test(c))) {
      return false;
    }
    i++;
  }
  return true;
}

// strconv.Quote for the ASCII strings used in error messages
function goQuote(s: string): string {
  return JSON.stringify(s);
}

// url.PathUnescape, returning the input unchanged on a malformed escape.
// The bytes are decoded as UTF-8.
export function pathUnescape(path: string): string {
  const unescaped = unescapeBytes(path);
  return unescaped === undefined ? path : unescaped;
}

// url.PathUnescape; undefined for a malformed escape
export function unescapeBytes(s: string): string | undefined {
  if (!s.includes("%")) {
    return s;
  }
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < s.length;) {
    const c = s[i] as string;
    if (c === "%") {
      const hex = s.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
        return undefined;
      }
      bytes.push(Number.parseInt(hex, 16));
      i += 3;
      continue;
    }
    const cp = s.codePointAt(i) as number;
    const ch = String.fromCodePoint(cp);
    bytes.push(...encoder.encode(ch));
    i += ch.length;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// relationship is a relation between two patterns
export type Relationship = "equivalent" | "moreGeneral" | "moreSpecific" | "disjoint" | "overlaps";

// conflictsWith reports whether p1 conflicts with p2, that is, whether
// there is a request that both match but where neither is higher precedence
// than the other.
export function conflictsWith(p1: Pattern, p2: Pattern): boolean {
  if (p1.host !== p2.host) {
    // Either one host is empty and the other isn't, in which case the
    // one with the host wins by rule, or neither host is empty
    // and they differ, so they won't match the same paths.
    return false;
  }
  const rel = comparePathsAndMethods(p1, p2);
  return rel === "equivalent" || rel === "overlaps";
}

function comparePathsAndMethods(p1: Pattern, p2: Pattern): Relationship {
  const mrel = compareMethods(p1, p2);
  // Optimization: avoid a call to comparePaths.
  if (mrel === "disjoint") {
    return "disjoint";
  }
  const prel = comparePaths(p1, p2);
  return combineRelationships(mrel, prel);
}

// compareMethods determines the relationship between the method part of
// patterns p1 and p2.
export function compareMethods(p1: Pattern, p2: Pattern): Relationship {
  if (p1.method === p2.method) {
    return "equivalent";
  }
  if (p1.method === "") {
    // p1 matches any method, but p2 does not, so p1 is more general.
    return "moreGeneral";
  }
  if (p2.method === "") {
    return "moreSpecific";
  }
  if (p1.method === "GET" && p2.method === "HEAD") {
    // p1 matches GET and HEAD; p2 matches only HEAD.
    return "moreGeneral";
  }
  if (p2.method === "GET" && p1.method === "HEAD") {
    return "moreSpecific";
  }
  return "disjoint";
}

// comparePaths determines the relationship between the path part of two
// patterns.
export function comparePaths(p1: Pattern, p2: Pattern): Relationship {
  // Optimization: if a path pattern doesn't end in a multi ("...") wildcard,
  // then it can only match paths with the same number of segments.
  if (
    p1.segments.length !== p2.segments.length &&
    !p1.lastSegment().multi &&
    !p2.lastSegment().multi
  ) {
    return "disjoint";
  }

  // Consider corresponding segments in the two path patterns.
  let rel: Relationship = "equivalent";
  let i = 0;
  for (; i < p1.segments.length && i < p2.segments.length; i++) {
    rel = combineRelationships(
      rel,
      compareSegments(p1.segments[i] as Segment, p2.segments[i] as Segment),
    );
    if (rel === "disjoint") {
      return rel;
    }
  }
  // We've reached the end of the corresponding segments of the patterns.
  // If they have the same number of segments, then we've already determined
  // their relationship.
  if (i === p1.segments.length && i === p2.segments.length) {
    return rel;
  }
  // Otherwise, the only way they could fail to be disjoint is if the shorter
  // pattern ends in a multi and is more general.
  if (p1.segments.length < p2.segments.length && p1.lastSegment().multi) {
    return combineRelationships(rel, "moreGeneral");
  }
  if (p2.segments.length < p1.segments.length && p2.lastSegment().multi) {
    return combineRelationships(rel, "moreSpecific");
  }
  return "disjoint";
}

// compareSegments determines the relationship between two segments.
function compareSegments(s1: Segment, s2: Segment): Relationship {
  if (s1.multi && s2.multi) {
    return "equivalent";
  }
  if (s1.multi) {
    return "moreGeneral";
  }
  if (s2.multi) {
    return "moreSpecific";
  }
  if (s1.wild && s2.wild) {
    return "equivalent";
  }
  if (s1.wild) {
    if (s2.s === "/") {
      // A single wildcard doesn't match a trailing slash.
      return "disjoint";
    }
    return "moreGeneral";
  }
  if (s2.wild) {
    if (s1.s === "/") {
      return "disjoint";
    }
    return "moreSpecific";
  }
  // Both literals.
  if (s1.s === s2.s) {
    return "equivalent";
  }
  return "disjoint";
}

// combineRelationships determines the overall relationship of two patterns
// given the relationships of a partition of the patterns into two parts.
function combineRelationships(r1: Relationship, r2: Relationship): Relationship {
  switch (r1) {
    case "equivalent":
      return r2;
    case "disjoint":
      return "disjoint";
    case "overlaps":
      if (r2 === "disjoint") {
        return "disjoint";
      }
      return "overlaps";
    case "moreGeneral":
    case "moreSpecific":
      if (r2 === "equivalent") {
        return r1;
      }
      if (r2 === inverseRelationship(r1)) {
        return "overlaps";
      }
      return r2;
  }
}

// If p1 has relationship `r` to p2, then p2 has inverseRelationship(r) to p1.
function inverseRelationship(r: Relationship): Relationship {
  switch (r) {
    case "moreSpecific":
      return "moreGeneral";
    case "moreGeneral":
      return "moreSpecific";
    default:
      return r;
  }
}

// describeConflict returns an explanation of why two patterns conflict.
export function describeConflict(p1: Pattern, p2: Pattern): string {
  const mrel = compareMethods(p1, p2);
  const prel = comparePaths(p1, p2);
  const rel = combineRelationships(mrel, prel);
  if (rel === "equivalent") {
    return `${p1} matches the same requests as ${p2}`;
  }
  if (rel !== "overlaps") {
    throw new Error("describeConflict called with non-conflicting patterns");
  }
  if (prel === "overlaps") {
    return `${p1} and ${p2} both match some paths, like ${goQuote(commonPath(p1, p2))}.
But neither is more specific than the other.
${p1} matches ${goQuote(differencePath(p1, p2))}, but ${p2} doesn't.
${p2} matches ${goQuote(differencePath(p2, p1))}, but ${p1} doesn't.`;
  }
  if (mrel === "moreGeneral" && prel === "moreSpecific") {
    return `${p1} matches more methods than ${p2}, but has a more specific path pattern`;
  }
  if (mrel === "moreSpecific" && prel === "moreGeneral") {
    return `${p1} matches fewer methods than ${p2}, but has a more general path pattern`;
  }
  return `bug: unexpected way for two patterns ${p1} and ${p2} to conflict: methods ${mrel}, paths ${prel}`;
}

function writeSegment(s: Segment): string {
  return s.multi || s.s === "/" ? "/" : `/${s.s}`;
}

// commonPath returns a path that both p1 and p2 match.
// It assumes there is such a path.
export function commonPath(p1: Pattern, p2: Pattern): string {
  let b = "";
  let i = 0;
  for (; i < p1.segments.length && i < p2.segments.length; i++) {
    const s1 = p1.segments[i] as Segment;
    const s2 = p2.segments[i] as Segment;
    b += s1.wild ? writeSegment(s2) : writeSegment(s1);
  }
  if (i < p1.segments.length) {
    b += p1.segments.slice(i).map(writeSegment).join("");
  } else if (i < p2.segments.length) {
    b += p2.segments.slice(i).map(writeSegment).join("");
  }
  return b;
}

// differencePath returns a path that p1 matches and p2 doesn't.
// It assumes there is such a path.
export function differencePath(p1: Pattern, p2: Pattern): string {
  let b = "";
  let i = 0;
  for (; i < p1.segments.length && i < p2.segments.length; i++) {
    const s1 = p1.segments[i] as Segment;
    const s2 = p2.segments[i] as Segment;
    if (s1.multi && s2.multi) {
      // From here the patterns match the same paths, so we must have found a difference earlier.
      return `${b}/`;
    }
    if (s1.multi && !s2.multi) {
      // s1 ends in a "..." wildcard but s2 does not.
      // A trailing slash will distinguish them, unless s2 ends in "{$}",
      // in which case any segment will do; prefer the wildcard name if
      // it has one.
      b += "/";
      if (s2.s === "/") {
        b += s1.s !== "" ? s1.s : "x";
      }
      return b;
    }
    if (!s1.multi && s2.multi) {
      b += writeSegment(s1);
    } else if (s1.wild && s2.wild) {
      // Both patterns will match whatever we put here; use
      // the first wildcard name.
      b += writeSegment(s1);
    } else if (s1.wild && !s2.wild) {
      // s1 is a wildcard, s2 is a literal.
      // Any segment other than s2.s will work.
      // Prefer the wildcard name, but if it's the same as the literal,
      // tweak the literal.
      b += s1.s !== s2.s ? writeSegment(s1) : `/${s2.s}x`;
    } else if (!s1.wild && s2.wild) {
      b += writeSegment(s1);
    } else {
      // Both are literals. A precondition of this function is that the
      // patterns overlap, so they must be the same literal. Use it.
      if (s1.s !== s2.s) {
        throw new Error(`literals differ: ${goQuote(s1.s)} and ${goQuote(s2.s)}`);
      }
      b += writeSegment(s1);
    }
  }
  if (i < p1.segments.length) {
    b += p1.segments.slice(i).map(writeSegment).join("");
  } else if (i < p2.segments.length) {
    b += p2.segments.slice(i).map(writeSegment).join("");
  }
  return b;
}

// ---------------------------------------------------------------------------
// routing_tree.go

// A RoutingNode is a node in the decision tree. The same struct is used for
// leaf and interior nodes.
export class RoutingNode<H> {
  // A leaf node holds a single pattern and the handler it was registered with.
  pattern: Pattern | undefined;
  handler: H | undefined;

  // An interior node maps parts of the incoming request to child nodes.
  // special children keys:
  //     "/"	trailing slash (resulting from {$})
  //	   ""   single wildcard
  children = new Map<string, RoutingNode<H>>();
  // child with multi wildcard
  multiChild: RoutingNode<H> | undefined;
  // optimization: child with key ""
  emptyChild: RoutingNode<H> | undefined;

  // addPattern adds a pattern and its associated handler to the tree at root.
  addPattern(p: Pattern, h: H): void {
    // First level of tree is host.
    let n = this.addChild(p.host);
    // Second level of tree is method.
    n = n.addChild(p.method);
    // Remaining levels are path.
    n.addSegments(p.segments, p, h);
  }

  // addSegments adds the given segments to the tree rooted at n.
  // If there are no segments, then n is a leaf node that holds
  // the given pattern and handler.
  addSegments(segs: readonly Segment[], p: Pattern, h: H): void {
    if (segs.length === 0) {
      this.set(p, h);
      return;
    }
    const seg = segs[0] as Segment;
    if (seg.multi) {
      if (segs.length !== 1) {
        throw new Error("multi wildcard not last");
      }
      const c = new RoutingNode<H>();
      this.multiChild = c;
      c.set(p, h);
    } else if (seg.wild) {
      this.addChild("").addSegments(segs.slice(1), p, h);
    } else {
      this.addChild(seg.s).addSegments(segs.slice(1), p, h);
    }
  }

  // set sets the pattern and handler for n, which
  // must be a leaf node.
  set(p: Pattern, h: H): void {
    if (this.pattern !== undefined || this.handler !== undefined) {
      throw new Error("non-nil leaf fields");
    }
    this.pattern = p;
    this.handler = h;
  }

  // addChild adds a child node with the given key to n
  // if one does not exist, and returns the child.
  addChild(key: string): RoutingNode<H> {
    if (key === "") {
      this.emptyChild ??= new RoutingNode<H>();
      return this.emptyChild;
    }
    let c = this.children.get(key);
    if (!c) {
      c = new RoutingNode<H>();
      this.children.set(key, c);
    }
    return c;
  }

  // findChild returns the child of n with the given key, or undefined
  // if there is no child with that key.
  findChild(key: string): RoutingNode<H> | undefined {
    if (key === "") {
      return this.emptyChild;
    }
    return this.children.get(key);
  }
}

// match returns the leaf node under root that matches the arguments, and a
// list of values for pattern wildcards in the order that the wildcards
// appear.
export function match<H>(
  root: RoutingNode<H>,
  host: string,
  method: string,
  path: string,
): [RoutingNode<H> | undefined, string[]] {
  if (host !== "") {
    // There is a host. If there is a pattern that specifies that host and it
    // matches, we are done. If the pattern doesn't match, fall through to
    // try patterns with no host.
    const [l, m] = matchMethodAndPath(root.findChild(host), method, path);
    if (l) {
      return [l, m];
    }
  }
  return matchMethodAndPath(root.emptyChild, method, path);
}

// matchMethodAndPath matches the method and path.
// Its return values are the same as match.
// The receiver should be a child of the root.
function matchMethodAndPath<H>(
  n: RoutingNode<H> | undefined,
  method: string,
  path: string,
): [RoutingNode<H> | undefined, string[]] {
  if (!n) {
    return [undefined, []];
  }
  let [l, m] = matchPath(n.findChild(method), path, []);
  if (l) {
    // Exact match of method name.
    return [l, m];
  }
  if (method === "HEAD") {
    // GET matches HEAD too.
    [l, m] = matchPath(n.findChild("GET"), path, []);
    if (l) {
      return [l, m];
    }
  }
  // No exact match; try patterns with no method.
  return matchPath(n.emptyChild, path, []);
}

// matchPath matches a path.
// Its return values are the same as match.
// matches is the list of wildcard matches so far.
function matchPath<H>(
  n: RoutingNode<H> | undefined,
  path: string,
  matches: string[],
): [RoutingNode<H> | undefined, string[]] {
  if (!n) {
    return [undefined, []];
  }
  // If path is empty, then we are done.
  // If n is a leaf node, we found a match; return it.
  // If n is an interior node (which means it has a nil pattern),
  // then we failed to match.
  if (path === "") {
    if (!n.pattern) {
      return [undefined, []];
    }
    return [n, matches];
  }
  // Get the first segment of path.
  const [seg, rest] = firstSegment(path);
  // First try matching against patterns that have a literal for this position.
  // We know by construction that such patterns are more specific than those
  // with a wildcard at this position (they are either more specific, equivalent,
  // or overlap, and we ruled out the first two when the patterns were registered).
  {
    const [c, m] = matchPath(n.findChild(seg), rest, matches);
    if (c) {
      return [c, m];
    }
  }
  // If matching a literal fails, try again with patterns that have a single
  // wildcard (represented by an empty string in the child mapping).
  // Again, by construction, patterns with a single wildcard must be more specific than
  // those with a multi wildcard.
  // We skip this step if the segment is a trailing slash, because single wildcards
  // don't match trailing slashes.
  if (seg !== "/") {
    const [c, m] = matchPath(n.emptyChild, rest, [...matches, seg]);
    if (c) {
      return [c, m];
    }
  }
  // Lastly, match the pattern (there can be at most one) that has a multi
  // wildcard in this position to the rest of the path.
  const c = n.multiChild;
  if (c) {
    // Don't record a match for a nameless wildcard (which arises from a
    // trailing slash in the pattern).
    if ((c.pattern as Pattern).lastSegment().s !== "") {
      matches = [...matches, pathUnescape(path.slice(1))]; // remove initial slash
    }
    return [c, matches];
  }
  return [undefined, []];
}

// firstSegment splits path into its first segment, and the rest.
// The path must begin with "/".
// If path consists of only a slash, firstSegment returns ["/", ""].
// The segment is returned unescaped, if possible.
export function firstSegment(path: string): [string, string] {
  if (path === "/") {
    return ["/", ""];
  }
  path = path.slice(1); // drop initial slash
  let i = path.indexOf("/");
  if (i < 0) {
    i = path.length;
  }
  return [pathUnescape(path.slice(0, i)), path.slice(i)];
}

// matchingMethods adds to methodSet all the methods that would result in a
// match if passed to routingNode.match with the given host and path.
export function matchingMethods<H>(
  root: RoutingNode<H>,
  host: string,
  path: string,
  methodSet: Set<string>,
): void {
  if (host !== "") {
    matchingMethodsPath(root.findChild(host), path, methodSet);
  }
  matchingMethodsPath(root.emptyChild, path, methodSet);
  if (methodSet.has("GET")) {
    methodSet.add("HEAD");
  }
}

function matchingMethodsPath<H>(
  n: RoutingNode<H> | undefined,
  path: string,
  set: Set<string>,
): void {
  if (!n) {
    return;
  }
  for (const [method, c] of n.children) {
    const [p] = matchPath(c, path, []);
    if (p) {
      set.add(method);
    }
  }
}

// ---------------------------------------------------------------------------
// server.go

// path.Clean
export function cleanSlashPath(p: string): string {
  if (p === "") {
    return ".";
  }
  const rooted = p.startsWith("/");
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!rooted) {
        out.push("..");
      }
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  if (rooted) {
    return `/${joined}`;
  }
  return joined === "" ? "." : joined;
}

// cleanPath returns the canonical path for p, eliminating . and .. elements.
export function cleanPath(p: string): string {
  if (p === "") {
    return "/";
  }
  if (p[0] !== "/") {
    p = `/${p}`;
  }
  let np = cleanSlashPath(p);
  // path.Clean removes trailing slash except for root;
  // put the trailing slash back if necessary.
  if (p[p.length - 1] === "/" && np !== "/") {
    np += "/";
  }
  return np;
}

// stripHostPort returns h without any trailing ":<port>".
export function stripHostPort(h: string): string {
  // If no port on host, return unchanged
  if (!h.includes(":")) {
    return h;
  }
  // net.SplitHostPort
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end === -1 || h[end + 1] !== ":" || h.slice(end + 2).includes(":")) {
      return h; // on error, return unchanged
    }
    const host = h.slice(1, end);
    return host.includes("]") ? h : host;
  }
  const colon = h.lastIndexOf(":");
  const host = h.slice(0, colon);
  if (host.includes(":") || host.includes("[") || host.includes("]")) {
    return h;
  }
  return host;
}

// exactMatch reports whether the node's pattern exactly matches the path.
// As a special case, if the node is undefined, exactMatch returns false.
//
// With wildcards, an inexact match is any one where a multi wildcard
// matches a non-empty string. All other matches are exact.
function exactMatch<H>(n: RoutingNode<H> | undefined, path: string): boolean {
  if (!n) {
    return false;
  }
  const pattern = n.pattern as Pattern;
  // If there is no multi, the match is exact.
  if (!pattern.lastSegment().multi) {
    return true;
  }
  // If the path doesn't end in a trailing slash, then the multi match
  // is non-empty.
  if (path.length > 0 && path[path.length - 1] !== "/") {
    return false;
  }
  // Only patterns ending in {$} or a multi wildcard can
  // match a path with a trailing slash.
  // For the match to be exact, the number of pattern
  // segments should be the same as the number of slashes in the path.
  // E.g. "/a/b/{$}" and "/a/b/{...}" exactly match "/a/b/", but "/a/" does not.
  return pattern.segments.length === path.split("/").length - 1;
}

// urlFromEscaped: the redirect target for an escaped path and a raw query
// (url.URL.String of a path-only URL).
function urlFromEscaped(escaped: string, rawQuery: string): string {
  return rawQuery === "" ? escaped : `${escaped}?${rawQuery}`;
}

export interface MuxRequest {
  method: string;
  // the Host header (r.Host)
  host: string;
  // r.URL.EscapedPath()
  escapedPath: string;
  // r.URL.RawQuery
  rawQuery: string;
}

export type MuxResult<H> =
  | { kind: "handler"; handler: H; pattern: Pattern; matches: string[] }
  | { kind: "redirect"; url: string }
  | { kind: "methodNotAllowed"; allow: string[] }
  | { kind: "notFound" };

// ServeMux is an HTTP request multiplexer (routing only: the caller writes
// the redirect, 404 and 405 responses with writeMuxResponse).
export class ServeMux<H> {
  #tree = new RoutingNode<H>();
  #patterns: Pattern[] = [];

  // Handle registers the handler for the given pattern. It throws if the
  // pattern is invalid or conflicts with one that is already registered.
  handle(patstr: string, handler: H): void {
    if (patstr === "") {
      throw new Error("http: invalid pattern");
    }
    let pat: Pattern;
    try {
      pat = parsePattern(patstr);
    } catch (err) {
      throw new Error(`parsing ${goQuote(patstr)}: ${(err as Error).message}`, { cause: err });
    }
    // Check for conflict.
    for (const pat2 of this.#patterns) {
      if (conflictsWith(pat, pat2)) {
        const d = describeConflict(pat, pat2);
        throw new Error(
          `pattern ${goQuote(pat.str)} conflicts with pattern ${goQuote(pat2.str)}:\n${d}`,
        );
      }
    }
    this.#tree.addPattern(pat, handler);
    this.#patterns.push(pat);
  }

  // findHandler finds a handler for a request.
  // If there is a matching handler, it returns it and the pattern that matched.
  // Otherwise it returns a redirect, method not allowed or not found result.
  findHandler(r: MuxRequest): MuxResult<H> {
    const escapedPath = r.escapedPath;
    let host: string;
    let path: string;
    let n: RoutingNode<H> | undefined;
    let matches: string[];
    // CONNECT requests are not canonicalized.
    if (r.method === "CONNECT") {
      // If r.URL.Path is /tree and its handler is not registered,
      // the /tree -> /tree/ redirect applies to CONNECT requests
      // but the path canonicalization does not.
      path = escapedPath;
      // r.URL.Host is empty for origin-form request targets
      const [, , u] = this.#matchOrRedirect("", r.method, path, r);
      if (u !== undefined) {
        return { kind: "redirect", url: u };
      }
      // Redo the match, this time with r.Host instead of r.URL.Host.
      // Pass no URL to skip the trailing-slash redirect logic.
      host = r.host;
      [n, matches] = this.#matchOrRedirect(host, r.method, path, undefined);
    } else {
      // All other requests have any port stripped and path cleaned
      // before passing to mux.handler.
      host = stripHostPort(r.host);
      path = cleanPath(escapedPath);

      // If the given path is /tree and its handler is not registered,
      // redirect for /tree/.
      let u: string | undefined;
      [n, matches, u] = this.#matchOrRedirect(host, r.method, path, r);
      if (u !== undefined) {
        return { kind: "redirect", url: u };
      }
      if (path !== escapedPath) {
        // Redirect to cleaned path.
        return { kind: "redirect", url: urlFromEscaped(path, r.rawQuery) };
      }
    }
    if (!n) {
      // We didn't find a match with the request method. To distinguish between
      // Not Found and Method Not Allowed, see if there is another pattern that
      // matches except for the method.
      const allowedMethods = this.#matchingMethods(host, path);
      if (allowedMethods.length > 0) {
        return { kind: "methodNotAllowed", allow: allowedMethods };
      }
      return { kind: "notFound" };
    }
    return {
      kind: "handler",
      handler: n.handler as H,
      pattern: n.pattern as Pattern,
      matches,
    };
  }

  // matchOrRedirect looks up a node in the tree that matches the host, method and path.
  //
  // If the url argument is defined, it also deals with trailing-slash
  // redirection: when a path doesn't match exactly, the match is tried again
  // after appending "/" to the path. If that second match succeeds, the last
  // return value is the URL to redirect to.
  #matchOrRedirect(
    host: string,
    method: string,
    path: string,
    u: MuxRequest | undefined,
  ): [RoutingNode<H> | undefined, string[], string | undefined] {
    const [n, matches] = match(this.#tree, host, method, path);
    // We can terminate here if any of the following is true:
    // - We have an exact match already.
    // - We were asked not to try trailing slash redirection.
    // - The URL already has a trailing slash.
    // - The URL is an empty string.
    if (!exactMatch(n, path) && u !== undefined && !path.endsWith("/") && path !== "") {
      // If there is an exact match with a trailing slash, then redirect.
      path += "/";
      const [n2] = match(this.#tree, host, method, path);
      if (exactMatch(n2, path)) {
        return [n2, [], urlFromEscaped(path, u.rawQuery)];
      }
    }
    return [n, matches, undefined];
  }

  // matchingMethods return a sorted list of all methods that would match with the given host and path.
  #matchingMethods(host: string, path: string): string[] {
    const ms = new Set<string>();
    matchingMethods(this.#tree, host, path, ms);
    // matchOrRedirect will try appending a trailing slash if there is no match.
    if (!path.endsWith("/")) {
      matchingMethods(this.#tree, host, `${path}/`, ms);
    }
    return [...ms].toSorted();
  }
}
