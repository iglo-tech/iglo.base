// The settings differential cases (settings.test.ts): requests sent to
// upstream and iglo.base in the same order, on copies of upstream's
// fixture. Cases run in order and change the settings for the ones after
// them, as a dashboard session would.
//
// Trusted proxy headers are sent only with values that are not IP
// addresses: RealIP reads the configured headers in M5.7, until then it
// is the remote address, which upstream also falls back to for these.

export type Identity = "guest" | "users" | "superuser";

export interface SettingsCase {
  name: string;
  as: Identity;
  method: "GET" | "PATCH" | "POST";
  url: string;
  body?: string;
  // more headers (a JSON content type is the default)
  headers?: Record<string, string>;
}

const patch = (name: string, body: string, headers?: Record<string, string>): SettingsCase => ({
  name,
  as: "superuser",
  method: "PATCH",
  url: "/api/settings",
  body,
  headers,
});

const get: SettingsCase = { name: "GET", as: "superuser", method: "GET", url: "/api/settings" };

// every settings endpoint, for the access checks
const endpoints: [SettingsCase["method"], string, string][] = [
  ["GET", "/api/settings", ""],
  ["PATCH", "/api/settings", `{"meta":{"appName":"access_test"}}`],
  ["POST", "/api/settings/test/s3", `{"filesystem":"storage"}`],
  // invalid, so that no email is sent (the mailer is M4.4)
  ["POST", "/api/settings/test/email", `{"template":"unknown","email":"test@example.com"}`],
  ["POST", "/api/settings/apple/generate-client-secret", `{}`],
];

export const accessCases: SettingsCase[] = endpoints.flatMap(([method, url, body]) =>
  (["guest", "users", "superuser"] as const).map((as) => ({
    name: `${method} ${url} as ${as}`,
    as,
    method,
    url,
    body: body === "" ? undefined : body,
  })),
);

