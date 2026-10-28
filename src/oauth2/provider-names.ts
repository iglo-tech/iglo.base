// Upstream: tools/auth/*.go (the `Name…` constants each provider file
// registers in auth.Providers from its init function) and
// tools/auth/auth.go (NewProviderByName)
//
// The OAuth2 providers are ported by M4.5. Until then this fixed list of
// the names upstream registers stands in for the registry, so that
// collection validation (checkProviderName) accepts and rejects the same
// provider names. M4.5 replaces it with the registry.

// the keys of auth.Providers, in the order of upstream's tools/auth/*.go
// files
const providerNames: ReadonlySet<string> = new Set([
  "apple", // apple.go NameApple
  "bitbucket", // bitbucket.go NameBitbucket
  "box", // box.go NameBox
  "discord", // discord.go NameDiscord
  "facebook", // facebook.go NameFacebook
  "gitea", // gitea.go NameGitea
  "gitee", // gitee.go NameGitee
  "github", // github.go NameGithub
  "gitlab", // gitlab.go NameGitlab
  "google", // google.go NameGoogle
  "instagram2", // instagram.go NameInstagram
  "kakao", // kakao.go NameKakao
  "lark", // lark.go NameLark
  "linear", // linear.go NameLinear
  "livechat", // livechat.go NameLivechat
  "mailcow", // mailcow.go NameMailcow
  "microsoft", // microsoft.go NameMicrosoft
  "monday", // monday.go NameMonday
  "notion", // notion.go NameNotion
  "oidc", // oidc.go NameOIDC
  "oidc2", // oidc.go NameOIDC+"2"
  "oidc3", // oidc.go NameOIDC+"3"
  "patreon", // patreon.go NamePatreon
  "planningcenter", // planningcenter.go NamePlanningcenter
  "spotify", // spotify.go NameSpotify
  "strava", // strava.go NameStrava
  "trakt", // trakt.go NameTrakt
  "twitch", // twitch.go NameTwitch
  "twitter", // twitter.go NameTwitter
  "vk", // vk.go NameVK
  "wakatime", // wakatime.go NameWakatime
  "yandex", // yandex.go NameYandex
]);

// whether auth.NewProviderByName(name) finds a provider (the name is an
// exact, case sensitive key of auth.Providers)
export function isProviderName(name: string): boolean {
  return providerNames.has(name);
}
