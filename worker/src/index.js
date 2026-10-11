// edge-store Worker: the index (D1), the HTTP API that apps use, and the scheduled scrubber.
// The Telegram bot token never leaves this Worker: file bytes are streamed through it,
// and callers identify themselves with keys that can be granted, limited and revoked.

const MAX_CHUNK = 19 * 1024 * 1024;        // a bot cannot download files of 20 MB or more
const MAX_JSON = 4 * 1024 * 1024;          // the largest JSON request body that is read
const SCRUB_BATCH = 20;                    // replicas checked per run, two Telegram calls each
const CHECK_BUDGET_MS = 20_000;            // stop starting new checks after this long; the rest wait for the next run
const DEFAULT_SCRUB_INTERVAL_MIN = 360;    // a pass over all replicas starts at most this often
const DEFAULT_CHANNEL_LIMIT = 500_000;     // messages per channel before uploads move on
const BACKUP_EVERY_MS = 24 * 3600 * 1000;
const BACKUP_TAG = 'edge-store-backup';
const SLOTS = [0, 1];
const RAW_GET_MAX_CHUNKS = 24;             // one request may make 50 outbound calls; a chunk takes two
const RANK = { read: 1, write: 2, admin: 3 };
const TG_PASSTHROUGH = ['getChat', 'forwardMessage', 'deleteMessage', 'deleteMessages', 'editMessageCaption'];

class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const caption = (fileId, idx) => `${fileId}:${idx}`;
const isSha = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
// Reads a request body into memory, or returns null as soon as it turns out longer than `max`.
// The length a client declares is not relied on: a body sent without one is counted as it arrives,
// so nothing longer than `max` is ever held here.
async function readUpTo(req, max) {
    if (Number(req.headers.get('content-length')) > max) return null;
    if (!req.body) return new Uint8Array(0);
    const reader = req.body.getReader();
    const parts = [];
    let n = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > max) {
            await reader.cancel().catch(() => {});
            return null;
        }
        parts.push(value);
    }
    const out = new Uint8Array(n);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.byteLength; }
    return out;
}
const normPath = (p) => {
    const s = String(p ?? '').replace(/^\/+/, '');
    if (!s || s.length > 1024) throw new HttpError(400, 'invalid path');
    return s;
};

export default {
    async fetch(req, env, ctx) {
        try {
            const who = await authenticate(req, env);
            if (!who) return json({ error: 'unauthorized' }, 401);
            return await route(req, env, ctx, who);
        } catch (e) {
            // whatever went wrong, the bot token must not ride out in an error message
            const message = noToken(env, e?.message || e);
            return json({ error: message }, e instanceof HttpError ? e.status : 500);
        }
    },
    async scheduled(event, env) {
        // awaited rather than handed to waitUntil, which would cut a slow run off after 30 seconds
        await tick(env);
    },
};

const noToken = (env, text) => (env.TG_BOT_TOKEN ? String(text).replaceAll(env.TG_BOT_TOKEN, '[bot token]') : String(text));

// Who is calling? Either the root token (a Worker secret, for the owner) or a key from the keys table.
async function authenticate(req, env) {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
    if (!token) return null;
    const enc = new TextEncoder();
    const same = (a, b) => {
        const x = enc.encode(a), y = enc.encode(b);
        return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
    };
    if (env.ACCESS_TOKEN && same(token, env.ACCESS_TOKEN)) return { id: 'root', name: 'root', role: 'admin', prefix: '' };
    const m = token.match(/^es_([0-9a-f]{8})_[0-9a-f]{64}$/);
    if (!m) return null;
    const k = await env.DB.prepare('SELECT id, name, hash, role, prefix, revoked_at, last_used_at FROM keys WHERE id = ?1').bind(m[1]).first();
    if (!k || k.revoked_at) return null;
    if (!same(hex(await crypto.subtle.digest('SHA-256', enc.encode(token))), k.hash)) return null;
    // "last used" is for the owner's overview; an hour's resolution keeps it to a few writes a day
    if (Date.now() - (k.last_used_at || 0) > 3600_000) {
        await env.DB.prepare('UPDATE keys SET last_used_at = ?2 WHERE id = ?1').bind(k.id, Date.now()).run();
    }
    return { id: k.id, name: k.name, role: k.role, prefix: k.prefix };
}

// ---- Telegram -----------------------------------------------------------

// TG_API can point at a self-hosted Bot API server (the tests point it at a simulated one).
const tgBase = (env) => env.TG_API || 'https://api.telegram.org';
const apiUrl = (env, method) => `${tgBase(env)}/bot${env.TG_BOT_TOKEN}/${method}`;
const fileUrl = (env, path) => `${tgBase(env)}/file/bot${env.TG_BOT_TOKEN}/${path}`;

