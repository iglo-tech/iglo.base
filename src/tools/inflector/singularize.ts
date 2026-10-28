// Upstream: tools/inflector/singularize.go
//
// Upstream compiles the rules lazily into a package-level store; the rules
// are constants, so here they are compiled once when the module loads.
//
// The Go RE2 patterns are translated by hand:
//   - (?i) is the i flag with u: RE2's case folding uses Unicode simple
//     folding (s also matches ſ, k matches the Kelvin sign), which JS does
//     only in unicode mode;
//   - `.` is [^\n]: RE2's dot excludes only \n, JS's also \r, \u2028 and
//     \u2029;
//   - ${1} in a replacement is $1 (an unmatched group is "" in both);
//   - ReplaceAllString replaces every match: the g flag.
// No rule can match the empty string, so RE2's and JS's handling of empty
// matches next to a previous match never differs here.

// note: the patterns are extracted from popular Ruby/PHP/Node.js inflector packages
const singularRules: [string, string][] = [
  ["([nrlm]ese|deer|fish|sheep|measles|ois|pox|media|ss)$", "$1"],
  ["^(sea[- ]bass)$", "$1"],
  ["(s)tatuses$", "$1tatus"],
  ["(f)eet$", "$1oot"],
  ["(t)eeth$", "$1ooth"],
  ["^([^\\n]*)(menu)s$", "$1$2"],
  ["(quiz)zes$", "$1"],
  ["(matr)ices$", "$1ix"],
  ["(vert|ind)ices$", "$1ex"],
  ["^(ox)en", "$1"],
  ["(alias)es$", "$1"],
  ["(alumn|bacill|cact|foc|fung|nucle|radi|stimul|syllab|termin|viri?)i$", "$1us"],
  ["([ftw]ax)es", "$1"],
  ["(cris|ax|test)es$", "$1is"],
  ["(shoe)s$", "$1"],
  ["(o)es$", "$1"],
  ["ouses$", "ouse"],
  ["([^a])uses$", "$1us"],
  ["([m|l])ice$", "$1ouse"],
  ["(x|ch|ss|sh)es$", "$1"],
  ["(m)ovies$", "$1ovie"],
  ["(s)eries$", "$1eries"],
  ["([^aeiouy]|qu)ies$", "$1y"],
  ["([lr])ves$", "$1f"],
  ["(tive)s$", "$1"],
  ["(hive)s$", "$1"],
  ["(drive)s$", "$1"],
  ["([^fo])ves$", "$1fe"],
  ["(^analy)ses$", "$1sis"],
  ["(analy|diagno|^ba|(p)arenthe|(p)rogno|(s)ynop|(t)he)ses$", "$1$2sis"],
  ["([ti])a$", "$1um"],
  ["(p)eople$", "$1erson"],
  ["(m)en$", "$1an"],
  ["(c)hildren$", "$1hild"],
  ["(n)ews$", "$1ews"],
  ["(n)etherlands$", "$1etherlands"],
  ["eaus$", "eau"],
  ["(currenc)ies$", "$1y"],
  ["^([^\\n]*us)$", "$1"],
  ["s$", ""],
];

const compiledRules = singularRules.map(([pattern, replacement]) => ({
  test: new RegExp(pattern, "iu"),
  replace: new RegExp(pattern, "giu"),
  replacement,
}));

// Singularize converts the specified word into its singular version, eg.
// "people" becomes "person".
export function singularize(word: string): string {
  if (word === "") {
    return "";
  }
  for (const rule of compiledRules) {
    if (rule.test.test(word)) {
      return word.replace(rule.replace, rule.replacement);
    }
  }
  return word;
}
