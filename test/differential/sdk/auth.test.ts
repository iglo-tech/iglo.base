// RecordService auth methods of the JavaScript SDK 0.28.1 against both
// servers: listAuthMethods, password, refresh, impersonate, verification,
// password reset, email change, OTP, MFA, OAuth2 (code and urlCallback forms),
// external auths. Tokens come from the servers' mail (each server has its
// own SMTP sink). Not part of `bun test`: run `bun run test:reference`.

import { describe, expect } from "bun:test";
import PocketBase from "pocketbase";

import {
  mailMatch,
  messageBody,
  password,
  sdkTest,
  type SdkEnv,
} from "@test/differential/sdk/harness";
import { updateCollection } from "@test/scenarios/prepare";
import { all, useProvider, verifiedEmail } from "@test/scenarios/record-auth-oauth2";
import { setMFA } from "@test/scenarios/record-auth-prepare";

const noMFA = ({ dataDir }: { dataDir: string }) => setMFA("users", false, "")({ dataDir });

// the client's auth store as comparable data
function store(pb: PocketBase): unknown {
  return {
    token: pb.authStore.token,
    record: pb.authStore.record,
    isValid: pb.authStore.isValid,
    isSuperuser: pb.authStore.isSuperuser,
  };
}

describe("password auth", () => {
  sdkTest(
    "listAuthMethods, authWithPassword, authRefresh, authStore",
    { prepare: noMFA },
    async (env) => {
      const pb = env.client();
      await env.step("listAuthMethods", () => pb.collection("users").listAuthMethods());
      await env.step("listAuthMethods (fields)", () =>
        pb.collection("users").listAuthMethods({ fields: "password" }),
      );
      await env.fails("listAuthMethods (not auth)", () => pb.collection("demo1").listAuthMethods());
      await env.fails("authWithPassword (wrong)", () =>
        pb.collection("users").authWithPassword("test@example.com", "wrong-password"),
      );
      env.record("authStore (guest)", store(pb));
      await env.step("authWithPassword", () =>
        pb.collection("users").authWithPassword("test@example.com", password, { expand: "" }),
      );
      env.record("authStore (user)", store(pb));
      await env.step("authRefresh", () => pb.collection("users").authRefresh());
      env.record("authStore (refreshed)", store(pb));
      const changes: unknown[] = [];
      const off = pb.authStore.onChange((token, record) =>
        changes.push([token !== "", record?.id]),
      );
      pb.authStore.clear();
      off();
      env.record("authStore (cleared)", { store: store(pb), changes });
      await env.fails("authRefresh (guest)", () => pb.collection("users").authRefresh());

      await env.step("authWithPassword (superuser)", () =>
        pb
          .collection("_superusers")
          .authWithPassword("test@example.com", password, { fields: "token,record.id" }),
      );
      env.record("authStore (superuser)", store(pb));
      await env.step("authWithPassword (by username identity)", () =>
        env.client().collection("clients").authWithPassword("test@example.com", password),
      );
    },
  );

  sdkTest("impersonate", { prepare: noMFA }, async (env) => {
    const pb = env.superuser();
    const client = await env.step("impersonate", () =>
      pb.collection("users").impersonate("4q1xlclmfloku33", 3600),
    );
    expect(client.authStore.isValid).toBe(true);
    await env.step("impersonated getOne", () =>
      client.collection("users").getOne("4q1xlclmfloku33"),
    );
    await env.step("impersonated authRefresh", () => client.collection("users").authRefresh());
    await env.fails("impersonate (not a superuser)", () =>
      client.collection("users").impersonate("4q1xlclmfloku33", 10),
    );
    await env.fails("impersonate (missing)", () =>
      pb.collection("users").impersonate("missingmissing1", 10),
    );
  });
});