async function tg(env, method, body) {
    const r = await fetch(apiUrl(env, method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
}

async function tgSend(env, chatId, bytes, name, text) {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', text);
    form.append('disable_notification', 'true');
    form.append('disable_content_type_detection', 'true');
    form.append('document', new Blob([bytes], { type: 'application/octet-stream' }), name);
    const r = await fetch(apiUrl(env, 'sendDocument'), { method: 'POST', body: form });
    return r.json();
}

// Uploads a document whose bytes arrive as a stream of known length. The multipart framing is
// written around the stream, so nothing is buffered here.
async function tgSendStream(env, chatId, body, size, name, text) {
    const boundary = `edgestore${crypto.randomUUID().replace(/-/g, '')}`;
    const field = (k, v) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
    const enc = new TextEncoder();
    const head = enc.encode(field('chat_id', chatId) + field('caption', text) + field('disable_notification', 'true') + field('disable_content_type_detection', 'true')
        + `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const foot = enc.encode(`\r\n--${boundary}--\r\n`);
    const { readable, writable } = new FixedLengthStream(head.byteLength + size + foot.byteLength);
    const pump = (async () => {
        let w = writable.getWriter();
        await w.write(head);
        w.releaseLock();
        await body.pipeTo(writable, { preventClose: true });
        w = writable.getWriter();
        await w.write(foot);
        await w.close();
    })();
    const [res] = await Promise.all([
        fetch(apiUrl(env, 'sendDocument'), { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: readable }),
        pump,
    ]);
    return res.json();
}

const docOf = (message) => message.document || message.video || message.audio || message.animation;

// ---- small D1 helpers ---------------------------------------------------

async function kvAll(db) {
    const rows = (await db.prepare('SELECT key, value FROM kv').all()).results;
    return Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.value)]));
}
const kvSet = (db, key, value) =>
    db.prepare('INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, JSON.stringify(value));
const event = (db, kind, detail) =>
    db.prepare('INSERT INTO events (at, kind, detail) VALUES (?1, ?2, ?3)').bind(Date.now(), kind, String(detail ?? '').slice(0, 500));

// The open channel for each slot; the fullest one first so channels fill up one at a time.
async function targets(db, limit) {
    const rows = (await db.prepare('SELECT chat_id, slot FROM channels WHERE active = 1 AND messages < ?1 ORDER BY slot, messages DESC')
        .bind(limit ?? DEFAULT_CHANNEL_LIMIT).all()).results;
    const t = {};
    for (const r of rows) if (!(r.slot in t)) t[r.slot] = r.chat_id;
    for (const s of SLOTS) if (!t[s]) throw new HttpError(507, `no open channel for replica slot ${s}; add a channel`);
    return t;
}

async function loadFile(db, id) {
    const f = await db.prepare('SELECT id, path, size, sha256, chunk_size, chunks, state, created_at FROM files WHERE id = ?1').bind(id).first();
    if (!f) throw new HttpError(404, 'no such file');
    return f;
}

// Where the replicas sit in Telegram is only shown to administrators; apps need just id, slot and state.
async function manifest(db, file, withLocations) {
    const [c, r] = await db.batch([
        db.prepare('SELECT idx, size, sha256 FROM chunks WHERE file_id = ?1 ORDER BY idx').bind(file.id),
        db.prepare(`SELECT id, idx, slot, state${withLocations ? ', chat_id, message_id, tg_file_id' : ''} FROM replicas WHERE file_id = ?1 ORDER BY idx, slot`).bind(file.id),
    ]);
    const chunks = c.results.map(x => ({ ...x, replicas: [] }));
    const byIdx = new Map(chunks.map(x => [x.idx, x]));
    for (const x of r.results) byIdx.get(x.idx)?.replicas.push(x);
    return { ...file, chunkList: chunks };
}

// ---- API ----------------------------------------------------------------

async function route(req, env, ctx, who) {
    const db = env.DB;
    const url = new URL(req.url);
    const p = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const m = req.method;
    const q = url.searchParams;
    const is = (method, ...parts) => m === method && p.length === parts.length && parts.every((x, i) => x === '*' || x === p[i]);
    const body = async () => {
        const bytes = await readUpTo(req, MAX_JSON);
        if (!bytes) throw new HttpError(413, 'the request body is too large');
        try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return {}; }
    };
    const need = (role) => {
        if (RANK[who.role] < RANK[role]) throw new HttpError(403, `this key is not allowed to do that (it needs ${role} access)`);
    };
    const scoped = (path) => {
        if (!path.startsWith(who.prefix)) throw new HttpError(403, `this key is limited to paths starting with "${who.prefix}"`);
        return path;
    };
    const fileFor = async (id, role) => {
        need(role);
        const f = await loadFile(db, id);
        scoped(f.path);
        return f;
    };

    if (is('GET', 'whoami')) return json({ name: who.name, role: who.role, prefix: who.prefix, maxChunk: MAX_CHUNK });

    // ---- a whole file in one request: for small files and simple clients ----

    if (p[0] === 'raw' && p.length > 1 && (m === 'GET' || m === 'PUT')) {
        const path = scoped(normPath(p.slice(1).join('/')));
        need(m === 'GET' ? 'read' : 'write');
        return m === 'GET' ? rawGet(env, ctx, path) : rawPut(req, env, path);
    }

    // ---- files, chunk by chunk ----

    // begin (or resume) an upload
    if (is('POST', 'files')) {
        need('write');
        const b = await body();
        const path = scoped(normPath(b.path));
        const { size, chunkSize, chunks } = b;
        if (![size, chunkSize, chunks].every(Number.isInteger) || size < 0 || chunkSize <= 0 || chunkSize > MAX_CHUNK || chunks !== Math.ceil(size / chunkSize)) {
            throw new HttpError(400, 'invalid size, chunkSize or chunks');
        }
        const kv = await kvAll(db);
        await targets(db, kv.channel_limit); // fail now, not after the first chunk has been sent
        const existing = (await db.prepare('SELECT id, size, chunk_size, state FROM files WHERE path = ?1').bind(path).all()).results;
        if (existing.some(f => f.state === 'complete')) throw new HttpError(409, 'a file already exists at this path');
        const up = existing.find(f => f.state === 'uploading');
        if (up && up.size === size && up.chunk_size === chunkSize) {
            const [c, r] = await db.batch([
                db.prepare('SELECT idx, sha256 FROM chunks WHERE file_id = ?1').bind(up.id),
                db.prepare(`SELECT idx, slot FROM replicas WHERE file_id = ?1 AND state = 'ok'`).bind(up.id),
            ]);
            const have = c.results.map(ch => ({ idx: ch.idx, sha256: ch.sha256, slots: r.results.filter(x => x.idx === ch.idx).map(x => x.slot) }));
            return json({ id: up.id, resumed: true, have });
        }
        // a different file was being uploaded to this path: clear it away first
        if (up && !await removeFile(env, db, up.id)) throw new HttpError(409, 'an earlier upload to this path is still being cleared; try again');
        const id = crypto.randomUUID();
        await db.prepare(`INSERT INTO files (id, path, size, chunk_size, chunks, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'uploading', ?6)`)
            .bind(id, path, size, chunkSize, chunks, Date.now()).run();
        return json({ id, resumed: false, have: [] });
    }

    if (is('PUT', 'files', '*', 'chunks', '*')) return putChunk(req, env, await fileFor(p[1], 'write'), Number(p[3]), q.get('sha256'));

    if (is('GET', 'files', '*', 'chunks', '*')) {
        const file = await fileFor(p[1], 'read');
        const slot = q.has('slot') ? Number(q.get('slot')) : null;
        const o = await openChunk(env, file, Number(p[3]), slot);
        return new Response(o.res.body.pipeThrough(new FixedLengthStream(o.chunk.size)), {
            headers: { 'content-type': 'application/octet-stream', 'x-sha256': o.chunk.sha256, 'x-replica': String(o.rep.id), 'x-slot': String(o.rep.slot) },
        });
    }

    if (is('POST', 'files', '*', 'commit')) {
        const file = await fileFor(p[1], 'write');
        if (file.state === 'complete') return json({ id: file.id, state: 'complete' });
        const b = await body();
        if (!isSha(b.sha256)) throw new HttpError(400, 'sha256 required');
        const n = await db.prepare(`SELECT (SELECT count(*) FROM chunks WHERE file_id = ?1) AS c,
            (SELECT count(*) FROM replicas WHERE file_id = ?1 AND state = 'ok') AS r`).bind(file.id).first();
        if (n.c !== file.chunks || n.r !== file.chunks * SLOTS.length) {
            throw new HttpError(409, `incomplete: ${n.c}/${file.chunks} chunks, ${n.r}/${file.chunks * SLOTS.length} replicas`);
        }
        try {
            await db.prepare(`UPDATE files SET state = 'complete', sha256 = ?2 WHERE id = ?1`).bind(file.id, b.sha256).run();
        } catch (e) {
            if (/UNIQUE/i.test(String(e?.message))) throw new HttpError(409, 'a file already exists at this path');
            throw e;
        }
        return json({ id: file.id, state: 'complete' });
    }

    if (is('GET', 'files')) {
        need('read');
        const prefix = scoped(q.get('prefix') || who.prefix);
        const after = q.get('after') || '';
        const all = q.get('all') === '1' ? 1 : 0;
        const rows = (await db.prepare(`SELECT id, path, size, sha256, chunks, state, created_at FROM files
            WHERE path >= ?1 AND path < ?2 AND path > ?3 AND (state = 'complete' OR ?4 = 1) ORDER BY path LIMIT 1000`)
            .bind(prefix, prefix + '\u{10FFFF}', after, all).all()).results;
        return json({ files: rows, next: rows.length === 1000 ? rows.at(-1).path : null });
    }
    if (is('GET', 'file')) {
        need('read');
        const f = await db.prepare(`SELECT id FROM files WHERE path = ?1 AND state = 'complete'`).bind(scoped(normPath(q.get('path')))).first();
        if (!f) throw new HttpError(404, 'no such file');
        return json(await manifest(db, await loadFile(db, f.id), who.role === 'admin'));
    }
    if (is('GET', 'files', '*')) return json(await manifest(db, await fileFor(p[1], 'read'), who.role === 'admin'));
    if (is('DELETE', 'files', '*')) {
        const file = await fileFor(p[1], 'write');
        return json({ deleted: file.id, done: await removeFile(env, db, file.id) });
    }

    // a client could not read this replica
    if (is('POST', 'replicas', '*')) {
        need('write');
        const id = Number(p[1]);
        const rep = await db.prepare('SELECT f.path FROM replicas r JOIN files f ON f.id = r.file_id WHERE r.id = ?1').bind(id).first();
        if (!rep) throw new HttpError(404, 'no such replica');
        scoped(rep.path);
        const b = await body();
        const r = await db.prepare(`UPDATE replicas SET state = 'missing', attempts = 0 WHERE id = ?1 AND state = 'ok'`).bind(id).run();
        if (r.meta.changes) await event(db, 'reported', `replica ${id} by ${who.name}: ${b.why || ''}`).run();
        return json({ ok: true, changed: r.meta.changes });
    }

    // ---- everything below is administration ----
    need('admin');

    if (is('GET', 'keys')) {
        const rows = (await db.prepare('SELECT id, name, role, prefix, created_at, revoked_at, last_used_at FROM keys ORDER BY created_at').all()).results;
        return json({ keys: rows });
    }
    if (is('POST', 'keys')) {
        const b = await body();
        const name = String(b.name ?? '').trim();
        const role = b.role ?? 'write';
        const prefix = String(b.prefix ?? '').replace(/^\/+/, '');
        if (!name || name.length > 100) throw new HttpError(400, 'a key needs a name');
        if (!(role in RANK)) throw new HttpError(400, 'role must be read, write or admin');
        const id = hex(crypto.getRandomValues(new Uint8Array(4)));
        const key = `es_${id}_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
        // only a hash is kept, so the key itself can be shown exactly once
        await db.prepare('INSERT INTO keys (id, name, hash, role, prefix, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
            .bind(id, name, hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))), role, prefix, Date.now()).run();
        return json({ id, name, role, prefix, key });
    }
    if (is('DELETE', 'keys', '*')) {
        const r = await db.prepare('UPDATE keys SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL').bind(p[1], Date.now()).run();
        if (!r.meta.changes) throw new HttpError(404, 'no such active key');
        return json({ revoked: p[1] });
    }

    if (is('GET', 'config')) {
        const kv = await kvAll(db);
        const channels = (await db.prepare('SELECT chat_id, slot, title, active, messages FROM channels ORDER BY slot, chat_id').all()).results;
        const open = await targets(db, kv.channel_limit).catch(() => null);
        return json({ tgApi: tgBase(env), maxChunk: MAX_CHUNK, channelLimit: kv.channel_limit ?? DEFAULT_CHANNEL_LIMIT, channels, targets: open });
    }
    if (is('POST', 'channels')) {
        const b = await body();
        const chatId = String(b.chat_id ?? '');
        if (!SLOTS.includes(b.slot)) throw new HttpError(400, 'slot must be 0 or 1');
        const chat = await tg(env, 'getChat', { chat_id: chatId });
        if (!chat.ok) throw new HttpError(400, `bot cannot see chat ${chatId}: ${chat.description}`);
        const me = await tg(env, 'getChatMember', { chat_id: chatId, user_id: Number(env.TG_BOT_TOKEN.split(':')[0]) });
        if (me.result?.status !== 'administrator') throw new HttpError(400, 'bot is not an administrator of that chat');
        await db.prepare(`INSERT INTO channels (chat_id, slot, title) VALUES (?1, ?2, ?3)
            ON CONFLICT(chat_id) DO UPDATE SET slot = excluded.slot, title = excluded.title, active = 1`)
            .bind(chatId, b.slot, chat.result.title || '').run();
        return json({ chat_id: chatId, slot: b.slot, title: chat.result.title || '' });
    }
    if (is('DELETE', 'channels', '*')) {
        await db.prepare('UPDATE channels SET active = 0 WHERE chat_id = ?1').bind(p[1]).run();
        return json({ retired: p[1] });
    }
    if (is('PUT', 'settings')) {
        const b = await body();
        const stmts = [];
        if (Number.isInteger(b.channelLimit) && b.channelLimit > 0) stmts.push(kvSet(db, 'channel_limit', b.channelLimit));
        if (typeof b.paused === 'boolean') stmts.push(kvSet(db, 'paused', b.paused));
        if (Number.isInteger(b.scrubIntervalMinutes) && b.scrubIntervalMinutes >= 0) stmts.push(kvSet(db, 'scrub_interval_min', b.scrubIntervalMinutes));
        if (stmts.length) await db.batch(stmts);
        return json({ ok: true });
    }

    if (is('GET', 'replicas')) {
        const rows = (await db.prepare(`SELECT r.id, r.file_id, r.idx, r.slot, r.state, r.attempts, c.size, c.sha256, f.path
            FROM replicas r JOIN chunks c ON c.file_id = r.file_id AND c.idx = r.idx JOIN files f ON f.id = r.file_id
            WHERE r.state != 'ok' ORDER BY r.id LIMIT 500`).all()).results;
        return json({ replicas: rows });
    }
    // replace a missing replica with bytes the caller has already verified
    if (is('PUT', 'replicas', '*')) {
        const rep = await db.prepare(`SELECT r.id, r.file_id, r.idx, r.slot, r.chat_id, r.message_id, c.size
            FROM replicas r JOIN chunks c ON c.file_id = r.file_id AND c.idx = r.idx WHERE r.id = ?1`).bind(Number(p[1])).first();
        if (!rep) throw new HttpError(404, 'no such replica');
        if (Number(req.headers.get('content-length')) !== rep.size || !req.body) throw new HttpError(400, `the chunk must be exactly ${rep.size} bytes`);
        const kv = await kvAll(db);
        const target = (await targets(db, kv.channel_limit))[rep.slot];
        const sent = await tgSendStream(env, target, req.body, rep.size, `${rep.file_id}.${rep.idx}`, caption(rep.file_id, rep.idx));
        if (!sent.ok || docOf(sent.result)?.file_size !== rep.size) return telegramFailed(sent, 'upload failed');
        await db.batch([
            db.prepare(`UPDATE replicas SET chat_id = ?2, message_id = ?3, tg_file_id = ?4, state = 'ok', attempts = 0 WHERE id = ?1`)
                .bind(rep.id, target, sent.result.message_id, docOf(sent.result).file_id),
            db.prepare('UPDATE channels SET messages = messages + 1 WHERE chat_id = ?1').bind(target),
            event(db, 'repaired', `replica ${rep.id} by ${who.name}`),
        ]);
        await tg(env, 'deleteMessage', { chat_id: rep.chat_id, message_id: rep.message_id }).catch(() => {});
        return json({ ok: true });
    }

    if (is('GET', 'status')) {
        const [files, reps, noCopy, channels, kv, events] = await db.batch([
            db.prepare('SELECT state, count(*) AS n, coalesce(sum(size), 0) AS bytes FROM files GROUP BY state'),
            db.prepare('SELECT state, count(*) AS n FROM replicas GROUP BY state'),
            db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM replicas GROUP BY file_id, idx HAVING sum(state = 'ok') = 0)`),
            db.prepare('SELECT chat_id, slot, title, active, messages FROM channels ORDER BY slot, chat_id'),
            db.prepare('SELECT key, value FROM kv'),
            db.prepare('SELECT at, kind, detail FROM events ORDER BY id DESC LIMIT 20'),
        ]);
        return json({
            files: Object.fromEntries(files.results.map(r => [r.state, { n: r.n, bytes: r.bytes }])),
            replicas: Object.fromEntries(reps.results.map(r => [r.state, r.n])),
            chunksWithNoCopy: noCopy.results[0].n,
            channels: channels.results,
            kv: Object.fromEntries(kv.results.map(r => [r.key, JSON.parse(r.value)])),
            events: events.results,
        });
    }

    if (is('POST', 'tick')) return json(await tick(env, true));
    if (is('POST', 'backup')) return json(await backup(env));
    if (is('POST', 'import')) { const b = await body(); return json(await importRows(db, b.table, b.rows)); }

    // hand back the newest index backup pinned in the given channels (the index may be gone, so the caller names them)
    if (is('POST', 'backup', 'latest')) {
        const b = await body();
        let newest = null;
        for (const chat_id of (Array.isArray(b.chats) ? b.chats : []).slice(0, 10)) {
            const pin = (await tg(env, 'getChat', { chat_id })).result?.pinned_message;
            if (pin?.document && String(pin.caption || '').startsWith(BACKUP_TAG) && (!newest || pin.date > newest.date)) newest = pin;
        }
        if (!newest) throw new HttpError(404, 'no pinned index backup found in the given channels');
        const g = await tg(env, 'getFile', { file_id: newest.document.file_id });
        if (!g.ok) throw new HttpError(502, `backup could not be read: ${g.description}`);
        const res = await fetch(fileUrl(env, g.result.file_path));
        if (!res.ok) throw new HttpError(502, `backup could not be read: HTTP ${res.status}`);
        return new Response(res.body, { headers: { 'content-type': 'application/gzip' } });
    }

    // a few Bot API calls for maintenance scripts, so they need no token of their own
    if (is('POST', 'telegram', '*')) {
        if (!TG_PASSTHROUGH.includes(p[1])) throw new HttpError(400, `only these Telegram methods are available: ${TG_PASSTHROUGH.join(', ')}`);
        return json(await tg(env, p[1], await body()));
    }

    throw new HttpError(404, 'not found');
}

// Turns a failed Telegram answer into an HTTP error the client can act on.
function telegramFailed(sent, what) {
    const retryAfter = sent?.error_code === 429 ? (sent.parameters?.retry_after ?? 5) : null;
    return json({ error: `${what}: ${sent?.description || 'unexpected answer from Telegram'}`, retryAfter }, retryAfter != null ? 429 : 502);
}

// Deletes a file's Telegram messages and index rows. Returns false if there were too many
// for one request, in which case the caller asks again.
async function removeFile(env, db, fileId) {
    const LIMIT = 4000; // 40 Telegram calls of 100 messages
    const reps = (await db.prepare('SELECT id, chat_id, message_id FROM replicas WHERE file_id = ?1 LIMIT ?2').bind(fileId, LIMIT).all()).results;
    const byChat = new Map();
    for (const r of reps) byChat.set(r.chat_id, [...(byChat.get(r.chat_id) || []), r.message_id]);
    for (const [chat_id, ids] of byChat) {
        for (let i = 0; i < ids.length; i += 100) await tg(env, 'deleteMessages', { chat_id, message_ids: ids.slice(i, i + 100) }).catch(() => {});
    }
    if (reps.length) await db.prepare('DELETE FROM replicas WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(reps.map(r => r.id))).run();
    if (reps.length === LIMIT) return false;
    await db.batch([
        db.prepare('DELETE FROM chunks WHERE file_id = ?1').bind(fileId),
        db.prepare('DELETE FROM files WHERE id = ?1').bind(fileId),
    ]);
    return true;
}

// ---- file bytes ---------------------------------------------------------

// Stores one chunk: the request body is piped to one upload per replica slot, never buffered,
// so the two replicas are independent stored files and the Worker spends almost no CPU on it.
async function putChunk(req, env, file, idx, sha) {
    const db = env.DB;
    if (file.state !== 'uploading') throw new HttpError(409, 'file is not being uploaded');
    if (!Number.isInteger(idx) || idx < 0 || idx >= file.chunks) throw new HttpError(400, 'chunk index out of range');
    if (!isSha(sha)) throw new HttpError(400, 'the sha256 query parameter is required');
    const size = idx < file.chunks - 1 ? file.chunk_size : file.size - file.chunk_size * (file.chunks - 1);
    if (Number(req.headers.get('content-length')) !== size || !req.body) throw new HttpError(400, `chunk ${idx} must be exactly ${size} bytes`);

    const [c, r] = await db.batch([
        db.prepare('SELECT sha256 FROM chunks WHERE file_id = ?1 AND idx = ?2').bind(file.id, idx),
        db.prepare(`SELECT id, slot, chat_id, message_id FROM replicas WHERE file_id = ?1 AND idx = ?2 AND state = 'ok'`).bind(file.id, idx),
    ]);
    // an earlier attempt may have stored this chunk in one slot or both; different content replaces it
    const same = c.results[0]?.sha256 === sha;
    const stale = same ? [] : r.results;
    const wanted = SLOTS.filter(s => !(same && r.results.some(x => x.slot === s)));
    if (!wanted.length) {
        await req.body.cancel();
        return json({ ok: true, slots: [] });
    }
    const kv = await kvAll(db);
    const t = await targets(db, kv.channel_limit);
    const streams = wanted.length === 2 ? req.body.tee() : [req.body];
    const sent = await Promise.allSettled(wanted.map((slot, i) =>
        tgSendStream(env, t[slot], streams[i], size, `${file.id}.${idx}`, caption(file.id, idx))));

    const stored = [];
    const problems = [];
    let limited = null;
    for (const [i, s] of sent.entries()) {
        const slot = wanted[i];
        const v = s.status === 'fulfilled' ? s.value : null;
        if (v?.ok && docOf(v.result)?.file_size === size) {
            stored.push({ slot, chat_id: t[slot], message_id: v.result.message_id, tg_file_id: docOf(v.result).file_id });
            continue;
        }
        if (v?.ok) await tg(env, 'deleteMessage', { chat_id: t[slot], message_id: v.result.message_id }).catch(() => {});
        if (v?.error_code === 429) limited = v;
        problems.push(`slot ${slot}: ${v ? (v.description || 'stored with the wrong size') : noToken(env, s.reason?.message)}`);
    }

    if (stored.length) {
        const stmts = [db.prepare(`INSERT INTO chunks (file_id, idx, size, sha256) VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(file_id, idx) DO UPDATE SET size = excluded.size, sha256 = excluded.sha256`).bind(file.id, idx, size, sha)];
        if (stale.length) stmts.push(db.prepare('DELETE FROM replicas WHERE file_id = ?1 AND idx = ?2').bind(file.id, idx));
        for (const x of stored) {
            stmts.push(db.prepare(`INSERT INTO replicas (file_id, idx, slot, chat_id, message_id, tg_file_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(file_id, idx, slot) DO UPDATE SET chat_id = excluded.chat_id, message_id = excluded.message_id,
                    tg_file_id = excluded.tg_file_id, state = 'ok', attempts = 0`).bind(file.id, idx, x.slot, x.chat_id, x.message_id, x.tg_file_id));
            stmts.push(db.prepare('UPDATE channels SET messages = messages + 1 WHERE chat_id = ?1').bind(x.chat_id));
        }
        await db.batch(stmts);
        for (const o of stale) await tg(env, 'deleteMessage', { chat_id: o.chat_id, message_id: o.message_id }).catch(() => {});
    }
    if (problems.length) {
        const retryAfter = limited ? (limited.parameters?.retry_after ?? 5) : null;
        return json({ error: `chunk ${idx} not fully stored (${problems.join('; ')})`, stored: stored.map(x => x.slot), retryAfter }, limited ? 429 : 502);
    }
    return json({ ok: true, slots: stored.map(x => x.slot) });
}

// Starts a download of one chunk from the first replica Telegram can still serve.
// A replica that is definitely gone is marked missing so the scrubber repairs it.
async function openChunk(env, file, idx, slot = null) {
    const db = env.DB;
    const [c, r] = await db.batch([
        db.prepare('SELECT idx, size, sha256 FROM chunks WHERE file_id = ?1 AND idx = ?2').bind(file.id, idx),
        db.prepare(`SELECT id, slot, tg_file_id, state FROM replicas WHERE file_id = ?1 AND idx = ?2 ORDER BY (state = 'ok') DESC, slot`).bind(file.id, idx),
    ]);
    const chunk = c.results[0];
    if (!chunk) throw new HttpError(404, 'no such chunk');
    let unsure = false;
    for (const rep of r.results.filter(x => slot === null || x.slot === slot)) {
        const g = await tg(env, 'getFile', { file_id: rep.tg_file_id });
        if (!g.ok || g.result.file_size !== chunk.size) {
            const gone = g.ok || /wrong file|invalid file|file not found/i.test(g.description || '');
            if (!gone) unsure = true;
            else if (rep.state === 'ok') {
                await db.batch([
                    db.prepare(`UPDATE replicas SET state = 'missing', attempts = 0 WHERE id = ?1`).bind(rep.id),
                    event(db, 'missing', `replica ${rep.id} (${file.id}:${idx}): ${g.ok ? 'stored file has the wrong size' : g.description}`),
                ]);
            }
            continue;
        }
        const res = await fetch(fileUrl(env, g.result.file_path));
        if (!res.ok || !res.body) { unsure = true; continue; }
        return { chunk, rep, res };
    }
    if (unsure) throw new HttpError(503, `chunk ${idx}: Telegram is not answering for it right now`);
    throw new HttpError(404, `chunk ${idx}: no readable replica`);
}

// A whole file as one response, its chunks piped through one after another.
async function rawGet(env, ctx, path) {
    const f = await env.DB.prepare(`SELECT id, size, sha256, chunks FROM files WHERE path = ?1 AND state = 'complete'`).bind(path).first();
    if (!f) throw new HttpError(404, 'no such file');
    if (f.chunks > RAW_GET_MAX_CHUNKS) {
        throw new HttpError(400, `this file has ${f.chunks} chunks; fetch it chunk by chunk with GET /files/${f.id}/chunks/<n>`);
    }
    // open the first chunk before answering, so an unreadable file is an error rather than a broken download
    const first = f.chunks ? await openChunk(env, f, 0) : null;
    const { readable, writable } = new FixedLengthStream(f.size);
    ctx.waitUntil((async () => {
        try {
            for (let i = 0; i < f.chunks; i++) {
                const o = i === 0 ? first : await openChunk(env, f, i);
                await o.res.body.pipeTo(writable, { preventClose: true });
            }
            await writable.close();
        } catch (e) {
            await writable.abort(e).catch(() => {});
        }
    })());
    return new Response(readable, { headers: { 'content-type': 'application/octet-stream', 'x-sha256': f.sha256 || '' } });
}

// A whole file in one request body. Only for files that fit in one chunk: it is buffered and hashed here.
async function rawPut(req, env, path) {
    const db = env.DB;
    const buf = await readUpTo(req, MAX_CHUNK);
    if (!buf) throw new HttpError(413, `larger than ${MAX_CHUNK} bytes: upload it in chunks, starting with POST /files`);
    const existing = (await db.prepare('SELECT id, state FROM files WHERE path = ?1').bind(path).all()).results;
    if (existing.some(f => f.state === 'complete')) throw new HttpError(409, 'a file already exists at this path');
    for (const f of existing) await removeFile(env, db, f.id);

    const kv = await kvAll(db);
    const t = await targets(db, kv.channel_limit);
    const id = crypto.randomUUID();
    const size = buf.byteLength;
    const sha = hex(await crypto.subtle.digest('SHA-256', buf));
    const sent = size ? await Promise.all(SLOTS.map(slot => tgSend(env, t[slot], buf, `${id}.0`, caption(id, 0)).catch(e => ({ ok: false, description: noToken(env, e.message) })))) : [];
    const failed = sent.find(s => !s.ok || docOf(s.result)?.file_size !== size);
    if (failed) {
        for (const [i, s] of sent.entries()) if (s.ok) await tg(env, 'deleteMessage', { chat_id: t[SLOTS[i]], message_id: s.result.message_id }).catch(() => {});
        return telegramFailed(failed, 'upload failed');
    }
    const stmts = [db.prepare(`INSERT INTO files (id, path, size, sha256, chunk_size, chunks, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'complete', ?7)`)
        .bind(id, path, size, sha, Math.max(size, 1), size ? 1 : 0, Date.now())];
    if (size) stmts.push(db.prepare('INSERT INTO chunks (file_id, idx, size, sha256) VALUES (?1, 0, ?2, ?3)').bind(id, size, sha));
    for (const [i, s] of sent.entries()) {
        stmts.push(db.prepare('INSERT INTO replicas (file_id, idx, slot, chat_id, message_id, tg_file_id) VALUES (?1, 0, ?2, ?3, ?4, ?5)')
            .bind(id, SLOTS[i], t[SLOTS[i]], s.result.message_id, docOf(s.result).file_id));
        stmts.push(db.prepare('UPDATE channels SET messages = messages + 1 WHERE chat_id = ?1').bind(t[SLOTS[i]]));
    }
    try {
        await db.batch(stmts);
    } catch (e) {
        for (const [i, s] of sent.entries()) await tg(env, 'deleteMessage', { chat_id: t[SLOTS[i]], message_id: s.result.message_id }).catch(() => {});
        if (/UNIQUE/i.test(String(e?.message))) throw new HttpError(409, 'a file already exists at this path');
        throw e;
    }
    return json({ id, path, size, sha256: sha });
}

// ---- scrub and repair ---------------------------------------------------

// One scheduled run: repair at most one replica, then check the next batch.
// Everything stays under the free plan's 50 outbound calls per run.
async function tick(env, manual = false) {
    const db = env.DB;
    const kv = await kvAll(db);
    if (kv.paused && !manual) return { paused: true };

    const lastBackup = kv.backup?.at || 0;
    if (!manual && Date.now() - lastBackup > BACKUP_EVERY_MS && await db.prepare(`SELECT 1 FROM files WHERE state = 'complete' LIMIT 1`).first()) {
        // a backup makes several calls of its own, so it gets a run to itself
        try {
            return { backup: await backup(env) };
        } catch (e) {
            await db.batch([
                kvSet(db, 'backup', { ...kv.backup, at: Date.now() - BACKUP_EVERY_MS + 3600_000, error: noToken(env, e?.message || e) }),
                event(db, 'backup-failed', noToken(env, e?.message || e)),
            ]);
            return { backup: { error: noToken(env, e?.message || e) } };
        }
    }

    const out = { repair: null, checked: 0, missing: 0, wrapped: false, resting: false };
    try {
        out.repair = await repairOne(env, kv.channel_limit);
    } catch (e) {
        out.repair = { ok: false, why: noToken(env, e?.message || e) };
    }

    const scrub = { cursor: 0, passes: 0, passStartedAt: 0, passDoneAt: 0, checked: 0, ...kv.scrub };
    // Each check makes Telegram fetch a whole chunk, so a finished pass is not repeated straight away.
    const interval = (kv.scrub_interval_min ?? DEFAULT_SCRUB_INTERVAL_MIN) * 60_000;
    out.resting = !manual && scrub.cursor === 0 && Date.now() < scrub.passStartedAt + interval;
    const rows = out.resting ? [] : (await db.prepare(`SELECT r.id, r.file_id, r.idx, r.chat_id, r.message_id, r.tg_file_id, c.size
        FROM replicas r JOIN files f ON f.id = r.file_id AND f.state = 'complete'
        JOIN chunks c ON c.file_id = r.file_id AND c.idx = r.idx
        WHERE r.id > ?1 AND r.state = 'ok' ORDER BY r.id LIMIT ?2`).bind(scrub.cursor, SCRUB_BATCH).all()).results;
    if (scrub.cursor === 0 && rows.length) scrub.passStartedAt = Date.now();

    const started = Date.now();
    const verdicts = await mapLimit(rows, 5, r => Date.now() - started > CHECK_BUDGET_MS
        ? { verdict: 'retry' }
        : checkReplica(env, r).catch(e => ({ verdict: 'ok', unclear: noToken(env, e?.message || e) })));
    const stmts = [];
    const gone = [];
    const unclear = [];
    let done = 0;
    for (; done < rows.length; done++) {
        const v = verdicts[done];
        if (v.verdict === 'retry') break; // rate limited: pick up here next run
        scrub.cursor = rows[done].id;
        if (v.unclear) unclear.push(v.unclear);
        if (v.verdict === 'missing') {
            gone.push(rows[done].id);
            stmts.push(event(db, 'missing', `replica ${rows[done].id} (${rows[done].file_id}:${rows[done].idx}): ${v.why}`));
        }
    }
    if (gone.length) {
        stmts.push(db.prepare(`UPDATE replicas SET state = 'missing', attempts = 0 WHERE state = 'ok' AND id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(gone)));
    }
    // kept as one note, not one event per replica, so a systematic oddity cannot flood the log
    if (unclear.length) scrub.unclear = { at: Date.now(), count: unclear.length, why: unclear[0] };
    const emptyStore = rows.length === 0 && scrub.cursor === 0;
    if (done === rows.length && rows.length < SCRUB_BATCH && !emptyStore) {
        // reached the end of the table: start again from the top
        out.wrapped = true;
        scrub.cursor = 0;
        scrub.passes += 1;
        scrub.passDoneAt = Date.now();
        stmts.push(db.prepare('DELETE FROM events WHERE id <= (SELECT max(id) FROM events) - 500'));
    }
    scrub.checked += done;
    scrub.lastTickAt = Date.now();
    stmts.push(kvSet(db, 'scrub', scrub));
    await db.batch(stmts);

    out.checked = done;
    out.missing = gone.length;
    return out;
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    }));
    return results;
}

