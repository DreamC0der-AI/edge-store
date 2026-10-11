// edge-store client library. Everything goes through the Worker's HTTP API with an access key;
// the client never talks to Telegram and never sees the bot token.
import { open, stat, rename, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { dirname } from 'node:path';

export const CHUNK = 16 * 1024 * 1024;
export const BACKUP_TAG = 'edge-store-backup';
const SLOTS = [0, 1];

// The web page stores a small preview of each picture beside it, as <folder>/.thumbs/<the picture's
// file id>.jpg (worker/web/util.js makes them by the same rule). A preview goes when its picture goes.
export const thumbPath = (path, id) => `${path.slice(0, path.lastIndexOf('/') + 1)}.thumbs/${id}.jpg`;
const THUMB = /(?:^|\/)\.thumbs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jpg$/;

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function hashFile(path) {
    return new Promise((resolve, reject) => {
        const h = createHash('sha256');
        createReadStream(path).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
}

export class ApiError extends Error {
    constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

// Runs fn until it succeeds. A rate limit (err.retryAfter) is waited out and does not count
// as a failure; a transient error (err.transient) is retried with backoff up to `tries`.
export async function withRetry(fn, { tries = 6, sleep = defaultSleep, maxWaits = 100 } = {}) {
    let failures = 0;
    let waits = 0;
    for (;;) {
        try {
            return await fn();
        } catch (e) {
            if (e.retryAfter != null && waits++ < maxWaits) {
                await sleep((e.retryAfter + 1) * 1000);
            } else if (e.transient && ++failures < tries) {
                await sleep(Math.min(30_000, 500 * 2 ** failures));
            } else {
                throw e;
            }
        }
    }
}

// Runs fn over items with at most `limit` in flight; stops handing out work after the first failure.
export async function pool(items, limit, fn) {
    let next = 0;
    let failed = false;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length && !failed) {
            const item = items[next++];
            try { await fn(item); } catch (e) { failed = true; throw e; }
        }
    }));
}

export class Store {
    constructor({ url, token, fetch = globalThis.fetch, sleep = defaultSleep, chunkSize = CHUNK }) {
        this.url = String(url).replace(/\/+$/, '');
        this.token = token;
        this.fetch = fetch;
        this.retry = { sleep };
        this.chunkSize = chunkSize;
    }

    // One HTTP call to the Worker, retried when the failure looks temporary. `read` turns the
    // response into a value inside the retry, so a body that is cut off is retried as well.
    // The Worker passes Telegram's rate limits on as 429 with a retryAfter.
    request(method, path, { body, headers = {} } = {}, read = (r) => r) {
        return withRetry(async () => {
            let r;
            try {
                r = await this.fetch(this.url + path, { method, headers: { authorization: `Bearer ${this.token}`, ...headers }, body });
            } catch (e) {
                throw Object.assign(new Error(`cannot reach the store: ${e.message}`), { transient: true });
            }
            if (!r.ok) {
                const data = await r.json().catch(() => ({}));
                throw new ApiError(r.status, data.error || `HTTP ${r.status}`, {
                    retryAfter: r.status === 429 ? (data.retryAfter ?? 5) : undefined,
                    transient: r.status >= 500 && r.status !== 507,
                });
            }
            try {
                return await read(r);
            } catch (e) {
                // the connection dropped part-way through the body
                throw Object.assign(new Error('the response was cut off'), { transient: true });
            }
        }, this.retry);
    }

    api(method, path, body) {
        return this.request(method, path, body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, (r) => r.json());
    }

    // ---- bytes ----------------------------------------------------------

    sendBytes(method, path, buf) {
        return this.request(method, path, { body: buf, headers: { 'content-type': 'application/octet-stream' } }, (r) => r.json());
    }

    // One chunk from whichever replica the Worker picks, or from a given slot.
    downloadChunk(fileId, idx, slot = null) {
        return this.request('GET', `/files/${fileId}/chunks/${idx}${slot === null ? '' : `?slot=${slot}`}`, {}, async (r) => ({
            buf: Buffer.from(await r.arrayBuffer()),
            replica: Number(r.headers.get('x-replica')),
            slot: Number(r.headers.get('x-slot')),
        }));
    }

    // ---- files ----------------------------------------------------------

