// Upstream: core/collection_model_auth_options_test.go (the tests that are
// not about validation: TestEmailTemplateResolve, the DurationTime tests,
// TestOAuth2ConfigUnmarshalJSON and TestOAuth2ConfigGetProviderConfig;
// the Validate tests come with M1.6a, TestOAuth2ProviderConfigInitProvider
// with M4)

import { describe, expect, test } from "bun:test";

import {
  EmailTemplate,
  MFAConfig,
  OAuth2Config,
  OAuth2KnownFields,
  OAuth2ProviderConfig,
  OTPConfig,
  TokenConfig,
} from "@/collections/collection-model-auth-options";
import { marshal } from "@/tools/types/go-json";

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
