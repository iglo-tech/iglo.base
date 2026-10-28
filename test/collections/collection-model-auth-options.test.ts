// Upstream: core/collection_model_auth_options_test.go (the tests that are
// not about validation: TestEmailTemplateResolve, the DurationTime tests,
// TestOAuth2ConfigUnmarshalJSON and TestOAuth2ConfigGetProviderConfig;
// the Validate tests TestCollectionAuthOptionsValidate, TestEmailTemplateValidate,
// TestTokenConfigValidate, TestAuthAlertConfigValidate, TestOTPConfigValidate,
// TestMFAConfigValidate, TestPasswordAuthConfigValidate, TestOAuth2ConfigValidate
// and TestOAuth2ProviderConfigValidate come with M1.6a;
// TestOAuth2ProviderConfigInitProvider with M4)

import { describe, expect, test } from "bun:test";

import { newAuthCollection } from "@/collections/collection-model";
import { validateCollection } from "@/collections/collection-validate";
import {
  AuthAlertConfig,
  EmailTemplate,
  MFAConfig,
  OAuth2Config,
  OAuth2KnownFields,
  OAuth2ProviderConfig,
  OTPConfig,
  PasswordAuthConfig,
  TokenConfig,
} from "@/collections/collection-model-auth-options";
import { TextField } from "@/fields/text";
import { marshal } from "@/tools/types/go-json";

import { openTestApp, type TestCollectionsApp } from "@test/collections/app";
import {
  type Pending,
  caseTest,
  expectValidationErrors,
  pendingRule,
} from "@test/collections/validation";

const second = 1_000_000_000n;

describe("EmailTemplateResolve", () => {
  const template = new EmailTemplate({
    subject: "test_subject {PARAM3} {PARAM1}-{PARAM2} repeat-{PARAM1}",
    body: "test_body {PARAM3} {PARAM2}-{PARAM1} repeat-{PARAM2}",
  });

  const scenarios: {
    name: string;
    placeholders: Record<string, unknown> | null;
    template: EmailTemplate;
    expectedSubject: string;
    expectedBody: string;
  }[] = [
    {
      name: "no placeholders",
      placeholders: null,
      template,
      expectedSubject: template.subject,
      expectedBody: template.body,
    },
    {
      name: "no matching placeholders",
      placeholders: { "{A}": "abc", "{B}": 456 },
      template,
      expectedSubject: template.subject,
      expectedBody: template.body,
    },
    {
      name: "at least one matching placeholder",
      placeholders: { "{PARAM1}": "abc", "{PARAM2}": 456 },
      template,
      expectedSubject: "test_subject {PARAM3} abc-456 repeat-abc",
      expectedBody: "test_body {PARAM3} 456-abc repeat-456",
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const [subject, body] = s.template.resolve(s.placeholders);

      expect(subject).toBe(s.expectedSubject);
      expect(body).toBe(s.expectedBody);
    });
  }
});

describe("TokenConfigDurationTime", () => {
  const scenarios: { config: TokenConfig; expected: bigint }[] = [
    { config: new TokenConfig(), expected: 0n * second },
    { config: new TokenConfig({ duration: 1234 }), expected: 1234n * second },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.config.duration}`, () => {
      expect(s.config.durationTime()).toBe(s.expected);
    });
  }
});

describe("OTPConfigDurationTime", () => {
  const scenarios: { config: OTPConfig; expected: bigint }[] = [
    { config: new OTPConfig(), expected: 0n * second },
    { config: new OTPConfig({ duration: 1234 }), expected: 1234n * second },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.config.duration}`, () => {
      expect(s.config.durationTime()).toBe(s.expected);
    });
  }
});

describe("MFAConfigDurationTime", () => {
  const scenarios: { config: MFAConfig; expected: bigint }[] = [
    { config: new MFAConfig(), expected: 0n * second },
    { config: new MFAConfig({ duration: 1234 }), expected: 1234n * second },
  ];

  for (const [i, s] of scenarios.entries()) {
    test(`${i}_${s.config.duration}`, () => {
      expect(s.config.durationTime()).toBe(s.expected);
    });
  }
});

