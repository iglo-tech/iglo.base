// Upstream: Go 1.27.2 net/http pattern_test.go and routing_tree_test.go (the tables for parsing, precedence, conflicts and tree matching).
import {
  type Relationship,
  ServeMux,
  commonPath,
  comparePaths,
  compareMethods,
  conflictsWith,
  describeConflict,
  differencePath,
  firstSegment,
  match,
  matchingMethods,
  parsePattern,
  RoutingNode,
} from "@/server/mux";
import { describe, expect, test } from "bun:test";

interface Seg {
  s: string;
  wild: boolean;
  multi: boolean;
}

// Go's segment helpers in pattern_test.go
const lit = (s: string): Seg => ({ s, wild: false, multi: false });
const wild = (s: string): Seg => ({ s, wild: true, multi: false });
const multi = (s: string): Seg => ({ s, wild: true, multi: true });

const inverseRelationship: Record<Relationship, Relationship> = {
  equivalent: "equivalent",
  disjoint: "disjoint",
  overlaps: "overlaps",
  moreGeneral: "moreSpecific",
  moreSpecific: "moreGeneral",
};

// buildTree mirrors routing_tree_test.go's buildTree; the handler is the pattern string.
function buildTree(...pats: string[]): RoutingNode<string> {
  const root = new RoutingNode<string>();
  for (const p of pats) {
    root.addPattern(parsePattern(p), p);
  }
  return root;
}

describe("parsePattern", () => {
  const cases: { in: string; method?: string; host?: string; segments: Seg[] }[] = [
    { in: "/", segments: [multi("")] },
    { in: "/a", segments: [lit("a")] },
    { in: "/a/", segments: [lit("a"), multi("")] },
    { in: "/path/to/something", segments: [lit("path"), lit("to"), lit("something")] },
    { in: "/{w1}/lit/{w2}", segments: [wild("w1"), lit("lit"), wild("w2")] },
    { in: "/{w1}/lit/{w2}/", segments: [wild("w1"), lit("lit"), wild("w2"), multi("")] },
    { in: "example.com/", host: "example.com", segments: [multi("")] },
    { in: "GET /", method: "GET", segments: [multi("")] },
    {
      in: "POST example.com/foo/{w}",
      method: "POST",
      host: "example.com",
      segments: [lit("foo"), wild("w")],
    },
    { in: "/{$}", segments: [lit("/")] },
    {
      in: "DELETE example.com/a/{foo12}/{$}",
      method: "DELETE",
      host: "example.com",
      segments: [lit("a"), wild("foo12"), lit("/")],
    },
    { in: "/foo/{$}", segments: [lit("foo"), lit("/")] },
    { in: "/{a}/foo/{rest...}", segments: [wild("a"), lit("foo"), multi("rest")] },
    { in: "//", segments: [lit(""), multi("")] },
    {
      in: "/foo///./../bar",
      segments: [lit("foo"), lit(""), lit(""), lit("."), lit(".."), lit("bar")],
    },
    { in: "a.com/foo//", host: "a.com", segments: [lit("foo"), lit(""), multi("")] },
    { in: "/%61%62/%7b/%", segments: [lit("ab"), lit("{"), lit("%")] },
    // Allow multiple spaces matching regexp '[ \t]+' between method and path.
    { in: "GET\t  /", method: "GET", segments: [multi("")] },
    {
      in: "POST \t  example.com/foo/{w}",
      method: "POST",
      host: "example.com",
      segments: [lit("foo"), wild("w")],
    },
    {
      in: "DELETE    \texample.com/a/{foo12}/{$}",
      method: "DELETE",
      host: "example.com",
      segments: [lit("a"), wild("foo12"), lit("/")],
    },
  ];

  for (const c of cases) {
    test(JSON.stringify(c.in), () => {
      const got = parsePattern(c.in);
      expect(got.method).toBe(c.method ?? "");
      expect(got.host).toBe(c.host ?? "");
      expect([...got.segments]).toEqual(c.segments);
    });
  }
});

