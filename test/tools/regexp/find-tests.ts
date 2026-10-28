// Upstream: Go go1.27.2 src/regexp/find_test.go (findTests), converted case for case.

// For each pattern/text pair, what is the expected output of each function?
// We can derive the textual results from the indexed results, the non-submatch
// results from the submatched results, the single results from the 'all' results,
// and the byte results from the string results. Therefore the table includes
// only the FindAllStringSubmatchIndex result.
export interface FindTest {
  pat: string;
  text: string;
  max: number;
  matches: number[][] | null;
}

export const findTests: FindTest[] = [
  { pat: "", text: "", max: -1, matches: [[0, 0]] },
  { pat: "^abcdefg", text: "abcdefg", max: -1, matches: [[0, 7]] },
  { pat: "a+", text: "baaab", max: -1, matches: [[1, 4]] },
  {
    pat: "a",
    text: "bababaab",
    max: -1,
    matches: [
      [1, 2],
      [3, 4],
      [5, 6],
      [6, 7],
    ],
  },
  { pat: "a", text: "bababaab", max: 0, matches: null },
  { pat: "a", text: "bababaab", max: 1, matches: [[1, 2]] },
  {
    pat: "a",
    text: "bababaab",
    max: 2,
    matches: [
      [1, 2],
      [3, 4],
    ],
  },
  {
    pat: "a",
    text: "bababaab",
    max: 3,
    matches: [
      [1, 2],
      [3, 4],
      [5, 6],
    ],
  },
  {
    pat: "a",
    text: "bababaab",
    max: 4,
    matches: [
      [1, 2],
      [3, 4],
      [5, 6],
      [6, 7],
    ],
  },
  {
    pat: "a",
    text: "bababaab",
    max: 5,
    matches: [
      [1, 2],
      [3, 4],
      [5, 6],
      [6, 7],
    ],
  },
  { pat: "abcd..", text: "abcdef", max: -1, matches: [[0, 6]] },
  { pat: "a", text: "a", max: -1, matches: [[0, 1]] },
  { pat: "x", text: "y", max: -1, matches: null },
  { pat: "b", text: "abc", max: -1, matches: [[1, 2]] },
  { pat: ".", text: "a", max: -1, matches: [[0, 1]] },
  { pat: ".*", text: "abcdef", max: -1, matches: [[0, 6]] },
  { pat: "^", text: "abcde", max: -1, matches: [[0, 0]] },
  { pat: "$", text: "abcde", max: -1, matches: [[5, 5]] },
  { pat: "^abcd$", text: "abcd", max: -1, matches: [[0, 4]] },
  { pat: "^bcd'", text: "abcdef", max: -1, matches: null },
  { pat: "^abcd$", text: "abcde", max: -1, matches: null },
  { pat: "a+", text: "baaab", max: -1, matches: [[1, 4]] },
  {
    pat: "a*",
    text: "baaab",
    max: -1,
    matches: [
      [0, 0],
      [1, 4],
      [5, 5],
    ],
  },
  { pat: "[a-z]+", text: "abcd", max: -1, matches: [[0, 4]] },
  { pat: "[^a-z]+", text: "ab1234cd", max: -1, matches: [[2, 6]] },
  {
    pat: "[a\\-\\]z]+",
    text: "az]-bcz",
    max: -1,
    matches: [
      [0, 4],
      [6, 7],
    ],
  },
  { pat: "[^\\n]+", text: "abcd\n", max: -1, matches: [[0, 4]] },
  { pat: "[日本語]+", text: "日本語日本語", max: -1, matches: [[0, 18]] },
  { pat: "日本語+", text: "日本語", max: -1, matches: [[0, 9]] },
  { pat: "日本語+", text: "日本語語語語", max: -1, matches: [[0, 18]] },
  { pat: "()", text: "", max: -1, matches: [[0, 0, 0, 0]] },
  { pat: "(a)", text: "a", max: -1, matches: [[0, 1, 0, 1]] },
  { pat: "(.)(.)", text: "日a", max: -1, matches: [[0, 4, 0, 3, 3, 4]] },
  { pat: "(.*)", text: "", max: -1, matches: [[0, 0, 0, 0]] },
  { pat: "(.*)", text: "abcd", max: -1, matches: [[0, 4, 0, 4]] },
  { pat: "(..)(..)", text: "abcd", max: -1, matches: [[0, 4, 0, 2, 2, 4]] },
  { pat: "(([^xyz]*)(d))", text: "abcd", max: -1, matches: [[0, 4, 0, 4, 0, 3, 3, 4]] },
  { pat: "((a|b|c)*(d))", text: "abcd", max: -1, matches: [[0, 4, 0, 4, 2, 3, 3, 4]] },
  { pat: "(((a|b|c)*)(d))", text: "abcd", max: -1, matches: [[0, 4, 0, 4, 0, 3, 2, 3, 3, 4]] },
  { pat: "\\a\\f\\n\\r\\t\\v", text: "\x07\x0c\n\r\t\x0b", max: -1, matches: [[0, 6]] },
  { pat: "[\\a\\f\\n\\r\\t\\v]+", text: "\x07\x0c\n\r\t\x0b", max: -1, matches: [[0, 6]] },

  { pat: "a*(|(b))c*", text: "aacc", max: -1, matches: [[0, 4, 2, 2, -1, -1]] },
  { pat: "(.*).*", text: "ab", max: -1, matches: [[0, 2, 0, 2]] },
  { pat: "[.]", text: ".", max: -1, matches: [[0, 1]] },
  { pat: "/$", text: "/abc/", max: -1, matches: [[4, 5]] },
  { pat: "/$", text: "/abc", max: -1, matches: null },

  // multiple matches
  {
    pat: ".",
    text: "abc",
    max: -1,
    matches: [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
  },
  {
    pat: "(.)",
    text: "abc",
    max: -1,
    matches: [
      [0, 1, 0, 1],
      [1, 2, 1, 2],
      [2, 3, 2, 3],
    ],
  },
  {
    pat: ".(.)",
    text: "abcd",
    max: -1,
    matches: [
      [0, 2, 1, 2],
      [2, 4, 3, 4],
    ],
  },
  {
    pat: "ab*",
    text: "abbaab",
    max: -1,
    matches: [
      [0, 3],
      [3, 4],
      [4, 6],
    ],
  },
  {
    pat: "a(b*)",
    text: "abbaab",
    max: -1,
    matches: [
      [0, 3, 1, 3],
      [3, 4, 4, 4],
      [4, 6, 5, 6],
    ],
  },

  // fixed bugs
  { pat: "ab$", text: "cab", max: -1, matches: [[1, 3]] },
  { pat: "axxb$", text: "axxcb", max: -1, matches: null },
  { pat: "data", text: "daXY data", max: -1, matches: [[5, 9]] },
  { pat: "da(.)a$", text: "daXY data", max: -1, matches: [[5, 9, 7, 8]] },
  { pat: "zx+", text: "zzx", max: -1, matches: [[1, 3]] },
  { pat: "ab$", text: "abcab", max: -1, matches: [[3, 5]] },
  { pat: "(aa)*$", text: "a", max: -1, matches: [[1, 1, -1, -1]] },
  { pat: "(?:.|(?:.a))", text: "", max: -1, matches: null },
  { pat: "(?:A(?:A|a))", text: "Aa", max: -1, matches: [[0, 2]] },
  { pat: "(?:A|(?:A|a))", text: "a", max: -1, matches: [[0, 1]] },
  { pat: "(a){0}", text: "", max: -1, matches: [[0, 0, -1, -1]] },
  { pat: "(?-s)(?:(?:^).)", text: "\n", max: -1, matches: null },
  { pat: "(?s)(?:(?:^).)", text: "\n", max: -1, matches: [[0, 1]] },
  { pat: "(?:(?:^).)", text: "\n", max: -1, matches: null },
  {
    pat: "\\b",
    text: "x",
    max: -1,
    matches: [
      [0, 0],
      [1, 1],
    ],
  },
  {
    pat: "\\b",
    text: "xx",
    max: -1,
    matches: [
      [0, 0],
      [2, 2],
    ],
  },
  {
    pat: "\\b",
    text: "x y",
    max: -1,
    matches: [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ],
  },
  {
    pat: "\\b",
    text: "xx yy",
    max: -1,
    matches: [
      [0, 0],
      [2, 2],
      [3, 3],
      [5, 5],
    ],
  },
  { pat: "\\B", text: "x", max: -1, matches: null },
  { pat: "\\B", text: "xx", max: -1, matches: [[1, 1]] },
  { pat: "\\B", text: "x y", max: -1, matches: null },
  {
    pat: "\\B",
    text: "xx yy",
    max: -1,
    matches: [
      [1, 1],
      [4, 4],
    ],
  },
  {
    pat: "(|a)*",
    text: "aa",
    max: -1,
    matches: [
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [2, 2, 2, 2],
    ],
  },
  { pat: "0A|0[aA]", text: "0a", max: -1, matches: [[0, 2]] },
  { pat: "0[aA]|0A", text: "0a", max: -1, matches: [[0, 2]] },

  // RE2 tests
  { pat: "[^\\S\\s]", text: "abcd", max: -1, matches: null },
  { pat: "[^\\S[:space:]]", text: "abcd", max: -1, matches: null },
  { pat: "[^\\D\\d]", text: "abcd", max: -1, matches: null },
  { pat: "[^\\D[:digit:]]", text: "abcd", max: -1, matches: null },
  { pat: "(?i)\\W", text: "x", max: -1, matches: null },
  { pat: "(?i)\\W", text: "k", max: -1, matches: null },
  { pat: "(?i)\\W", text: "s", max: -1, matches: null },

  // can backslash-escape any punctuation
  {
    pat: "\\!\\\"\\#\\$\\%\\&\\'\\(\\)\\*\\+\\,\\-\\.\\/\\:\\;\\<\\=\\>\\?\\@\\[\\\\\\]\\^\\_\\{\\|\\}\\~",
    text: "!\"#$%&'()*+,-./:;<=>?@[\\]^_{|}~",
    max: -1,
    matches: [[0, 31]],
  },
  {
    pat: "[\\!\\\"\\#\\$\\%\\&\\'\\(\\)\\*\\+\\,\\-\\.\\/\\:\\;\\<\\=\\>\\?\\@\\[\\\\\\]\\^\\_\\{\\|\\}\\~]+",
    text: "!\"#$%&'()*+,-./:;<=>?@[\\]^_{|}~",
    max: -1,
    matches: [[0, 31]],
  },
  { pat: "\\`", text: "`", max: -1, matches: [[0, 1]] },
  { pat: "[\\`]+", text: "`", max: -1, matches: [[0, 1]] },

  { pat: "�", text: "\udcff", max: -1, matches: [[0, 1]] },
  { pat: "�", text: "hello\udcffworld", max: -1, matches: [[5, 6]] },
  { pat: ".*", text: "hello\udcffworld", max: -1, matches: [[0, 11]] },
  { pat: "\\x{fffd}", text: "\udcc2\x00", max: -1, matches: [[0, 1]] },
  { pat: "[�]", text: "\udcff", max: -1, matches: [[0, 1]] },
  { pat: "[\\x{fffd}]", text: "\udcc2\x00", max: -1, matches: [[0, 1]] },

  // long set of matches (longer than startSize)
  {
    pat: ".",
    text: "qwertyuiopasdfghjklzxcvbnm1234567890",
    max: -1,
    matches: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 8],
      [8, 9],
      [9, 10],
      [10, 11],
      [11, 12],
      [12, 13],
      [13, 14],
      [14, 15],
      [15, 16],
      [16, 17],
      [17, 18],
      [18, 19],
      [19, 20],
      [20, 21],
      [21, 22],
      [22, 23],
      [23, 24],
      [24, 25],
      [25, 26],
      [26, 27],
      [27, 28],
      [28, 29],
      [29, 30],
      [30, 31],
      [31, 32],
      [32, 33],
      [33, 34],
      [34, 35],
      [35, 36],
    ],
  },
];