// Is this replica still there? One call for the message, one for the stored file.
// Only an explicit "not found" counts as missing. An answer we do not recognise is
// noted (`unclear`) and the stored file is still checked.
async function checkReplica(env, r) {
    let unclear;
    const e = await tg(env, 'editMessageCaption', { chat_id: r.chat_id, message_id: r.message_id, caption: caption(r.file_id, r.idx) });
    if (e.error_code === 429) return { verdict: 'retry' };
    if (!e.ok && !/not modified/i.test(e.description || '')) {
        if (/message to edit not found|message not found|MESSAGE_ID_INVALID|chat not found|bot was kicked|not a member/i.test(e.description || '')) {
            return { verdict: 'missing', why: e.description };
        }
        unclear = `message check: ${e.description}`;
    }
    // getFile makes Telegram fetch the stored file and report its size, which is the check we want
    const g = await tg(env, 'getFile', { file_id: r.tg_file_id });
    if (g.error_code === 429) return { verdict: 'retry' };
    if (!g.ok) {
        // Telegram uses one message for "wrong id" and "temporarily unavailable"; a repair is harmless either way
        if (/wrong file|invalid file|file not found/i.test(g.description || '')) return { verdict: 'missing', why: `getFile: ${g.description}` };
        return { verdict: 'ok', unclear: `getFile: ${g.description}` };
    }
    if (g.result.file_size == null) return { verdict: 'ok', unclear: unclear || 'getFile reported no size' };
    if (g.result.file_size !== r.size) return { verdict: 'missing', why: `stored file is ${g.result.file_size} bytes, expected ${r.size}` };
    return { verdict: 'ok', unclear };
}

