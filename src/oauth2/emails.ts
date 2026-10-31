// Upstream: tools/auth/github.go and tools/auth/gitea.go, fetchVerifiedPrimaryEmail
// (the same code in both)

import type { BaseProvider } from "@/oauth2/base-provider";
import { decodeNestedList } from "@/oauth2/user-fields";
import type { Token } from "@/oauth2/token";
import { anyType, boolType, stringType, unmarshal } from "@/tools/types/go-json";

// fetchVerifiedPrimaryEmail sends an API request to retrieve the verified
// primary email, in case "Keep my email address private" was set.
//
// NB! This method can succeed and still return an empty email.
// Error responses that are result of insufficient scopes permissions are ignored.
export async function fetchVerifiedPrimaryEmail(
  provider: BaseProvider,
  token: Token,
  emailsURL: string,
): Promise<string> {
  const res = await provider.fetchWithToken(token, emailsURL);

  // ignore common http errors caused by insufficient scope permissions
  // (the email field is optional, aka. return the auth user without it)
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    await res.body?.cancel();
    return "";
  }

  const content = new Uint8Array(await res.arrayBuffer());
  const emails = decodeNestedList<{ email: string; verified: boolean; primary: boolean }>(
    unmarshal(content, anyType),
    { email: stringType, verified: boolType, primary: boolType },
  );

  // extract the verified primary email
  for (const email of emails) {
    if (email.verified && email.primary) {
      return email.email;
    }
  }

  return "";
}
