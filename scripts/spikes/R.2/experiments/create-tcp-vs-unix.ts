// experiment: 1-client sequential creates, keep-alive, to a primary over TCP or Unix socket
const [mode, base, exe, secs] = process.argv.slice(2);
const dir = `${process.env.EXP_TMP}/${mode}`;
await Bun.$`rm -rf ${dir} && mkdir -p ${dir} && cp -r ${base} ${dir}/pb_data`.quiet();
const sock = `${dir}/p.sock`;
const port = 19000 + Math.floor(Math.random() * 500);
const args = mode === "unix" ? [`unix:${sock}`] : [`127.0.0.1:${port}`];
const proc = Bun.spawn([exe, "serve", "--http", args[0]!, "--dir", `${dir}/pb_data`, "--automigrate=false"], { stdout: "ignore", stderr: "ignore" });
const opts = mode === "unix" ? { unix: sock } : {};
const url = mode === "unix" ? "http://primary" : `http://127.0.0.1:${port}`;
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url + "/api/health", opts as any)).ok) break; } catch {} await Bun.sleep(50); }
  const body = JSON.stringify({ title: "New post", body: "<p>created by the benchmark</p>", views: 1, author: "m0000000000000007".slice(0, 15) });
  const send = async () => { const r = await fetch(url + "/api/collections/posts/records", { method: "POST", headers: { "content-type": "application/json" }, body, ...opts } as any); await r.arrayBuffer(); return r.status; };
  for (let i = 0; i < 300; i++) await send();
  const times: number[] = []; let errs = 0;
  const end = performance.now() + Number(secs) * 1000;
  while (performance.now() < end) { const t = performance.now(); const s = await send(); times.push(performance.now() - t); if (s !== 200) errs++; }
  times.sort((a, b) => a - b);
  console.log(`${mode} create n=${times.length} p50=${times[Math.floor(times.length / 2)]!.toFixed(3)} p95=${times[Math.floor(times.length * 0.95)]!.toFixed(3)} errs=${errs}`);
} finally { proc.kill("SIGTERM"); await proc.exited; }