export const validationCases: SettingsCase[] = [
  // meta
  patch("meta: empty appName", `{"meta":{"appName":""}}`),
  patch("meta: appName over 255 bytes", `{"meta":{"appName":"${"a".repeat(256)}"}}`),
  patch("meta: invalid appURL", `{"meta":{"appURL":"test"}}`),
  patch("meta: invalid senderAddress", `{"meta":{"senderAddress":"invalid_email"}}`),
  patch("meta: short accentColor", `{"meta":{"accentColor":"#fff"}}`),
  patch("meta: non-hex accentColor", `{"meta":{"accentColor":"#gggggg"}}`),
  patch("meta: empty senderName", `{"meta":{"senderName":""}}`),
  patch("meta: null (zero value)", `{"meta":null}`),
  patch(
    "meta: every field invalid",
    `{"meta":{"accentColor":"x","appName":"","appURL":"","senderName":"","senderAddress":""}}`,
  ),
  patch("meta: appName of the wrong type", `{"meta":{"appName":1}}`),
  // logs
  patch("logs: negative maxDays", `{"logs":{"maxDays":-1}}`),
  patch("logs: negative maxDataSize", `{"logs":{"maxDataSize":-1}}`),
  patch("logs: maxDataSize above 2^53-1", `{"logs":{"maxDataSize":9007199254740992}}`),
  patch("logs: minLevel above 2^53-1", `{"logs":{"minLevel":9007199254740993}}`),
  patch("logs: fractional maxDays", `{"logs":{"maxDays":1.5}}`),
  // smtp
  patch("smtp: enabled without host and port", `{"smtp":{"enabled":true,"host":"","port":0}}`),
  patch("smtp: negative port", `{"smtp":{"port":-1}}`),
  patch("smtp: invalid authMethod", `{"smtp":{"authMethod":"CRAM"}}`),
  patch(
    "smtp: invalid localName and host",
    `{"smtp":{"localName":"invalid!","host":"test:test:test"}}`,
  ),
  patch("smtp: port beyond int64", `{"smtp":{"port":9223372036854775808}}`),
  patch("smtp: port as a string", `{"smtp":{"port":"587"}}`),
  // s3
  patch("s3: enabled without values", `{"s3":{"enabled":true}}`),
  patch(
    "s3: enabled with an invalid endpoint",
    `{"s3":{"enabled":true,"endpoint":"test:test:test","bucket":"b","region":"r","accessKey":"a","secret":"s"}}`,
  ),
  patch("backups.s3: enabled without values", `{"backups":{"s3":{"enabled":true}}}`),
  // backups
  patch("backups: invalid cron (word)", `{"backups":{"cron":"invalid","cronMaxKeep":1}}`),
  patch("backups: cron with 4 segments", `{"backups":{"cron":"* * * *","cronMaxKeep":1}}`),
  patch("backups: cron minute out of range", `{"backups":{"cron":"60 * * * *","cronMaxKeep":1}}`),
  patch("backups: cron zero step", `{"backups":{"cron":"*/0 * * * *","cronMaxKeep":1}}`),
  patch(
    "backups: cron step on a single value",
    `{"backups":{"cron":"2/3 * * * *","cronMaxKeep":1}}`,
  ),
  patch(
    "backups: cron range of three parts",
    `{"backups":{"cron":"1-2-3 * * * *","cronMaxKeep":1}}`,
  ),
  patch("backups: cron reversed range", `{"backups":{"cron":"* 5-1 * * *","cronMaxKeep":1}}`),
  patch("backups: cron non-numeric value", `{"backups":{"cron":"* * a * *","cronMaxKeep":1}}`),
  patch(
    "backups: cron out-of-range number",
    `{"backups":{"cron":"99999999999999999999 * * * *","cronMaxKeep":1}}`,
  ),
  patch("backups: cron with zero cronMaxKeep", `{"backups":{"cron":"@daily","cronMaxKeep":0}}`),
  patch("backups: negative cronMaxKeep without cron", `{"backups":{"cron":"","cronMaxKeep":-1}}`),
  // batch
  patch(
    "batch: enabled with zero values",
    `{"batch":{"enabled":true,"maxRequests":0,"timeout":0}}`,
  ),
  patch("batch: negative values", `{"batch":{"maxRequests":-1,"timeout":-1,"maxBodySize":-1}}`),
  patch("batch: fractional timeout", `{"batch":{"timeout":1.5}}`),
  // rateLimits
  patch("rateLimits: enabled without rules", `{"rateLimits":{"enabled":true,"rules":[]}}`),
  patch("rateLimits: enabled with null rules", `{"rateLimits":{"enabled":true,"rules":null}}`),
  patch(
    "rateLimits: invalid rules",
    `{"rateLimits":{"rules":[{"label":"@abc","duration":-1,"maxRequests":-1,"audience":"invalid"},{"label":""}]}}`,
  ),
  patch(
    "rateLimits: conflicting labels",
    `{"rateLimits":{"rules":[{"label":"/a","duration":1,"maxRequests":1},{"label":"/a","duration":2,"maxRequests":2,"audience":"@guest"}]}}`,
  ),
  patch(
    "rateLimits: conflicting prefix labels",
    `{"rateLimits":{"rules":[{"label":"/api/","duration":1,"maxRequests":1},{"label":"/api/x","duration":1,"maxRequests":1},{"label":"/api","duration":1,"maxRequests":1}]}}`,
  ),
  patch("rateLimits: invalid excludedIPs", `{"rateLimits":{"excludedIPs":["","1.2.3.4/33","x"]}}`),
  // trustedProxy (no validation; only decoding errors)
  patch("trustedProxy: headers of the wrong type", `{"trustedProxy":{"headers":"x"}}`),
  patch(
    "trustedProxy: useLeftmostIP of the wrong type",
    `{"trustedProxy":{"useLeftmostIP":"true"}}`,
  ),
  // superuserIPs
  patch(
    "superuserIPs: invalid entries",
    `{"superuserIPs":["127.0.0.1","",""," 10.0.0.1","fe80::1%eth0/64","::1/129"]}`,
  ),
  // several groups at once
  patch(
    "several groups invalid",
    `{"superuserIPs":[""],"meta":{"appName":""},"logs":{"maxDays":-10},"smtp":{"enabled":true,"host":""},"s3":{"enabled":true,"endpoint":"invalid"},"backups":{"cron":"invalid","cronMaxKeep":-10},"batch":{"enabled":true,"maxRequests":-1,"timeout":-1},"rateLimits":{"enabled":true,"rules":null}}`,
  ),
  // body decoding
  patch("invalid JSON", `{`),
  patch("a JSON array", `[]`),
  patch("a JSON null body", `null`),
  patch("duplicate names", `{"meta":{"appName":"a","appName":"b"}}`),
  patch("invalid UTF-8 escape", `{"meta":{"appName":"\\ud800"}}`),
  patch("trailing garbage after the value", `{"meta":{"appName":"trailing"}} x`),
  get,
];