// Restore one missing replica by moving the chunk through this Worker.
async function repairOne(env, channelLimit) {
    const db = env.DB;
    const m = await db.prepare(`SELECT r.id, r.file_id, r.idx, r.slot, r.chat_id, r.message_id, c.size, c.sha256
        FROM replicas r JOIN chunks c ON c.file_id = r.file_id AND c.idx = r.idx
        WHERE r.state = 'missing' ORDER BY r.attempts, r.id LIMIT 1`).first();
    if (!m) return null;
    const retryLater = async (why) => {
        await db.batch([db.prepare('UPDATE replicas SET attempts = attempts + 1 WHERE id = ?1').bind(m.id), event(db, 'repair-failed', `replica ${m.id}: ${why}`)]);
        return { id: m.id, ok: false, why };
    };

    // Healthy copies first; a deleted message's file often stays downloadable, so those are tried too.
    const sources = (await db.prepare(`SELECT id, tg_file_id, state FROM replicas WHERE file_id = ?1 AND idx = ?2
        ORDER BY (state = 'ok') DESC, id`).bind(m.file_id, m.idx).all()).results;
    let bytes = null;
    for (const s of sources) {
        const g = await tg(env, 'getFile', { file_id: s.tg_file_id });
        if (!g.ok) continue;
        const res = await fetch(fileUrl(env, g.result.file_path));
        if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        if (buf.byteLength === m.size && hex(await crypto.subtle.digest('SHA-256', buf)) === m.sha256) { bytes = buf; break; }
        if (s.state === 'ok') {
            // an "ok" copy with the wrong content must not be trusted again
            await db.batch([db.prepare(`UPDATE replicas SET state = 'missing' WHERE id = ?1`).bind(s.id), event(db, 'corrupt', `replica ${s.id} failed its hash`)]);
        }
    }
    // Nothing is ever written off: Telegram may be having a bad hour, so the replica stays
    // "missing" and is retried after the ones that have been tried less often.
    if (!bytes) return retryLater('no readable copy right now');

    let target;
    try { target = (await targets(db, channelLimit))[m.slot]; } catch (e) { return retryLater(e.message); }
    const sent = await tgSend(env, target, bytes, `${m.file_id}.${m.idx}`, caption(m.file_id, m.idx));
    if (!sent.ok) return retryLater(`upload: ${sent.description}`);
    await db.batch([
        db.prepare(`UPDATE replicas SET chat_id = ?2, message_id = ?3, tg_file_id = ?4, state = 'ok', attempts = 0 WHERE id = ?1`)
            .bind(m.id, target, sent.result.message_id, docOf(sent.result).file_id),
        db.prepare('UPDATE channels SET messages = messages + 1 WHERE chat_id = ?1').bind(target),
        event(db, 'repaired', `replica ${m.id} (${m.file_id}:${m.idx}) re-uploaded to ${target}`),
    ]);
    // the replaced message may still exist (its file was the problem, or it was only reported); don't leave it behind
    await tg(env, 'deleteMessage', { chat_id: m.chat_id, message_id: m.message_id }).catch(() => {});
    return { id: m.id, ok: true };
}

