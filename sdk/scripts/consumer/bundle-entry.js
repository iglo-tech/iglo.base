import PocketBase, { ClientResponseError } from "@iglo.tech/iglo.base";
const pb = new PocketBase("http://127.0.0.1:8090");
const err = new ClientResponseError({ status: 404 });
console.log("bundle-eval", typeof PocketBase, PocketBase.name, pb.baseURL, err.status);