describe("OAuth2ConfigUnmarshalJSON", () => {
  const scenarios: { name: string; newJSON: string; expected: string }[] = [
    {
      name: "missing",
      newJSON: `{
				"enabled": true,
				"mappedFields": {"username": "username_test"}
			}`,
      expected: `{"providers":[{"pkce":null,"name":"a","clientId":"a_clientId","clientSecret":"a_clientSecret","authURL":"","tokenURL":"","userInfoURL":"","displayName":"","extra":{}},{"pkce":null,"name":"b","clientId":"b_clientId","clientSecret":"b_clientSecret","authURL":"","tokenURL":"","userInfoURL":"","displayName":"","extra":{}}],"mappedFields":{"id":"","name":"name_test","username":"username_test","avatarURL":""},"enabled":true}`,
    },
    {
      name: "empty",
      newJSON: `{
				"enabled": true,
				"mappedFields": {"username": "username_test"},
				"providers": []
			}`,
      expected: `{"providers":[],"mappedFields":{"id":"","name":"name_test","username":"username_test","avatarURL":""},"enabled":true}`,
    },
    {
      name: "non-empty",
      newJSON: `{
				"enabled": true,
				"mappedFields": {"username": "username_test"},
				"providers": [
					{"name": "c", "clientId": "c_clientId", "clientSecret": "c_clientSecret"},
					{"name": "a", "displayName": "a_displayName"}
				]
			}`,
      expected: `{"providers":[{"pkce":null,"name":"c","clientId":"c_clientId","clientSecret":"c_clientSecret","authURL":"","tokenURL":"","userInfoURL":"","displayName":"","extra":{}},{"pkce":null,"name":"a","clientId":"a_clientId","clientSecret":"a_clientSecret","authURL":"","tokenURL":"","userInfoURL":"","displayName":"a_displayName","extra":{}}],"mappedFields":{"id":"","name":"name_test","username":"username_test","avatarURL":""},"enabled":true}`,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const config = new OAuth2Config({
        enabled: false,
        mappedFields: new OAuth2KnownFields({
          name: "name_test",
        }),
        providers: [
          new OAuth2ProviderConfig({
            name: "a",
            clientId: "a_clientId",
            clientSecret: "a_clientSecret",
          }),
          new OAuth2ProviderConfig({
            name: "b",
            clientId: "b_clientId",
            clientSecret: "b_clientSecret",
          }),
        ],
      });

      config.unmarshalJSON(s.newJSON);

      expect(marshal(config)).toBe(s.expected);
    });
  }
});

describe("OAuth2ConfigGetProviderConfig", () => {
  const scenarios: {
    name: string;
    providerName: string;
    config: OAuth2Config;
    expectedExists: boolean;
  }[] = [
    {
      name: "zero value",
      providerName: "gitlab",
      config: new OAuth2Config(),
      expectedExists: false,
    },
    {
      name: "empty config with valid provider",
      providerName: "gitlab",
      config: new OAuth2Config(),
      expectedExists: false,
    },
    {
      name: "non-empty config with missing provider",
      providerName: "gitlab",
      config: new OAuth2Config({
        providers: [
          new OAuth2ProviderConfig({ name: "google" }),
          new OAuth2ProviderConfig({ name: "github" }),
        ],
      }),
      expectedExists: false,
    },
    {
      name: "config with existing provider",
      providerName: "github",
      config: new OAuth2Config({
        providers: [
          new OAuth2ProviderConfig({ name: "google" }),
          new OAuth2ProviderConfig({ name: "github" }),
        ],
      }),
      expectedExists: true,
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const [config, exists] = s.config.getProviderConfig(s.providerName);

      expect(exists).toBe(s.expectedExists);

      if (exists) {
        expect(config.name).toBe(s.providerName);
      } else {
        expect(config.name).toBe("");
      }
    });
  }
});

