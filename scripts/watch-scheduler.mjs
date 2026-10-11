// Prints each new scheduled scrubber run as it is recorded. Run: node scripts/watch-scheduler.mjs [minutes]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../client/lib.mjs';

const store = new Store(JSON.parse(readFileSync(process.env.EDGE_STORE_CONFIG || join(homedir(), '.config', 'edge-store', 'config.json'), 'utf8')));
const until = Date.now() + Number(process.argv[2] || 5) * 60_000;
const seen = new Set();
while (Date.now() < until) {
    const s = await store.status().catch(() => null);
    const t = s?.kv.scrub?.lastTickAt;
    if (t && !seen.has(t)) { seen.add(t); console.log(`run recorded at ${new Date(t).toISOString().slice(11, 19)}`); }
    await new Promise(r => setTimeout(r, 10_000));
}
console.log(`${seen.size} run(s) seen in ${process.argv[2] || 5} minute(s)`);