describe("parsePattern errors", () => {
  const cases: { in: string; contains: string }[] = [
    { in: "", contains: "empty pattern" },
    { in: "A=B /", contains: "at offset 0: invalid method" },
    { in: " ", contains: "at offset 1: host/path missing /" },
    { in: "/{w}x", contains: "at offset 1: bad wildcard segment" },
    { in: "/x{w}", contains: "at offset 1: bad wildcard segment" },
    { in: "/{wx", contains: "at offset 1: bad wildcard segment" },
    { in: "/a/{/}/c", contains: "at offset 3: bad wildcard segment" },
    // wildcard names aren't unescaped
    { in: "/a/{%61}/c", contains: "at offset 3: bad wildcard name" },
    { in: "/{a$}", contains: "at offset 1: bad wildcard name" },
    { in: "/{}", contains: "at offset 1: empty wildcard" },
    { in: "POST a.com/x/{}/y", contains: "at offset 13: empty wildcard" },
    { in: "/{...}", contains: "at offset 1: empty wildcard" },
    { in: "/{$...}", contains: "at offset 1: bad wildcard" },
    { in: "/{$}/", contains: "at offset 1: {$} not at end" },
    { in: "/{$}/x", contains: "at offset 1: {$} not at end" },
    { in: "/abc/{$}/x", contains: "at offset 5: {$} not at end" },
    { in: "/{a...}/", contains: "at offset 1: {...} wildcard not at end" },
    { in: "/{a...}/x", contains: "at offset 1: {...} wildcard not at end" },
    {
      in: "{a}/b",
      contains: "at offset 0: host contains '{' (missing initial '/'?)",
    },
    { in: "/a/{x}/b/{x...}", contains: "at offset 9: duplicate wildcard name" },
    { in: "GET //", contains: "at offset 4: non-CONNECT pattern with unclean path" },
  ];

  for (const c of cases) {
    test(JSON.stringify(c.in), () => {
      expect(() => parsePattern(c.in)).toThrow(c.contains);
    });
  }
});

describe("compareMethods", () => {
  const cases: { p1: string; p2: string; want: Relationship }[] = [
    { p1: "/", p2: "/", want: "equivalent" },
    { p1: "GET /", p2: "GET /", want: "equivalent" },
    { p1: "HEAD /", p2: "HEAD /", want: "equivalent" },
    { p1: "POST /", p2: "POST /", want: "equivalent" },
    { p1: "GET /", p2: "POST /", want: "disjoint" },
    { p1: "GET /", p2: "/", want: "moreSpecific" },
    { p1: "HEAD /", p2: "/", want: "moreSpecific" },
    { p1: "GET /", p2: "HEAD /", want: "moreGeneral" },
  ];

  for (const c of cases) {
    test(`${c.p1} vs ${c.p2} is ${c.want}`, () => {
      const pat1 = parsePattern(c.p1);
      const pat2 = parsePattern(c.p2);
      expect(compareMethods(pat1, pat2)).toBe(c.want);
      expect(compareMethods(pat2, pat1)).toBe(inverseRelationship[c.want]);
    });
  }
});

