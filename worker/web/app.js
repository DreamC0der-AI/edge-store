// The edge-store web page: drop files in, come back later to see, download or delete them.
// It is an ordinary client of the Worker's HTTP API and holds nothing but an access key.
import { CHUNK, Sha256, hex, walkEntries, isClutter, folderView, homeOf, dirToHash, hashToDir, fmtSize, withRetry, pool,
    kindOf, thumbPath, splitThumbs, rawUrl, fitWithin } from './util.js';

const SLOTS = [0, 1];
const RANK = { read: 1, write: 2, admin: 3 };
const KEY_SLOT = 'edge-store-key';
const UPLOADS_AT_ONCE = 2;
const CHUNKS_AT_ONCE = 2;
const HASH_STEP = 4 * 1024 * 1024;
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const THUMB_PX = 256;            // a stored preview fits in a square this size
const THUMB_SOURCE_MAX = 100 * MB; // larger pictures are not decoded just to make a preview
// A download larger than streamAbove is written straight to a file the user picks, where the
// browser can do that (Chrome, Edge); otherwise it is held in memory until it is complete.
// A file larger than previewMax is not shown in the page, and a text file is shown up to textMax.
const settings = window.edgeStore = { streamAbove: 256 * MB, previewMax: 256 * MB, textMax: 256 * 1024 };

let key = null;
let me = null;          // { name, role, prefix }
let files = [];         // every file this key can see, stored previews aside
let thumbIndex = new Map(); // picture id -> its stored preview file
let shown = [];         // the files in the list right now, in order
let viewing = null;     // the file open in the viewer
// stands in for a transfer when something is fetched in the background; signing out cuts it short
let bg = { ctrl: new AbortController() };
let dir = '';           // the folder on show, '' or ending in '/'
let loaded = false;
const transfers = [];

const $ = (id) => document.getElementById(id);
function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.className = v;
        else el.setAttribute(k, v);
    }
    el.append(...children);
    return el;
}
const canWrite = () => RANK[me?.role] >= RANK.write;
const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const count = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
// lets the page repaint and respond between slices of a long calculation; unlike a timer,
// this is not slowed down while the tab is in the background
const breathe = () => new Promise((res) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => { c.port1.close(); res(); };
    c.port2.postMessage(0);
});
const pause = (ms, signal) => new Promise((res, rej) => {
    if (signal?.aborted) return rej(signal.reason);
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true });
});

// ---- the key ----------------------------------------------------------------

const storage = {
    get() { try { return localStorage.getItem(KEY_SLOT); } catch { return null; } },
    set(v) { try { localStorage.setItem(KEY_SLOT, v); } catch { /* private window: signed in until the tab closes */ } },
    clear() { try { localStorage.removeItem(KEY_SLOT); } catch { /* nothing was kept */ } },
};

function signOut(message = '') {
    storage.clear();
    key = null;
    me = null;
    files = [];
    loaded = false;
    for (const t of transfers) t.ctrl.abort();
    transfers.length = 0;
    bg.ctrl.abort();
    bg = { ctrl: new AbortController() };
    if ($('viewer').open) $('viewer').close();
    forgetPreviews();
    $('transfer-list').replaceChildren();
    $('transfers').hidden = true;
    $('app').hidden = true;
    $('signin').hidden = false;
    $('signin-error').textContent = message;
    $('signin-error').hidden = !message;
    $('key-input').value = '';
    $('key-input').focus();
}

// ---- talking to the Worker --------------------------------------------------

class ApiError extends Error {
    constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}
const failure = (status, data) => new ApiError(status, data?.error || `HTTP ${status}`, {
    retryAfter: status === 429 ? (data?.retryAfter ?? 5) : undefined,
    transient: status >= 500 && status !== 507,
});
const unreachable = () => Object.assign(new Error('cannot reach the store; check the connection'), { transient: true });
const refused = () => {
    signOut('That key was not accepted. It may be mistyped or revoked.');
    return new ApiError(401, 'signed out');
};
const retryOptions = (t) => ({
    sleep: (ms) => pause(ms, t?.ctrl.signal),
    onRetry: (e) => { if (t) { t.waiting = e.message; paint(t); } },
});

// One call to the Worker, retried when the failure looks temporary. `read` turns the response
// into a value inside the retry, so a body that is cut off is retried as well.
function request(method, path, { body, headers = {}, t } = {}, read = (r) => r) {
    const signal = t?.ctrl.signal;
    return withRetry(async () => {
        let r;
        try {
            r = await fetch(path, { method, headers: { authorization: `Bearer ${key}`, ...headers }, body, signal });
        } catch (e) {
            if (signal?.aborted) throw signal.reason;
            throw unreachable();
        }
        if (r.status === 401) throw refused();
        if (!r.ok) throw failure(r.status, await r.json().catch(() => ({})));
        try {
            const value = await read(r);
            if (t?.waiting) { t.waiting = null; paint(t); }
            return value;
        } catch (e) {
            if (signal?.aborted) throw signal.reason;
            throw Object.assign(new Error('the response was cut off'), { transient: true });
        }
    }, retryOptions(t));
}

