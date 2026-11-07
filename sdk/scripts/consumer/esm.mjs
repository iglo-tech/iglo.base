import PocketBase, {
  ClientResponseError,
  BaseAuthStore,
  LocalAuthStore,
  AsyncAuthStore,
  getTokenPayload,
  cookieParse,
} from "iglo.base";
const pb = new PocketBase("http://127.0.0.1:1");
console.log(
  "esm",
  typeof PocketBase,
  pb.constructor.name,
  pb.baseURL,
  typeof ClientResponseError,
  typeof BaseAuthStore,
  typeof LocalAuthStore,
  typeof AsyncAuthStore,
  typeof getTokenPayload,
  typeof cookieParse,
  pb.filter("a = {:x}", { x: "it's" }),
);
const e = new ClientResponseError({ status: 404 });
console.log(e.name, e.status);

import {
  createServerClient,
  createSuperuserClient,
  createSessionCache,
  createRequestCookieAdapter,
  SSR_NO_CACHE_HEADERS,
} from "iglo.base/ssr";
console.log(
  "esm ssr",
  typeof createServerClient,
  typeof createSuperuserClient,
  typeof createSessionCache,
  typeof createRequestCookieAdapter,
  SSR_NO_CACHE_HEADERS["Cache-Control"],
);

const serverClient = await createServerClient({
  url: "http://127.0.0.1:8090",
  cookies: { getAll: () => [] },
});
if (!(serverClient instanceof PocketBase)) {
  throw new Error("serverClient is not an instance of PocketBase");
}
console.log("instanceof PocketBase: ok");

let verified = false;
try {
  await serverClient.auth.verify();
} catch (err) {
  if (err instanceof ClientResponseError) {
    verified = true;
  } else {
    throw new Error("expected err instanceof ClientResponseError from iglo.base", { cause: err });
  }
}
if (!verified) {
  throw new Error("expected verify() to throw");
}
console.log("instanceof ClientResponseError: ok");