describe("comparePaths", () => {
  const cases: { p1: string; p2: string; want: Relationship }[] = [
    // A literal should be more specific than anything it overlaps, except itself.
    { p1: "/a", p2: "/a", want: "equivalent" },
    { p1: "/a", p2: "/b", want: "disjoint" },
    { p1: "/a", p2: "/", want: "moreSpecific" },
    { p1: "/a", p2: "/{$}", want: "disjoint" },
    { p1: "/a", p2: "/{x}", want: "moreSpecific" },
    { p1: "/a", p2: "/{x...}", want: "moreSpecific" },

    // Adding a segment doesn't change that.
    { p1: "/b/a", p2: "/b/a", want: "equivalent" },
    { p1: "/b/a", p2: "/b/b", want: "disjoint" },
    { p1: "/b/a", p2: "/b/", want: "moreSpecific" },
    { p1: "/b/a", p2: "/b/{$}", want: "disjoint" },
    { p1: "/b/a", p2: "/b/{x}", want: "moreSpecific" },
    { p1: "/b/a", p2: "/b/{x...}", want: "moreSpecific" },
    { p1: "/{z}/a", p2: "/{z}/a", want: "equivalent" },
    { p1: "/{z}/a", p2: "/{z}/b", want: "disjoint" },
    { p1: "/{z}/a", p2: "/{z}/", want: "moreSpecific" },
    { p1: "/{z}/a", p2: "/{z}/{$}", want: "disjoint" },
    { p1: "/{z}/a", p2: "/{z}/{x}", want: "moreSpecific" },
    { p1: "/{z}/a", p2: "/{z}/{x...}", want: "moreSpecific" },

    // Single wildcard on left.
    { p1: "/{z}", p2: "/a", want: "moreGeneral" },
    { p1: "/{z}", p2: "/a/b", want: "disjoint" },
    { p1: "/{z}", p2: "/{$}", want: "disjoint" },
    { p1: "/{z}", p2: "/{x}", want: "equivalent" },
    { p1: "/{z}", p2: "/", want: "moreSpecific" },
    { p1: "/{z}", p2: "/{x...}", want: "moreSpecific" },
    { p1: "/b/{z}", p2: "/b/a", want: "moreGeneral" },
    { p1: "/b/{z}", p2: "/b/a/b", want: "disjoint" },
    { p1: "/b/{z}", p2: "/b/{$}", want: "disjoint" },
    { p1: "/b/{z}", p2: "/b/{x}", want: "equivalent" },
    { p1: "/b/{z}", p2: "/b/", want: "moreSpecific" },
    { p1: "/b/{z}", p2: "/b/{x...}", want: "moreSpecific" },

    // Trailing slash on left.
    { p1: "/", p2: "/a", want: "moreGeneral" },
    { p1: "/", p2: "/a/b", want: "moreGeneral" },
    { p1: "/", p2: "/{$}", want: "moreGeneral" },
    { p1: "/", p2: "/{x}", want: "moreGeneral" },
    { p1: "/", p2: "/", want: "equivalent" },
    { p1: "/", p2: "/{x...}", want: "equivalent" },

    { p1: "/b/", p2: "/b/a", want: "moreGeneral" },
    { p1: "/b/", p2: "/b/a/b", want: "moreGeneral" },
    { p1: "/b/", p2: "/b/{$}", want: "moreGeneral" },
    { p1: "/b/", p2: "/b/{x}", want: "moreGeneral" },
    { p1: "/b/", p2: "/b/", want: "equivalent" },
    { p1: "/b/", p2: "/b/{x...}", want: "equivalent" },

    { p1: "/{z}/", p2: "/{z}/a", want: "moreGeneral" },
    { p1: "/{z}/", p2: "/{z}/a/b", want: "moreGeneral" },
    { p1: "/{z}/", p2: "/{z}/{$}", want: "moreGeneral" },
    { p1: "/{z}/", p2: "/{z}/{x}", want: "moreGeneral" },
    { p1: "/{z}/", p2: "/{z}/", want: "equivalent" },
    { p1: "/{z}/", p2: "/a/", want: "moreGeneral" },
    { p1: "/{z}/", p2: "/{z}/{x...}", want: "equivalent" },
    { p1: "/{z}/", p2: "/a/{x...}", want: "moreGeneral" },
    { p1: "/a/{z}/", p2: "/{z}/a/", want: "overlaps" },
    { p1: "/a/{z}/b/", p2: "/{x}/c/{y...}", want: "overlaps" },

    // Multi wildcard on left.
    { p1: "/{m...}", p2: "/a", want: "moreGeneral" },
    { p1: "/{m...}", p2: "/a/b", want: "moreGeneral" },
    { p1: "/{m...}", p2: "/{$}", want: "moreGeneral" },
    { p1: "/{m...}", p2: "/{x}", want: "moreGeneral" },
    { p1: "/{m...}", p2: "/", want: "equivalent" },
    { p1: "/{m...}", p2: "/{x...}", want: "equivalent" },

    { p1: "/b/{m...}", p2: "/b/a", want: "moreGeneral" },
    { p1: "/b/{m...}", p2: "/b/a/b", want: "moreGeneral" },
    { p1: "/b/{m...}", p2: "/b/{$}", want: "moreGeneral" },
    { p1: "/b/{m...}", p2: "/b/{x}", want: "moreGeneral" },
    { p1: "/b/{m...}", p2: "/b/", want: "equivalent" },
    { p1: "/b/{m...}", p2: "/b/{x...}", want: "equivalent" },
    { p1: "/b/{m...}", p2: "/a/{x...}", want: "disjoint" },

    { p1: "/{z}/{m...}", p2: "/{z}/a", want: "moreGeneral" },
    { p1: "/{z}/{m...}", p2: "/{z}/a/b", want: "moreGeneral" },
    { p1: "/{z}/{m...}", p2: "/{z}/{$}", want: "moreGeneral" },
    { p1: "/{z}/{m...}", p2: "/{z}/{x}", want: "moreGeneral" },
    { p1: "/{z}/{m...}", p2: "/{w}/", want: "equivalent" },
    { p1: "/{z}/{m...}", p2: "/a/", want: "moreGeneral" },
    { p1: "/{z}/{m...}", p2: "/{z}/{x...}", want: "equivalent" },
    { p1: "/{z}/{m...}", p2: "/a/{x...}", want: "moreGeneral" },
    { p1: "/a/{m...}", p2: "/a/b/{y...}", want: "moreGeneral" },
    { p1: "/a/{m...}", p2: "/a/{x}/{y...}", want: "moreGeneral" },
    { p1: "/a/{z}/{m...}", p2: "/a/b/{y...}", want: "moreGeneral" },
    { p1: "/a/{z}/{m...}", p2: "/{z}/a/", want: "overlaps" },
    { p1: "/a/{z}/{m...}", p2: "/{z}/b/{y...}", want: "overlaps" },
    { p1: "/a/{z}/b/{m...}", p2: "/{x}/c/{y...}", want: "overlaps" },
    { p1: "/a/{z}/a/{m...}", p2: "/{x}/b", want: "disjoint" },

    // Dollar on left.
    { p1: "/{$}", p2: "/a", want: "disjoint" },
    { p1: "/{$}", p2: "/a/b", want: "disjoint" },
    { p1: "/{$}", p2: "/{$}", want: "equivalent" },
    { p1: "/{$}", p2: "/{x}", want: "disjoint" },
    { p1: "/{$}", p2: "/", want: "moreSpecific" },
    { p1: "/{$}", p2: "/{x...}", want: "moreSpecific" },

    { p1: "/b/{$}", p2: "/b", want: "disjoint" },
    { p1: "/b/{$}", p2: "/b/a", want: "disjoint" },
    { p1: "/b/{$}", p2: "/b/a/b", want: "disjoint" },
    { p1: "/b/{$}", p2: "/b/{$}", want: "equivalent" },
    { p1: "/b/{$}", p2: "/b/{x}", want: "disjoint" },
    { p1: "/b/{$}", p2: "/b/", want: "moreSpecific" },
    { p1: "/b/{$}", p2: "/b/{x...}", want: "moreSpecific" },
    { p1: "/b/{$}", p2: "/b/c/{x...}", want: "disjoint" },
    { p1: "/b/{x}/a/{$}", p2: "/{x}/c/{y...}", want: "overlaps" },
    { p1: "/{x}/b/{$}", p2: "/a/{x}/{y}", want: "disjoint" },
    { p1: "/{x}/b/{$}", p2: "/a/{x}/c", want: "disjoint" },

    { p1: "/{z}/{$}", p2: "/{z}/a", want: "disjoint" },
    { p1: "/{z}/{$}", p2: "/{z}/a/b", want: "disjoint" },
    { p1: "/{z}/{$}", p2: "/{z}/{$}", want: "equivalent" },
    { p1: "/{z}/{$}", p2: "/{z}/{x}", want: "disjoint" },
    { p1: "/{z}/{$}", p2: "/{z}/", want: "moreSpecific" },
    { p1: "/{z}/{$}", p2: "/a/", want: "overlaps" },
    { p1: "/{z}/{$}", p2: "/a/{x...}", want: "overlaps" },
    { p1: "/{z}/{$}", p2: "/{z}/{x...}", want: "moreSpecific" },
    { p1: "/a/{z}/{$}", p2: "/{z}/a/", want: "overlaps" },
  ];

  for (const c of cases) {
    test(`${c.p1} vs ${c.p2} is ${c.want}`, () => {
      const pat1 = parsePattern(c.p1);
      const pat2 = parsePattern(c.p2);
      // A pattern matches itself.
      expect(comparePaths(pat1, pat1)).toBe("equivalent");
      expect(comparePaths(pat2, pat2)).toBe("equivalent");
      expect(comparePaths(pat1, pat2)).toBe(c.want);
      expect(comparePaths(pat2, pat1)).toBe(inverseRelationship[c.want]);
    });
  }
});