const api = (method, path, body, t) =>
    request(method, path, body === undefined ? { t } : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, t }, (r) => r.json());

// Sends one chunk. XMLHttpRequest is used because it reports how much has been sent.
// A cancelled transfer only cuts a request whose body is still on its way: once the Worker has
// the whole chunk it may already be stored, and its answer is waited for so nothing is left behind.
function sendChunk(path, buf, t, onSent) {
    const signal = t.ctrl.signal;
    return withRetry(() => new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const x = new XMLHttpRequest();
        let bodySent = false;
        const onAbort = () => { if (!bodySent) x.abort(); };
        const settle = (fn, v) => { signal.removeEventListener('abort', onAbort); fn(v); };
        x.open('PUT', path);
        x.responseType = 'json';
        x.setRequestHeader('authorization', `Bearer ${key}`);
        x.setRequestHeader('content-type', 'application/octet-stream');
        x.upload.onprogress = (e) => onSent(e.loaded);
        x.upload.onload = () => { bodySent = true; };
        x.onload = () => {
            if (x.status === 401) return settle(reject, refused());
            if (x.status < 200 || x.status >= 300) return settle(reject, failure(x.status, x.response));
            if (t.waiting) { t.waiting = null; paint(t); }
            settle(resolve, x.response);
        };
        x.onerror = x.ontimeout = () => settle(reject, unreachable());
        x.onabort = () => settle(reject, signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        x.send(buf);
    }), retryOptions(t));
}

// ---- uploading --------------------------------------------------------------

async function runUpload(t) {
    const { file } = t;
    const signal = t.ctrl.signal;
    const size = file.size;
    const chunks = Math.ceil(size / CHUNK);
    const begin = await api('POST', '/files', { path: t.path, size, chunkSize: CHUNK, chunks }, t);
    t.fileId = begin.id;
    const have = new Map(begin.have.map(x => [x.idx, x]));

    const whole = new Sha256();
    const sent = new Array(chunks).fill(0);
    const show = () => { t.done = sent.reduce((a, b) => a + b, 0); paint(t); };
    const inflight = new Set();
    let firstError = null;
    for (let idx = 0; idx < chunks && !firstError; idx++) {
        signal.throwIfAborted();
        const start = idx * CHUNK;
        const len = Math.min(CHUNK, size - start);
        let buf;
        try {
            buf = new Uint8Array(await file.slice(start, start + len).arrayBuffer());
        } catch {
            throw new Error('the file could not be read; it may have been moved or changed');
        }
        if (buf.length !== len) throw new Error('the file changed while it was being uploaded');
        for (let o = 0; o < len; o += HASH_STEP) {
            whole.update(buf.subarray(o, o + HASH_STEP));
            await breathe();
        }
        const hash = hex(await crypto.subtle.digest('SHA-256', buf));
        // an earlier, interrupted upload may already have stored this chunk in both slots
        const got = have.get(idx);
        if (got?.sha256 === hash && SLOTS.every(s => got.slots.includes(s))) {
            t.resumed = true;
            sent[idx] = len;
            show();
            continue;
        }
        const task = sendChunk(`/files/${begin.id}/chunks/${idx}?sha256=${hash}`, buf, t, (n) => { sent[idx] = Math.min(n, len); show(); })
            .then(() => { sent[idx] = len; show(); })
            .catch((e) => { firstError ??= e; })
            .finally(() => inflight.delete(task));
        inflight.add(task);
        if (inflight.size >= CHUNKS_AT_ONCE) await Promise.race(inflight);
    }
    await Promise.all(inflight);
    if (firstError) throw firstError;
    signal.throwIfAborted();
    // not tied to the cancel button: a commit that was cut short could have gone through anyway
    t.committing = true;
    paint(t);
    await api('POST', `/files/${begin.id}/commit`, { sha256: whole.hex() });
    files = files.filter(f => f.path !== t.path).concat({ id: begin.id, path: t.path, size, chunks, state: 'complete', created_at: Date.now() });
    renderFiles();
    // the picture is still at hand here, so its preview costs no download
    if (kindOf(t.path).kind === 'image' && size <= THUMB_SOURCE_MAX) await saveThumb({ id: begin.id, path: t.path }, file);
}

// Removes a file and its stored copies; the Worker does it in batches and says when it is done.
async function removeById(id) {
    while (!(await api('DELETE', `/files/${id}`)).done);
}

function enqueue(list) {
    const fresh = [];
    for (const { file, rel } of list) {
        if (isClutter(rel)) continue;
        const path = dir + rel;
        const t = addTransfer({ kind: 'up', name: path, path, file, total: file.size });
        const twin = files.find(f => f.path === path);
        const busy = transfers.some(o => o !== t && o.kind === 'up' && o.path === path && (o.state === 'queued' || o.state === 'active'));
        if (path.length > 1024) finish(t, 'error', 'The name is too long (1,024 characters at most).');
        else if (busy) finish(t, 'error', 'This file is already being uploaded.');
        else if (twin) finish(t, 'error', twin.size === file.size
            ? 'Already stored here (a file with this name and size exists).'
            : 'A different file with this name is already here. Delete it first, or rename yours.');
        else fresh.push(t);
    }
    if (fresh.length) pump();
}

