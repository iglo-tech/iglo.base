import PocketBase, { ClientResponseError } from "iglo.base";
import { createServerClient } from "iglo.base/ssr";
const pb = new PocketBase("http://127.0.0.1:1");
export { pb, ClientResponseError, createServerClient };
