import { newPrimaryHop } from "@/replicas/primary-hop";
const [base, exe, secs] = process.argv.slice(2);
const dir = `${process.env.EXP_TMP}/hop`;
await Bun.$`rm -rf ${dir} && mkdir -p ${dir} && cp -r ${base} ${dir}/pb_data`.quiet();
const sock = `${dir}/p.sock`;
const proc = Bun.spawn([exe!, "serve", "--http", `unix:${sock}`, "--dir", `${dir}/pb_data`, "--automigrate=false"], { stdout: "ignore", stderr: "ignore" });
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch("http://primary/api/health", { unix: sock })).ok) break; } catch {} await Bun.sleep(50); }
  const hop = newPrimaryHop(sock);
  const body = JSON.stringify({ title: "New post", body: "<p>created by the benchmark</p>", views: 1, author: "m00000000000007" });
  const send = async () => { const req = new Request("http://replica/api/collections/posts/records", { method: "POST", headers: { "content-type": "application/json" }, body }); const r = await hop.send(req); await r.arrayBuffer(); return r.status; };
  for (let i = 0; i < 300; i++) await send();
  const times: number[] = []; let errs = 0;
  const end = performance.now() + Number(secs) * 1000;
  while (performance.now() < end) { const t = performance.now(); const s = await send(); times.push(performance.now() - t); if (s !== 200) errs++; }
  times.sort((a, b) => a - b);
  console.log(`hop create n=${times.length} p50=${times[Math.floor(times.length / 2)]!.toFixed(3)} p95=${times[Math.floor(times.length * 0.95)]!.toFixed(3)} errs=${errs}`);
  hop.close();
} finally { proc.kill("SIGTERM"); await proc.exited; }