describe("TestCollectionAuthOptionsValidate", () => {
  interface Scenario {
    name: string;
    collection: (app: TestCollectionsApp) => ReturnType<typeof newAuthCollection>;
    expectedErrors: string[];
    pending?: Pending;
  }

  const scenarios: Scenario[] = [
    // authRule
    {
      name: "nil authRule",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.authRule = null;
        return c;
      },
      expectedErrors: [],
    },
    {
      name: "empty authRule",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.authRule = "";
        return c;
      },
      expectedErrors: [],
    },
    {
      name: "invalid authRule",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.authRule = "missing != ''";
        return c;
      },
      expectedErrors: ["authRule"],
      pending: pendingRule,
    },
    {
      name: "valid authRule",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.authRule = "id != ''";
        return c;
      },
      expectedErrors: [],
    },

    // manageRule
    {
      name: "nil manageRule",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.manageRule = null;
        return c;
      },
      expectedErrors: [],
    },
    {
      name: "empty manageRule",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.manageRule = "";
        return c;
      },
      expectedErrors: ["manageRule"],
    },
    {
      name: "invalid manageRule",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.manageRule = "missing != ''";
        return c;
      },
      expectedErrors: ["manageRule"],
      pending: pendingRule,
    },
    {
      name: "valid manageRule",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.manageRule = "id != ''";
        return c;
      },
      expectedErrors: [],
    },

    // passwordAuth
    {
      name: "trigger passwordAuth validations",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.passwordAuth = new PasswordAuthConfig({ enabled: true });
        return c;
      },
      expectedErrors: ["passwordAuth"],
    },
    {
      name: "passwordAuth with non-unique identity fields",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.fields.add(new TextField({ name: "test" }));
        c.passwordAuth = new PasswordAuthConfig({
          enabled: true,
          identityFields: ["email", "test"],
        });
        return c;
      },
      expectedErrors: ["passwordAuth"],
    },
    {
      name: "passwordAuth with non-unique identity fields",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.fields.add(new TextField({ name: "test" }));
        c.addIndex("auth_test_idx", true, "test", "");
        c.passwordAuth = new PasswordAuthConfig({
          enabled: true,
          identityFields: ["email", "test"],
        });
        return c;
      },
      expectedErrors: [],
    },

    // oauth2
    {
      name: "trigger oauth2 validations",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.oauth2 = new OAuth2Config({
          enabled: true,
          providers: [new OAuth2ProviderConfig({ name: "missing" })],
        });
        return c;
      },
      expectedErrors: ["oauth2"],
    },

    // otp
    {
      name: "trigger otp validations",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.otp = new OTPConfig({ enabled: true, duration: -10 });
        return c;
      },
      expectedErrors: ["otp"],
    },

    // mfa
    {
      name: "trigger mfa validations",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.mfa = new MFAConfig({ enabled: true, duration: -10 });
        return c;
      },
      expectedErrors: ["mfa"],
    },
    {
      name: "mfa enabled with < 2 auth methods",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.mfa.enabled = true;
        c.passwordAuth.enabled = true;
        c.otp.enabled = false;
        c.oauth2.enabled = false;
        return c;
      },
      expectedErrors: ["mfa"],
    },
    {
      name: "mfa enabled with >= 2 auth methods",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.mfa.enabled = true;
        c.passwordAuth.enabled = true;
        c.otp.enabled = true;
        c.oauth2.enabled = false;
        return c;
      },
      expectedErrors: [],
    },
    {
      name: "mfa disabled with invalid rule",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.passwordAuth.enabled = true;
        c.otp.enabled = true;
        c.mfa.enabled = false;
        c.mfa.rule = "invalid";
        return c;
      },
      expectedErrors: [],
    },
    {
      name: "mfa enabled with invalid rule",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.passwordAuth.enabled = true;
        c.otp.enabled = true;
        c.mfa.enabled = true;
        c.mfa.rule = "invalid";
        return c;
      },
      expectedErrors: ["mfa"],
      pending: pendingRule,
    },
    {
      name: "mfa enabled with valid rule",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.passwordAuth.enabled = true;
        c.otp.enabled = true;
        c.mfa.enabled = true;
        c.mfa.rule = "1=1";
        return c;
      },
      expectedErrors: [],
    },

    // tokens
    {
      name: "trigger authToken validations",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.authToken.secret = "";
        return c;
      },
      expectedErrors: ["authToken"],
    },
    {
      name: "trigger passwordResetToken validations",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.passwordResetToken.secret = "";
        return c;
      },
      expectedErrors: ["passwordResetToken"],
    },
    {
      name: "trigger emailChangeToken validations",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.emailChangeToken.secret = "";
        return c;
      },
      expectedErrors: ["emailChangeToken"],
    },
    {
      name: "trigger verificationToken validations",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.verificationToken.secret = "";
        return c;
      },
      expectedErrors: ["verificationToken"],
    },
    {
      name: "trigger fileToken validations",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.fileToken.secret = "";
        return c;
      },
      expectedErrors: ["fileToken"],
    },

    // templates
    {
      name: "trigger verificationTemplate validations",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.verificationTemplate.body = "";
        return c;
      },
      expectedErrors: ["verificationTemplate"],
    },
    {
      name: "trigger resetPasswordTemplate validations",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.resetPasswordTemplate.body = "";
        return c;
      },
      expectedErrors: ["resetPasswordTemplate"],
    },
    {
      name: "trigger confirmEmailChangeTemplate validations",
      collection: () => {
        const c = newAuthCollection("new_auth");
        c.confirmEmailChangeTemplate.body = "";
        return c;
      },
      expectedErrors: ["confirmEmailChangeTemplate"],
    },
  ];

  for (const s of scenarios) {
    caseTest(s.name, s.pending, () => {
      const app = openTestApp();
      try {
        const collection = s.collection(app);

        const result = validateCollection(app, collection);

        expectValidationErrors(result, s.expectedErrors);
      } finally {
        app.cleanup();
      }
    });
  }
});

