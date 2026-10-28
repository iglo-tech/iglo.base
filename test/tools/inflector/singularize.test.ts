// Upstream: tools/inflector/singularize_test.go

import { describe, expect, test } from "bun:test";

import { singularize } from "@/tools/inflector/singularize";

describe("Singularize", () => {
  const scenarios: [string, string][] = [
    ["abcnese", "abcnese"],
    ["deer", "deer"],
    ["sheep", "sheep"],
    ["measles", "measles"],
    ["pox", "pox"],
    ["media", "media"],
    ["bliss", "bliss"],
    ["sea-bass", "sea-bass"],
    ["Statuses", "Status"],
    ["Feet", "Foot"],
    ["Teeth", "Tooth"],
    ["abcmenus", "abcmenu"],
    ["Quizzes", "Quiz"],
    ["Matrices", "Matrix"],
    ["Vertices", "Vertex"],
    ["Indices", "Index"],
    ["Aliases", "Alias"],
    ["Alumni", "Alumnus"],
    ["Bacilli", "Bacillus"],
    ["Cacti", "Cactus"],
    ["Fungi", "Fungus"],
    ["Nuclei", "Nucleus"],
    ["Radii", "Radius"],
    ["Stimuli", "Stimulus"],
    ["Syllabi", "Syllabus"],
    ["Termini", "Terminus"],
    ["Viri", "Virus"],
    ["Faxes", "Fax"],
    ["Crises", "Crisis"],
    ["Axes", "Axis"],
    ["Shoes", "Shoe"],
    ["abcoes", "abco"],
    ["Houses", "House"],
    ["Mice", "Mouse"],
    ["abcxes", "abcx"],
    ["Movies", "Movie"],
    ["Series", "Series"],
    ["abcquies", "abcquy"],
    ["Relatives", "Relative"],
    ["Drives", "Drive"],
    ["aardwolves", "aardwolf"],
    ["Analyses", "Analysis"],
    ["Diagnoses", "Diagnosis"],
    ["People", "Person"],
    ["Men", "Man"],
    ["Children", "Child"],
    ["News", "News"],
    ["Netherlands", "Netherlands"],
    ["Tableaus", "Tableau"],
    ["Currencies", "Currency"],
    ["abcs", "abc"],
    ["abc", "abc"],
  ];

  for (const [word, expected] of scenarios) {
    test(word, () => {
      expect(singularize(word)).toBe(expected);
    });
  }
});

// Not in upstream's tests: RE2's (?i) uses Unicode simple case folding,
// and RE2's dot matches \r (JS's does not).
describe("Singularize RE2 semantics", () => {
  const scenarios: [string, string][] = [
    ["\u017ftatuses", "\u017ftatus"], // long s folds to s
    ["Statu\u017fes", "Status"],
    ["a\rus", "a\rus"], // ^(.*us)$ matches, so the last rule never runs
  ];

  for (const [word, expected] of scenarios) {
    test(JSON.stringify(word), () => {
      expect(singularize(word)).toBe(expected);
    });
  }
});
