// The generated collections of a fuzz run. The fixture leaves these forms
// unreachable: stored `%`, `_`, `\`, quotes and non-ASCII text for `~` and
// `:lower`, fractional, negative and large numbers, JSON scalars and nested
// values, duplicate-free multi selects with data, a relation target that no
// longer exists, and a single back-relation (a unique index on the relation)
// that has data. Created through upstream's API before the servers start.

export const fuzzTags = {
  name: "fuzz_tags",
  type: "base",
  listRule: `name != "hidden"`,
  viewRule: "",
  fields: [
    { name: "name", type: "text" },
    { name: "weight", type: "number" },
    { name: "owner", type: "relation", collectionId: "_pb_users_auth_", maxSelect: 1 },
    { name: "created", type: "autodate", onCreate: true },
  ],
};

export function fuzzItems(tagsId: string): object {
  return {
    name: "fuzz_items",
    type: "base",
    listRule: "",
    viewRule: "",
    fields: [
      { name: "text", type: "text" },
      { name: "number", type: "number" },
      { name: "bool", type: "bool" },
      { name: "date", type: "date" },
      { name: "json", type: "json" },
      { name: "email", type: "email" },
      { name: "url", type: "url" },
      { name: "editor", type: "editor" },
      { name: "point", type: "geoPoint" },
      { name: "one", type: "select", values: ["a", "b", "c", "%", "_"], maxSelect: 1 },
      { name: "many", type: "select", values: ["a", "b", "c", "%", "_"], maxSelect: 5 },
      { name: "tag", type: "relation", collectionId: tagsId, maxSelect: 1 },
      { name: "tags", type: "relation", collectionId: tagsId, maxSelect: 5 },
      { name: "created", type: "autodate", onCreate: true },
    ],
    indexes: ["CREATE UNIQUE INDEX `idx_fuzz_items_tag` ON `fuzz_items` (`tag`) WHERE `tag` != ''"],
  };
}

const tagIds = Array.from({ length: 6 }, (_, i) => `fuzztag${String(i).padStart(8, "0")}`);

export const tagRecords: string[] = [
  ["alpha", 1],
  ["beta", 1.5],
  ["GAMMA", -1],
  ["hidden", 0],
  ["50%", 100],
  ["", 0],
].map(([name, weight], i) =>
  JSON.stringify({
    id: tagIds[i],
    name,
    weight,
    ...(i % 2 === 0 ? { owner: "4q1xlclmfloku33" } : {}),
  }),
);

const texts = [
  "",
  "test",
  "TEST",
  "Test1",
  "50%",
  "100%%",
  "a_b",
  "a b",
  "aXb",
  "back\\slash",
  "tr\\",
  "\\%",
  "it's",
  `say "hi"`,
  "zażółć",
  "ZAŻÓŁĆ",
  "日本語",
  "🙂",
  "0",
  "1",
  "1.5",
  "007",
  "true",
  "false",
  "null",
  " space ",
  "line\nbreak",
  "2022-10-01 12:00:00.000Z",
  "{:t}",
  "' OR 1=1 --",
];

const numbers = [
  "0",
  "1",
  "-1",
  "1.5",
  "-0.5",
  "2",
  "123456",
  "1000000",
  "9007199254740993",
  "0.1",
];

const dates = [
  "",
  "2022-10-01 12:00:00.000Z",
  "2000-01-01 00:00:00.000Z",
  "2099-12-31 23:59:59.999Z",
  "2022-10-01 00:00:00.000Z",
];

// raw JSON text: the values are written as given
const jsons = [
  "null",
  "true",
  "false",
  "0",
  "1.5",
  "-1",
  `"str"`,
  `""`,
  `"100%"`,
  "[]",
  "{}",
  `[1,"a",null,{"a":1}]`,
  `{"a":{"b":[1,2]}}`,
  `{"1":"x","10":"y","2":"z"}`,
  `{"a":null}`,
  `[[1,2],[3]]`,
  "12345678901234567890",
  `{"a":"test","b":true,"c":1}`,
];

const selects = [[], ["a"], ["b", "a"], ["%"], ["_"], ["a", "b", "c"], ["%", "_"]];

// every value of each list appears; the rows are a fixed cycle of them
export const itemRecords: string[] = texts.map((text, i) => {
  const one = ["", "a", "b", "%", "_"][i % 5];
  const fields = [
    `"id":${JSON.stringify(`fuzzitem${String(i).padStart(7, "0")}`)}`,
    `"text":${JSON.stringify(text)}`,
    `"number":${numbers[i % numbers.length]}`,
    `"bool":${i % 3 === 0}`,
    `"date":${JSON.stringify(dates[i % dates.length])}`,
    `"json":${jsons[i % jsons.length]}`,
    `"email":${JSON.stringify(i % 4 === 0 ? "" : `user${i}@example.com`)}`,
    `"url":${JSON.stringify(i % 4 === 1 ? "" : `https://example.com/${i}?q=50%25`)}`,
    `"editor":${JSON.stringify(i % 2 === 0 ? "" : `<p>${i}</p>`)}`,
    `"point":${JSON.stringify({ lon: (i * 37) % 180, lat: ((i * 23) % 180) - 90 })}`,
    `"one":${JSON.stringify(one)}`,
    `"many":${JSON.stringify(selects[i % selects.length])}`,
    `"tag":${JSON.stringify(i < tagIds.length ? tagIds[i] : "")}`,
    `"tags":${JSON.stringify(tagIds.filter((_, t) => (i >> t) % 2 === 1))}`,
  ];
  return `{${fields.join(",")}}`;
});