export const mergeCases: SettingsCase[] = [
  patch("empty object", `{}`),
  patch("one meta field", `{"meta":{"appName":"merge_test"}}`),
  get,
  patch("case-insensitive names", `{"META":{"AppName":"case_test","senderNAME":"Case"}}`),
  get,
  patch(
    "unknown names are ignored",
    `{"unknown":1,"meta":{"unknown":{"a":[1,2]},"hideControls":true}}`,
  ),
  patch(
    "rules replace the list",
    `{"rateLimits":{"enabled":true,"rules":[{"label":"users:create","duration":10,"maxRequests":5},{"label":"POST /api/x/","audience":"@auth","duration":1,"maxRequests":2}],"excludedIPs":["10.0.0.0/8","::1"]}}`,
  ),
  get,
  patch(
    "a rule element merged from zero",
    `{"rateLimits":{"rules":[{"label":"*:auth","maxRequests":3,"duration":1}]}}`,
  ),
  patch("superuserIPs set", `{"superuserIPs":["127.0.0.1","::1","10.0.0.0/8"]}`),
  patch("superuserIPs emptied", `{"superuserIPs":[]}`),
  patch("superuserIPs null", `{"superuserIPs":null}`),
  patch(
    "trusted proxy headers",
    `{"trustedProxy":{"headers":["X-Real-IP","CF-Connecting-IP"],"useLeftmostIP":true}}`,
  ),
  {
    name: "health reads the trusted proxy headers",
    as: "superuser",
    method: "GET",
    url: "/api/health",
    headers: { "x-real-ip": "unknown" },
  },
  patch(
    "logs and batch values",
    `{"logs":{"maxDataSize":1024,"maxDays":7,"minLevel":-4,"logIP":true,"logAuthId":true},"batch":{"enabled":true,"maxRequests":10,"timeout":9223372036854775807,"maxBodySize":0}}`,
  ),
  patch("negative int64 minimum", `{"logs":{"minLevel":-9223372036854775808}}`),
  patch("backups cron macro", `{"backups":{"cron":"@weekly","cronMaxKeep":5}}`),
  patch(
    "backups cron list and steps",
    `{"backups":{"cron":"1,2,5-20/3 */2 1-31 * 0-6","cronMaxKeep":2}}`,
  ),
  patch(
    "strings with escapes",
    `{"meta":{"appName":"<b>&amp;\\u2028\\"q\\"\\\\\\u0001é😀","senderName":"Ünïcode"}}`,
  ),
  get,
  {
    name: "picked fields",
    as: "superuser",
    method: "GET",
    url: "/api/settings?fields=meta.appName,smtp,rateLimits.rules",
  },
  patch("form-urlencoded body", "meta.appName=form_name&superuserIPs=127.0.0.1&smtp.port=25", {
    "content-type": "application/x-www-form-urlencoded",
  }),
  get,
  patch(
    "multipart body",
    `--X\r\nContent-Disposition: form-data; name="meta.senderName"\r\n\r\nmultipart\r\n--X\r\nContent-Disposition: form-data; name="@jsonPayload"\r\n\r\n{"meta":{"appName":"payload"}}\r\n--X--\r\n`,
    { "content-type": "multipart/form-data; boundary=X" },
  ),
  get,
  patch("reset superuserIPs", `{"superuserIPs":[]}`),
];

export const secretCases: SettingsCase[] = [
  patch(
    "set every secret",
    `{"smtp":{"password":"smtp_secret","username":"u"},"s3":{"secret":"s3_secret","accessKey":"k"},"backups":{"s3":{"secret":"backups_secret"}}}`,
  ),
  get,
  // the masked GET body sent back: no password member, no secret members
  patch("masked values sent back leave the secrets", "@GET"),
  get,
  patch("other changes leave the secrets", `{"meta":{"appName":"secrets_kept"}}`),
  patch("an empty password clears it", `{"smtp":{"password":""}}`),
  get,
  patch("an empty s3 secret is not stored", `{"s3":{"secret":""}}`),
  patch("a later save stores the kept s3 secret again", `{}`),
  get,
  {
    name: "test/s3 with S3 disabled",
    as: "superuser",
    method: "POST",
    url: "/api/settings/test/s3",
    body: `{"filesystem":"backups"}`,
  },
];

// on a pair of its own: once 127.0.0.1 is not whitelisted, the superuser
// cannot change the settings back
export const whitelistCases: SettingsCase[] = [
  patch("whitelist loopback", `{"superuserIPs":["127.0.0.1","::1"]}`),
  get,
  {
    name: "records as superuser (whitelisted)",
    as: "superuser",
    method: "GET",
    url: "/api/collections/demo1/records?perPage=1",
  },
  patch("whitelist a subnet", `{"superuserIPs":["127.0.0.0/8"]}`),
  { name: "health as superuser (subnet)", as: "superuser", method: "GET", url: "/api/health" },
  patch(
    "whitelist other addresses",
    `{"superuserIPs":["10.0.0.1","::ffff:127.0.0.1","127.0.0.2/32"]}`,
  ),
  {
    name: "settings as superuser (not whitelisted)",
    as: "superuser",
    method: "GET",
    url: "/api/settings",
  },
  {
    name: "settings PATCH as superuser (not whitelisted)",
    as: "superuser",
    method: "PATCH",
    url: "/api/settings",
    body: `{"superuserIPs":[]}`,
  },
  {
    name: "records as superuser (not whitelisted)",
    as: "superuser",
    method: "GET",
    url: "/api/collections/demo1/records?perPage=1",
  },
  {
    name: "record view as superuser (not whitelisted)",
    as: "superuser",
    method: "GET",
    url: "/api/collections/demo1/records/imy661ixudk5izi",
  },
  {
    name: "record create as superuser (not whitelisted)",
    as: "superuser",
    method: "POST",
    url: "/api/collections/demo2/records",
    body: `{"title":"blocked"}`,
  },
  {
    name: "health as superuser (not whitelisted)",
    as: "superuser",
    method: "GET",
    url: "/api/health",
  },
  {
    name: "records as users (not checked)",
    as: "users",
    method: "GET",
    url: "/api/collections/demo2/records?perPage=1",
  },
  {
    name: "records as guest (not checked)",
    as: "guest",
    method: "GET",
    url: "/api/collections/demo2/records?perPage=1",
  },
  {
    name: "settings as users (forbidden either way)",
    as: "users",
    method: "GET",
    url: "/api/settings",
  },
];
