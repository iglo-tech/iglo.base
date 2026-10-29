// Upstream: core/settings_model_test.go
//
// Through the public functions of src/settings/settings-model.ts. Not
// ported: TestSettingsDelete (nothing deletes the settings param; the
// delete guard is a model hook, D5). Go struct literals become zero values
// with the listed fields set. TestSettings_DBExport decrypts with the
// ported security.Decrypt and a key generated in the test.

import { describe, expect, test } from "bun:test";

import {
  type BackupsConfig,
  type BatchConfig,
  findRateLimitRule,
  type LogsConfig,
  type MetaConfig,
  RateLimitRuleAudienceAuth,
  RateLimitRuleAudienceGuest,
  rateLimitRuleDurationTime,
  rateLimitRuleString,
  type RateLimitRule,
  type RateLimitsConfig,
  type S3Config,
  Settings,
  type SMTPConfig,
  SMTPAuthLogin,
  validateBackups,
  validateBatch,
  validateLogs,
  validateMeta,
  validateRateLimitRule,
  validateRateLimits,
  validateS3,
  validateSMTP,
  zeroSettingsData,
} from "@/settings/settings-model";
import { decrypt } from "@/tools/security/encrypt";
import { randomString } from "@/tools/security/random";
import { Errors } from "@/validation/error";

import { expectValidationErrors } from "@test/collections/validation";

const zero = zeroSettingsData();
const meta = (c: Partial<MetaConfig> = {}): MetaConfig => ({ ...zero.Meta, ...c });
const logs = (c: Partial<LogsConfig> = {}): LogsConfig => ({ ...zero.Logs, ...c });
const smtp = (c: Partial<SMTPConfig> = {}): SMTPConfig => ({ ...zero.SMTP, ...c });
const s3 = (c: Partial<S3Config> = {}): S3Config => ({ ...zero.S3, ...c });
const backups = (c: Partial<BackupsConfig> = {}): BackupsConfig => ({ ...zero.Backups, ...c });
const batch = (c: Partial<BatchConfig> = {}): BatchConfig => ({ ...zero.Batch, ...c });
const rateLimits = (c: Partial<RateLimitsConfig> = {}): RateLimitsConfig => ({
  ...zero.RateLimits,
  ...c,
});
const rule = (c: Partial<RateLimitRule> = {}): RateLimitRule => ({
  Label: "",
  Audience: "",
  Duration: 0,
  MaxRequests: 0,
  ...c,
});

const fixedClock = { now: () => new Date("2026-10-29T10:00:00.123Z") };

describe("TestSettings_DBExport", () => {
  const encryptionKey = randomString(32);

  for (const [name, encryption] of [
    ["no encryption", false],
    ["with encryption", true],
  ] as const) {
    test(name, async () => {
      const settings = new Settings();
      settings.Meta.AppName = "test_app_name";
      settings.Logs.MaxDays = 123;
      settings.SMTP.Host = "smtp_host";
      settings.SMTP.Username = "smtp_username";
      settings.SMTP.Password = ""; // ensures that empty password is exported
      settings.S3.Endpoint = "s3_endpoint";
      settings.S3.Secret = "s3_secret";
      settings.Backups.Cron = "* * * * *";
      settings.Backups.S3.Enabled = true;
      settings.Backups.S3.Secret = "";
      settings.Batch.Timeout = 15;
      settings.RateLimits.Enabled = true;
      settings.TrustedProxy.UseLeftmostIP = true;

      const exported = await settings.dbExport(fixedClock, encryption ? encryptionKey : "");

      let valueStr: string;
      if (encryption) {
        expect(typeof exported.value).toBe("string");
        valueStr = new TextDecoder().decode(await decrypt(exported.value as string, encryptionKey));
      } else {
        expect(exported.value).toBeInstanceOf(Uint8Array);
        valueStr = new TextDecoder().decode(exported.value as Uint8Array);
      }

      const expected = `{"superuserIPs":[],"smtp":{"enabled":false,"port":0,"host":"smtp_host","username":"smtp_username","password":"","authMethod":"","tls":false,"localName":""},"backups":{"cron":"* * * * *","cronMaxKeep":0,"s3":{"enabled":true,"bucket":"","region":"","endpoint":"","accessKey":"","forcePathStyle":false}},"s3":{"enabled":false,"bucket":"","region":"","endpoint":"s3_endpoint","accessKey":"","secret":"s3_secret","forcePathStyle":false},"meta":{"accentColor":"","appName":"test_app_name","appURL":"","senderName":"","senderAddress":"","hideControls":false},"rateLimits":{"rules":[],"excludedIPs":[],"enabled":true},"trustedProxy":{"headers":[],"useLeftmostIP":true},"batch":{"enabled":false,"maxRequests":0,"timeout":15,"maxBodySize":0},"logs":{"maxDataSize":0,"maxDays":123,"minLevel":0,"logIP":false,"logAuthId":false}}`;
      expect(valueStr).toBe(expected);

      // not new: updated only
      expect(exported.id).toBe("settings");
      expect(exported.updated).toBe("2026-10-29 10:00:00.123Z");
      expect(exported.created).toBeUndefined();
    });
  }

  test("a new settings model also exports created", async () => {
    const settings = new Settings(zeroSettingsData(), true);
    const exported = await settings.dbExport(fixedClock, "");
    expect(exported.created).toBe("2026-10-29 10:00:00.123Z");
    expect(exported.updated).toBe("2026-10-29 10:00:00.123Z");
  });
});

