// Drives the deployed probe Worker. Run: PROBE_URL=https://edge-store-probe.<you>.workers.dev node probe.mjs <test> [args]
import { readFileSync } from 'node:fs';

const BASE = process.env.PROBE_URL;
if (!BASE) throw new Error('set PROBE_URL to the address of the deployed probe Worker');
const K = readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8').match(/TOKEN = "(\w+)"/)[1];

async function call(path, params = {}, method = 'GET') {
    const u = new URL(BASE + path);
    for (const [k, v] of Object.entries({ ...params, k: K })) u.searchParams.set(k, v);
    const t = performance.now();
    try {
        const r = await fetch(u, { method, signal: AbortSignal.timeout(120_000) });
        const text = await r.text();
        let body; try { body = JSON.parse(text); } catch { body = text.replace(/\s+/g, ' ').slice(0, 140); }
        return { status: r.status, ms: Math.round(performance.now() - t), body };
    } catch (e) {
        return { status: 0, ms: Math.round(performance.now() - t), body: String(e.message) };
    }
}

const show = (label, r) => console.log(`${label.padEnd(26)} ${r.status}  ${String(r.ms).padStart(6)} ms  ${typeof r.body === 'string' ? r.body : JSON.stringify(r.body)}`);

async function repeat(label, n, fn) {
    const rs = [];
    for (let i = 0; i < n; i++) rs.push(await fn(i));
    const ok = rs.filter(r => r.status === 200).length;
    const ms = rs.map(r => r.ms).sort((a, b) => a - b);
    const bad = rs.filter(r => r.status !== 200).map(r => `${r.status}:${typeof r.body === 'string' ? r.body : JSON.stringify(r.body)}`);
    console.log(`${label.padEnd(26)} ${ok}/${n} ok   median ${ms[n >> 1]} ms   max ${ms[n - 1]} ms${bad.length ? '   failures: ' + [...new Set(bad)].join(' | ').slice(0, 300) : ''}`);
    return rs;
}

const tests = {
    async burn() {
        for (const m of [5, 20, 50, 100, 300, 1000]) show(`burn m=${m}`, await call('/burn', { m }));
    },
    async meta() {
        show('register json (1 try)', await call('/register', { mode: 'json' }, 'POST'));
        show('register batch (1 try)', await call('/register', { mode: 'batch' }, 'POST'));
        const regs = await repeat('register json x20', 20, () => call('/register', { mode: 'json' }, 'POST'));
        await repeat('register batch x20', 20, () => call('/register', { mode: 'batch' }, 'POST'));
        const id = regs.find(r => r.status === 200)?.body.fileId;
        show('manifest (1 try)', await call('/manifest', { file: id }));
        await repeat('manifest x20', 20, () => call('/manifest', { file: id }));
    },
    async hash() {
        for (const mb of [1, 4, 16, 64]) await repeat(`hash ${mb} MiB x5`, 5, () => call('/hash', { mb }));
    },
    async fan() {
        for (const n of [40, 50, 60]) show(`fan n=${n}`, await call('/fan', { n }));
    },
    async relay() {
        show('relay no hash (1 try)', await call('/relay', { hash: 0 }));
        await repeat('relay no hash x10', 10, () => call('/relay', { hash: 0 }));
        await repeat('relay + sha256 x10', 10, () => call('/relay', { hash: 1 }));
    },
    async cron() {
        const r = await call('/cronstats');
        const { runs = [], starts = [] } = r.body;
        for (const w of [...new Set(starts.map(s => s.worker))]) {
            const st = starts.filter(s => s.worker === w && s.scheduled_at);
            const done = runs.filter(x => x.worker === w);
            const doneAt = new Set(done.map(x => x.at));
            const killed = st.filter(s => !doneAt.has(s.at));
            const minutes = st.map(s => Math.round(s.scheduled_at / 60000)).sort((a, b) => a - b);
            const span = minutes.length ? minutes.at(-1) - minutes[0] + 1 : 0;
            const gaps = [];
            for (let i = 1; i < minutes.length; i++) if (minutes[i] - minutes[i - 1] > 1) gaps.push(`${new Date(minutes[i - 1] * 60000).toISOString().slice(11, 16)}+${minutes[i] - minutes[i - 1] - 1}`);
            console.log(`${w.padEnd(6)} scheduled minutes spanned ${span}, started ${st.length}, finished ${st.length - killed.length}, started-but-not-finished ${killed.length}, ` +
                `relay ok ${done.filter(x => x.relay === 'ok' && st.some(s => s.at === x.at)).length}, fetch errors ${done.filter(x => x.err).length}, missed minutes after: [${gaps.join(' ')}]`);
        }
    },
    async tick() { show('tick', await call('/tick')); },
};

for (const name of process.argv.slice(2)) {
    console.log(`\n== ${name} ==`);
    await tests[name]();
}