function pump() {
    while (transfers.filter(t => t.kind === 'up' && t.state === 'active').length < UPLOADS_AT_ONCE) {
        const t = transfers.find(x => x.kind === 'up' && x.state === 'queued');
        if (!t) break;
        run(t, runUpload);
    }
}

// ---- downloading ------------------------------------------------------------

// Reads one chunk and checks its hash. If the copy the Worker chose is wrong, the other
// slots are tried one by one and the bad copy is reported so that it gets repaired.
async function fetchChunk(fileId, c, t, onBytes) {
    let last;
    const tried = new Set();
    for (const slot of [null, ...SLOTS]) {
        if (tried.has(slot)) continue;
        let got;
        try {
            got = await request('GET', `/files/${fileId}/chunks/${c.idx}${slot === null ? '' : `?slot=${slot}`}`, { t }, async (r) => {
                const out = new Uint8Array(c.size);
                const reader = r.body.getReader();
                let n = 0;
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (n + value.length <= out.length) out.set(value, n);
                    n += value.length;
                    onBytes(Math.min(n, c.size));
                }
                return { bytes: out, length: n, replica: Number(r.headers.get('x-replica')), slot: Number(r.headers.get('x-slot')) };
            });
        } catch (e) {
            if (t.ctrl.signal.aborted || e.status === 401) throw e;
            last = e;
            if (slot === null && e.status === 404) break; // the Worker already tried every copy
            continue;
        }
        tried.add(got.slot);
        if (got.length === c.size && hex(await crypto.subtle.digest('SHA-256', got.bytes)) === c.sha256) return got.bytes;
        last = new Error(`copy ${got.slot + 1} does not match its hash`);
        if (canWrite()) api('POST', `/replicas/${got.replica}`, { state: 'missing', why: 'content does not match its hash' }).catch(() => {});
    }
    throw new Error(`part ${c.idx + 1} could not be read from either copy (${last?.message})`);
}

async function runDownload(t) {
    const m = await api('GET', `/files/${t.fileId}`, undefined, t);
    if (m.chunkList.length !== m.chunks) throw new Error('the index lists fewer parts than the file has');
    t.total = m.size;
    const got = new Array(m.chunks).fill(0);
    const show = () => { t.done = got.reduce((a, b) => a + b, 0); paint(t); };

    let sink;
    if (t.handle) {
        const w = await t.handle.createWritable();
        sink = {
            write: (c, bytes) => w.write({ type: 'write', position: c.idx * m.chunk_size, data: bytes }),
            close: () => w.close(),
            abort: () => w.abort().catch(() => {}),
        };
    } else {
        const parts = new Array(m.chunks);
        sink = {
            write: (c, bytes) => { parts[c.idx] = new Blob([bytes]); },
            close: () => saveBlob(new Blob(parts, { type: 'application/octet-stream' }), t.name.split('/').pop()),
            abort: () => {},
        };
    }
    try {
        await pool(m.chunkList, 3, async (c) => {
            const bytes = await fetchChunk(m.id, c, t, (n) => { got[c.idx] = n; show(); });
            await sink.write(c, bytes);
            got[c.idx] = c.size;
            show();
        });
        t.ctrl.signal.throwIfAborted();
        await sink.close();
    } catch (e) {
        await sink.abort();
        throw e;
    }
}

function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function startDownload(f) {
    let handle = null;
    if (f.size > settings.streamAbove && window.showSaveFilePicker) {
        try {
            handle = await window.showSaveFilePicker({ suggestedName: f.name });
        } catch (e) {
            if (e.name === 'AbortError') return; // the user closed the dialog
        }
    }
    const t = addTransfer({ kind: 'down', name: f.path, fileId: f.id, total: f.size, handle });
    t.inMemory = !handle && f.size > GB;
    run(t, runDownload);
}

// ---- the transfer list ------------------------------------------------------

function addTransfer(t) {
    Object.assign(t, { state: 'queued', done: 0, message: '', waiting: null, ctrl: new AbortController() });
    const name = h('div', { class: 't-name' }, `${t.kind === 'up' ? '↑' : '↓'} ${t.name}`);
    const status = h('div', { class: 't-status' });
    const button = h('button', { type: 'button', class: 'quiet', onclick: () => act(t) });
    const bar = h('progress', { max: '1', value: '0' });
    t.els = { li: h('li', { 'data-state': t.state }, name, status, button, bar), status, button, bar };
    transfers.push(t);
    $('transfer-list').append(t.els.li);
    $('transfers').hidden = false;
    paint(t);
    return t;
}

