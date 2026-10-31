// Upstream: tools/auth/microsoft.go (FetchAuthUser, extractIdTokenClaims and
// the email extraction methods), checked in-process: the Graph user is the
// provider's default userInfoURL, answered by a test-only fetch
// (test/support/fetch-stub.ts). The id_token is read without a signature
// check, as upstream does; the times are checked against an injected clock.

import { afterEach, describe, expect, test } from "bun:test";

import { OAuth2ProviderConfig } from "@/collections/collection-model-auth-options";
import { Microsoft } from "@/oauth2/microsoft";
import { initProvider } from "@/oauth2/providers";
import { Token } from "@/oauth2/token";
import { json, type StubbedFetch, stubFetch } from "@test/support/fetch-stub";

const graphURL = "https://graph.microsoft.com/v1.0/me";

// the clock of the test: id_token times are checked at this instant
const instant = Date.parse("2026-10-31T12:00:00.000Z");
const nowSeconds = Math.floor(instant / 1000);
const clock = { now: () => new Date(instant) };

const b64url = (value: string): string => Buffer.from(value).toString("base64url");

// an id_token with these claims; its signature is not checked
function idToken(claims: { [key: string]: unknown }): string {
  return [
    b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    b64url(JSON.stringify(claims)),
    b64url("unchecked"),
  ].join(".");
}

const graphUser = { id: "e1f2a3", displayName: "Jane Doe", mail: "jane@example.com" };

let stub: StubbedFetch | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

// the Graph user and the token, signed in with the given extra config
async function signIn(
  extra: { [key: string]: unknown } | null,
  claims: { [key: string]: unknown } | null,
  user: { [key: string]: unknown } = graphUser,
): Promise<{ email: string; name: string; id: string }> {
  stub?.restore();
  stub = stubFetch({ [graphURL]: () => json(user) });
  const provider = initProvider(
    new OAuth2ProviderConfig({ name: "microsoft", extra }),
  ) as Microsoft;
  provider.clock = clock;
  const token = new Token({
    accessToken: "abc",
    raw: claims === null ? {} : { id_token: idToken(claims) },
  });
  const result = await provider.fetchAuthUser(token);
  return { email: result.email, name: result.name, id: result.id };
}

const claims = (overrides: { [key: string]: unknown } = {}) => ({
  iat: nowSeconds - 10,
  exp: nowSeconds + 3600,
  email: "jane@example.com",
  verified_primary_email: "jane@example.com",
  ...overrides,
});

describe("Microsoft's email methods", () => {
  test("without the extra config, the Graph mail is the email", async () => {
    expect(await signIn(null, null)).toEqual({
      email: "jane@example.com",
      name: "Jane Doe",
      id: "e1f2a3",
    });
  });

  test("an empty idTokenEmailClaim keeps the Graph mail", async () => {
    const { email } = await signIn({ idTokenEmailClaim: "" }, claims());
    expect(email).toBe("jane@example.com");
  });

  test("email reads the id_token's email claim", async () => {
    const { email } = await signIn(
      { idTokenEmailClaim: "email" },
      claims({ email: "claim@example.com" }),
      { ...graphUser, mail: "graph@example.com" },
    );
    expect(email).toBe("claim@example.com");
  });

  test("an unknown method falls back to the Graph mail", async () => {
    const { email } = await signIn({ idTokenEmailClaim: "other" }, claims(), {
      ...graphUser,
      mail: "graph@example.com",
    });
    expect(email).toBe("graph@example.com");
  });

  test("an id_token without an expiry is accepted", async () => {
    const { email } = await signIn(
      { idTokenEmailClaim: "verified_primary_email" },
      claims({ exp: undefined }),
    );
    expect(email).toBe("jane@example.com");
  });

  test("an id_token issued 400 seconds ahead is outside the 300 second leeway", async () => {
    const { email } = await signIn(
      { idTokenEmailClaim: "verified_primary_email" },
      claims({ iat: nowSeconds + 400 }),
    );
    expect(email).toBe("");
  });

  test("an id_token issued 200 seconds ahead is inside the leeway", async () => {
    const { email } = await signIn(
      { idTokenEmailClaim: "verified_primary_email" },
      claims({ iat: nowSeconds + 200 }),
    );
    expect(email).toBe("jane@example.com");
  });

  test("any_verified takes the xms_edov email when there is no verified primary email", async () => {
    const { email } = await signIn(
      { idTokenEmailClaim: "any_verified" },
      claims({ verified_primary_email: undefined, xms_edov: true, email: "edov@example.com" }),
    );
    expect(email).toBe("edov@example.com");
  });

  test("a non-string verified primary email is no email", async () => {
    const { email } = await signIn(
      { idTokenEmailClaim: "verified_primary_email" },
      claims({ verified_primary_email: 42 }),
    );
    expect(email).toBe("");
  });

  test("the xms_edov flag is read as a Go bool: a string 'true' counts", async () => {
    const { email } = await signIn(
      { idTokenEmailClaim: "email_and_xms_edov" },
      claims({ xms_edov: "true", email: "edov@example.com" }),
    );
    expect(email).toBe("edov@example.com");
  });
});

describe("Microsoft's id_token", () => {
  test("a missing id_token gives no email, not an error", async () => {
    const { email, name } = await signIn({ idTokenEmailClaim: "email" }, null);
    expect(email).toBe("");
    expect(name).toBe("Jane Doe");
  });

  test("a malformed id_token gives no email, not an error", async () => {
    stub?.restore();
    stub = stubFetch({ [graphURL]: () => json(graphUser) });
    const provider = initProvider(
      new OAuth2ProviderConfig({ name: "microsoft", extra: { idTokenEmailClaim: "email" } }),
    );
    provider.clock = clock;
    const user = await provider.fetchAuthUser(
      new Token({ accessToken: "abc", raw: { id_token: "x" } }),
    );
    expect(user.email).toBe("");
  });

  test("the Graph request carries the bearer token", async () => {
    stub?.restore();
    stub = stubFetch({ [graphURL]: () => json(graphUser) });
    const provider = new Microsoft();
    await provider.fetchAuthUser(new Token({ accessToken: "abc", tokenType: "bearer" }));
    expect(stub.calls).toEqual([graphURL]);
  });
});
