// Upstream: tools/auth/auth.go (NewProviderByName),
// core/collection_model_auth_options.go (OAuth2ProviderConfig.InitProvider),
// tools/auth/base_provider.go (BuildAuthURL with golang.org/x/oauth2's
// Config.AuthCodeURL) and the defaults of tools/auth/gitlab.go and google.go
//
// The fixed table of ported providers. A new provider is one file with a
// class that extends BaseProvider, and one line in portedProviders here; the
// display name, logo and order come from provider-list.ts. M4.6 and M4.7
// add the rest. Until then:
//   - a configured provider that is neither ported nor in listedProviders
//     fails to initialize, so the auth methods list skips it;
//   - listedProviders only have what the auth methods list needs; signing
//     in with them, or with any other unported provider, fails in
//     initSignInProvider before any network call.

import type { OAuth2ProviderConfig } from "@/collections/collection-model-auth-options";
import { type AuthUser, BaseProvider } from "@/oauth2/base-provider";
import { OIDC } from "@/oauth2/oidc";
import { providerMetadata } from "@/oauth2/provider-list";
import { encodeValues } from "@/server/request";

// the constructors of the ported providers, by name (auth.Providers)
const portedProviders = new Map<string, () => BaseProvider>([
  ["oidc", () => new OIDC()], // oidc.go
  ["oidc2", () => new OIDC()], // oidc.go
  ["oidc3", () => new OIDC()], // oidc.go
]);

// A provider with only the defaults the auth methods list reads.
class ListedProvider extends BaseProvider {
  constructor(pkce: boolean, scopes: string[], authURL: string) {
    super();
    this.pkce = pkce;
    this.scopes = scopes;
    this.authURL = authURL;
  }

  fetchAuthUser(): Promise<AuthUser> {
    return Promise.reject(new Error("the provider is not ported yet"));
  }
}

const listedProviders = new Map<string, () => BaseProvider>([
  // gitlab.go NewGitlabProvider
  ["gitlab", () => new ListedProvider(true, ["read_user"], "https://gitlab.com/oauth/authorize")],
  // google.go NewGoogleProvider
  [
    "google",
    () =>
      new ListedProvider(
        true,
        [
          "https://www.googleapis.com/auth/userinfo.profile",
          "https://www.googleapis.com/auth/userinfo.email",
        ],
        "https://accounts.google.com/o/oauth2/v2/auth",
      ),
  ],
]);

// NewProviderByName returns a new preconfigured provider instance by its
// name identifier.
function newProviderByName(name: string): BaseProvider {
  const factory = portedProviders.get(name) ?? listedProviders.get(name);
  const metadata = providerMetadata.get(name);
  if (factory === undefined || metadata === undefined) {
    throw new Error("missing provider " + name);
  }

  const provider = factory();
  provider.displayName = metadata.displayName;
  provider.logo = metadata.logo;
  provider.order = metadata.order;
  return provider;
}

// InitProvider returns a new auth.Provider instance loaded with the
// current OAuth2Config options. Throws "missing provider <name>" for a
// provider without defaults here.
export function initProvider(config: OAuth2ProviderConfig): BaseProvider {
  const provider = newProviderByName(config.name);

  if (config.clientId !== "") {
    provider.clientId = config.clientId;
  }

  if (config.clientSecret !== "") {
    provider.clientSecret = config.clientSecret;
  }

  if (config.authURL !== "") {
    provider.authURL = config.authURL;
  }

  if (config.userInfoURL !== "") {
    provider.userInfoURL = config.userInfoURL;
  }

  if (config.tokenURL !== "") {
    provider.tokenURL = config.tokenURL;
  }

  if (config.displayName !== "") {
    provider.displayName = config.displayName;
  }

  if (config.pkce !== null) {
    provider.pkce = config.pkce;
  }

  if (config.extra !== null) {
    provider.extra = config.extra;
  }

  return provider;
}

// initProvider for the sign-in, which needs a provider's implementation:
// throws for a provider that is not ported yet (upstream knows all of them).
export function initSignInProvider(config: OAuth2ProviderConfig): BaseProvider {
  if (!portedProviders.has(config.name)) {
    throw new Error(`the OAuth2 provider ${config.name} is not ported yet`);
  }
  return initProvider(config);
}

// BuildAuthURL returns a URL to the provider's consent page that asks for
// permissions for the required scopes explicitly (oauth2.Config's
// AuthCodeURL; opts are its SetAuthURLParam options, in order).
export function buildAuthURL(
  p: BaseProvider,
  state: string,
  ...opts: [key: string, value: string][]
): string {
  const v = new Map<string, string[]>([
    ["response_type", ["code"]],
    ["client_id", [p.clientId]],
  ]);
  if (p.redirectURL !== "") {
    v.set("redirect_uri", [p.redirectURL]);
  }
  if (p.scopes.length > 0) {
    v.set("scope", [p.scopes.join(" ")]);
  }
  if (state !== "") {
    v.set("state", [state]);
  }
  for (const [key, value] of opts) {
    v.set(key, [value]);
  }

  return p.authURL + (p.authURL.includes("?") ? "&" : "?") + encodeValues(v);
}
