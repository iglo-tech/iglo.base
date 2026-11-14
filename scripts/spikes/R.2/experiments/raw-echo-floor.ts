// raw floor: mode echo (TCP echo), relay (TCP -> unix echo via a relay process)
const [mode, port, sock, secs] = process.argv.slice(2);
if (mode === "unixecho") {
  Bun.listen({ unix: sock!, socket: { data(s, d) { s.write(d); }, open() {}, close() {}, error() {} } });
  console.log("ready");
} else if (mode === "echo") {
  Bun.listen({ hostname: "127.0.0.1", port: Number(port), reusePort: true, socket: { data(s, d) { s.write(d); }, open() {}, close() {}, error() {} } });
  console.log("ready");
} else if (mode === "relay") {
  Bun.listen({ hostname: "127.0.0.1", port: Number(port), reusePort: true, socket: {
    open(s: any) { s.data = { up: undefined as any, pending: [] as Uint8Array[] }; Bun.connect({ unix: sock!, socket: { data(u: any, d: any) { s.write(d); }, open() {}, close() { s.end(); }, error() { s.end(); } } }).then((u) => { s.data.up = u; for (const p of s.data.pending) u.write(p); s.data.pending = []; }); },
    data(s: any, d: any) { const copy = new Uint8Array(d); if (s.data.up) s.data.up.write(copy); else s.data.pending.push(copy); },
    close() {}, error() {} } });
  console.log("ready");
} else {
  // client: sequential 300-byte request / response on one keep-alive TCP connection
  const msg = new TextEncoder().encode("x".repeat(300));
  const times: number[] = []; let resolveWait: (() => void) | undefined; let got = 0;
  const sock2 = await Bun.connect({ hostname: "127.0.0.1", port: Number(port), socket: { data(_s, d) { got += d.length; if (got >= 300) { got = 0; resolveWait?.(); } }, open() {}, close() {}, error() {} } });
  const one = () => new Promise<void>((r) => { resolveWait = r; sock2.write(msg); });
  for (let i = 0; i < 300; i++) await one();
  const end = performance.now() + Number(secs) * 1000;
  while (performance.now() < end) { const t = performance.now(); await one(); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  console.log(`${port} rtt n=${times.length} p50=${times[Math.floor(times.length / 2)]!.toFixed(3)} p95=${times[Math.floor(times.length * 0.95)]!.toFixed(3)}`);
  process.exit(0);
}
setInterval(() => {}, 1 << 30);
