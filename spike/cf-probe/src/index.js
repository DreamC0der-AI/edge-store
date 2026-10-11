// Probe Worker for claims cf-meta, cf-cron and cf-relay. Throwaway.
const CHUNK = 16 * 1024 * 1024;
const CHUNKS_PER_GB = 64;
const REPLICAS = 2;

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default {
    async fetch(req, env) {
        const url = new URL(req.url);
        const q = url.searchParams;
        if (q.get('k') !== env.TOKEN) return new Response('forbidden', { status: 403 });
        try {
            switch (url.pathname) {
                case '/register': return json(await register(env, q.get('mode') || 'json'));
                case '/manifest': return json(await manifest(env, q.get('file')));
                case '/burn': return json(burn(Number(q.get('m') || 10)));
                case '/hash': return json(await hash(Number(q.get('mb') || 16)));
                case '/fan': return json(await fan(Number(q.get('n') || 60)));
                case '/relay': return json(await relay(q.get('hash') === '1'));
                case '/cronstats': return json(await cronstats(env));
                case '/tick': return json(await tick(env));
            }
            return new Response('not found', { status: 404 });
        } catch (e) {
            return json({ error: String(e?.message || e) }, 500);
        }
    },
    async scheduled(event, env, ctx) {
        // hard stop so a forgotten schedule cannot keep generating traffic
        if (env.STOP_AT && Date.now() > Number(env.STOP_AT)) return;
        ctx.waitUntil(tick(env, event.scheduledTime));
    },
};

// ---- cf-meta ------------------------------------------------------------

function fakeFile() {
    const fileId = crypto.randomUUID();
    const chunks = [];
    const replicas = [];
    for (let i = 0; i < CHUNKS_PER_GB; i++) {
        chunks.push({ size: CHUNK + 16, sha256: 'ab'.repeat(32) });
        for (let r = 0; r < REPLICAS; r++) {
            replicas.push({ i, r, c: `-100${1000000000 + r}`, m: 100000 + i, f: 'BQACAgUAAxkBAAI'.padEnd(72, 'x') });
        }
    }
    return { fileId, chunks, replicas };
}

