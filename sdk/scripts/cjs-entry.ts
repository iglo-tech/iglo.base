// iglo.base addition (js-sdk v0.28.1 builds this with rollup `exports: "default"`):
// the CommonJS build is the client class itself, so `require("iglo.base/cjs")` returns it.
import Client from "@sdk/Client";

declare const module: { exports: unknown };
module.exports = Client;
