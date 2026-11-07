const PocketBase = require("iglo.base/cjs");
const pb = new PocketBase("http://127.0.0.1:1");
console.log("cjs", typeof PocketBase, PocketBase.name, pb.baseURL, pb.collection("x").baseCrudPath);
