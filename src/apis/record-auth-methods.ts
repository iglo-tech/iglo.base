// Upstream: apis/record_auth_methods.go
//
// The OAuth2 providers come from src/oauth2/providers.ts, which knows the
// defaults of every provider upstream registers. A
// provider that fails to initialize is skipped, as upstream skips it
// (upstream also writes a debug log line; application code here logs only
// errors).

import type { RequestEvent } from "@/app/event-request";
import { findAuthCollection } from "@/apis/record-auth";
import type { BaseProvider } from "@/oauth2/base-provider";
import { buildAuthURL, initProvider } from "@/oauth2/providers";
import { ApiError } from "@/server/error";
import type { HandlerResult } from "@/server/handler";
import { s256Challenge } from "@/tools/security/crypto";
import { randomString } from "@/tools/security/random";

// auth.NameApple
const NameApple = "apple";

interface ProviderInfo {
  name: string;
  displayName: string;
  logo: string;
  state: string;
  authURL: string;

  // @todo
  // deprecated: use AuthURL instead
  // AuthUrl will be removed after dropping v0.22 support
  authUrl: string;

  // technically could be omitted if the provider doesn't support PKCE,
  // but to avoid breaking existing typed clients we'll return them as empty string
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

// the response members in the order of upstream's struct fields
interface AuthMethodsResponse {
  password: { identityFields: string[]; enabled: boolean };
  oauth2: { providers: ProviderInfo[]; enabled: boolean };
  mfa: { enabled: boolean; duration: number }; // duration in seconds
  otp: { enabled: boolean; duration: number }; // duration in seconds

  // legacy fields
  // @todo remove after dropping v0.22 support
  authProviders: ProviderInfo[];
  usernamePassword: boolean;
  emailPassword: boolean;
}

function fillLegacyFields(amr: AuthMethodsResponse): void {
  amr.emailPassword = amr.password.enabled && amr.password.identityFields.includes("email");

  amr.usernamePassword = amr.password.enabled && amr.password.identityFields.includes("username");

  if (amr.oauth2.enabled) {
    // clone without the logo
    amr.authProviders = amr.oauth2.providers.map((p) => ({ ...p, logo: "" }));
  }
}

export function recordAuthMethods(e: RequestEvent): HandlerResult {
  const collection = findAuthCollection(e);
  if (collection instanceof ApiError) {
    return collection;
  }

  const result: AuthMethodsResponse = {
    password: { identityFields: [], enabled: false },
    oauth2: { providers: [], enabled: false },
    mfa: { enabled: collection.mfa.enabled, duration: 0 },
    otp: { enabled: collection.otp.enabled, duration: 0 },
    authProviders: [],
    usernamePassword: false,
    emailPassword: false,
  };

  if (collection.passwordAuth.enabled) {
    result.password.enabled = true;
    result.password.identityFields = collection.passwordAuth.identityFields;
  }

  if (collection.otp.enabled) {
    result.otp.duration = Number(collection.otp.duration);
  }

  if (collection.mfa.enabled) {
    result.mfa.duration = Number(collection.mfa.duration);
  }

  if (!collection.oauth2.enabled) {
    fillLegacyFields(result);

    return e.json(200, result);
  }

  result.oauth2.enabled = true;

  for (const config of collection.oauth2.providers ?? []) {
    let provider: BaseProvider;
    try {
      provider = initProvider(config);
    } catch {
      continue; // skip provider
    }

    const info: ProviderInfo = {
      name: config.name,
      displayName: provider.displayName,
      logo: provider.logo,
      state: randomString(30),
      authURL: "",
      authUrl: "",
      codeVerifier: "",
      codeChallenge: "",
      codeChallengeMethod: "",
    };

    if (info.displayName === "") {
      info.displayName = config.name;
    }

    const urlOpts: [string, string][] = [];

    // custom providers url options
    switch (config.name) {
      case NameApple:
        // see https://developer.apple.com/documentation/sign_in_with_apple/sign_in_with_apple_js/incorporating_sign_in_with_apple_into_other_platforms#3332113
        urlOpts.push(["response_mode", "form_post"]);
        break;
    }

    if (provider.pkce) {
      info.codeVerifier = randomString(43);
      info.codeChallenge = s256Challenge(info.codeVerifier);
      info.codeChallengeMethod = "S256";
      urlOpts.push(
        ["code_challenge", info.codeChallenge],
        ["code_challenge_method", info.codeChallengeMethod],
      );
    }

    info.authURL = buildAuthURL(provider, info.state, ...urlOpts) + "&redirect_uri="; // empty redirect_uri so that users can append their redirect url

    info.authUrl = info.authURL;

    result.oauth2.providers.push(info);
  }

  fillLegacyFields(result);

  return e.json(200, result);
}
