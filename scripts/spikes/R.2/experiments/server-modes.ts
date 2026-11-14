import { newPrimaryHop } from "@/replicas/primary-hop";
const [mode, port, sock] = process.argv.slice(2);
const hop = newPrimaryHop(sock!);
const noop = new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } });
Bun.serve({ hostname: "127.0.0.1", port: Number(port), reusePort: true, maxRequestBodySize: Number.MAX_SAFE_INTEGER, development: false,
  async fetch(req) {
    if (mode === "noop") { await req.arrayBuffer(); return new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } }); }
    if (mode === "fetch") { const b = await req.arrayBuffer(); const r = await fetch("http://primary/api/collections/posts/records", { method: "POST", headers: { "content-type": "application/json" }, body: b, unix: sock! }); return new Response(r.body, { status: r.status, headers: r.headers }); }
    return hop.send(req);
  } });
console.log("ready");