describe("conflictsWith", () => {
  const cases: { p1: string; p2: string; want: boolean }[] = [
    { p1: "/a", p2: "/a", want: true },
    { p1: "/a", p2: "/ab", want: false },
    { p1: "/a/b/cd", p2: "/a/b/cd", want: true },
    { p1: "/a/b/cd", p2: "/a/b/c", want: false },
    { p1: "/a/b/c", p2: "/a/c/c", want: false },
    { p1: "/{x}", p2: "/{y}", want: true },
    // more specific
    { p1: "/{x}", p2: "/a", want: false },
    { p1: "/{x}/{y}", p2: "/{x}/a", want: false },
    { p1: "/{x}/{y}", p2: "/{x}/a/b", want: false },
    { p1: "/{x}", p2: "/a/{y}", want: false },
    { p1: "/{x}/{y}", p2: "/{x}/a/", want: false },
    // more specific
    { p1: "/{x}", p2: "/a/{y...}", want: false },
    // more specific
    { p1: "/{x}/a/{y}", p2: "/{x}/a/{y...}", want: false },
    // more specific
    { p1: "/{x}/{y}", p2: "/{x}/a/{$}", want: false },
    { p1: "/{x}/{y}/{$}", p2: "/{x}/a/{$}", want: false },
    { p1: "/a/{x}", p2: "/{x}/b", want: true },
    { p1: "/", p2: "GET /", want: false },
    { p1: "/", p2: "GET /foo", want: false },
    { p1: "GET /", p2: "GET /foo", want: false },
    { p1: "GET /", p2: "/foo", want: true },
    { p1: "GET /foo", p2: "HEAD /", want: true },
  ];

  for (const c of cases) {
    test(`${c.p1} conflicts with ${c.p2} is ${c.want}`, () => {
      const pat1 = parsePattern(c.p1);
      const pat2 = parsePattern(c.p2);
      expect(conflictsWith(pat1, pat2)).toBe(c.want);
      // conflictsWith should be commutative.
      expect(conflictsWith(pat2, pat1)).toBe(c.want);
    });
  }
});