function paint(t) {
    if (!t.els) return t.onPaint?.(); // not a row in the transfer list
    const { li, status, button, bar } = t.els;
    const active = t.state === 'queued' || t.state === 'active';
    li.dataset.state = t.state;
    bar.hidden = t.state !== 'active';
    bar.value = t.total ? t.done / t.total : 0;
    status.className = `t-status${t.state === 'error' ? ' error' : t.state === 'done' ? ' done' : ''}`;
    button.textContent = active ? 'Cancel' : t.state === 'error' && t.retry ? 'Retry' : 'Dismiss';
    button.disabled = t.cancelling === true;
    if (t.state === 'queued') status.textContent = 'Waiting';
    else if (t.state !== 'active') status.textContent = t.message;
    else if (t.cancelling) status.textContent = 'Cancelling…';
    else if (t.waiting) status.textContent = `Waiting to try again: ${t.waiting}`;
    else if (t.committing) status.textContent = 'Finishing…';
    else {
        const verb = t.kind === 'up' ? 'Uploading' : 'Downloading';
        status.textContent = `${verb} · ${fmtSize(t.done)} of ${fmtSize(t.total)}${t.inMemory ? ' · held in memory until complete; a file this large may not fit in this browser' : ''}`;
    }
}

function finish(t, state, message, retry = null) {
    Object.assign(t, { state, message, retry, waiting: null, cancelling: false, committing: false });
    paint(t);
}

async function run(t, job) {
    t.state = 'active';
    paint(t);
    try {
        await job(t);
        finish(t, 'done', t.kind === 'up'
            ? `Saved, two copies${t.resumed ? ' (picked up an earlier, unfinished upload)' : ''}`
            : 'Downloaded and checked');
    } catch (e) {
        if (!key) return; // signed out meanwhile
        if (t.ctrl.signal.aborted) {
            // a cancelled upload is taken back out of the store; a failed one is kept so that it can resume
            if (t.kind === 'up' && t.fileId) await removeById(t.fileId).catch(() => {});
            finish(t, 'cancelled', 'Cancelled');
        } else if (t.kind === 'up' && e.status === 409 && /already exists/.test(e.message)) {
            finish(t, 'error', 'A file with this name is already stored here.');
        } else {
            finish(t, 'error', `Failed: ${e.message}`, () => {
                t.ctrl = new AbortController();
                Object.assign(t, { state: 'queued', done: 0, message: '', retry: null });
                paint(t);
                if (t.kind === 'up') pump(); else run(t, job);
            });
        }
    }
    if (t.kind === 'up') {
        pump();
        // once the queue has drained, show what the index really holds
        if (key && !transfers.some(x => x.kind === 'up' && (x.state === 'queued' || x.state === 'active'))) loadFiles();
    }
}

function act(t) {
    if (t.state === 'queued') {
        finish(t, 'cancelled', 'Cancelled');
    } else if (t.state === 'active') {
        t.cancelling = true;
        t.ctrl.abort();
        paint(t);
    } else if (t.retry) {
        t.retry();
    } else {
        dismiss(t);
    }
}

function dismiss(t) {
    transfers.splice(transfers.indexOf(t), 1);
    t.els.li.remove();
    $('transfers').hidden = transfers.length === 0;
}

// ---- the file list ----------------------------------------------------------

async function loadFiles() {
    const all = [];
    let after = '';
    try {
        do {
            const page = await api('GET', `/files?prefix=${encodeURIComponent(me.prefix)}&after=${encodeURIComponent(after)}`);
            all.push(...page.files);
            after = page.next;
        } while (after);
    } catch (e) {
        if (key) showEmpty(`The list could not be loaded: ${e.message}`);
        return;
    }
    ({ files, thumbs: thumbIndex } = splitThumbs(all));
    loaded = true;
    renderFiles();
    loadHealth();
    thumbStore.keep(new Set(files.map(f => f.id)));
}

function showEmpty(text) {
    $('empty').textContent = text;
    $('empty').hidden = !text;
}