async function register(env, mode) {
    const { fileId, chunks, replicas } = fakeFile();
    const fileStmt = env.DB.prepare('INSERT INTO files (id, size, header, manifest, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(fileId, CHUNKS_PER_GB * CHUNK, '{"wrappedKey":"..."}', JSON.stringify(chunks), Date.now());
    let stmts;
    if (mode === 'batch') {
        // one statement per replica row
        const ins = env.DB.prepare('INSERT INTO replicas (file_id, idx, replica, chat_id, message_id, tg_file_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)');
        stmts = [fileStmt, ...replicas.map(x => ins.bind(fileId, x.i, x.r, x.c, x.m, x.f))];
    } else {
        // all replica rows in one statement, passed as a single JSON parameter
        stmts = [fileStmt, env.DB.prepare(
            `INSERT INTO replicas (file_id, idx, replica, chat_id, message_id, tg_file_id)
             SELECT ?1, value->>'i', value->>'r', value->>'c', value->>'m', value->>'f' FROM json_each(?2)`
        ).bind(fileId, JSON.stringify(replicas))];
    }
    const res = await env.DB.batch(stmts);
    return { fileId, mode, statements: stmts.length, rowsWritten: res.reduce((n, r) => n + (r.meta?.rows_written || 0), 0) };
}

async function manifest(env, fileId) {
    const [file, reps] = await env.DB.batch([
        env.DB.prepare('SELECT id, size, header, manifest FROM files WHERE id = ?1').bind(fileId),
        env.DB.prepare('SELECT idx, replica, chat_id, message_id, tg_file_id, state FROM replicas WHERE file_id = ?1 ORDER BY idx, replica').bind(fileId),
    ]);
    return { found: file.results.length, chunks: JSON.parse(file.results[0]?.manifest || '[]').length, replicas: reps.results.length };
}

// ---- plan calibration and CPU -------------------------------------------

// Pure CPU, no I/O: m million rounds of xorshift. The free plan should kill a large m.
function burn(m) {
    let n = 2463534242;
    for (let i = 0; i < m * 1e6; i++) { n ^= n << 13; n ^= n >>> 17; n ^= n << 5; }
    return { m, n };
}

async function hash(mb) {
    const buf = new Uint8Array(mb * 1024 * 1024);
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return { mb, sha256: [...d.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('') };
}

// How many outbound calls one request may make.
async function fan(n) {
    let ok = 0, firstError = null;
    for (let i = 0; i < n; i++) {
        try {
            const r = await fetch('https://api.telegram.org/botINVALID/getMe');
            await r.arrayBuffer();
            ok++;
        } catch (e) {
            firstError = String(e?.message || e);
            break;
        }
    }
    return { asked: n, ok, firstError };
}

// ---- cf-relay -----------------------------------------------------------

async function relay(withHash) {
    // any public file larger than one chunk; Range trims it to exactly 16 MiB
    const down = await fetch('https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz', { headers: { Range: `bytes=0-${CHUNK - 1}` } });
    const buf = await down.arrayBuffer();
    let sha = null;
    if (withHash) {
        const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
        sha = [...d.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    const form = new FormData();
    form.append('chat_id', '-1001234567890');
    form.append('document', new Blob([buf], { type: 'application/octet-stream' }), 'chunk.bin');
    const up = await fetch('https://speed.cloudflare.com/__up', { method: 'POST', body: form });
    await up.arrayBuffer();
    return { downStatus: down.status, bytes: buf.byteLength, sha, upStatus: up.status };
}

// ---- cf-cron ------------------------------------------------------------

async function tick(env, scheduledAt = 0) {
    const t0 = Date.now();
    const worker = env.NAME || 'heavy';
    await env.DB.prepare('INSERT INTO cron_start (at, scheduled_at, worker) VALUES (?1, ?2, ?3)').bind(t0, scheduledAt, worker).run();
    const rows = (await env.DB.prepare('SELECT id FROM replicas ORDER BY checked_at LIMIT 20').all()).results;
    let ok = 0, err = null;
    try {
        // two calls per replica, as a liveness check would make
        const statuses = await Promise.all(Array.from({ length: rows.length * 2 }, async () => {
            const r = await fetch('https://api.telegram.org/botINVALID/getMe');
            await r.arrayBuffer();
            return r.status;
        }));
        ok = statuses.filter(s => s === 404).length;
        await env.DB.prepare('UPDATE replicas SET checked_at = ?1 WHERE id IN (SELECT value FROM json_each(?2))')
            .bind(Date.now(), JSON.stringify(rows.map(r => r.id))).run();
    } catch (e) {
        err = String(e?.message || e);
    }
    // one paced repair: move a chunk through the Worker and hash it
    let relayed = 'skipped';
    if (env.RELAY !== 'off') {
        try {
            const r = await relay(true);
            relayed = r.downStatus === 206 && r.upStatus === 200 && r.bytes === CHUNK ? 'ok' : JSON.stringify(r);
        } catch (e) {
            relayed = String(e?.message || e);
        }
    }
    const wall = Date.now() - t0;
    await env.DB.prepare('INSERT INTO cron_log (at, rows, fetches_ok, err, wall_ms, relay, worker) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
        .bind(t0, rows.length, ok, err, wall, relayed, worker).run();
    return { rows: rows.length, ok, err, wall, relayed };
}

async function cronstats(env) {
    const runs = (await env.DB.prepare('SELECT at, rows, fetches_ok, err, wall_ms, relay, worker FROM cron_log ORDER BY at').all()).results;
    const starts = (await env.DB.prepare('SELECT at, scheduled_at, worker FROM cron_start ORDER BY at').all()).results;
    return { runs, starts };
}