describe("ServeMux registration conflicts", () => {
  test("/a/{y}/{z...} conflicts with an already registered /a/{x}/", () => {
    const mux = new ServeMux<string>();
    mux.handle("/a/{x}/", "first");
    expect(() => mux.handle("/a/{y}/{z...}", "second")).toThrow("conflicts with");
  });
});

describe("describeConflict", () => {
  const cases: { p1: string; p2: string; want: string }[] = [
    { p1: "/a/{x}", p2: "/a/{y}", want: "the same requests" },
    { p1: "/", p2: "/{m...}", want: "the same requests" },
    { p1: "/a/{x}", p2: "/{y}/b", want: "both match some paths" },
    {
      p1: "/a",
      p2: "GET /{x}",
      want: "matches more methods than GET /{x}, but has a more specific path pattern",
    },
    {
      p1: "GET /a",
      p2: "HEAD /",
      want: "matches more methods than HEAD /, but has a more specific path pattern",
    },
    {
      p1: "POST /",
      p2: "/a",
      want: "matches fewer methods than /a, but has a more general path pattern",
    },
  ];

  for (const c of cases) {
    test(`${c.p1} vs. ${c.p2}`, () => {
      const got = describeConflict(parsePattern(c.p1), parsePattern(c.p2));
      expect(got).toContain(c.want);
    });
  }
});

describe("commonPath", () => {
  const cases: { p1: string; p2: string; want: string }[] = [
    { p1: "/a/{x}", p2: "/{x}/a", want: "/a/a" },
    { p1: "/a/{z}/", p2: "/{z}/a/", want: "/a/a/" },
    { p1: "/a/{z}/{m...}", p2: "/{z}/a/", want: "/a/a/" },
    { p1: "/{z}/{$}", p2: "/a/", want: "/a/" },
    { p1: "/{z}/{$}", p2: "/a/{x...}", want: "/a/" },
    { p1: "/a/{z}/{$}", p2: "/{z}/a/", want: "/a/a/" },
    { p1: "/a/{x}/b/{y...}", p2: "/{x}/c/{y...}", want: "/a/c/b/" },
    { p1: "/a/{x}/b/", p2: "/{x}/c/{y...}", want: "/a/c/b/" },
    { p1: "/a/{x}/b/{$}", p2: "/{x}/c/{y...}", want: "/a/c/b/" },
    { p1: "/a/{z}/{x...}", p2: "/{z}/b/{y...}", want: "/a/b/" },
  ];

  for (const c of cases) {
    test(`${c.p1} vs. ${c.p2}`, () => {
      const pat1 = parsePattern(c.p1);
      const pat2 = parsePattern(c.p2);
      expect(comparePaths(pat1, pat2)).toBe("overlaps");
      expect(commonPath(pat1, pat2)).toBe(c.want);
    });
  }
});

