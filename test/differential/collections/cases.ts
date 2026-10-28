// The collections the reference test (collections.test.ts) creates through
// upstream's POST /api/collections, in order. Bodies are JSON texts, sent
// as they are. "$users" stands for the id of the fresh install's "users"
// collection, "$base_all" for the id of the base_all collection (created
// first). Every field type, every auth option group with non-default
// values, OAuth2 providers with secrets and Extra maps, Go int/int64
// settings past 2^53, and unique, partial and expression indexes.

const secret = (c: string): string => c.repeat(40);

const allFields = `[
  {"name":"title","type":"text","required":true,"min":3,"max":120,"pattern":"^[\\\\w ]+$","autogeneratePattern":"","presentable":true,"help":"<b>Title</b> & more"},
  {"name":"body","type":"editor","maxSize":9007199254740991,"convertURLs":true,"hidden":true},
  {"name":"amount","type":"number","min":-1.5,"max":1e21,"onlyInt":false,"required":false},
  {"name":"count","type":"number","min":0,"max":100,"onlyInt":true},
  {"name":"active","type":"bool","required":false,"presentable":true},
  {"name":"contact","type":"email","exceptDomains":["example.com","a.b"],"onlyDomains":[]},
  {"name":"site","type":"url","onlyDomains":["pocketbase.io"],"exceptDomains":[]},
  {"name":"due","type":"date","min":"2020-01-01 00:00:00.000Z","max":"2030-12-31 10:00:00.123Z"},
  {"name":"kind","type":"select","values":["a","b","ünïcode","<x>"],"maxSelect":2},
  {"name":"meta","type":"json","maxSize":9007199254740991},
  {"name":"docs","type":"file","maxSelect":3,"maxSize":1048576,"mimeTypes":["image/png","application/pdf"],"thumbs":["100x100","0x50t"],"protected":true},
  {"name":"owner","type":"relation","collectionId":"$users","maxSelect":1,"cascadeDelete":true,"minSelect":0},
  {"name":"secret","type":"password","min":10,"max":40,"cost":6,"pattern":"^\\\\S+$"},
  {"name":"where","type":"geoPoint","required":true},
  {"name":"created","type":"autodate","onCreate":true,"onUpdate":false},
  {"name":"updated","type":"autodate","onCreate":true,"onUpdate":true}
]`;

const fullAuthOptions = `
  "authRule": "verified = true",
  "manageRule": "@request.auth.id != ''",
  "authAlert": {"enabled": false, "emailTemplate": {"subject": "Alert <b>{APP_NAME}</b>", "body": "<p>New login: {ALERT_INFO} & \\u2028 \\u00e9t\\u00e9</p>"}},
  "oauth2": {
    "enabled": true,
    "mappedFields": {"id": "", "name": "name", "username": "username", "avatarURL": "missing_field"},
    "providers": [
      {"name": "google", "clientId": "g-client", "clientSecret": "g-secret-value", "pkce": true, "displayName": "Google <x>",
       "extra": {"z": 1, "a": {"y": 2.50, "b": [1, "x", null, true]}, "big": 12345678901234567890, "1": "one", "10": "ten", "2": 0.1, "\\u00e9": "e"}},
      {"name": "github", "clientId": "gh-client", "clientSecret": "gh-secret", "pkce": false,
       "authURL": "https://example.com/auth", "tokenURL": "https://example.com/token", "userInfoURL": "https://example.com/me"},
      {"name": "gitlab", "clientId": "gl-client", "clientSecret": "gl-secret", "extra": {}}
    ]
  },
  "passwordAuth": {"enabled": true, "identityFields": ["email", "username"]},
  "mfa": {"enabled": true, "duration": 900, "rule": "verified = true"},
  "otp": {"enabled": true, "duration": 600, "length": 6, "emailTemplate": {"subject": "Your code", "body": "<p>{OTP} / {OTP_ID}</p>"}},
  "authToken": {"secret": "${secret("a")}", "duration": 1209600},
  "passwordResetToken": {"secret": "${secret("b")}", "duration": 3600},
  "emailChangeToken": {"secret": "${secret("c")}", "duration": 7200},
  "verificationToken": {"secret": "${secret("d")}", "duration": 604800},
  "fileToken": {"secret": "${secret("e")}", "duration": 120},
  "verificationTemplate": {"subject": "Verify {APP_NAME}", "body": "<a href=\\"{APP_URL}/v/{TOKEN}\\">verify</a>"},
  "resetPasswordTemplate": {"subject": "Reset {APP_NAME}", "body": "<a href=\\"{APP_URL}/r/{TOKEN}\\">reset</a>"},
  "confirmEmailChangeTemplate": {"subject": "Confirm {APP_NAME}", "body": "<a href=\\"{APP_URL}/c/{TOKEN}\\">confirm</a>"}`;