describe("TestEmailTemplateValidate", () => {
  const scenarios: { name: string; template: EmailTemplate; expectedErrors: string[] }[] = [
    {
      name: "zero value",
      template: new EmailTemplate(),
      expectedErrors: ["subject", "body"],
    },
    {
      name: "non-empty data",
      template: new EmailTemplate({ subject: "a", body: "b" }),
      expectedErrors: [],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const result = s.template.validate();

      expectValidationErrors(result, s.expectedErrors);
    });
  }
});

describe("TestTokenConfigValidate", () => {
  const scenarios: { name: string; config: TokenConfig; expectedErrors: string[] }[] = [
    {
      name: "zero value",
      config: new TokenConfig(),
      expectedErrors: ["secret", "duration"],
    },
    {
      name: "invalid data",
      config: new TokenConfig({
        secret: "a".repeat(29),
        duration: 9,
      }),
      expectedErrors: ["secret", "duration"],
    },
    {
      name: "valid data",
      config: new TokenConfig({
        secret: "a".repeat(30),
        duration: 10,
      }),
      expectedErrors: [],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const result = s.config.validate();

      expectValidationErrors(result, s.expectedErrors);
    });
  }
});

describe("TestAuthAlertConfigValidate", () => {
  const scenarios: { name: string; config: AuthAlertConfig; expectedErrors: string[] }[] = [
    {
      name: "zero value (disabled)",
      config: new AuthAlertConfig(),
      expectedErrors: ["emailTemplate"],
    },
    {
      name: "zero value (enabled)",
      config: new AuthAlertConfig({ enabled: true }),
      expectedErrors: ["emailTemplate"],
    },
    {
      name: "invalid template",
      config: new AuthAlertConfig({
        emailTemplate: new EmailTemplate({ body: "", subject: "b" }),
      }),
      expectedErrors: ["emailTemplate"],
    },
    {
      name: "valid data",
      config: new AuthAlertConfig({
        emailTemplate: new EmailTemplate({ body: "a", subject: "b" }),
      }),
      expectedErrors: [],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const result = s.config.validate();

      expectValidationErrors(result, s.expectedErrors);
    });
  }
});