test("TestSettingsMerge", () => {
  const s1 = new Settings();
  s1.Meta.AppURL = "app_url"; // should be unset

  const s2 = new Settings();
  s2.Meta.AppName = "test";
  s2.Logs.MaxDays = 123;
  s2.SMTP.Host = "test";
  s2.SMTP.Enabled = true;
  s2.S3.Enabled = true;
  s2.S3.Endpoint = "test";
  s2.Backups.Cron = "* * * * *";
  s2.Batch.Timeout = 15;

  s1.merge(s2);

  expect(s1.marshalJSON()).toBe(s2.marshalJSON());
});

test("TestSettingsClone", () => {
  const s1 = new Settings();
  s1.Meta.AppName = "test_name";

  const s2 = s1.clone();

  expect(s2.marshalJSON()).toBe(s1.marshalJSON());

  // verify that it is a deep copy
  s2.Meta.AppName = "new_test_name";
  expect(s1.Meta.AppName).not.toBe(s2.Meta.AppName);
});

test("TestSettingsMarshalJSON", () => {
  const settings = new Settings();

  // control fields
  settings.Meta.AppName = "test123";
  settings.SMTP.Username = "abc";

  // secrets
  const testSecret = "test_secret";
  settings.SMTP.Password = testSecret;
  settings.S3.Secret = testSecret;
  settings.Backups.S3.Secret = testSecret;

  const expected = `{"superuserIPs":[],"smtp":{"enabled":false,"port":0,"host":"","username":"abc","authMethod":"","tls":false,"localName":""},"backups":{"cron":"","cronMaxKeep":0,"s3":{"enabled":false,"bucket":"","region":"","endpoint":"","accessKey":"","forcePathStyle":false}},"s3":{"enabled":false,"bucket":"","region":"","endpoint":"","accessKey":"","forcePathStyle":false},"meta":{"accentColor":"","appName":"test123","appURL":"","senderName":"","senderAddress":"","hideControls":false},"rateLimits":{"rules":[],"excludedIPs":[],"enabled":false},"trustedProxy":{"headers":[],"useLeftmostIP":false},"batch":{"enabled":false,"maxRequests":0,"timeout":0,"maxBodySize":0},"logs":{"maxDataSize":0,"maxDays":0,"minLevel":0,"logIP":false,"logAuthId":false}}`;

  expect(settings.marshalJSON()).toBe(expected);

  // the secrets themselves are kept
  expect(settings.SMTP.Password).toBe(testSecret);
  expect(settings.S3.Secret).toBe(testSecret);
  expect(settings.Backups.S3.Secret).toBe(testSecret);
});