describe("differencePath", () => {
  const cases: { p1: string; p2: string; want: string }[] = [
    { p1: "/a/{x}", p2: "/{x}/a", want: "/a/x" },
    { p1: "/{x}/a", p2: "/a/{x}", want: "/x/a" },
    { p1: "/a/{z}/", p2: "/{z}/a/", want: "/a/z/" },
    { p1: "/{z}/a/", p2: "/a/{z}/", want: "/z/a/" },
    { p1: "/{a}/a/", p2: "/a/{z}/", want: "/ax/a/" },
    { p1: "/a/{z}/{x...}", p2: "/{z}/b/{y...}", want: "/a/z/" },
    { p1: "/{z}/b/{y...}", p2: "/a/{z}/{x...}", want: "/z/b/" },
    { p1: "/a/b/", p2: "/a/b/c", want: "/a/b/" },
    { p1: "/a/b/{x...}", p2: "/a/b/c", want: "/a/b/" },
    { p1: "/a/b/{x...}", p2: "/a/b/c/d", want: "/a/b/" },
    { p1: "/a/b/{x...}", p2: "/a/b/c/d/", want: "/a/b/" },
    { p1: "/a/{z}/{m...}", p2: "/{z}/a/", want: "/a/z/" },
    { p1: "/{z}/a/", p2: "/a/{z}/{m...}", want: "/z/a/" },
    { p1: "/{z}/{$}", p2: "/a/", want: "/z/" },
    { p1: "/a/", p2: "/{z}/{$}", want: "/a/x" },
    { p1: "/{z}/{$}", p2: "/a/{x...}", want: "/z/" },
    { p1: "/a/{foo...}", p2: "/{z}/{$}", want: "/a/foo" },
    { p1: "/a/{z}/{$}", p2: "/{z}/a/", want: "/a/z/" },
    { p1: "/{z}/a/", p2: "/a/{z}/{$}", want: "/z/a/x" },
    { p1: "/a/{x}/b/{y...}", p2: "/{x}/c/{y...}", want: "/a/x/b/" },
    { p1: "/{x}/c/{y...}", p2: "/a/{x}/b/{y...}", want: "/x/c/" },
    { p1: "/a/{c}/b/", p2: "/{x}/c/{y...}", want: "/a/cx/b/" },
    { p1: "/{x}/c/{y...}", p2: "/a/{c}/b/", want: "/x/c/" },
    { p1: "/a/{x}/b/{$}", p2: "/{x}/c/{y...}", want: "/a/x/b/" },
    { p1: "/{x}/c/{y...}", p2: "/a/{x}/b/{$}", want: "/x/c/" },
  ];

  for (const c of cases) {
    test(`${c.p1} vs. ${c.p2}`, () => {
      const pat1 = parsePattern(c.p1);
      const pat2 = parsePattern(c.p2);
      const rel = comparePaths(pat1, pat2);
      expect(rel === "overlaps" || rel === "moreGeneral").toBe(true);
      expect(differencePath(pat1, pat2)).toBe(c.want);
    });
  }
});

describe("firstSegment", () => {
  const cases: { in: string; want: string[] }[] = [
    { in: "/a/b/c", want: ["a", "b", "c"] },
    { in: "/a/b/", want: ["a", "b", "/"] },
    { in: "/", want: ["/"] },
    { in: "/a/%62/c", want: ["a", "b", "c"] },
    { in: "/a%2Fb%2fc", want: ["a/b/c"] },
  ];

  for (const c of cases) {
    test(c.in, () => {
      const got: string[] = [];
      let rest = c.in;
      while (rest.length > 0) {
        const [seg, next] = firstSegment(rest);
        got.push(seg);
        rest = next;
      }
      expect(got).toEqual(c.want);
    });
  }
});

// TestRoutingAddPattern compares Go's debug print of the tree (routingNode.print,
// test-only Go code that formats the tree structure). It checks an internal
// representation, not observable behavior, so it is not ported.