function renderFiles() {
    if (!me) return;
    const crumbs = [h('a', { href: dirToHash('') }, 'All files')];
    const parts = dir.split('/').filter(Boolean);
    parts.forEach((name, i) => {
        crumbs.push(h('span', { class: 'sep' }, '/'), h('a', { href: dirToHash(parts.slice(0, i + 1).join('/') + '/') }, name));
    });
    $('crumbs').replaceChildren(...crumbs);
    $('drop-target').textContent = dir || 'All files';

    const needle = $('filter').value.trim().toLowerCase();
    let view;
    if (needle) {
        // a search looks through everything below the folder on show
        const hits = files.filter(f => f.path.startsWith(dir) && f.path.slice(dir.length).toLowerCase().includes(needle))
            .map(f => ({ ...f, name: f.path.slice(dir.length) }));
        view = { folders: [], files: hits };
    } else {
        view = folderView(files, dir);
    }

    shown = view.files;
    inView.disconnect();
    const rows = [];
    for (const d of view.folders) {
        rows.push(h('li', {},
            h('a', { class: 'tile folder', href: dirToHash(d.path), tabindex: '-1', 'aria-hidden': 'true' }, '\u{1F4C1}'),
            h('div', { class: 'f-main' },
                h('a', { class: 'f-name', href: dirToHash(d.path) }, d.name),
                h('div', { class: 'f-meta' }, `${count(d.count, 'file')} · ${fmtSize(d.size)}`))));
    }
    for (const f of view.files) {
        const actions = [h('button', { type: 'button', onclick: () => startDownload(f) }, 'Download')];
        if (canWrite()) {
            const del = h('button', { type: 'button', class: 'danger', onclick: () => confirmDelete(f, del) }, 'Delete');
            actions.push(del);
        }
        const name = kindOf(f.name).kind
            ? h('button', { type: 'button', class: 'f-name', onclick: () => showFile(f) }, f.name)
            : h('div', { class: 'f-name' }, f.name);
        rows.push(h('li', { 'data-path': f.path },
            tile(f),
            h('div', { class: 'f-main' },
                name,
                h('div', { class: 'f-meta' }, `${fmtSize(f.size)} · saved ${when(f.created_at)}`)),
            ...actions));
    }
    $('file-list').replaceChildren(...rows);
    $('file-list').hidden = rows.length === 0;

    const here = view.files.reduce((n, f) => n + f.size, 0);
    const total = files.reduce((n, f) => n + f.size, 0);
    if (!loaded) showEmpty('Loading…');
    else if (rows.length) showEmpty('');
    else if (needle) showEmpty('Nothing here matches that.');
    else if (dir && dir !== homeOf(me.prefix)) showEmpty('This folder is empty.');
    else showEmpty(canWrite() ? 'Nothing stored yet. Drop a file above to save it.' : 'Nothing stored yet.');
    $('summary').textContent = !loaded ? '' : needle
        ? `${count(view.files.length, 'match', 'matches')} · ${fmtSize(here)}`
        : `${count(view.files.length, 'file')} here · ${fmtSize(here)}   —   ${count(files.length, 'file')} in total · ${fmtSize(total)}`;
}

// The first click arms the button, the second one within a few seconds deletes.
function confirmDelete(f, button) {
    if (!button.classList.contains('armed')) {
        button.classList.add('armed');
        button.textContent = 'Really delete?';
        button.disarm = setTimeout(() => { button.classList.remove('armed'); button.textContent = 'Delete'; }, 4000);
        return;
    }
    clearTimeout(button.disarm);
    button.disabled = true;
    button.textContent = 'Deleting…';
    removeById(f.id).then(async () => {
        files = files.filter(x => x.id !== f.id);
        renderFiles();
        // a picture's stored preview goes with it
        const stored = thumbIndex.get(f.id);
        thumbIndex.delete(f.id);
        dropThumb(f.id);
        if (stored) await removeById(stored.id).catch(() => {});
    }, (e) => {
        if (!key) return;
        button.disabled = false;
        button.classList.remove('armed');
        button.textContent = 'Delete';
        showEmpty(`Could not delete ${f.name}: ${e.message}`);
    });
}

// ---- previews ---------------------------------------------------------------
//
// A picture's preview is a small JPEG stored beside it (see thumbPath). It is made in the browser
// from the picture itself: when the picture is uploaded here, or the first time it is opened in the
// viewer. The list never downloads a whole picture just to show a preview of it.

