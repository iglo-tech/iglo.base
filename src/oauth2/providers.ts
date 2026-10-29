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
import { encodeValues } from "@/server/request";

interface ProviderDefaults {
  displayName: string;
  logo: string;
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
      displayName: "GitLab",
      logo: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="247" fill="none"><path fill="#e24329" d="m251.7 97.7-.3-.9-34.7-90.6a9 9 0 0 0-9-5.7q-3 .2-5.2 2a9 9 0 0 0-3.1 4.7L176 78.9H81L57.7 7.2a9.1 9.1 0 0 0-17.2-1L5.6 96.8l-.4.9a64.4 64.4 0 0 0 21.4 74.5h.1l.3.3L80 212l26 19.8 16 12a11 11 0 0 0 13 0l15.9-12 26.2-19.8 53.1-39.9h.2a64.5 64.5 0 0 0 21.3-74.5"/><path fill="#fc6d26" d="m251.7 97.7-.3-.9c-17 3.5-32.9 10.6-46.7 21l-76.2 57.6 48.5 36.7 53.2-39.8.2-.1a64.5 64.5 0 0 0 21.3-74.5"/><path fill="#fca326" d="m80 212.1 26 19.8 16 12a11 11 0 0 0 13 0l15.9-12 26.2-19.8s-22.7-17-48.6-36.7z"/><path fill="#fc6d26" d="M52.2 117.8a117 117 0 0 0-46.6-21l-.4.9a64.4 64.4 0 0 0 21.4 74.5h.1l.3.3L80 212l48.5-36.7z"/></svg>',
      pkce: true,
      scopes: ["read_user"],
      authURL: "https://gitlab.com/oauth/authorize",
    },
  ],
  // google.go NewGoogleProvider
  [
    "google",
    {
      displayName: "Google",
      logo: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="262" preserveAspectRatio="xMidYMid"><path fill="#4285f4" d="M255.9 133.5c0-10.8-.9-18.6-2.8-26.7H130.6v48.4h71.9a64 64 0 0 1-26.7 42.4l-.2 1.6 38.7 30 2.7.3c24.7-22.8 38.9-56.3 38.9-96"/><path fill="#34a853" d="M130.6 261.1c35.2 0 64.8-11.6 86.4-31.6l-41.2-32a76 76 0 0 1-45.2 13.1 79 79 0 0 1-74.3-54.2l-1.5.1-40.3 31.2-.6 1.5A131 131 0 0 0 130.6 261"/><path fill="#fbbc05" d="M56.3 156.4a80 80 0 0 1-.2-51.7V103L15.3 71.3l-1.4.6a131 131 0 0 0 0 117.3z"/><path fill="#eb4335" d="M130.6 50.5c24.5 0 41 10.6 50.4 19.4L218 34c-22.8-21-52.2-34-87.4-34C79.5 0 35.4 29.3 13.9 72l42.2 32.7a79 79 0 0 1 74.5-54.2"/></svg>',
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
  if (defaults === undefined) {
    throw new Error("missing provider " + config.name);
  }

  const provider: Provider = {
    displayName: defaults.displayName,
    logo: defaults.logo,
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
