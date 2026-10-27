# Auth

Ported from upstream `apis/record_auth*.go`, `core/record_model_auth.go`, `core/record_tokens.go`, `core/{mfa,otp,auth_origin,external_auth}_*.go` and `tools/auth`. Every flow keeps upstream's request fields, response shape (`{ "token", "record", "meta"? }`), errors and emails.

## Auth collections

Options per auth collection, stored in `_collections.options` with upstream's names: `authRule`, `manageRule`, `authAlert`, `oauth2`, `passwordAuth` (`identityFields`), `mfa` (`duration`, `rule`), `otp` (`duration`, `length`, `emailTemplate`), the five token configs (`authToken`, `passwordResetToken`, `emailChangeToken`, `verificationToken`, `fileToken`, each `secret` and `duration`), and the three email templates (`verificationTemplate`, `resetPasswordTemplate`, `confirmEmailChangeTemplate`).

System fields: `id`, `email`, `emailVisibility`, `verified`, `password`, `tokenKey`, `created`, `updated`. `_superusers` is an auth collection with fixed rules.

## Tokens

See [Data compatibility](03-data-compatibility.md#tokens) for the format. Rules ported from upstream:

- the token is read from `Authorization`, with or without the `Bearer ` prefix;
- `auth-refresh` issues a new token only for refreshable tokens; impersonation tokens are not refreshable;
- changing the password or email regenerates `tokenKey`, invalidating existing tokens;
- superuser tokens are rejected if the request IP fails `superuserIPs`.

## Flows

| Flow | Notes |
|---|---|
| Password | `identity` matched against `identityFields` in order (case-insensitive for email), bcrypt verify, `authRule` checked after identity is proven |
| OTP | `request-otp` creates an `_otps` row (hashed password) and emails it; always returns an `otpId`, even for unknown emails, to avoid enumeration; `auth-with-otp` verifies and deletes it; marks email verified when sent to the record's email |
| MFA | when `mfa.enabled` and the `mfa.rule` matches, the first factor returns 401 with `mfaId`; the second, different method passes `mfaId` and completes; `_mfas` rows expire after `mfa.duration` |
| OAuth2 | code exchange with PKCE, user info mapping (`mappedFields`), `_externalAuths` linking, new record creation (with `createData`), avatar download into the mapped file field, `meta` in the response with upstream's keys (`id`, `name`, `username`, `email`, `avatarURL`, `accessToken`, `refreshToken`, `expiry`, `isNew`, `rawUser`) |
| Verification, password reset, email change | request endpoints always return 204 (no enumeration) and rate-limited resends as upstream; confirm endpoints validate the token type and claims |
| Impersonate | superusers only, `duration` in the body, non-refreshable token |
| Auth alerts | on a login from a new device fingerprint, an `_authOrigins` row is stored and the alert email is sent if `authAlert.enabled` |

## OAuth2 providers

All providers in upstream `tools/auth`, with their names, default endpoints, scopes and user-info mapping:

Apple, Bitbucket, Box, Discord, Facebook, Gitea, Gitee, GitHub, GitLab, Google, Instagram, Kakao, Lark, Linear, LiveChat, mailcow, Microsoft, monday.com, Notion, OIDC (three slots: `oidc`, `oidc2`, `oidc3`), Patreon, Planning Center, Spotify, Strava, Trakt, Twitch, Twitter/X, VK, WakaTime, Yandex.

`GET /api/collections/meta/oauth2-providers` returns the same list and metadata the dashboard uses.

Provider details that must be carried over:

- Apple's `id_token` verification with Apple's JWKS, and the name from the first-login form post;
- OIDC `id_token` validation (issuer, audience, expiry with `PB_ID_TOKEN_LEEWAY`) and JWKS fetching, and the userinfo fallback;
- provider-specific quirks in user-info parsing (for example GitHub's separate emails endpoint, Microsoft's tenant URLs, Twitter's lack of email).

Each provider is tested against a local mock that replays upstream's test fixtures. Live checks against real providers are manual and recorded in `docs/manual-tests/oauth2.md`.

## Email templates

Placeholders as upstream: `{APP_NAME}`, `{APP_URL}`, `{TOKEN}`, `{OTP}`, `{OTP_ID}`, `{ALERT_INFO}`, and `{RECORD:<field>}`. Defaults are upstream's v0.41.0 templates, including the auth-alert template update applied by system migration `1763020353_update_default_auth_alert_templates.go`. Templates are plain string replacement, not a template language, as upstream.

## Rate limits and abuse

- Default rate-limit rules from upstream settings (`*:auth` 2 per 3 s, `*:create` 20 per 5 s, `/api/batch` 3 per 1 s, `/api/` 300 per 10 s) and the same matching by label, method and audience (`@guest`, `@auth`).
- The superuser installer link and `superuser otp` command behave as upstream ([Admin UI](08-admin-ui.md#installer)).
