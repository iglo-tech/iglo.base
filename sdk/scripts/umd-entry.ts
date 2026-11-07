// iglo.base addition (js-sdk v0.28.1 builds this with rollup format `umd`, name `PocketBase`):
// the browser build for `<script>` tags sets the global `PocketBase` to the client class.
import Client from "@sdk/Client";

const root = (typeof window !== "undefined" ? window : globalThis) as { PocketBase?: unknown };
root.PocketBase = Client;