// Previews already fetched are kept in this browser, so each is downloaded once; signing out empties it.
const thumbStore = (() => {
    let opening;
    const open = () => opening ??= new Promise((res, rej) => {
        const r = indexedDB.open('edge-store', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('thumbs');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
    // where the browser offers no storage (some private windows) every call quietly does nothing
    const run = async (mode, fn) => {
        try {
            const db = await open();
            return await new Promise((res, rej) => {
                const q = fn(db.transaction('thumbs', mode).objectStore('thumbs'));
                q.onsuccess = () => res(q.result);
                q.onerror = () => rej(q.error);
            });
        } catch {
            return undefined;
        }
    };
    return {
        // kept as plain bytes: Safari refuses to keep Blobs here in a private window
        async get(id) {
            const bytes = await run('readonly', s => s.get(id));
            return bytes ? new Blob([bytes], { type: 'image/jpeg' }) : undefined;
        },
        async put(id, blob) {
            const bytes = await blob.arrayBuffer();
            return run('readwrite', s => s.put(bytes, id));
        },
        del: (id) => run('readwrite', s => s.delete(id)),
        clear: () => run('readwrite', s => s.clear()),
        // forgets previews of pictures that are no longer in the store
        async keep(ids) {
            for (const id of await run('readonly', s => s.getAllKeys()) || []) if (!ids.has(id)) await this.del(id);
        },
    };
})();

const thumbs = new Map();   // picture id -> address of its preview, or null when there is none to be had
const wanted = [];          // previews waiting to be fetched
const asked = new Set();    // previews being looked for, so a redrawn list does not ask twice
let fetching = 0;
const inView = new IntersectionObserver((entries) => {
    for (const e of entries) {
        if (!e.isIntersecting) continue;
        inView.unobserve(e.target);
        wantThumb(e.target.dataset.id);
    }
}, { rootMargin: '300px' });

// The square at the start of a row: the preview if there is one, otherwise the kind of file.
function tile(f) {
    const { kind, ext } = kindOf(f.name);
    const el = kind
        ? h('button', { type: 'button', class: 'tile', 'aria-label': `Show ${f.name}`, 'data-id': f.id, onclick: () => showFile(f) })
        : h('div', { class: 'tile', 'data-id': f.id });
    if (thumbs.get(f.id)) {
        el.append(h('img', { src: thumbs.get(f.id), alt: '' }));
    } else {
        el.textContent = (ext || 'file').slice(0, 4);
        if (kind === 'image' && !thumbs.has(f.id)) inView.observe(el);
    }
    return el;
}

function showThumb(id, blob) {
    if (thumbs.get(id)) return;
    const url = URL.createObjectURL(blob);
    thumbs.set(id, url);
    for (const el of document.querySelectorAll(`.tile[data-id="${id}"]`)) el.replaceChildren(h('img', { src: url, alt: '' }));
}

function dropThumb(id) {
    if (thumbs.get(id)) URL.revokeObjectURL(thumbs.get(id));
    thumbs.delete(id);
    thumbStore.del(id);
}

function forgetPreviews() {
    for (const url of thumbs.values()) if (url) URL.revokeObjectURL(url);
    thumbs.clear();
    thumbIndex = new Map();
    wanted.length = 0;
    asked.clear();
    shown = [];
    blobs.clear();
    blobBytes = 0;
    thumbStore.clear();
}

async function wantThumb(id) {
    if (asked.has(id) || thumbs.has(id)) return;
    asked.add(id);
    const signedInAs = key;
    const kept = await thumbStore.get(id);
    if (key !== signedInAs) return;
    if (kept || thumbs.has(id) || !thumbIndex.has(id)) {
        // found in this browser, made meanwhile, or never stored for this picture
        asked.delete(id);
        if (kept) showThumb(id, kept);
        return;
    }
    wanted.push(id);
    fetchThumbs();
}

function fetchThumbs() {
    while (fetching < 4 && wanted.length) {
        const id = wanted.shift();
        const stored = thumbIndex.get(id);
        if (!stored || thumbs.has(id)) { asked.delete(id); continue; }
        fetching++;
        request('GET', rawUrl(stored.path), { t: bg }, (r) => r.blob()).then((raw) => {
            const blob = new Blob([raw], { type: 'image/jpeg' });
            thumbStore.put(id, blob);
            showThumb(id, blob);
        }, () => {
            if (key) thumbs.set(id, null); // not asked for again until the page is reloaded
        }).finally(() => { asked.delete(id); fetching--; fetchThumbs(); });
    }
}

// A picture drawn small, as a JPEG; null if this browser cannot read the picture.
async function shrink(source) {
    const url = URL.createObjectURL(source);
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        if (!img.naturalWidth || !img.naturalHeight) return null;
        const { w, h: height } = fitWithin(img.naturalWidth, img.naturalHeight, THUMB_PX);
        const canvas = h('canvas', { width: w, height });
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; // JPEG has no transparency
        ctx.fillRect(0, 0, w, height);
        ctx.drawImage(img, 0, 0, w, height);
        return await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.8));
    } catch {
        return null;
    } finally {
        URL.revokeObjectURL(url);
    }
}

// Makes the preview of picture f ({ id, path }) from its content and stores it beside the picture.
// A key that may only read keeps the preview in this browser instead.
async function saveThumb(f, source) {
    if (thumbs.get(f.id) || thumbIndex.has(f.id)) return;
    const signedInAs = key;
    const small = await shrink(source);
    if (!small || key !== signedInAs) return;
    thumbStore.put(f.id, small);
    showThumb(f.id, small);
    if (!canWrite()) return;
    const path = thumbPath(f.path, f.id);
    try {
        const made = await request('PUT', rawUrl(path), { body: small, headers: { 'content-type': 'image/jpeg' }, t: bg }, (r) => r.json());
        thumbIndex.set(f.id, { id: made.id, path, size: small.size });
    } catch {
        // the picture itself is safe; it is only without a stored preview
    }
}

// ---- the viewer -------------------------------------------------------------

// Files looked at recently, so stepping back and forth does not download them again.
const blobs = new Map();
let blobBytes = 0;
function keepBlob(id, blob) {
    if (blob.size > 64 * MB || blobs.has(id)) return;
    blobs.set(id, blob);
    blobBytes += blob.size;
    while (blobBytes > 192 * MB) {
        const [oldest, b] = blobs.entries().next().value;
        blobs.delete(oldest);
        blobBytes -= b.size;
    }
}

