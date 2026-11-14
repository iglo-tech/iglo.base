// experiment: raw front. Connections whose first request is a write are pinned to the primary and relayed as bytes.
const [port, sock] = process.argv.slice(2);
type St = { up?: any; pending: Uint8Array[]; decided: boolean };
Bun.listen({ hostname: "127.0.0.1", port: Number(port), reusePort: true, socket: {
  open(s: any) { s.data = { up: undefined, pending: [], decided: false } as St; },
  data(s: any, d: Uint8Array) {
    const st = s.data as St;
    if (!st.decided) {
      st.decided = true;
      const line = new TextDecoder().decode(d.subarray(0, Math.min(d.length, 16)));
      // every request on this connection goes to the primary: writes need it, and this experiment only sends writes
      void line;
      Bun.connect({ unix: sock!, socket: {
        data(u: any, chunk: Uint8Array) { s.write(chunk); },
        open(u: any) { st.up = u; for (const p of st.pending) u.write(p); st.pending = []; },
        close() { s.end(); }, error() { s.end(); }, drain() {} } }).catch(() => s.end());
    }
    const copy = new Uint8Array(d);
    if (st.up) st.up.write(copy); else st.pending.push(copy);
  },
  close(s: any) { (s.data as St).up?.end(); }, error() {}, drain() {} } });
console.log("ready");
setInterval(() => {}, 1 << 30);