test("TestSettingsValidate", () => {
  const s = new Settings();

  // set invalid settings data
  s.SuperuserIPs = ["127.0.0.1", ""];
  s.Meta.AppName = "";
  s.Logs.MaxDays = -10;
  s.SMTP.Enabled = true;
  s.SMTP.Host = "";
  s.S3.Enabled = true;
  s.S3.Endpoint = "invalid";
  s.Backups.Cron = "invalid";
  s.Backups.CronMaxKeep = -10;
  s.Batch.Enabled = true;
  s.Batch.MaxRequests = -1;
  s.Batch.Timeout = -1;
  s.RateLimits.Enabled = true;
  s.RateLimits.Rules = null;

  // check if Validate() is triggering the members validate methods.
  const err = s.validate();
  expect(err).toBeInstanceOf(Errors);

  const jsonErr = (err as Errors).marshalJSON();
  for (const expected of [
    `"superuserIPs":{`,
    `"meta":{`,
    `"logs":{`,
    `"smtp":{`,
    `"s3":{`,
    `"backups":{`,
    `"batch":{`,
    `"rateLimits":{`,
  ]) {
    expect(jsonErr).toContain(expected);
  }
});

function validationTable<T>(
  name: string,
  validate: (config: T) => Error | null,
  scenarios: [string, T, string[]][],
): void {
  describe(name, () => {
    for (const [scenario, config, expectedErrors] of scenarios) {
      test(scenario, () => {
        expectValidationErrors(validate(config), expectedErrors);
      });
    }
  });
}

validationTable("TestMetaConfigValidate", validateMeta, [
  ["zero values", meta(), ["appName", "appURL", "senderName", "senderAddress"]],
  [
    "invalid data",
    meta({
      AccentColor: "#fff",
      AppName: "a".repeat(300),
      AppURL: "test",
      SenderName: "a".repeat(300),
      SenderAddress: "invalid_email",
    }),
    ["accentColor", "appName", "appURL", "senderName", "senderAddress"],
  ],
  [
    "valid data",
    meta({
      AccentColor: "#ffffff",
      AppName: "test",
      AppURL: "https://example.com",
      SenderName: "test",
      SenderAddress: "test@example.com",
    }),
    [],
  ],
]);

validationTable("TestLogsConfigValidate", validateLogs, [
  ["zero values", logs(), []],
  ["invalid data", logs({ MaxDays: -1, MaxDataSize: -1 }), ["maxDays", "maxDataSize"]],
  ["valid data", logs({ MaxDays: 2 }), []],
]);

validationTable("TestSMTPConfigValidate", validateSMTP, [
  ["zero values (disabled)", smtp(), []],
  ["zero values (enabled)", smtp({ Enabled: true }), ["host", "port"]],
  [
    "invalid data",
    smtp({
      Enabled: true,
      Host: "test:test:test",
      Port: -10,
      LocalName: "invalid!",
      AuthMethod: "invalid",
    }),
    ["host", "port", "authMethod", "localName"],
  ],
  [
    "valid data (no explicit auth method and localName)",
    smtp({ Enabled: true, Host: "example.com", Port: 100, TLS: true }),
    [],
  ],
  [
    "valid data (explicit auth method and localName)",
    smtp({
      Enabled: true,
      Host: "example.com",
      Port: 100,
      AuthMethod: SMTPAuthLogin,
      LocalName: "example.com",
    }),
    [],
  ],
]);

validationTable("TestS3ConfigValidate", validateS3, [
  ["zero values (disabled)", s3(), []],
  [
    "zero values (enabled)",
    s3({ Enabled: true }),
    ["bucket", "region", "endpoint", "accessKey", "secret"],
  ],
  [
    "invalid data",
    s3({ Enabled: true, Endpoint: "test:test:test" }),
    ["bucket", "region", "endpoint", "accessKey", "secret"],
  ],
  [
    "valid data (url endpoint)",
    s3({
      Enabled: true,
      Endpoint: "https://localhost:8090",
      Bucket: "test",
      Region: "test",
      AccessKey: "test",
      Secret: "test",
    }),
    [],
  ],
  [
    "valid data (hostname endpoint)",
    s3({
      Enabled: true,
      Endpoint: "example.com",
      Bucket: "test",
      Region: "test",
      AccessKey: "test",
      Secret: "test",
    }),
    [],
  ],
]);

