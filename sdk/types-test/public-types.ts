// Type tests for the public generics of the SDK. This file only has to compile:
// `bun run typecheck` fails when an `Expect<Equal<...>>` is false or when a
// `@ts-expect-error` line stops being an error.
import PocketBase, {
  BaseAuthStore,
  ClientResponseError,
  LocalAuthStore,
  type AuthRecord,
  type BatchRequestResult,
  type ListResult,
  type RecordAuthResponse,
  type RecordModel,
  type RecordSubscription,
  type UnsubscribeFunc,
} from "@sdk/index";
import type { Equal, Expect } from "@sdk-test-types/helpers";

type Post = { id: string; title: string; views: number };

const pb = new PocketBase("http://127.0.0.1:8090");

export async function collectionGenerics(): Promise<void> {
  const posts = pb.collection<Post>("posts");

  // the collection generic is the default of every method
  const list = await posts.getList(1, 20);
  type _List = Expect<Equal<typeof list, ListResult<Post>>>;
  const full = await posts.getFullList();
  type _Full = Expect<Equal<typeof full, Array<Post>>>;
  const fullLegacy = await posts.getFullList(200);
  type _FullLegacy = Expect<Equal<typeof fullLegacy, Array<Post>>>;
  const one = await posts.getOne("id");
  type _One = Expect<Equal<typeof one, Post>>;
  const first = await posts.getFirstListItem('title = "a"');
  type _First = Expect<Equal<typeof first, Post>>;
  const created = await posts.create({ title: "a" });
  type _Created = Expect<Equal<typeof created, Post>>;
  const updated = await posts.update("id", { title: "b" });
  type _Updated = Expect<Equal<typeof updated, Post>>;

  // a method generic overrides the collection one
  type Other = { slug: string };
  const otherList = await posts.getList<Other>();
  type _OtherList = Expect<Equal<typeof otherList, ListResult<Other>>>;
  const otherFull = await posts.getFullList<Other>();
  type _OtherFull = Expect<Equal<typeof otherFull, Array<Other>>>;
  const otherOne = await posts.getOne<Other>("id");
  type _OtherOne = Expect<Equal<typeof otherOne, Other>>;
  const otherFirst = await posts.getFirstListItem<Other>("x");
  type _OtherFirst = Expect<Equal<typeof otherFirst, Other>>;
  const otherCreated = await posts.create<Other>({});
  type _OtherCreated = Expect<Equal<typeof otherCreated, Other>>;
  const otherUpdated = await posts.update<Other>("id", {});
  type _OtherUpdated = Expect<Equal<typeof otherUpdated, Other>>;

  // without a generic the model is a RecordModel, whose fields stay readable and assignable
  const record = await pb.collection("posts").getOne("id");
  type _Record = Expect<Equal<typeof record, RecordModel>>;
  const title: string = record.title;
  const asRecord: RecordModel = { id: "1", collectionId: "c", collectionName: "posts", extra: 1 };
  void [title, asRecord];

  // @ts-expect-error getOne needs the record id
  await posts.getOne();
  // @ts-expect-error perPage is a number
  await posts.getList(1, "20");
  // @ts-expect-error getFirstListItem needs a filter
  await posts.getFirstListItem();
}

export async function authGenerics(): Promise<void> {
  type User = RecordModel & { name: string };

  const auth = await pb.collection("users").authWithPassword("a@b.c", "secret");
  type _Auth = Expect<Equal<typeof auth, RecordAuthResponse<RecordModel>>>;

  const typed = await pb.collection("users").authWithPassword<User>("a@b.c", "secret");
  type _Typed = Expect<Equal<typeof typed, RecordAuthResponse<User>>>;
  const name: string = typed.record.name;
  const token: string = typed.token;
  void [name, token];

  const fromCollection = await pb.collection<User>("users").authWithPassword("a@b.c", "secret");
  type _FromCollection = Expect<Equal<typeof fromCollection, RecordAuthResponse<User>>>;

  const refreshed = await pb.collection("users").authRefresh<User>();
  type _Refreshed = Expect<Equal<typeof refreshed, RecordAuthResponse<User>>>;

  // @ts-expect-error the password is required
  await pb.collection("users").authWithPassword("a@b.c");
}