    async put(local, remote, { onProgress = () => {}, concurrency = 2 } = {}) {
        const st = await stat(local);
        if (!st.isFile()) throw new Error(`${local} is not a file`);
        const size = st.size;
        const chunkSize = this.chunkSize;
        const chunks = Math.ceil(size / chunkSize);
        const begin = await this.api('POST', '/files', { path: remote, size, chunkSize, chunks });
        const have = new Map(begin.have.map(h => [h.idx, h]));

        const whole = createHash('sha256');
        const fh = await open(local, 'r');
        const inflight = new Set();
        let firstError = null;
        try {
            for (let idx = 0; idx < chunks && !firstError; idx++) {
                const len = Math.min(chunkSize, size - idx * chunkSize);
                const buf = Buffer.allocUnsafe(len);
                const { bytesRead } = await fh.read(buf, 0, len, idx * chunkSize);
                if (bytesRead !== len) throw new Error(`${local} changed while it was being uploaded`);
                whole.update(buf);
                const hash = sha256(buf);
                // an earlier, interrupted run may already have stored this chunk in both slots
                const h = have.get(idx);
                if (h?.sha256 === hash && SLOTS.every(s => h.slots.includes(s))) {
                    onProgress({ idx, chunks, bytes: len, skipped: true });
                    continue;
                }
                const task = this.sendBytes('PUT', `/files/${begin.id}/chunks/${idx}?sha256=${hash}`, buf)
                    .then(() => onProgress({ idx, chunks, bytes: len, skipped: false }))
                    .catch(e => { firstError ??= e; })
                    .finally(() => inflight.delete(task));
                inflight.add(task);
                if (inflight.size >= concurrency) await Promise.race(inflight);
            }
            await Promise.all(inflight);
        } finally {
            await fh.close();
        }
        if (firstError) throw firstError;
        const done = await this.api('POST', `/files/${begin.id}/commit`, { sha256: whole.digest('hex') });
        return { ...done, size, chunks, resumed: begin.resumed };
    }

    manifest(remote) {
        return this.api('GET', `/file?path=${encodeURIComponent(remote)}`);
    }

    async get(remote, local, { onProgress = () => {}, concurrency = 3 } = {}) {
        const file = await this.manifest(remote);
        await mkdir(dirname(local), { recursive: true });
        const part = `${local}.part`;
        const fh = await open(part, 'w');
        try {
            await pool(file.chunkList, concurrency, async (c) => {
                const buf = await this.fetchChunk(file.id, c);
                await fh.write(buf, 0, buf.length, c.idx * file.chunk_size);
                onProgress({ idx: c.idx, chunks: file.chunks, bytes: buf.length });
            });
        } finally {
            await fh.close();
        }
        if ((await stat(part)).size !== file.size || await hashFile(part) !== file.sha256) {
            throw new Error(`${remote}: downloaded file does not match its recorded hash`);
        }
        await rename(part, local);
        return file;
    }

    // Reads one chunk and checks its hash. If the copy the Worker chose is wrong, the other
    // slots are tried one by one and the bad replica is reported so that it gets repaired.
    async fetchChunk(fileId, c) {
        let last;
        const tried = new Set();
        for (const slot of [null, ...SLOTS]) {
            if (tried.has(slot)) continue;
            let got;
            try {
                got = await this.downloadChunk(fileId, c.idx, slot);
            } catch (e) {
                last = e;
                if (slot === null && e.status === 404) break; // the Worker already tried every replica
                continue;
            }
            tried.add(got.slot);
            if (got.buf.length === c.size && sha256(got.buf) === c.sha256) return got.buf;
            last = new Error(`replica ${got.replica} does not match its hash`);
            await this.report(got.replica, 'content does not match its hash');
        }
        throw new Error(`chunk ${c.idx}: no readable replica (${last?.message})`);
    }

    report(replicaId, why) {
        return this.api('POST', `/replicas/${replicaId}`, { state: 'missing', why }).catch(() => {});
    }

    async ls(prefix = '', { all = false } = {}) {
        const files = [];
        let after = '';
        do {
            const page = await this.api('GET', `/files?prefix=${encodeURIComponent(prefix)}&after=${encodeURIComponent(after)}${all ? '&all=1' : ''}`);
            files.push(...page.files);
            after = page.next;
        } while (after);
        return files;
    }

    // Removes a file's index entry and its Telegram messages. Works on unfinished uploads too.
    async rmById(id) {
        while (!(await this.api('DELETE', `/files/${id}`)).done);
    }

    async rm(remote) {
        const file = await this.manifest(remote);
        await this.rmById(file.id);
        let messages = file.chunkList.reduce((n, c) => n + c.replicas.length, 0);
        // a picture saved through the web page has a preview stored beside it
        const thumb = await this.manifest(thumbPath(remote, file.id)).catch((e) => { if (e.status === 404) return null; throw e; });
        if (thumb) {
            await this.rmById(thumb.id);
            messages += thumb.chunkList.reduce((n, c) => n + c.replicas.length, 0);
        }
        return { id: file.id, messages };
    }

