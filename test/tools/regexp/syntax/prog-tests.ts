// Upstream: Go go1.27.2 src/regexp/syntax/prog_test.go (compileTests), converted case for case.

export const compileTests: { regexp: string; prog: string }[] = [
  {
    regexp: "a",
    prog: ["  0\tfail", '  1*\trune1 "a" -> 2', "  2\tmatch", ""].join("\n"),
  },
  {
    regexp: "[A-M][n-z]",
    prog: ["  0\tfail", '  1*\trune "AM" -> 2', '  2\trune "nz" -> 3', "  3\tmatch", ""].join("\n"),
  },
  {
    regexp: "",
    prog: ["  0\tfail", "  1*\tnop -> 2", "  2\tmatch", ""].join("\n"),
  },
  {
    regexp: "a?",
    prog: ["  0\tfail", '  1\trune1 "a" -> 3', "  2*\talt -> 1, 3", "  3\tmatch", ""].join("\n"),
  },
  {
    regexp: "a??",
    prog: ["  0\tfail", '  1\trune1 "a" -> 3', "  2*\talt -> 3, 1", "  3\tmatch", ""].join("\n"),
  },
  {
    regexp: "a+",
    prog: ["  0\tfail", '  1*\trune1 "a" -> 2', "  2\talt -> 1, 3", "  3\tmatch", ""].join("\n"),
  },
  {
    regexp: "a+?",
    prog: ["  0\tfail", '  1*\trune1 "a" -> 2', "  2\talt -> 3, 1", "  3\tmatch", ""].join("\n"),
  },
  {
    regexp: "a*",
    prog: ["  0\tfail", '  1\trune1 "a" -> 2', "  2*\talt -> 1, 3", "  3\tmatch", ""].join("\n"),
  },
  {
    regexp: "a*?",
    prog: ["  0\tfail", '  1\trune1 "a" -> 2', "  2*\talt -> 3, 1", "  3\tmatch", ""].join("\n"),
  },
  {
    regexp: "a+b+",
    prog: [
      "  0\tfail",
      '  1*\trune1 "a" -> 2',
      "  2\talt -> 1, 3",
      '  3\trune1 "b" -> 4',
      "  4\talt -> 3, 5",
      "  5\tmatch",
      "",
    ].join("\n"),
  },
  {
    regexp: "(a+)(b+)",
    prog: [
      "  0\tfail",
      "  1*\tcap 2 -> 2",
      '  2\trune1 "a" -> 3',
      "  3\talt -> 2, 4",
      "  4\tcap 3 -> 5",
      "  5\tcap 4 -> 6",
      '  6\trune1 "b" -> 7',
      "  7\talt -> 6, 8",
      "  8\tcap 5 -> 9",
      "  9\tmatch",
      "",
    ].join("\n"),
  },
  {
    regexp: "a+|b+",
    prog: [
      "  0\tfail",
      '  1\trune1 "a" -> 2',
      "  2\talt -> 1, 6",
      '  3\trune1 "b" -> 4',
      "  4\talt -> 3, 6",
      "  5*\talt -> 1, 3",
      "  6\tmatch",
      "",
    ].join("\n"),
  },
  {
    regexp: "A[Aa]",
    prog: ["  0\tfail", '  1*\trune1 "A" -> 2', '  2\trune "A"/i -> 3', "  3\tmatch", ""].join(
      "\n",
    ),
  },
  {
    regexp: "(?:(?:^).)",
    prog: ["  0\tfail", "  1*\tempty 4 -> 2", "  2\tanynotnl -> 3", "  3\tmatch", ""].join("\n"),
  },
  {
    regexp: "(?:|a)+",
    prog: [
      "  0\tfail",
      "  1\tnop -> 4",
      '  2\trune1 "a" -> 4',
      "  3*\talt -> 1, 2",
      "  4\talt -> 3, 5",
      "  5\tmatch",
      "",
    ].join("\n"),
  },
  {
    regexp: "(?:|a)*",
    prog: [
      "  0\tfail",
      "  1\tnop -> 4",
      '  2\trune1 "a" -> 4',
      "  3\talt -> 1, 2",
      "  4\talt -> 3, 6",
      "  5*\talt -> 3, 6",
      "  6\tmatch",
      "",
    ].join("\n"),
  },
];
