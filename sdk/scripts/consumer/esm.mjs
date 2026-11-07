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