interface MatchCase {
  method: string;
  host: string;
  path: string;
  // "" for no match
  wantPat: string;
  wantMatches: string[];
}

function runMatchCases(tree: RoutingNode<string>, cases: MatchCase[]): void {
  for (const c of cases) {
    test(`${c.method} ${c.host} ${c.path} -> ${c.wantPat || "no match"}`, () => {
      const [node, matches] = match(tree, c.host, c.method, c.path);
      expect(node?.pattern?.str ?? "").toBe(c.wantPat);
      expect(matches).toEqual(c.wantMatches);
    });
  }
}

describe("RoutingNode match", () => {
  describe("base tree", () => {
    runMatchCases(
      buildTree(
        "/a",
        "/a/b",
        "/a/{x}",
        "/g/h/i",
        "/g/{x}/j",
        "/a/b/{x...}",
        "/a/b/{y}",
        "/a/b/{$}",
      ),
      [
        { method: "GET", host: "", path: "/a", wantPat: "/a", wantMatches: [] },
        { method: "Get", host: "", path: "/b", wantPat: "", wantMatches: [] },
        { method: "Get", host: "", path: "/a/b", wantPat: "/a/b", wantMatches: [] },
        { method: "Get", host: "", path: "/a/c", wantPat: "/a/{x}", wantMatches: ["c"] },
        { method: "Get", host: "", path: "/a/b/", wantPat: "/a/b/{$}", wantMatches: [] },
        { method: "Get", host: "", path: "/a/b/c", wantPat: "/a/b/{y}", wantMatches: ["c"] },
        {
          method: "Get",
          host: "",
          path: "/a/b/c/d",
          wantPat: "/a/b/{x...}",
          wantMatches: ["c/d"],
        },
        { method: "Get", host: "", path: "/g/h/i", wantPat: "/g/h/i", wantMatches: [] },
        { method: "Get", host: "", path: "/g/h/j", wantPat: "/g/{x}/j", wantMatches: ["h"] },
      ],
    );
  });

  describe("methods, hosts and multi wildcards", () => {
    runMatchCases(
      buildTree(
        "/item/",
        "POST /item/{user}",
        "GET /item/{user}",
        "/item/{user}",
        "/item/{user}/{id}",
        "/item/{user}/new",
        "/item/{$}",
        "POST alt.com/item/{user}",
        "GET /headwins",
        "HEAD /headwins",
        "/path/{p...}",
      ),
      [
        {
          method: "GET",
          host: "",
          path: "/item/jba",
          wantPat: "GET /item/{user}",
          wantMatches: ["jba"],
        },
        {
          method: "POST",
          host: "",
          path: "/item/jba",
          wantPat: "POST /item/{user}",
          wantMatches: ["jba"],
        },
        {
          method: "HEAD",
          host: "",
          path: "/item/jba",
          wantPat: "GET /item/{user}",
          wantMatches: ["jba"],
        },
        // method matches are case-sensitive
        {
          method: "get",
          host: "",
          path: "/item/jba",
          wantPat: "/item/{user}",
          wantMatches: ["jba"],
        },
        {
          method: "POST",
          host: "",
          path: "/item/jba/17",
          wantPat: "/item/{user}/{id}",
          wantMatches: ["jba", "17"],
        },
        {
          method: "GET",
          host: "",
          path: "/item/jba/new",
          wantPat: "/item/{user}/new",
          wantMatches: ["jba"],
        },
        { method: "GET", host: "", path: "/item/", wantPat: "/item/{$}", wantMatches: [] },
        { method: "GET", host: "", path: "/item/jba/17/line2", wantPat: "/item/", wantMatches: [] },
        {
          method: "POST",
          host: "alt.com",
          path: "/item/jba",
          wantPat: "POST alt.com/item/{user}",
          wantMatches: ["jba"],
        },
        {
          method: "GET",
          host: "alt.com",
          path: "/item/jba",
          wantPat: "GET /item/{user}",
          wantMatches: ["jba"],
        },
        // does not match
        { method: "GET", host: "", path: "/item", wantPat: "", wantMatches: [] },
        // HEAD is more specific than GET
        { method: "GET", host: "", path: "/headwins", wantPat: "GET /headwins", wantMatches: [] },
        { method: "HEAD", host: "", path: "/headwins", wantPat: "HEAD /headwins", wantMatches: [] },
        {
          method: "GET",
          host: "",
          path: "/path/to/file",
          wantPat: "/path/{p...}",
          wantMatches: ["to/file"],
        },
        { method: "GET", host: "", path: "/path/*", wantPat: "/path/{p...}", wantMatches: ["*"] },
      ],
    );
  });

  describe("pattern ending in {$}", () => {
    // A pattern ending in {$} should only match URLS with a trailing slash.
    const pat1 = "/a/b/{$}";
    runMatchCases(buildTree(pat1), [
      { method: "GET", host: "", path: "/a/b", wantPat: "", wantMatches: [] },
      { method: "GET", host: "", path: "/a/b/", wantPat: pat1, wantMatches: [] },
      { method: "GET", host: "", path: "/a/b/c", wantPat: "", wantMatches: [] },
      { method: "GET", host: "", path: "/a/b/c/d", wantPat: "", wantMatches: [] },
    ]);
  });

  describe("pattern ending in a single wildcard", () => {
    // A pattern ending in a single wildcard should not match a trailing slash URL.
    const pat2 = "/a/b/{w}";
    runMatchCases(buildTree(pat2), [
      { method: "GET", host: "", path: "/a/b", wantPat: "", wantMatches: [] },
      { method: "GET", host: "", path: "/a/b/", wantPat: "", wantMatches: [] },
      { method: "GET", host: "", path: "/a/b/c", wantPat: pat2, wantMatches: ["c"] },
      { method: "GET", host: "", path: "/a/b/c/d", wantPat: "", wantMatches: [] },
    ]);
  });

  describe("pattern ending in a multi wildcard", () => {
    // A pattern ending in a multi wildcard should match both URLs.
    const pat3 = "/a/b/{w...}";
    runMatchCases(buildTree(pat3), [
      { method: "GET", host: "", path: "/a/b", wantPat: "", wantMatches: [] },
      { method: "GET", host: "", path: "/a/b/", wantPat: pat3, wantMatches: [""] },
      { method: "GET", host: "", path: "/a/b/c", wantPat: pat3, wantMatches: ["c"] },
      { method: "GET", host: "", path: "/a/b/c/d", wantPat: pat3, wantMatches: ["c/d"] },
    ]);
  });

  describe("all three together", () => {
    // All three of the above should work together.
    const pat1 = "/a/b/{$}";
    const pat2 = "/a/b/{w}";
    const pat3 = "/a/b/{w...}";
    runMatchCases(buildTree(pat1, pat2, pat3), [
      { method: "GET", host: "", path: "/a/b", wantPat: "", wantMatches: [] },
      { method: "GET", host: "", path: "/a/b/", wantPat: pat1, wantMatches: [] },
      { method: "GET", host: "", path: "/a/b/c", wantPat: pat2, wantMatches: ["c"] },
      { method: "GET", host: "", path: "/a/b/c/d", wantPat: pat3, wantMatches: ["c/d"] },
    ]);
  });
});

