// Upstream: tools/auth/base_provider.go (the provider defaults the auth
// methods list reads, BuildAuthURL with golang.org/x/oauth2's
// Config.AuthCodeURL), tools/auth/auth.go (NewProviderByName),
// core/collection_model_auth_options.go (OAuth2ProviderConfig.InitProvider)
// and the defaults of tools/auth/gitlab.go and google.go
//
// Only what GET /api/collections/{collection}/auth-methods needs: a
// provider's display name, logo, PKCE flag and authorization URL. The
// provider implementations (token exchange, user info) and the defaults of
// the other providers come with the OAuth2 tasks (M4.5–M4.7); until then a
// configured provider without defaults here fails to initialize and is
// skipped, as upstream skips a provider it cannot set up.

import type { OAuth2ProviderConfig } from "@/collections/collection-model-auth-options";
import { providerMetadata } from "@/oauth2/provider-list";
import { encodeValues } from "@/server/request";

// the display name and logo come from provider-list.ts
interface ProviderDefaults {
  pkce: boolean;
  scopes: string[];
  authURL: string;
}

// the BaseProvider fields of each provider's constructor, by name
const providerDefaults = new Map<string, ProviderDefaults>([
  // gitlab.go NewGitlabProvider
  [
    "gitlab",
    {
      pkce: true,
      scopes: ["read_user"],
      authURL: "https://gitlab.com/oauth/authorize",
    },
  ],
  // google.go NewGoogleProvider
  [
    "google",
    {
      pkce: true,
      scopes: [
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
      authURL: "https://accounts.google.com/o/oauth2/v2/auth",
    },
  ],
]);

// The provider settings the auth methods list reads.
export interface Provider {
  displayName: string;
  logo: string;
  pkce: boolean;
  clientId: string;
  redirectURL: string;
  scopes: string[];
  authURL: string;
}

// InitProvider returns a new auth.Provider instance loaded with the
// current OAuth2Config options. Throws "missing provider <name>" for a
// provider without defaults here.
export function initProvider(config: OAuth2ProviderConfig): Provider {
  const defaults = providerDefaults.get(config.name);
  const metadata = providerMetadata.get(config.name);
  if (defaults === undefined || metadata === undefined) {
    throw new Error("missing provider " + config.name);
  }

  const provider: Provider = {
    displayName: metadata.displayName,
    logo: metadata.logo,
    pkce: defaults.pkce,
    clientId: "",
    redirectURL: "",
    scopes: defaults.scopes,
    authURL: defaults.authURL,
  };

  if (config.clientId !== "") {
    provider.clientId = config.clientId;
  }

  if (config.authURL !== "") {
    provider.authURL = config.authURL;
  }

  if (config.displayName !== "") {
    provider.displayName = config.displayName;
  }

  if (config.pkce !== null) {
    provider.pkce = config.pkce;
  }

  return provider;
}

// BuildAuthURL returns a URL to the provider's consent page that asks for
// permissions for the required scopes explicitly (oauth2.Config's
// AuthCodeURL; opts are its SetAuthURLParam options, in order).
export function buildAuthURL(
  p: Provider,
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
