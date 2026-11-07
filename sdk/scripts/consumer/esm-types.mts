import PocketBase, {
  ClientResponseError,
  type RecordModel,
  type ListResult,
  type BeforeSendResult,
  BaseAuthStore,
} from "iglo.base";
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
export { a, b, s, n, store, bsr, bad };