// The whole file as one Blob, every chunk checked against its hash.
async function loadBlob(f, mime, t, onProgress) {
    if (blobs.has(f.id)) return blobs.get(f.id);
    const m = await api('GET', `/files/${f.id}`, undefined, t);
    if (m.chunkList.length !== m.chunks) throw new Error('the index lists fewer parts than the file has');
    const parts = new Array(m.chunks);
    const got = new Array(m.chunks).fill(0);
    await pool(m.chunkList, 3, async (c) => {
        parts[c.idx] = await fetchChunk(m.id, c, t, (n) => { got[c.idx] = n; onProgress(got.reduce((a, b) => a + b, 0), m.size); });
    });
    const blob = new Blob(parts, { type: mime });
    keepBlob(f.id, blob);
    return blob;
}

// The start of a text file. Text is only ever put on the page as text, whatever it contains.
async function loadText(f, t) {
    const m = await api('GET', `/files/${f.id}`, undefined, t);
    if (!m.chunks) return '';
    const bytes = await fetchChunk(m.id, m.chunkList[0], t, () => {});
    return new TextDecoder().decode(bytes.subarray(0, settings.textMax));
}

const note = (text, cls = '') => h('p', { class: `viewer-note ${cls}` }, text);

async function showFile(f) {
    stopViewing();
    const v = viewing = { f, ctrl: new AbortController(), url: null, waiting: null };
    const { kind, mime } = kindOf(f.name);
    const body = $('viewer-body');
    const status = note('Loading…');
    v.onPaint = () => { if (v.waiting) status.textContent = `Waiting to try again: ${v.waiting}`; };
    body.replaceChildren(status);
    $('viewer-name').textContent = f.name;
    $('viewer-meta').textContent = `${fmtSize(f.size)} · saved ${when(f.created_at)}`;
    // the arrows step through the other files in the list that can be shown
    const others = shown.filter(x => kindOf(x.name).kind);
    const at = others.findIndex(x => x.id === f.id);
    v.prev = at > 0 ? others[at - 1] : null;
    v.next = at !== -1 && at < others.length - 1 ? others[at + 1] : null;
    $('viewer-prev').disabled = !v.prev;
    $('viewer-next').disabled = !v.next;
    if (!$('viewer').open) $('viewer').showModal();

    if (kind !== 'text' && f.size > settings.previewMax) {
        return body.replaceChildren(note(`This file is ${fmtSize(f.size)}, too large to show here. Download it instead.`));
    }
    const cannot = () => { if (viewing === v) body.replaceChildren(note('This browser cannot show this file. Download it instead.')); };
    try {
        let el;
        if (kind === 'text') {
            const text = await loadText(f, v);
            const more = f.size > settings.textMax ? `\n\n… this is the first ${fmtSize(settings.textMax)} of ${fmtSize(f.size)}` : '';
            el = f.size ? h('pre', {}, text + more) : note('This file is empty.');
        } else {
            const blob = await loadBlob(f, mime, v, (n, total) => { status.textContent = `Loading · ${fmtSize(n)} of ${fmtSize(total)}`; });
            if (viewing !== v) return;
            v.url = URL.createObjectURL(blob);
            if (kind === 'image') {
                el = h('img', { src: v.url, alt: f.name, onerror: cannot });
                // the picture has been downloaded anyway: if it has no preview yet, this is the moment to make one
                saveThumb(f, blob);
            } else if (kind === 'video') {
                el = h('video', { src: v.url, controls: '', playsinline: '', onerror: cannot });
            } else if (kind === 'audio') {
                el = h('audio', { src: v.url, controls: '', onerror: cannot });
            } else {
                // a phone shows only the first page inside the frame, hence the link
                v.keepUrl = true;
                el = h('div', { class: 'viewer-pdf' },
                    h('iframe', { src: v.url, title: f.name }),
                    h('a', { href: v.url, target: '_blank', rel: 'noopener' }, 'Open in a new tab'));
            }
        }
        if (viewing === v) body.replaceChildren(el);
    } catch (e) {
        if (viewing === v && key) body.replaceChildren(note(`This file could not be loaded: ${e.message}`, 'error'));
    }
}

function stopViewing() {
    if (!viewing) return;
    viewing.ctrl.abort();
    // a PDF may have been opened in another tab, which still needs the address
    if (viewing.url && !viewing.keepUrl) URL.revokeObjectURL(viewing.url);
    viewing = null;
    $('viewer-body').replaceChildren();
}

$('viewer').addEventListener('close', stopViewing);
$('viewer').addEventListener('click', (e) => { if (e.target === $('viewer')) $('viewer').close(); });
$('viewer-close').addEventListener('click', () => $('viewer').close());
$('viewer-prev').addEventListener('click', () => { if (viewing?.prev) showFile(viewing.prev); });
$('viewer-next').addEventListener('click', () => { if (viewing?.next) showFile(viewing.next); });
$('viewer-download').addEventListener('click', () => { if (viewing) startDownload(viewing.f); });
$('viewer').addEventListener('keydown', (e) => {
    // inside a player the arrow keys belong to the player
    if (!viewing || e.target.closest('video, audio')) return;
    if (e.key === 'ArrowLeft' && viewing.prev) showFile(viewing.prev);
    if (e.key === 'ArrowRight' && viewing.next) showFile(viewing.next);
});