describe("mail flows", () => {
  sdkTest("verification", { smtp: true, prepare: noMFA }, async (env) => {
    const pb = env.client();
    await env.step("requestVerification", () =>
      pb.collection("users").requestVerification("test@example.com"),
    );
    const m = await env.mail("verification mail", "test@example.com");
    const token = mailMatch(m, /confirm-verification\/([^)\s]+)/);
    await env.fails("confirmVerification (invalid)", () =>
      pb.collection("users").confirmVerification("invalid"),
    );
    await env.step("confirmVerification", () => pb.collection("users").confirmVerification(token));
    await env.fails("confirmVerification (again)", () =>
      pb.collection("users").confirmVerification(token),
    );
    await env.step("verified", () =>
      env.superuser().collection("users").getOne("4q1xlclmfloku33", { fields: "id,verified" }),
    );
    await env.fails("requestVerification (invalid)", () =>
      pb.collection("users").requestVerification("not-an-email"),
    );
  });

  sdkTest("password reset", { smtp: true, prepare: noMFA }, async (env) => {
    const pb = env.client();
    await env.step("requestPasswordReset", () =>
      pb.collection("users").requestPasswordReset("test2@example.com"),
    );
    const m = await env.mail("reset mail", "test2@example.com");
    const token = mailMatch(m, /confirm-password-reset\/([^)\s]+)/);
    await env.fails("confirmPasswordReset (mismatch)", () =>
      pb.collection("users").confirmPasswordReset(token, "newpassword123", "different123"),
    );
    await env.step("confirmPasswordReset", () =>
      pb.collection("users").confirmPasswordReset(token, "newpassword123", "newpassword123"),
    );
    await env.fails("authWithPassword (old password)", () =>
      pb.collection("users").authWithPassword("test2@example.com", password),
    );
    await env.step("authWithPassword (new password)", () =>
      pb.collection("users").authWithPassword("test2@example.com", "newpassword123"),
    );
    await env.fails("confirmPasswordReset (used token)", () =>
      pb.collection("users").confirmPasswordReset(token, "another12345", "another12345"),
    );
  });

  sdkTest("email change", { smtp: true, prepare: noMFA }, async (env) => {
    const pb = env.client();
    await env.fails("requestEmailChange (guest)", () =>
      pb.collection("users").requestEmailChange("new@example.com"),
    );
    await env.step("authWithPassword", () =>
      pb.collection("users").authWithPassword("test2@example.com", password),
    );
    await env.fails("requestEmailChange (invalid)", () =>
      pb.collection("users").requestEmailChange("nope"),
    );
    await env.step("requestEmailChange", () =>
      pb.collection("users").requestEmailChange("changed@example.com"),
    );
    const m = await env.mail("email change mail", "changed@example.com");
    const token = mailMatch(m, /confirm-email-change\/([^)\s]+)/);
    await env.fails("confirmEmailChange (wrong password)", () =>
      pb.collection("users").confirmEmailChange(token, "wrong-password"),
    );
    await env.step("confirmEmailChange", () =>
      pb.collection("users").confirmEmailChange(token, password),
    );
    env.record("authStore after email change", store(pb));
    await env.step("authWithPassword (new email)", () =>
      env.client().collection("users").authWithPassword("changed@example.com", password),
    );
  });

  sdkTest("OTP", { smtp: true, prepare: noMFA }, async (env) => {
    const pb = env.client();
    const { otpId } = await env.step("requestOTP", () =>
      pb.collection("users").requestOTP("test2@example.com"),
    );
    const m = await env.mail("otp mail", "test2@example.com");
    const code = /\b(\d{8})\b/.exec(messageBody(m))?.[1] ?? "";
    await env.fails("authWithOTP (wrong)", () =>
      pb.collection("users").authWithOTP(otpId, "000000"),
    );
    await env.step("authWithOTP", () => pb.collection("users").authWithOTP(otpId, code));
    env.record("authStore (otp)", store(pb));
    await env.fails("authWithOTP (used)", () => pb.collection("users").authWithOTP(otpId, code));
    await env.step("requestOTP (unknown email)", () =>
      pb
        .collection("users")
        .requestOTP("nobody@example.com")
        .then((r) => ({ hasId: r.otpId.length })),
    );
  });

  sdkTest(
    "MFA with password then OTP",
    {
      smtp: true,
      prepare: ({ dataDir }) => {
        updateCollection(dataDir, "users", (c) => {
          c.mfa.enabled = true;
          c.mfa.rule = "";
        });
      },
    },
    async (env) => {
      const pb = env.client();
      const err = await env.fails("authWithPassword (mfa required)", () =>
        pb.collection("users").authWithPassword("test2@example.com", password),
      );
      const mfaId = (err.response as { mfaId: string }).mfaId;
      const { otpId } = await env.step("requestOTP", () =>
        pb.collection("users").requestOTP("test2@example.com"),
      );
      const m = await env.mail("otp mail", "test2@example.com");
      const code = /\b(\d{8})\b/.exec(messageBody(m))?.[1] ?? "";
      await env.step("authWithOTP (mfa)", () =>
        pb.collection("users").authWithOTP(otpId, code, { body: { otpId, password: code, mfaId } }),
      );
    },
  );
});

