const fs = require("fs"),
  vm = require("vm");
const file = require.resolve("iglo.base/umd");
const window = {};
vm.runInNewContext(fs.readFileSync(file, "utf8"), { window, console }, { filename: file });
const pb = new window.PocketBase("http://127.0.0.1:1");
console.log("umd", typeof window.PocketBase, window.PocketBase.name, pb.baseURL);
