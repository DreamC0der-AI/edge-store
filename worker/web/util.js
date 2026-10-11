// Helpers for the web page that have no need of a browser window, so the tests can run them in Node.

export const CHUNK = 16 * 1024 * 1024;

export const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// SHA-256 that can be fed piece by piece. The browser's own crypto.subtle.digest wants the whole
// input at once, which is fine for a chunk but not for the hash of a file of many gigabytes.
export class Sha256 {
    constructor() {
        this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
        this.w = new Int32Array(64);
        this.buf = new Uint8Array(64);
        this.n = 0;      // bytes waiting in buf
        this.len = 0;    // bytes seen in total
    }

    update(data) {
        let i = 0;
        this.len += data.length;
        if (this.n) {
            while (i < data.length && this.n < 64) this.buf[this.n++] = data[i++];
            if (this.n < 64) return this;
            this.block(this.buf, 0);
            this.n = 0;
        }
        for (; i + 64 <= data.length; i += 64) this.block(data, i);
        while (i < data.length) this.buf[this.n++] = data[i++];
        return this;
    }

    block(p, o) {
        const w = this.w, h = this.h;
        for (let i = 0; i < 16; i++, o += 4) w[i] = (p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3];
        for (let i = 16; i < 64; i++) {
            const x = w[i - 15], y = w[i - 2];
            const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
            const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let a = h[0] | 0, b = h[1] | 0, c = h[2] | 0, d = h[3] | 0, e = h[4] | 0, f = h[5] | 0, g = h[6] | 0, k = h[7] | 0;
        for (let i = 0; i < 64; i++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const t1 = (k + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
            k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
    }

    // Finishes the hash; the object must not be fed again afterwards.
    hex() {
        const len = this.len;
        const pad = new Uint8Array(((this.n < 56 ? 56 : 120) - this.n) + 8);
        pad[0] = 0x80;
        const view = new DataView(pad.buffer);
        view.setUint32(pad.length - 8, Math.floor(len / 0x20000000));
        view.setUint32(pad.length - 4, (len * 8) % 0x100000000);
        this.update(pad);
        return [...this.h].map(x => x.toString(16).padStart(8, '0')).join('');
    }
}

// Everything dropped on the page, folders included, as [{ file, rel }] with rel the path below the drop.
// `entries` are FileSystemEntry objects (DataTransferItem.webkitGetAsEntry).
export async function walkEntries(entries) {
    const out = [];
    const walk = async (entry, dir) => {
        if (entry.isFile) {
            const file = await new Promise((res, rej) => entry.file(res, rej));
            out.push({ file, rel: dir + entry.name });
            return;
        }
        const reader = entry.createReader();
        for (;;) {
            // a directory is read in batches; an empty batch means the end
            const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
            if (!batch.length) break;
            for (const e of batch) await walk(e, `${dir}${entry.name}/`);
        }
    };
    for (const e of entries) await walk(e, '');
    return out;
}

// Files the operating system scatters into folders; nobody means to store these.
export const isClutter = (rel) => /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/.test(rel);

// What one folder shows: its sub-folders (with totals of everything below them) and its own files.
export function folderView(files, dir) {
    const folders = new Map();
    const own = [];
    for (const f of files) {
        if (!f.path.startsWith(dir)) continue;
        const rest = f.path.slice(dir.length);
        const cut = rest.indexOf('/');
        if (cut === -1) {
            own.push({ ...f, name: rest });
        } else {
            const name = rest.slice(0, cut);
            const d = folders.get(name) || { name, path: `${dir}${name}/`, count: 0, size: 0, newest: 0 };
            d.count++;
            d.size += f.size;
            d.newest = Math.max(d.newest, f.created_at);
            folders.set(name, d);
        }
    }
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return { folders: [...folders.values()].sort(byName), files: own.sort(byName) };
}

// The folder a key that is limited to `prefix` starts in.
export const homeOf = (prefix) => prefix.slice(0, prefix.lastIndexOf('/') + 1);

// "#/photos/2024/" <-> "photos/2024/"
export const dirToHash = (dir) => '#/' + dir.split('/').map(encodeURIComponent).join('/');
export function hashToDir(hash) {
    if (!hash.startsWith('#/')) return null;
    try {
        const dir = hash.slice(2).split('/').map(decodeURIComponent).join('/');
        return dir === '' || dir.endsWith('/') ? dir : `${dir}/`;
    } catch {
        return null;
    }
}

export function fmtSize(n) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i && n < 100 ? 1 : 0)} ${u[i]}`;
}

// Runs fn until it succeeds. A rate limit (err.retryAfter) is waited out and does not count
// as a failure; a transient error (err.transient) is retried with backoff up to `tries`.
// onRetry hears about each failure that is about to be retried.
export async function withRetry(fn, { tries = 6, sleep = (ms) => new Promise(r => setTimeout(r, ms)), maxWaits = 100, onRetry = () => {} } = {}) {
    let failures = 0;
    let waits = 0;
    for (;;) {
        try {
            return await fn();
        } catch (e) {
            let wait;
            if (e.retryAfter != null && waits++ < maxWaits) wait = (e.retryAfter + 1) * 1000;
            else if (e.transient && ++failures < tries) wait = Math.min(30_000, 500 * 2 ** failures);
            else throw e;
            onRetry(e, wait);
            await sleep(wait);
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

// What the page can show in place, judged by the file's name alone. The content type handed to
// the browser always comes from this table, never from the file, so stored content cannot
// pass itself off as a web page.
const SHOWN = {
    image: { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
        svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', heic: 'image/heic', heif: 'image/heif' },
    video: { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg' },
    audio: { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
        opus: 'audio/ogg', flac: 'audio/flac' },
    pdf: { pdf: 'application/pdf' },
    text: Object.fromEntries(('txt md markdown log csv tsv json yaml yml toml ini conf cfg xml html htm css js mjs ts jsx tsx py rb go rs java c h cpp hpp '
        + 'cs php sh bash zsh sql env gitignore srt vtt tex').split(' ').map(e => [e, 'text/plain'])),
};

// { kind, mime, ext } for a file name; kind is null when the page has no way of showing it.
export function kindOf(name) {
    const base = name.slice(name.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    const ext = dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
    for (const [kind, types] of Object.entries(SHOWN)) if (Object.hasOwn(types, ext)) return { kind, mime: types[ext], ext };
    return { kind: null, mime: 'application/octet-stream', ext };
}

// A picture's small preview is stored beside it as <folder>/.thumbs/<the picture's file id>.jpg.
// Naming it after the id, not the picture's name, means a preview can never be taken for that
// of a different picture later stored under the same name. (client/lib.mjs follows the same rule.)
export const thumbPath = (path, id) => `${path.slice(0, path.lastIndexOf('/') + 1)}.thumbs/${id}.jpg`;
const THUMB = /(?:^|\/)\.thumbs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jpg$/;

// Separates a listing into the files to show and the stored previews, keyed by the picture's id.
export function splitThumbs(all) {
    const files = [];
    const thumbs = new Map();
    for (const f of all) {
        const m = f.path.match(THUMB);
        if (m) thumbs.set(m[1], f);
        else files.push(f);
    }
    return { files, thumbs };
}

// "/raw/<path>" with each part of the path escaped for a URL
export const rawUrl = (path) => `/raw/${path.split('/').map(encodeURIComponent).join('/')}`;

// The size a picture is drawn at to fit a square of `max` pixels, never enlarged.
export function fitWithin(w, h, max) {
    const s = Math.min(1, max / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}