const authUserFields = `[
  {"name":"username","type":"text","min":3,"max":150,"required":true,"pattern":"^[\\\\w.]+$","autogeneratePattern":"user[0-9]{6}"},
  {"name":"name","type":"text","max":200},
  {"name":"avatar","type":"file","maxSelect":1,"maxSize":5242880,"mimeTypes":["image/jpeg"],"thumbs":["70x70"]}
]`;

export interface CollectionCase {
  name: string;
  body: string;
}

export const collectionCases: CollectionCase[] = [
  {
    name: "base_all",
    body: `{"name":"base_all","type":"base","fields":${allFields}}`,
  },
  {
    name: "base_indexes",
    body: `{"name":"base_indexes","type":"base","fields":[
      {"name":"a","type":"text"},{"name":"b","type":"text"},{"name":"c","type":"number"}],
      "indexes":[
        "CREATE UNIQUE INDEX idx_bi_a ON base_indexes (a)",
        "create unique index \\"idx_bi_ab\\" on \\"base_indexes\\" (a, b DESC) where a != ''",
        "CREATE INDEX IF NOT EXISTS idx_bi_c ON base_indexes (\\n  c COLLATE NOCASE ASC,\\n  b\\n)",
        "CREATE INDEX idx_bi_expr ON base_indexes (lower(a), c)",
        "CREATE INDEX \`idx_bi_other\` ON \`some_other_table\` (\`b\`)"
      ]}`,
  },
  {
    name: "base_rules",
    body: `{"name":"base_rules","type":"base",
      "listRule":"","viewRule":null,"createRule":"@request.auth.id != ''",
      "updateRule":"// leading comment\\n@request.auth.id != '' && title != \\"x\\"\\n// trailing",
      "deleteRule":"@request.auth.collectionName = 'users'",
      "fields":[{"name":"title","type":"text","hidden":true,"help":"help \\u003c\\u003e & \\ud83d\\ude00"}]}`,
  },
  {
    name: "base_unicode",
    body: `{"name":"base_unicode","type":"base","fields":[
      {"name":"tytul","type":"text","help":"zażółć gęślą jaźń 日本 \\u2028\\u2029"},
      {"name":"opcje","type":"select","values":["żółw","\\u00e9","<script>&amp;</script>"],"maxSelect":1}]}`,
  },
  {
    name: "base_numbers",
    body: `{"name":"base_numbers","type":"base","fields":[
      {"name":"n1","type":"number","min":0.1,"max":0.30000000000000004},
      {"name":"n2","type":"number","min":-1e-7,"max":123456789012345680000},
      {"name":"j","type":"json","maxSize":9007199254740990},
      {"name":"e","type":"editor","maxSize":4503599627370497},
      {"name":"s","type":"select","values":["x","y","z"],"maxSelect":3},
      {"name":"t","type":"text","min":0,"max":9007199254740991}]}`,
  },
  {
    name: "base_custom_id",
    body: `{"name":"base_custom_id","type":"base","fields":[
      {"name":"id","type":"text","min":5,"max":20,"pattern":"^[a-z]+[0-9]*$","autogeneratePattern":"[a-z]{10}","hidden":true,"system":false}]}`,
  },
  {
    name: "base_relations",
    body: `{"name":"base_relations","type":"base","fields":[
      {"name":"one","type":"relation","collectionId":"$base_all","maxSelect":1,"required":true},
      {"name":"many","type":"relation","collectionId":"$base_all","minSelect":1,"maxSelect":5,"cascadeDelete":true},
      {"name":"user","type":"relation","collectionId":"$users","maxSelect":999,"presentable":true}]}`,
  },
  {
    name: "base_files",
    body: `{"name":"base_files","type":"base","fields":[
      {"name":"f1","type":"file"},
      {"name":"f2","type":"file","maxSelect":99,"maxSize":9007199254740991,"mimeTypes":[],"thumbs":["0x10","10x20f","30x40b"]}]}`,
  },
  {
    name: "base_explicit_id",
    body: `{"id":"explicit_id_001","name":"base_explicit_id","type":"base","fields":[{"name":"x","type":"bool"}]}`,
  },
  {
    name: "base_only_id",
    body: `{"name":"base_only_id","type":"base"}`,
  },
  {
    name: "view_simple",
    body: `{"name":"view_simple","type":"view","listRule":"","viewRule":"id != ''",
      "viewQuery":"SELECT id, title, amount, created FROM base_all"}`,
  },
  {
    name: "view_agg",
    body: `{"name":"view_agg","type":"view",
      "viewQuery":"select (ROW_NUMBER() OVER()) as id, count(*) as total, max(amount) as m\\nfrom base_all group by active"}`,
  },
  {
    name: "view_join",
    body: `{"name":"view_join","type":"view",
      "viewQuery":"SELECT r.id, r.one, a.title FROM base_relations r LEFT JOIN base_all a ON a.id = r.one"}`,
  },
  {
    name: "auth_full",
    body: `{"name":"auth_full","type":"auth","fields":${authUserFields},
      "indexes":["CREATE UNIQUE INDEX idx_auth_full_username ON auth_full (username)"],
      ${fullAuthOptions}}`,
  },
  {
    name: "auth_ints",
    body: `{"name":"auth_ints","type":"auth",
      "mfa": {"enabled": false, "duration": 9223372036854775807, "rule": ""},
      "otp": {"enabled": true, "duration": 10, "length": 9007199254740993},
      "authToken": {"duration": 94670856},
      "passwordResetToken": {"duration": 10},
      "emailChangeToken": {"duration": 9007199},
      "verificationToken": {"duration": 86400},
      "fileToken": {"duration": 11}}`,
  },
  {
    name: "auth_oauth2",
    body: `{"name":"auth_oauth2","type":"auth","fields":[{"name":"name","type":"text"}],
      "oauth2": {"enabled": false, "mappedFields": {"id": "id", "name": "name", "username": "", "avatarURL": ""},
        "providers": [
          {"name": "discord", "clientId": "d", "clientSecret": "ds", "displayName": "", "extra": {"scopes": ["identify", "email"], "n": -0.0, "e": 1e-7}},
          {"name": "microsoft", "clientId": "m", "clientSecret": "ms", "pkce": null, "authURL": "https://login.example.com/\\u00e9?a=1&b=2"}
        ]}}`,
  },
  {
    name: "auth_no_auth",
    body: `{"name":"auth_no_auth","type":"auth","authRule":null,"manageRule":null,
      "passwordAuth": {"enabled": false, "identityFields": []},
      "authAlert": {"enabled": true, "emailTemplate": {"subject": "s", "body": "b"}}}`,
  },
  {
    name: "auth_custom_system_fields",
    body: `{"name":"auth_custom_system_fields","type":"auth","fields":[
      {"name":"password","type":"password","min":12,"max":64,"cost":11,"pattern":"^\\\\S+$","hidden":false,"required":false},
      {"name":"email","type":"email","onlyDomains":["example.com"],"required":false,"hidden":true},
      {"name":"verified","type":"bool","system":false,"presentable":true},
      {"name":"tokenKey","type":"text","min":30,"max":60,"autogeneratePattern":"[a-z]{40}"},
      {"name":"extra_field","type":"json"}]}`,
  },
  {
    name: "auth_custom_indexes",
    body: `{"name":"auth_custom_indexes","type":"auth","fields":[{"name":"code","type":"text"}],
      "indexes":[
        "CREATE UNIQUE INDEX \`my_token_idx\` ON \`auth_custom_indexes\` (\`tokenKey\`)",
        "CREATE UNIQUE INDEX my_email_idx ON auth_custom_indexes (email) WHERE email != ''",
        "CREATE INDEX idx_code ON auth_custom_indexes (code)"
      ],
      "passwordAuth": {"enabled": true, "identityFields": ["email"]}}`,
  },
  {
    name: "auth_otp_only",
    body: `{"name":"auth_otp_only","type":"auth",
      "passwordAuth": {"enabled": false, "identityFields": ["email"]},
      "otp": {"enabled": true, "duration": 86400, "length": 4},
      "mfa": {"enabled": false, "duration": 10, "rule": "@request.auth.id != ''"}}`,
  },
  {
    name: "view_auth",
    body: `{"name":"view_auth","type":"view",
      "viewQuery":"SELECT id, email, username, verified FROM auth_full"}`,
  },
  {
    name: "base_autodate",
    body: `{"name":"base_autodate","type":"base","listRule":"@request.auth.id != ''","fields":[
      {"name":"created","type":"autodate","onCreate":true,"onUpdate":false,"hidden":true},
      {"name":"updated","type":"autodate","onCreate":false,"onUpdate":true,"presentable":true}]}`,
  },
];

// Minimal creates, compared with NewBaseCollection, NewAuthCollection and
// NewViewCollection for the same name.
export const minimalCases = {
  base: { name: "min_base", body: `{"name":"min_base","type":"base"}` },
  auth: { name: "min_auth", body: `{"name":"min_auth","type":"auth"}` },
  view: {
    name: "min_view",
    query: "SELECT id FROM base_only_id",
    body: `{"name":"min_view","type":"view","viewQuery":"SELECT id FROM base_only_id"}`,
  },
};