// Administrators also see whether the stored copies are all in place.
async function loadHealth() {
    const el = $('health');
    if (me?.role !== 'admin') { el.hidden = true; return; }
    let s;
    try { s = await api('GET', '/status'); } catch { return; }
    const ok = s.replicas.ok || 0;
    const missing = s.replicas.missing || 0;
    const scrub = s.kv.scrub || {};
    let text;
    if (s.chunksWithNoCopy) text = `${count(s.chunksWithNoCopy, 'stored part')} cannot be read from either copy right now.`;
    else if (missing) text = `${count(missing, 'copy', 'copies')} went missing and ${missing === 1 ? 'is' : 'are'} being re-made from the other copy, one a minute.`;
    else text = `All ${count(ok, 'stored copy', 'stored copies')} are in place.`;
    text += scrub.passDoneAt ? ` Last full check finished ${when(scrub.passDoneAt)}.` : ' No full check has finished yet.';
    if (s.kv.paused) text += ' The scheduled checker is paused.';
    el.textContent = text;
    el.className = `health${s.chunksWithNoCopy || missing || s.kv.paused ? ' warn' : ''}`;
    el.hidden = false;
}

// ---- wiring -----------------------------------------------------------------

function showApp() {
    $('signin').hidden = true;
    $('app').hidden = false;
    const may = me.name === 'root' && me.role === 'admin' ? 'owner token, full control'
        : `key "${me.name}", ${{ read: 'can only read', write: 'can read and write', admin: 'full control' }[me.role]}`;
    $('who').textContent = `${may}${me.prefix ? `, limited to ${me.prefix}` : ''}`;
    $('drop').hidden = !canWrite();
    dir = hashToDir(location.hash) ?? homeOf(me.prefix);
    renderFiles();
    loadFiles();
}

async function signIn(candidate) {
    key = candidate;
    try {
        me = await api('GET', '/whoami');
    } catch (e) {
        if (e.status !== 401) {
            key = null;
            $('signin').hidden = false;
            $('signin-error').textContent = `Could not reach the store (${e.message}). Reload the page to try again.`;
            $('signin-error').hidden = false;
        }
        return;
    }
    storage.set(key);
    showApp();
}

$('signin-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const candidate = $('key-input').value.trim();
    if (candidate) signIn(candidate);
});
$('signout').addEventListener('click', () => signOut());
$('choose').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
    enqueue([...e.target.files].map(file => ({ file, rel: file.name })));
    e.target.value = '';
});
$('clear-transfers').addEventListener('click', () => {
    for (const t of [...transfers]) if (t.state !== 'queued' && t.state !== 'active') dismiss(t);
});
$('filter').addEventListener('input', renderFiles);
$('refresh').addEventListener('click', loadFiles);
window.addEventListener('hashchange', () => {
    if (takeKeyFromAddress()) return;
    const next = hashToDir(location.hash);
    if (!me || next === null) return;
    dir = next;
    $('filter').value = '';
    renderFiles();
});

// Dropping files anywhere on the page saves them into the folder on show.
const draggingFiles = (e) => me && canWrite() && [...(e.dataTransfer?.types || [])].includes('Files');
let depth = 0;
window.addEventListener('dragenter', (e) => {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    depth++;
    $('drop-veil').hidden = false;
});
window.addEventListener('dragover', (e) => { if (draggingFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => {
    if (!draggingFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) $('drop-veil').hidden = true;
});
window.addEventListener('drop', async (e) => {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $('drop-veil').hidden = true;
    // the entries must be taken out during the event; afterwards the browser empties the list
    const plain = [...e.dataTransfer.files].map(file => ({ file, rel: file.name }));
    const entries = [...e.dataTransfer.items].filter(i => i.kind === 'file').map(i => i.webkitGetAsEntry?.()).filter(Boolean);
    let list = plain;
    if (entries.length) {
        try { list = await walkEntries(entries); } catch { /* fall back to the plain files */ }
    }
    enqueue(list);
});
window.addEventListener('beforeunload', (e) => {
    if (transfers.some(t => t.state === 'queued' || t.state === 'active')) e.preventDefault();
});

// "edge web" opens the page as .../#key=<key>; the key is taken out of the address at once.
function takeKeyFromAddress() {
    const handed = location.hash.match(/^#key=(.+)$/);
    if (!handed) return false;
    history.replaceState(null, '', location.pathname);
    if (me) signOut();
    signIn(decodeURIComponent(handed[1]));
    return true;
}

if (takeKeyFromAddress()) {
    // signing in
} else if (storage.get()) {
    signIn(storage.get());
} else {
    signOut();
}
