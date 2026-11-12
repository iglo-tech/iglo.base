import PocketBase, {
  ClientResponseError,
  type RecordModel,
  type ListResult,
  type BeforeSendResult,
  BaseAuthStore,
} from "@iglo.tech/iglo.base";
type Post = { id: string; title: string };
const pb = new PocketBase("http://127.0.0.1:1");
const a: Promise<ListResult<Post>> = pb.collection<Post>("posts").getList(1, 2);
const b: Promise<RecordModel> = pb.collection("posts").getOne("x");
const s: string = pb.authStore.record?.email;
const e = new ClientResponseError({});
const n: number = e.status;
const store: BaseAuthStore = pb.authStore;
const bsr: BeforeSendResult = { url: "http://127.0.0.1:1" };
// @ts-expect-error number is not a string
const bad: string = e.status;

import {
  createServerClient,
  createSuperuserClient,
  createSessionCache,
  createRequestCookieAdapter,
  type ServerClient,
  type SuperuserClient,
  type SessionCache,
  type RequestCookieAdapter,
} from "@iglo.tech/iglo.base/ssr";
const dummyReq = new Request("https://example.com");
const cookieAdapter: RequestCookieAdapter = createRequestCookieAdapter(dummyReq);
const serverClientPromise: Promise<ServerClient> = createServerClient({
  url: "https://example.com",
  cookies: cookieAdapter,
});
const superuserClientPromise: Promise<SuperuserClient> = createSuperuserClient({
  url: "https://example.com",
  token: "test",
});
const cache: SessionCache = createSessionCache();

import { createBrowserClient, type BrowserClient } from "@iglo.tech/iglo.base/ssr/browser";
const browserClient: BrowserClient = createBrowserClient({ url: "https://example.com" });
const asPocketBase: PocketBase = browserClient;

export {
  asPocketBase,
  browserClient,
  a,
  b,
  s,
  n,
  store,
  bsr,
  bad,
  cookieAdapter,
  serverClientPromise,
  cache,
  superuserClientPromise,
};