describe("matchingMethods", () => {
  const hostTree = buildTree("GET a.com/", "PUT b.com/", "POST /foo/{x}");
  const cases: {
    name: string;
    tree: RoutingNode<string>;
    host: string;
    path: string;
    want: string;
  }[] = [
    { name: "post", tree: buildTree("POST /"), host: "", path: "/foo", want: "POST" },
    { name: "get", tree: buildTree("GET /"), host: "", path: "/foo", want: "GET,HEAD" },
    { name: "host", tree: hostTree, host: "", path: "/foo", want: "" },
    { name: "host", tree: hostTree, host: "", path: "/foo/bar", want: "POST" },
    { name: "host2", tree: hostTree, host: "a.com", path: "/foo/bar", want: "GET,HEAD,POST" },
    { name: "host3", tree: hostTree, host: "b.com", path: "/bar", want: "PUT" },
    // This case shouldn't come up because we only call matchingMethods
    // when there was no match, but we include it for completeness.
    { name: "empty", tree: buildTree("/"), host: "", path: "/", want: "" },
  ];

  for (const c of cases) {
    test(`${c.name}: ${c.host} ${c.path}`, () => {
      const ms = new Set<string>();
      matchingMethods(c.tree, c.host, c.path, ms);
      expect([...ms].toSorted().join(",")).toBe(c.want);
    });
  }
});