// ---- index backup -------------------------------------------------------

const TABLES = {
    channels: { cols: ['chat_id', 'slot', 'title', 'active', 'messages'], order: 'chat_id' },
    files: { cols: ['id', 'path', 'size', 'sha256', 'chunk_size', 'chunks', 'state', 'created_at'], order: 'id' },
    chunks: { cols: ['file_id', 'idx', 'size', 'sha256'], order: 'file_id, idx' },
    replicas: { cols: ['id', 'file_id', 'idx', 'slot', 'chat_id', 'message_id', 'tg_file_id', 'state', 'attempts'], order: 'id' },
    keys: { cols: ['id', 'name', 'hash', 'role', 'prefix', 'created_at', 'revoked_at', 'last_used_at'], order: 'id' },
};

// Snapshot the index, upload it to one channel per slot and pin it there,
// so it can be found again with nothing but the bot and the channel.
async function backup(env) {
    const db = env.DB;
    const kv = await kvAll(db);
    const lines = [JSON.stringify({ edgeStoreBackup: 1, at: Date.now() })];
    let rowCount = 0;
    for (const [name, t] of Object.entries(TABLES)) {
        for (let off = 0; ; off += 5000) {
            const rows = (await db.prepare(`SELECT ${t.cols.join(', ')} FROM ${name} ORDER BY ${t.order} LIMIT 5000 OFFSET ?1`).bind(off).all()).results;
            for (const r of rows) lines.push(JSON.stringify({ t: name, r }));
            rowCount += rows.length;
            if (rows.length < 5000) break;
        }
    }
    const gz = await new Response(new Blob([lines.join('\n') + '\n']).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    if (gz.byteLength > MAX_CHUNK) throw new Error('index backup no longer fits in one Telegram message');

    const t = await targets(db, kv.channel_limit);
    const stamp = new Date().toISOString();
    const messages = [];
    const problems = [];
    for (const slot of SLOTS) {
        const sent = await tgSend(env, t[slot], gz, `${BACKUP_TAG}.ndjson.gz`, `${BACKUP_TAG} ${stamp}`);
        if (!sent.ok) { problems.push(`slot ${slot} upload: ${sent.description}`); continue; }
        messages.push({ chat_id: t[slot], message_id: sent.result.message_id });
        const pin = await tg(env, 'pinChatMessage', { chat_id: t[slot], message_id: sent.result.message_id, disable_notification: true });
        if (!pin.ok) problems.push(`slot ${slot} pin: ${pin.description}`);
    }
    if (!messages.length) throw new Error(problems.join('; '));
    for (const old of kv.backup?.messages || []) await tg(env, 'deleteMessage', old);

    const record = { at: Date.now(), bytes: gz.byteLength, rows: rowCount, messages, problems };
    await db.batch([kvSet(db, 'backup', record), event(db, 'backup', `${rowCount} rows, ${gz.byteLength} bytes${problems.length ? '; ' + problems.join('; ') : ''}`)]);
    return record;
}

async function importRows(db, table, rows) {
    const t = TABLES[table];
    if (!t || !Array.isArray(rows)) throw new HttpError(400, 'unknown table or no rows');
    if (!rows.length) return { imported: 0 };
    await db.prepare(`INSERT OR REPLACE INTO ${table} (${t.cols.join(', ')})
        SELECT ${t.cols.map(c => `value->>'${c}'`).join(', ')} FROM json_each(?1)`).bind(JSON.stringify(rows)).run();
    return { imported: rows.length };
}