validationTable("TestBackupsConfigValidate", validateBackups, [
  ["zero value", backups(), []],
  ["invalid cron", backups({ Cron: "invalid", CronMaxKeep: 0 }), ["cron", "cronMaxKeep"]],
  ["invalid enabled S3", backups({ S3: s3({ Enabled: true }) }), ["s3"]],
  [
    "valid data",
    backups({
      S3: s3({
        Enabled: true,
        Endpoint: "example.com",
        Bucket: "test",
        Region: "test",
        AccessKey: "test",
        Secret: "test",
      }),
      Cron: "*/10 * * * *",
      CronMaxKeep: 1,
    }),
    [],
  ],
]);

validationTable("TestBatchConfigValidate", validateBatch, [
  ["zero value", batch(), []],
  ["zero value (enabled)", batch({ Enabled: true }), ["maxRequests", "timeout"]],
  [
    "invalid data (negative values)",
    batch({ MaxRequests: -1, Timeout: -1, MaxBodySize: -1 }),
    ["maxRequests", "timeout", "maxBodySize"],
  ],
  ["min fields valid data", batch({ Enabled: true, MaxRequests: 1, Timeout: 1 }), []],
  [
    "all fields valid data",
    batch({ Enabled: true, MaxRequests: 10, Timeout: 1, MaxBodySize: 1 }),
    [],
  ],
]);

validationTable("TestRateLimitsConfigValidate", validateRateLimits, [
  ["zero value (disabled)", rateLimits(), []],
  ["zero value (enabled)", rateLimits({ Enabled: true }), ["rules"]],
  [
    "invalid data",
    rateLimits({
      Enabled: true,
      ExcludedIPs: ["", "127.0.0.1"],
      Rules: [
        rule({ Label: "/123abc/", Duration: 1, MaxRequests: 2 }),
        rule({ Label: "!abc", Duration: -1, MaxRequests: -1 }),
      ],
    }),
    ["rules", "excludedIPs"],
  ],
  [
    "valid data",
    rateLimits({
      Enabled: true,
      ExcludedIPs: ["127.0.0.1", "10.0.0.1/20"],
      Rules: [
        rule({ Label: "123_abc", Duration: 1, MaxRequests: 2 }),
        rule({ Label: "/456-abc", Duration: 1, MaxRequests: 2 }),
      ],
    }),
    [],
  ],
  [
    "duplicated rules with the same audience",
    rateLimits({
      Enabled: true,
      Rules: [
        rule({ Label: "/a", Duration: 1, MaxRequests: 2 }),
        rule({ Label: "/a", Duration: 2, MaxRequests: 3 }),
      ],
    }),
    ["rules"],
  ],
  [
    "duplicated rule with conflicting audience (A)",
    rateLimits({
      Enabled: true,
      Rules: [
        rule({ Label: "/a", Duration: 1, MaxRequests: 2 }),
        rule({ Label: "/a", Duration: 1, MaxRequests: 2, Audience: RateLimitRuleAudienceGuest }),
      ],
    }),
    ["rules"],
  ],
  [
    "duplicated rule with conflicting audience (B)",
    rateLimits({
      Enabled: true,
      Rules: [
        rule({ Label: "/a", Duration: 1, MaxRequests: 2, Audience: RateLimitRuleAudienceAuth }),
        rule({ Label: "/a", Duration: 1, MaxRequests: 2 }),
      ],
    }),
    ["rules"],
  ],
  [
    "duplicated rule with non-conflicting audience",
    rateLimits({
      Enabled: true,
      Rules: [
        rule({ Label: "/a", Duration: 1, MaxRequests: 2, Audience: RateLimitRuleAudienceAuth }),
        rule({ Label: "/a", Duration: 1, MaxRequests: 2, Audience: RateLimitRuleAudienceGuest }),
      ],
    }),
    [],
  ],
]);