describe("TestOTPConfigValidate", () => {
  const scenarios: { name: string; config: OTPConfig; expectedErrors: string[] }[] = [
    {
      name: "zero value (disabled)",
      config: new OTPConfig(),
      expectedErrors: ["emailTemplate"],
    },
    {
      name: "zero value (enabled)",
      config: new OTPConfig({ enabled: true }),
      expectedErrors: ["duration", "length", "emailTemplate"],
    },
    {
      name: "invalid length (< 3)",
      config: new OTPConfig({
        enabled: true,
        emailTemplate: new EmailTemplate({ body: "a", subject: "b" }),
        duration: 100,
        length: 3,
      }),
      expectedErrors: ["length"],
    },
    {
      name: "invalid duration (< 10)",
      config: new OTPConfig({
        enabled: true,
        emailTemplate: new EmailTemplate({ body: "a", subject: "b" }),
        duration: 9,
        length: 100,
      }),
      expectedErrors: ["duration"],
    },
    {
      name: "invalid duration (> 86400)",
      config: new OTPConfig({
        enabled: true,
        emailTemplate: new EmailTemplate({ body: "a", subject: "b" }),
        duration: 86401,
        length: 100,
      }),
      expectedErrors: ["duration"],
    },
    {
      name: "invalid template (triggering EmailTemplate validations)",
      config: new OTPConfig({
        enabled: true,
        emailTemplate: new EmailTemplate({ body: "", subject: "b" }),
        duration: 86400,
        length: 4,
      }),
      expectedErrors: ["emailTemplate"],
    },
    {
      name: "valid data",
      config: new OTPConfig({
        enabled: true,
        emailTemplate: new EmailTemplate({ body: "a", subject: "b" }),
        duration: 86400,
        length: 4,
      }),
      expectedErrors: [],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const result = s.config.validate();

      expectValidationErrors(result, s.expectedErrors);
    });
  }
});

describe("TestMFAConfigValidate", () => {
  const scenarios: { name: string; config: MFAConfig; expectedErrors: string[] }[] = [
    {
      name: "zero value (disabled)",
      config: new MFAConfig(),
      expectedErrors: [],
    },
    {
      name: "zero value (enabled)",
      config: new MFAConfig({ enabled: true }),
      expectedErrors: ["duration"],
    },
    {
      name: "invalid duration (< 10)",
      config: new MFAConfig({ enabled: true, duration: 9 }),
      expectedErrors: ["duration"],
    },
    {
      name: "invalid duration (> 86400)",
      config: new MFAConfig({ enabled: true, duration: 86401 }),
      expectedErrors: ["duration"],
    },
    {
      name: "valid data",
      config: new MFAConfig({ enabled: true, duration: 86400 }),
      expectedErrors: [],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const result = s.config.validate();

      expectValidationErrors(result, s.expectedErrors);
    });
  }
});

describe("TestPasswordAuthConfigValidate", () => {
  const scenarios: { name: string; config: PasswordAuthConfig; expectedErrors: string[] }[] = [
    {
      name: "zero value (disabled)",
      config: new PasswordAuthConfig(),
      expectedErrors: [],
    },
    {
      name: "zero value (enabled)",
      config: new PasswordAuthConfig({ enabled: true }),
      expectedErrors: ["identityFields"],
    },
    {
      name: "empty values",
      config: new PasswordAuthConfig({ enabled: true, identityFields: ["", ""] }),
      expectedErrors: ["identityFields"],
    },
    {
      name: "valid data",
      config: new PasswordAuthConfig({ enabled: true, identityFields: ["abc"] }),
      expectedErrors: [],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const result = s.config.validate();

      expectValidationErrors(result, s.expectedErrors);
    });
  }
});

