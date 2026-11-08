// The app's one iglo.base adapter. Created lazily, once per server process: the session cache and
// the superuser client live here, and every request (middleware, pages, route handlers) shares them.
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";

import { createSessionCache, createSuperuserClient, type SuperuserClient } from "iglo.base/ssr";
import { createNextAuth, type NextAuth, type NextCookieStore } from "iglo.base/ssr/next";

/** The fallback without superuser credentials: the session cookie is readable by page scripts. */
function readableCookie(): boolean {
  return process.env.PB_READABLE_COOKIE === "1";
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function create(): Promise<NextAuth> {
  const url = required("PB_URL");
  const fallback = readableCookie();
  let superuser: SuperuserClient | undefined;
  if (!fallback) {
    superuser = await createSuperuserClient({
      url,
      email: required("PB_SUPERUSER_EMAIL"),
      password: required("PB_SUPERUSER_PASSWORD"),
    });
  }
  const origin = process.env.APP_ORIGIN;
  return createNextAuth({
    url,
    sessionCache: createSessionCache(),
    superuser,
    readableCookie: fallback,
    origin,
    next: (init) => NextResponse.next(init),
  });
}

let authPromise: Promise<NextAuth> | undefined;

/** The adapter, created on first use. A failed creation is retried on the next call. */
export function getAuth(): Promise<NextAuth> {
  authPromise ??= create().catch((err: unknown) => {
    authPromise = undefined;
    throw err;
  });
  return authPromise;
}

/** The session of the current request, resumed from the cookies the middleware prepared. */
export async function currentSession() {
  // Read the request first: that makes the page dynamic, so a build never creates the adapter
  // (which needs the environment). Next's cookie setter is overloaded; the adapter's structural
  // type takes the single-signature form, hence the cast.
  const store = (await cookies()) as unknown as NextCookieStore;
  const requestHeaders = await headers();
  const auth = await getAuth();
  return auth.serverSession({ cookies: store, headers: requestHeaders });
}