    // Removes uploads that were started but never finished, and previews whose picture is gone.
    async clean(olderThanMs = 24 * 3600 * 1000) {
        const all = await this.ls('', { all: true });
        const kept = new Set(all.filter(f => f.state === 'complete').map(f => f.id));
        const stale = all.filter(f => f.state === 'uploading'
            ? Date.now() - f.created_at >= olderThanMs
            : THUMB.test(f.path) && !kept.has(f.path.match(THUMB)[1]));
        for (const f of stale) await this.rmById(f.id);
        return stale.map(f => f.path);
    }

    whoami() {
        return this.api('GET', '/whoami');
    }

    // ---- administration -------------------------------------------------

    status() {
        return this.api('GET', '/status');
    }

    keyAdd(name, { role = 'write', prefix = '' } = {}) {
        return this.api('POST', '/keys', { name, role, prefix });
    }

    async keyList() {
        return (await this.api('GET', '/keys')).keys;
    }

    keyRevoke(id) {
        return this.api('DELETE', `/keys/${encodeURIComponent(id)}`);
    }

    // A Bot API call made by the Worker on the caller's behalf (a short allow-list, admin only).
    async telegram(method, params) {
        const r = await this.api('POST', `/telegram/${method}`, params);
        if (!r.ok) throw Object.assign(new Error(`Telegram ${method}: ${r.description}`), { code: r.error_code });
        return r.result;
    }

    // Downloads every replica and checks its hash. Slow, but the only full proof.
    async verify(prefix = '', { onProgress = () => {} } = {}) {
        const bad = [];
        let replicas = 0;
        const files = await this.ls(prefix);
        for (const f of files) {
            const m = await this.api('GET', `/files/${f.id}`);
            await pool(m.chunkList.flatMap(c => c.replicas.map(r => ({ c, r }))), 3, async ({ c, r }) => {
                replicas++;
                let problem = null;
                try {
                    const got = await this.downloadChunk(f.id, c.idx, r.slot);
                    if (got.buf.length !== c.size || sha256(got.buf) !== c.sha256) problem = 'content does not match its hash';
                } catch (e) {
                    if (e.status !== 404) throw e;
                    problem = e.message;
                }
                if (problem) {
                    bad.push({ path: f.path, idx: c.idx, slot: r.slot, replica: r.id, problem });
                    if (r.state === 'ok') await this.report(r.id, problem);
                }
                onProgress({ path: f.path, idx: c.idx, slot: r.slot, ok: !problem });
            });
        }
        return { files: files.length, replicas, bad };
    }

    // Re-uploads every replica the index lists as missing, from any copy that still reads correctly.
    async repair({ onProgress = () => {} } = {}) {
        const { replicas } = await this.api('GET', '/replicas');
        const out = { repaired: 0, failed: [] };
        for (const m of replicas) {
            try {
                const buf = await this.fetchChunk(m.file_id, m);
                await this.sendBytes('PUT', `/replicas/${m.id}`, buf);
                out.repaired++;
                onProgress({ replica: m.id, path: m.path, idx: m.idx, ok: true });
            } catch (e) {
                out.failed.push({ replica: m.id, path: m.path, idx: m.idx, why: e.message });
                onProgress({ replica: m.id, path: m.path, idx: m.idx, ok: false, why: e.message });
            }
        }
        return out;
    }

    backup() {
        return this.api('POST', '/backup');
    }

    // Rebuilds the index from the newest backup pinned in any of the given channels.
    async restore(chatIds) {
        const gz = await this.request('POST', '/backup/latest', { body: JSON.stringify({ chats: chatIds }), headers: { 'content-type': 'application/json' } },
            async (r) => Buffer.from(await r.arrayBuffer()));
        const lines = gunzipSync(gz).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
        const header = lines.shift();
        if (header.edgeStoreBackup !== 1) throw new Error('unrecognised backup format');
        const counts = {};
        for (const table of ['channels', 'files', 'chunks', 'replicas', 'keys']) {
            const rows = lines.filter(l => l.t === table).map(l => l.r);
            for (let i = 0; i < rows.length; i += 400) await this.api('POST', '/import', { table, rows: rows.slice(i, i + 400) });
            counts[table] = rows.length;
        }
        return { takenAt: header.at, counts };
    }
}