export async function sendGenerics(): Promise<void> {
  // the default response type stays readable without a cast
  const untyped = await pb.send("/hello", {});
  const anything: string = untyped.message;
  void anything;

  const typed = await pb.send<{ message: string }>("/hello", { method: "GET" });
  type _Typed = Expect<Equal<typeof typed, { message: string }>>;

  const num = await pb.send<number>("/count", {});
  type _Num = Expect<Equal<typeof num, number>>;

  // @ts-expect-error the options argument is required
  await pb.send("/hello");
}

export async function realtimeGenerics(): Promise<void> {
  const unsubscribe = await pb.collection<Post>("posts").subscribe("*", (e) => {
    type _Event = Expect<Equal<typeof e, RecordSubscription<Post>>>;
    type _Record = Expect<Equal<typeof e.record, Post>>;
    type _Action = Expect<Equal<typeof e.action, string>>;
  });
  type _Unsub = Expect<Equal<typeof unsubscribe, UnsubscribeFunc>>;

  await pb.collection("posts").subscribe<Post>("*", (e) => {
    type _Record = Expect<Equal<typeof e.record, Post>>;
  });

  // the realtime service takes untyped data
  await pb.realtime.subscribe("topic", (data) => {
    const anything: string = data.whatever;
    void anything;
  });

  // @ts-expect-error the callback is required
  await pb.collection("posts").subscribe("*");
}

export async function batchTypes(): Promise<void> {
  const batch = pb.createBatch();
  batch.collection("posts").create({ title: "a" });
  batch.collection("posts").update("id", { title: "b" });
  batch.collection("posts").delete("id");
  batch.collection("posts").upsert({ id: "x", title: "c" });

  const results = await batch.send();
  type _Results = Expect<Equal<typeof results, Array<BatchRequestResult>>>;
  const status: number = results[0]!.status;
  void status;

  // @ts-expect-error update needs the record id
  batch.collection("posts").update({ title: "b" });
}

export function authStoreModels(): void {
  const store = new BaseAuthStore();
  type _Token = Expect<Equal<typeof store.token, string>>;
  type _Record = Expect<Equal<typeof store.record, AuthRecord>>;
  type _Model = Expect<Equal<typeof store.model, AuthRecord>>;
  type _Valid = Expect<Equal<typeof store.isValid, boolean>>;
  type _Superuser = Expect<Equal<typeof store.isSuperuser, boolean>>;
  type _RecordShape = Expect<Equal<NonNullable<AuthRecord>, RecordModel>>;

  store.save("token", null);
  store.save("token", { id: "1", collectionId: "c", collectionName: "users" });
  store.clear();
  const off = store.onChange((token, record) => {
    type _CbToken = Expect<Equal<typeof token, string>>;
    type _CbRecord = Expect<Equal<typeof record, AuthRecord>>;
  }, true);
  type _Off = Expect<Equal<typeof off, () => void>>;

  const email: string | undefined = pb.authStore.record?.email;
  void email;

  const local = new LocalAuthStore("custom_key");
  type _LocalToken = Expect<Equal<typeof local.token, string>>;

  // @ts-expect-error the token is required
  store.save();
  // @ts-expect-error a record is an object or null
  store.save("token", "record");
}

export function clientResponseErrorTypes(): void {
  try {
    throw new ClientResponseError({ status: 400 });
  } catch (err) {
    if (err instanceof ClientResponseError) {
      type _Status = Expect<Equal<typeof err.status, number>>;
      type _Url = Expect<Equal<typeof err.url, string>>;
      type _Abort = Expect<Equal<typeof err.isAbort, boolean>>;
      type _Data = Expect<Equal<typeof err.data, typeof err.response>>;
      // the response bag stays readable without casts
      const message: string = err.response.message;
      const field: string = err.data.data.email.message;
      void [message, field];
    }
  }

  // the constructor accepts anything
  void new ClientResponseError();
  void new ClientResponseError(new Error("x"));
  void new ClientResponseError("x");
  void new ClientResponseError(null);
}
