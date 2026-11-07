import PocketBase, {
  ClientResponseError,
  type RecordModel,
  type ListResult,
  BaseAuthStore,
} from "iglo.base";
import UmdPocketBase from "iglo.base/umd";
type Post = { id: string; title: string };
const pb = new PocketBase("http://127.0.0.1:1");
const a: Promise<ListResult<Post>> = pb.collection<Post>("posts").getList(1, 2);
const b: Promise<RecordModel> = pb.collection("posts").getOne("x");
const s: string = pb.authStore.record?.email;
const e = new ClientResponseError({});
const n: number = e.status;
const store: BaseAuthStore = pb.authStore;
const u: PocketBase = new UmdPocketBase("x");
// @ts-expect-error number is not a string
const bad: string = e.status;
export { a, b, s, n, store, u, bad };
