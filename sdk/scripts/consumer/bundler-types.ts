import PocketBase, { ClientResponseError } from "iglo.base";
import Cjs from "iglo.base/cjs";
const pb = new PocketBase("http://127.0.0.1:1");
const c = new Cjs("x");
export { pb, c, ClientResponseError };