describe("TestRateLimitsFindRateLimitRule", () => {
  const limits = rateLimits({
    Rules: [
      rule({ Label: "abc" }),
      rule({ Label: "def", Audience: RateLimitRuleAudienceGuest }),
      rule({ Label: "/test/a", Audience: RateLimitRuleAudienceGuest }),
      rule({ Label: "POST /test/a" }),
      rule({ Label: "/test/a/", Audience: RateLimitRuleAudienceAuth }),
      rule({ Label: "POST /test/a/" }),
    ],
  });

  const scenarios: [string[], string[], string][] = [
    [[], [], ""],
    [["missing"], [], ""],
    [["abc"], [], "abc"],
    [["abc"], [RateLimitRuleAudienceGuest], ""],
    [["abc"], [RateLimitRuleAudienceAuth], ""],
    [["def"], [RateLimitRuleAudienceGuest], "def"],
    [["def"], [RateLimitRuleAudienceAuth], ""],
    [["/test"], [], ""],
    [["/test/a"], [], "/test/a"],
    [["/test/a"], [RateLimitRuleAudienceAuth], "/test/a/"],
    [["/test/a"], [RateLimitRuleAudienceGuest], "/test/a"],
    [["GET /test/a"], [], ""],
    [["POST /test/a"], [], "POST /test/a"],
    [["/test/a/b/c"], [], "/test/a/"],
    [["/test/a/b/c"], [RateLimitRuleAudienceAuth], "/test/a/"],
    [["/test/a/b/c"], [RateLimitRuleAudienceGuest], ""],
    [["GET /test/a/b/c"], [], ""],
    [["POST /test/a/b/c"], [], "POST /test/a/"],
    [["/test/a", "abc"], [], "/test/a"], // priority checks
  ];

  for (const [labels, audience, expected] of scenarios) {
    test(`${labels.join("_")}:${audience.join("_")}`, () => {
      const [found, ok] = findRateLimitRule(limits, labels, ...audience);

      const hasLabel = found.Label !== "";
      expect(ok).toBe(hasLabel);
      expect(found.Label).toBe(expected);
    });
  }
});

validationTable("TestRateLimitRuleValidate", validateRateLimitRule, [
  ["zero value", rule(), ["label", "duration", "maxRequests"]],
  [
    "invalid data",
    rule({ Label: "@abc", Duration: -1, MaxRequests: -1, Audience: "invalid" }),
    ["label", "duration", "maxRequests", "audience"],
  ],
  ["valid data (name)", rule({ Label: "abc:123", Duration: 1, MaxRequests: 1 }), []],
  ["valid data (name:action)", rule({ Label: "abc:123", Duration: 1, MaxRequests: 1 }), []],
  ["valid data (*:action)", rule({ Label: "*:123", Duration: 1, MaxRequests: 1 }), []],
  ["valid data (path /a/b)", rule({ Label: "/a/b", Duration: 1, MaxRequests: 1 }), []],
  ["valid data (path POST /a/b)", rule({ Label: "POST /a/b/", Duration: 1, MaxRequests: 1 }), []],
  [
    "invalid audience",
    rule({ Label: "/a/b/", Duration: 1, MaxRequests: 1, Audience: "invalid" }),
    ["audience"],
  ],
  [
    "valid audience - " + RateLimitRuleAudienceGuest,
    rule({
      Label: "POST /a/b/",
      Duration: 1,
      MaxRequests: 1,
      Audience: RateLimitRuleAudienceGuest,
    }),
    [],
  ],
  [
    "valid audience - " + RateLimitRuleAudienceAuth,
    rule({ Label: "POST /a/b/", Duration: 1, MaxRequests: 1, Audience: RateLimitRuleAudienceAuth }),
    [],
  ],
]);

describe("TestRateLimitRuleDurationTime", () => {
  const scenarios: [RateLimitRule, number][] = [
    [rule(), 0],
    [rule({ Duration: 1234 }), 1234 * 1000],
  ];

  for (const [i, [r, expected]] of scenarios.entries()) {
    test(`${i}_${r.Duration}`, () => {
      expect(rateLimitRuleDurationTime(r)).toBe(expected);
    });
  }
});

describe("TestRateLimitRuleString", () => {
  const scenarios: [string, RateLimitRule, string][] = [
    ["empty", rule(), `{"label":"","audience":"","duration":0,"maxRequests":0}`],
    [
      "all fields",
      rule({
        Label: "POST /a/b/",
        Duration: 1,
        MaxRequests: 2,
        Audience: RateLimitRuleAudienceAuth,
      }),
      `{"label":"POST /a/b/","audience":"@auth","duration":1,"maxRequests":2}`,
    ],
  ];

  for (const [name, r, expected] of scenarios) {
    test(name, () => {
      expect(rateLimitRuleString(r)).toBe(expected);
    });
  }
});