describe("OAuth2", () => {
  const prepare = (user: object) => (env: { dataDir: string }) =>
    all(
      noMFA,
      useProvider({ user }, (collection, provider) => {
        const first = collection.oauth2.providers?.[0];
        if (first !== undefined) {
          // one name for both servers' mock providers
          first.authURL = "https://oauth.example/auth?client_id=123";
        }
        void provider;
      }),
    )({ dataDir: env.dataDir });

  async function authWithCode(env: SdkEnv): Promise<void> {
    const pb = env.client();
    await env.step("listAuthMethods", () =>
      pb.collection("users").listAuthMethods({ fields: "oauth2" }),
    );
    await env.step("authWithOAuth2Code (sign up)", () =>
      pb
        .collection("users")
        .authWithOAuth2Code("oidc", "code", "verifier", "https://example.com/redirect", {
          name: "SDK User",
        }),
    );
    env.record("authStore (oauth2)", store(pb));
    await env.step("listExternalAuths", () =>
      env
        .superuser()
        .collection("users")
        .listExternalAuths(pb.authStore.record?.id as string),
    );
    await env.step("authWithOAuth2Code (sign in again)", () =>
      env
        .client()
        .collection("users")
        .authWithOAuth2Code("oidc", "code", "verifier", "https://example.com/redirect"),
    );
    await env.fails("authWithOAuth2Code (unknown provider)", () =>
      env
        .client()
        .collection("users")
        .authWithOAuth2Code("nope", "code", "verifier", "https://example.com/redirect"),
    );
    await env.step("unlinkExternalAuth", () =>
      env
        .superuser()
        .collection("users")
        .unlinkExternalAuth(pb.authStore.record?.id as string, "oidc"),
    );
    await env.fails("unlinkExternalAuth (again)", () =>
      env
        .superuser()
        .collection("users")
        .unlinkExternalAuth(pb.authStore.record?.id as string, "oidc"),
    );
  }

  sdkTest(
    "authWithOAuth2Code, listExternalAuths, unlinkExternalAuth",
    {
      prepare: prepare({
        sub: "sdk-1",
        ...verifiedEmail("oauth-sdk@example.com"),
        preferred_username: "sdkuser",
      }),
    },
    authWithCode,
  );

  sdkTest(
    "authWithOAuth2 (urlCallback form)",
    { prepare: prepare({ sub: "sdk-2", ...verifiedEmail("oauth-url@example.com") }) },
    async (env) => {
      const pb = env.client();
      const urls: string[] = [];
      await env.step("authWithOAuth2", () =>
        pb.collection("users").authWithOAuth2({
          provider: "oidc",
          createData: { name: "Popupless" },
          urlCallback: async (url) => {
            const u = new URL(url);
            urls.push(
              u.origin +
                u.pathname +
                `?client_id=${u.searchParams.get("client_id")}&redirect_uri=${u.searchParams.get("redirect_uri")?.replace(env.url, "<base>")}&scope=${u.searchParams.get("scope")}`,
            );
            const state = u.searchParams.get("state") ?? "";
            // the page it answers with is the dashboard (iglo.base patches its title)
            await fetch(`${env.url}/api/oauth2-redirect?state=${state}&code=from_provider`);
          },
        }),
      );
      env.record("authorization URLs", urls);
      env.record("authStore", store(pb));
      await env.fails("authWithOAuth2 (unknown provider)", () =>
        env
          .client()
          .collection("users")
          .authWithOAuth2({ provider: "nope", urlCallback: () => undefined }),
      );
    },
  );
});