describe("TestOAuth2ConfigValidate", () => {
  const scenarios: { name: string; config: OAuth2Config; expectedErrors: string[] }[] = [
    {
      name: "zero value (disabled)",
      config: new OAuth2Config(),
      expectedErrors: [],
    },
    {
      name: "zero value (enabled)",
      config: new OAuth2Config({ enabled: true }),
      expectedErrors: [],
    },
    {
      name: "unknown provider",
      config: new OAuth2Config({
        enabled: true,
        providers: [
          new OAuth2ProviderConfig({ name: "missing", clientId: "abc", clientSecret: "456" }),
        ],
      }),
      expectedErrors: ["providers"],
    },
    {
      name: "known provider with invalid data",
      config: new OAuth2Config({
        enabled: true,
        providers: [
          new OAuth2ProviderConfig({ name: "gitlab", clientId: "abc", tokenURL: "!invalid!" }),
        ],
      }),
      expectedErrors: ["providers"],
    },
    {
      name: "known provider with valid data",
      config: new OAuth2Config({
        enabled: true,
        providers: [
          new OAuth2ProviderConfig({
            name: "gitlab",
            clientId: "abc",
            clientSecret: "456",
            tokenURL: "https://example.com",
          }),
        ],
      }),
      expectedErrors: [],
    },
    {
      name: "known provider with valid data (duplicated)",
      config: new OAuth2Config({
        enabled: true,
        providers: [
          new OAuth2ProviderConfig({
            name: "gitlab",
            clientId: "abc1",
            clientSecret: "1",
            tokenURL: "https://example1.com",
          }),
          new OAuth2ProviderConfig({
            name: "google",
            clientId: "abc2",
            clientSecret: "2",
            tokenURL: "https://example2.com",
          }),
          new OAuth2ProviderConfig({
            name: "gitlab",
            clientId: "abc3",
            clientSecret: "3",
            tokenURL: "https://example3.com",
          }),
        ],
      }),
      expectedErrors: ["providers"],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const result = s.config.validate();

      expectValidationErrors(result, s.expectedErrors);
    });
  }
});

describe("TestOAuth2ProviderConfigValidate", () => {
  const scenarios: {
    name: string;
    config: OAuth2ProviderConfig;
    expectedErrors: string[];
  }[] = [
    {
      name: "zero value",
      config: new OAuth2ProviderConfig(),
      expectedErrors: ["name", "clientId", "clientSecret"],
    },
    {
      name: "minimum valid data",
      config: new OAuth2ProviderConfig({ name: "gitlab", clientId: "abc", clientSecret: "456" }),
      expectedErrors: [],
    },
    {
      name: "non-existing provider",
      config: new OAuth2ProviderConfig({ name: "missing", clientId: "abc", clientSecret: "456" }),
      expectedErrors: ["name"],
    },
    {
      name: "invalid urls",
      config: new OAuth2ProviderConfig({
        name: "gitlab",
        clientId: "abc",
        clientSecret: "456",
        authURL: "!invalid!",
        tokenURL: "!invalid!",
        userInfoURL: "!invalid!",
      }),
      expectedErrors: ["authURL", "tokenURL", "userInfoURL"],
    },
    {
      name: "valid urls",
      config: new OAuth2ProviderConfig({
        name: "gitlab",
        clientId: "abc",
        clientSecret: "456",
        authURL: "https://example.com/a",
        tokenURL: "https://example.com/b",
        userInfoURL: "https://example.com/c",
      }),
      expectedErrors: [],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const result = s.config.validate();

      expectValidationErrors(result, s.expectedErrors);
    });
  }
});
