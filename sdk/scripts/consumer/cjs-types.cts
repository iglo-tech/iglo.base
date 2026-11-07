import PocketBase = require("iglo.base/cjs");
const pb = new PocketBase("http://127.0.0.1:1");
const t: Promise<{ id: string }> = pb.collection<{ id: string }>("posts").getOne("x");
const m: string = pb.baseURL;
const inst: PocketBase = pb;
export { t, m, inst };
