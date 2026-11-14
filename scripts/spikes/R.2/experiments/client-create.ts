const [url, secs] = process.argv.slice(2);
const body = JSON.stringify({ title: "New post", body: "<p>created by the benchmark</p>", views: 1, author: "m00000000000007" });
const send = async () => { const r = await fetch(url!, { method: "POST", headers: { "content-type": "application/json" }, body }); await r.arrayBuffer(); return r.status; };
for (let i = 0; i < 300; i++) await send();
const times: number[] = []; let errs = 0; const end = performance.now() + Number(secs) * 1000;
while (performance.now() < end) { const t = performance.now(); const s = await send(); times.push(performance.now() - t); if (s !== 200) errs++; }
times.sort((a, b) => a - b);
console.log(`${url} n=${times.length} p50=${times[Math.floor(times.length / 2)]!.toFixed(3)} p95=${times[Math.floor(times.length * 0.95)]!.toFixed(3)} errs=${errs}`);
