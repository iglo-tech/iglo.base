// Upstream: tools/auth/auth.go (NewProviderByName),
// core/collection_model_auth_options.go (OAuth2ProviderConfig.InitProvider),
// tools/auth/base_provider.go (BuildAuthURL with golang.org/x/oauth2's
// Config.AuthCodeURL) and the constructors of tools/auth/*.go
//
// The fixed table of the providers upstream registers (auth.Providers). A
// provider is one file with a class that extends BaseProvider, and one line
// in portedProviders here; the display name, logo and order come from
// provider-list.ts. A configured name that is not in the table fails to
// initialize, so the auth methods list skips it, and signing in with it
// fails before any network call, as upstream's NewProviderByName does.

import type { OAuth2ProviderConfig } from "@/collections/collection-model-auth-options";
import { Apple } from "@/oauth2/apple";
import { Bitbucket } from "@/oauth2/bitbucket";
import { BaseProvider } from "@/oauth2/base-provider";
import { Box } from "@/oauth2/box";
import { Discord } from "@/oauth2/discord";
import { Facebook } from "@/oauth2/facebook";
import { Gitea } from "@/oauth2/gitea";
import { Gitee } from "@/oauth2/gitee";
import { Github } from "@/oauth2/github";
import { Gitlab } from "@/oauth2/gitlab";
import { Google } from "@/oauth2/google";
import { Instagram } from "@/oauth2/instagram";
import { Kakao } from "@/oauth2/kakao";
import { Lark } from "@/oauth2/lark";
import { Linear } from "@/oauth2/linear";
import { Livechat } from "@/oauth2/livechat";
import { Mailcow } from "@/oauth2/mailcow";
import { Microsoft } from "@/oauth2/microsoft";
import { Monday } from "@/oauth2/monday";
import { Notion } from "@/oauth2/notion";
import { OIDC } from "@/oauth2/oidc";
import { Patreon } from "@/oauth2/patreon";
import { Planningcenter } from "@/oauth2/planningcenter";
import { providerMetadata } from "@/oauth2/provider-list";
import { Spotify } from "@/oauth2/spotify";
import { Strava } from "@/oauth2/strava";
import { Trakt } from "@/oauth2/trakt";
import { Twitch } from "@/oauth2/twitch";
import { Twitter } from "@/oauth2/twitter";
import { VK } from "@/oauth2/vk";
import { Wakatime } from "@/oauth2/wakatime";
import { Yandex } from "@/oauth2/yandex";
import { encodeValues } from "@/server/request";

// the constructors of the ported providers, by name (auth.Providers)
const portedProviders = new Map<string, () => BaseProvider>([
  ["apple", () => new Apple()], // apple.go
  ["bitbucket", () => new Bitbucket()], // bitbucket.go
  ["box", () => new Box()], // box.go
  ["discord", () => new Discord()], // discord.go
  ["facebook", () => new Facebook()], // facebook.go
  ["gitea", () => new Gitea()], // gitea.go
  ["gitee", () => new Gitee()], // gitee.go
  ["github", () => new Github()], // github.go
  ["gitlab", () => new Gitlab()], // gitlab.go
  ["google", () => new Google()], // google.go
  ["instagram2", () => new Instagram()], // instagram.go
  ["kakao", () => new Kakao()], // kakao.go
  ["lark", () => new Lark()], // lark.go
  ["linear", () => new Linear()], // linear.go
  ["livechat", () => new Livechat()], // livechat.go
  ["mailcow", () => new Mailcow()], // mailcow.go
  ["microsoft", () => new Microsoft()], // microsoft.go
  ["monday", () => new Monday()], // monday.go
  ["notion", () => new Notion()], // notion.go
  ["oidc", () => new OIDC()], // oidc.go
  ["oidc2", () => new OIDC()], // oidc.go
  ["oidc3", () => new OIDC()], // oidc.go
  ["patreon", () => new Patreon()], // patreon.go
  ["planningcenter", () => new Planningcenter()], // planningcenter.go
  ["spotify", () => new Spotify()], // spotify.go
  ["strava", () => new Strava()], // strava.go
  ["trakt", () => new Trakt()], // trakt.go
  ["twitch", () => new Twitch()], // twitch.go
  ["twitter", () => new Twitter()], // twitter.go
  ["vk", () => new VK()], // vk.go
  ["wakatime", () => new Wakatime()], // wakatime.go
  ["yandex", () => new Yandex()], // yandex.go
]);

// NewProviderByName returns a new preconfigured provider instance by its
// name identifier.
function newProviderByName(name: string): BaseProvider {
  const factory = portedProviders.get(name);
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
// name upstream does not register.
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
    provider.setExtra(config.extra);
  }

  return provider;
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
