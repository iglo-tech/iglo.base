import { env } from "$env/dynamic/private";
import { createSessionCache, createSuperuserClient } from "@iglo.tech/iglo.base/ssr";
import { createSvelteKitAuth, type SvelteKitAuth } from "@iglo.tech/iglo.base/ssr/sveltekit";

/** The fallback without superuser credentials: the session cookie is readable by page scripts. */
const readable = env.PB_READABLE_COOKIE === "1";

function required(name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

async function create(): Promise<SvelteKitAuth> {
  const url = required("PB_URL");
  const superuser = readable
    ? undefined
    : await createSuperuserClient({
        url,
        email: required("PB_SUPERUSER_EMAIL"),
        password: required("PB_SUPERUSER_PASSWORD"),
      });
  return createSvelteKitAuth({
    url,
    sessionCache: createSessionCache(),
    superuser,
    readableCookie: readable,
    origin: required("APP_ORIGIN"),
  });
}

let auth: Promise<SvelteKitAuth> | undefined;

/**
 * The app's auth, created once per process on the first request. A failed creation is retried
 * by the next request instead of being cached.
 */
export function getAuth(): Promise<SvelteKitAuth> {
  auth ??= create().catch((err: unknown) => {
    auth = undefined;
    throw err;
  });
  return auth;
}
