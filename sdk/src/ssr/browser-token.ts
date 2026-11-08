// docs/design/13-ssr.md ("Browser client and realtime", "Fallback without superuser credentials").
//
// Lives in `iglo.base/ssr` (the server entry), not in the browser entry: it needs the server
// client's validated session and the superuser client, and neither may reach a browser bundle.
import type { ServerClient } from "@sdk/ssr/server-client";
import type { SuperuserClient } from "@sdk/ssr/superuser-client";
import type { BrowserToken, MintBrowserTokenOptions } from "@sdk/ssr/types";
import { getTokenPayload } from "@sdk/tools/jwt";

/** The lifetime of a browser token when the app does not set one (15 minutes). */
export const DEFAULT_BROWSER_TOKEN_DURATION_SEC = 900;

/**
 * What a page needs for its browser client, for the user the server client resumed: a token
 * from the superuser client's `impersonate` (a non-refreshable one, 15 minutes by default), and
 * the server client's validated record. The session token never leaves the server.
 *
 * Returns `null` when nobody is signed in. Without a superuser client, the server client must
 * be in fallback mode (`readableCookie`): the page then gets the session token, which the session
 * cookie already exposes to page JavaScript.
 *
 * @throws {TypeError} without a superuser client on a server client that is not in fallback mode
 */
export async function mintBrowserToken(
  server: ServerClient,
  superuser: SuperuserClient | undefined,
  options: MintBrowserTokenOptions = {},
): Promise<BrowserToken | null> {
  const session = server.authStore.token;
  const record = server.authStore.record;
  if (!session || !record) {
    return null;
  }

  let token: string;
  if (superuser) {
    const collection = record.collectionName || record.collectionId;
    const minted = await superuser.impersonate(
      collection,
      record.id,
      options.duration ?? DEFAULT_BROWSER_TOKEN_DURATION_SEC,
    );
    token = minted.token;
  } else if (server.readableCookie) {
    token = session;
  } else {
    throw new TypeError(
      "mintBrowserToken needs a superuser client, or a server client with readableCookie",
    );
  }

  const exp = getTokenPayload(token).exp;
  if (!exp) {
    throw new Error("the token has no expiry");
  }
  // the record is the server client's own, validated by its session check, never the minted one
  return { token, record, expiresAt: exp * 1000 };
}
