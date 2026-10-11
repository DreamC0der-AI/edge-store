// Pure client logic, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { Store, withRetry, pool, sha256, thumbPath, printable, safe } from '../client/lib.mjs';
import * as web from '../worker/web/util.js';

const err = (props) => Object.assign(new Error('x'), props);

test('withRetry waits out a rate limit and does not count it as a failure', async () => {
    const waits = [];
    let calls = 0;
    const result = await withRetry(async () => {
        if (++calls <= 3) throw err({ retryAfter: 7 });
        return 'done';
    }, { tries: 1, sleep: async (ms) => waits.push(ms) });
    assert.equal(result, 'done');
    assert.deepEqual(waits, [8000, 8000, 8000]);
});

test('withRetry retries transient errors up to the limit, then gives up', async () => {
    let calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw err({ transient: true }); }, { tries: 4, sleep: async () => {} }));
    assert.equal(calls, 4);
});

test('withRetry does not retry a permanent error', async () => {
    let calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw err({}); }, { sleep: async () => {} }));
    assert.equal(calls, 1);
});

test('pool keeps to its concurrency limit and stops after a failure', async () => {
    let running = 0, peak = 0, started = 0;
    await pool([...Array(20).keys()], 3, async () => {
        started++; running++; peak = Math.max(peak, running);
        await new Promise(r => setTimeout(r, 2));
        running--;
    });
    assert.equal(started, 20);
    assert.equal(peak, 3);

    started = 0;
    await assert.rejects(pool([...Array(20).keys()], 2, async (i) => { started++; if (i === 1) throw new Error('boom'); await new Promise(r => setTimeout(r, 5)); }));
    assert.ok(started < 20, `started ${started}`);
});

// A Store whose chunk downloads and reports are scripted. `plan` maps the slot asked for
// ("any", 0 or 1) to what comes back: { slot, bytes } or an error to throw.
function scripted(plan) {
    const store = new Store({ url: 'http://unused', token: 't' });
    store.reports = [];
    store.asked = [];
    store.downloadChunk = async (fileId, idx, slot = null) => {
        store.asked.push(slot === null ? 'any' : slot);
        const d = plan[slot === null ? 'any' : slot];
        if (d instanceof Error) throw d;
        return { buf: d.bytes, replica: 100 + d.slot, slot: d.slot };
    };
    store.report = async (id) => { store.reports.push(id); };
    return store;
}
const good = Buffer.from('the right bytes');
const wrong = Buffer.from('the wrong bytes');
const chunk = { idx: 0, size: good.length, sha256: sha256(good) };

test('fetchChunk takes what the Worker serves when it matches its hash', async () => {
    const s = scripted({ any: { slot: 0, bytes: good } });
    assert.deepEqual(await s.fetchChunk('f', chunk), good);
    assert.deepEqual(s.asked, ['any']);
    assert.deepEqual(s.reports, []);
});

test('fetchChunk reports a copy with the wrong content and reads the other slot', async () => {
    const s = scripted({ any: { slot: 0, bytes: wrong }, 1: { slot: 1, bytes: good } });
    assert.deepEqual(await s.fetchChunk('f', chunk), good);
    assert.deepEqual(s.asked, ['any', 1]);
    assert.deepEqual(s.reports, [100]);
});

test('fetchChunk asks for each slot when the Worker could not choose one', async () => {
    const s = scripted({ any: err({ status: 503 }), 0: err({ status: 404 }), 1: { slot: 1, bytes: good } });
    assert.deepEqual(await s.fetchChunk('f', chunk), good);
    assert.deepEqual(s.asked, ['any', 0, 1]);
});

test('fetchChunk stops when the Worker says no replica is readable', async () => {
    const s = scripted({ any: err({ status: 404 }) });
    await assert.rejects(s.fetchChunk('f', chunk), /no readable replica/);
    assert.deepEqual(s.asked, ['any']);
});

test('fetchChunk fails clearly when every copy has the wrong content', async () => {
    const s = scripted({ any: { slot: 0, bytes: wrong }, 1: { slot: 1, bytes: wrong } });
    await assert.rejects(s.fetchChunk('f', chunk), /no readable replica/);
    assert.deepEqual(s.reports, [100, 101]);
});

test('a response cut off part-way is retried', async () => {
    let bodies = 0;
    const cutOff = () => ({ ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => { throw new TypeError('terminated'); } });
    const whole = () => new Response('hello', { headers: { 'x-replica': '7', 'x-slot': '1' } });
    const store = new Store({ url: 'http://store', token: 't', sleep: async () => {}, fetch: async () => (++bodies < 3 ? cutOff() : whole()) });
    const got = await store.downloadChunk('f', 0);
    assert.equal(got.buf.toString(), 'hello');
    assert.deepEqual([got.replica, got.slot], [7, 1]);
    assert.equal(bodies, 3);
});

test('a rate limit passed on by the store is waited out, and the key is sent', async () => {
    const waits = [];
    let calls = 0;
    const store = new Store({
        url: 'http://store', token: 'secret-key', sleep: async (ms) => waits.push(ms),
        fetch: async (url, init) => {
            assert.equal(init.headers.authorization, 'Bearer secret-key');
            return ++calls === 1
                ? new Response(JSON.stringify({ error: 'slow down', retryAfter: 3 }), { status: 429 })
                : new Response(JSON.stringify({ ok: true }));
        },
    });
    assert.deepEqual(await store.api('GET', '/whoami'), { ok: true });
    assert.deepEqual(waits, [4000]);
});

// ---- the web page's helpers (worker/web/util.js) ----

test('the page hashes a file piece by piece to the same SHA-256 as hashing it whole', () => {
    // lengths around the 64-byte block and 56-byte padding edges, plus a larger buffer cut at random points
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 121, 128, 1000, 300_007]) {
        const data = randomBytes(n);
        const want = sha256(data);
        assert.equal(new web.Sha256().update(data).hex(), want, `${n} bytes in one piece`);
        const h = new web.Sha256();
        for (let o = 0; o < n;) {
            const step = 1 + Math.floor(Math.random() * 200);
            h.update(data.subarray(o, o + step));
            o += step;
        }
        assert.equal(h.hex(), want, `${n} bytes in pieces`);
    }
    assert.equal(new web.Sha256().update(Buffer.from('abc')).hex(), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('the page hashes more than 512 MB correctly (the bit count no longer fits in 32 bits)', { timeout: 120_000 }, () => {
    const piece = randomBytes(8 << 20);
    const mine = new web.Sha256();
    const theirs = createHash('sha256');
    for (let i = 0; i < 70; i++) { mine.update(piece); theirs.update(piece); }
    assert.equal(mine.hex(), theirs.digest('hex'));
});

test('a dropped folder is walked into, batch by batch, keeping relative paths', async () => {
    const file = (name) => ({ isFile: true, name, file: (ok) => ok({ name, size: 1 }) });
    const folder = (name, children) => ({
        isFile: false, name,
        // like the browser, hand the children out a few at a time and finish with an empty batch
        createReader() {
            const left = [...children];
            return { readEntries: (ok) => ok(left.splice(0, 2)) };
        },
    });
    const got = await web.walkEntries([
        file('top.txt'),
        folder('trip', [file('a.jpg'), file('b.jpg'), file('c.jpg'), folder('raw', [file('a.dng')]), folder('empty', [])]),
    ]);
    assert.deepEqual(got.map(x => x.rel), ['top.txt', 'trip/a.jpg', 'trip/b.jpg', 'trip/c.jpg', 'trip/raw/a.dng']);
    assert.ok(web.isClutter('trip/.DS_Store') && web.isClutter('Thumbs.db') && !web.isClutter('trip/my.DS_Store.txt'));
});

test('a folder shows its own files and totals for the folders below it', () => {
    const f = (path, size, created_at = 1) => ({ path, size, created_at });
    const files = [f('a.txt', 1), f('docs/x.pdf', 10, 5), f('docs/old/y.pdf', 20, 9), f('docs2/z', 4), f('pics/10.jpg', 2), f('pics/9.jpg', 2)];
    const root = web.folderView(files, '');
    assert.deepEqual(root.files.map(x => x.name), ['a.txt']);
    assert.deepEqual(root.folders.map(d => [d.name, d.path, d.count, d.size]), [['docs', 'docs/', 2, 30], ['docs2', 'docs2/', 1, 4], ['pics', 'pics/', 2, 4]]);
    const docs = web.folderView(files, 'docs/');
    assert.deepEqual([docs.files.map(x => x.name), docs.folders.map(d => d.name)], [['x.pdf'], ['old']]);
    assert.deepEqual(web.folderView(files, 'pics/').files.map(x => x.name), ['9.jpg', '10.jpg']);
});

test('folder addresses survive awkward names, and a limited key starts in its own folder', () => {
    for (const dir of ['', 'a/', 'a b/c#d/', '100%/été/', '?x=1&y/']) assert.equal(web.hashToDir(web.dirToHash(dir)), dir);
    assert.equal(web.hashToDir('#/a/b'), 'a/b/');
    assert.equal(web.hashToDir('#key=es_123'), null);
    assert.equal(web.hashToDir('#/%E0%A4%A'), null);
    assert.deepEqual(['', 'apps/photos/', 'apps/ph', 'x'].map(web.homeOf), ['', 'apps/photos/', 'apps/', '']);
    assert.deepEqual([0, 1023, 1024, 1536, 150 * 1024 ** 2, 3 * 1024 ** 3].map(web.fmtSize), ['0 B', '1023 B', '1.0 KB', '1.5 KB', '150 MB', '3.0 GB']);
});

test('what the page offers to show is decided by the file name, and the content type comes from the same table', () => {
    const k = (name) => { const { kind, mime } = web.kindOf(name); return [kind, mime]; };
    assert.deepEqual(k('trip/Beach.JPG'), ['image', 'image/jpeg']);
    assert.deepEqual(k('clip.mov'), ['video', 'video/quicktime']);
    assert.deepEqual(k('song.flac'), ['audio', 'audio/flac']);
    assert.deepEqual(k('paper.pdf'), ['pdf', 'application/pdf']);
    // a web page or a script is only ever text to the page
    assert.deepEqual(k('page.html'), ['text', 'text/plain']);
    assert.deepEqual(k('run.js'), ['text', 'text/plain']);
    for (const name of ['archive.tar.zst', 'README', 'folder.jpg/inner', 'backup.pdf.gpg', 'constructor', 'x.toString']) {
        assert.deepEqual(k(name), [null, 'application/octet-stream'], name);
    }
    assert.equal(web.kindOf('.gitignore').kind, 'text');
});

test('a preview is stored beside its picture under the picture\'s id, and listings keep the two apart', () => {
    const id = '9182e2b9-24e4-451f-9197-bfa048f23ab1';
    assert.equal(web.thumbPath('photos/2026/beach.jpg', id), `photos/2026/.thumbs/${id}.jpg`);
    assert.equal(web.thumbPath('beach.jpg', id), `.thumbs/${id}.jpg`);
    for (const path of ['beach.jpg', 'a/b c/d.png', 'a/.thumbs/x.jpg']) assert.equal(thumbPath(path, id), web.thumbPath(path, id), 'the command line and the page must agree');

    const f = (path) => ({ path });
    const all = [f('beach.jpg'), f(`.thumbs/${id}.jpg`), f(`a/.thumbs/${id.replace('9', '0')}.jpg`), f('a/.thumbs/mine.jpg'), f(`a/thumbs/${id}.jpg`), f(`a/.thumbs/${id}.jpg.bak`)];
    const { files, thumbs } = web.splitThumbs(all);
    // only what is named like a preview is hidden; anything else a person put in such a folder still shows
    assert.deepEqual(files.map(x => x.path), ['beach.jpg', 'a/.thumbs/mine.jpg', `a/thumbs/${id}.jpg`, `a/.thumbs/${id}.jpg.bak`]);
    assert.deepEqual([...thumbs.keys()], [id, id.replace('9', '0')]);

    assert.equal(web.rawUrl('a b/100%/é#?.jpg'), '/raw/a%20b/100%25/%C3%A9%23%3F.jpg');
    assert.deepEqual([[600, 400], [400, 800], [100, 50], [5000, 3], [256, 256]].map(([w, h]) => web.fitWithin(w, h, 256)),
        [{ w: 256, h: 171 }, { w: 128, h: 256 }, { w: 100, h: 50 }, { w: 256, h: 1 }, { w: 256, h: 256 }]);
});

test('text from the store is printed with control characters spelled out, and ordinary text untouched', () => {
    assert.equal(printable('photos/2026/déjà vu 文件.jpg'), 'photos/2026/déjà vu 文件.jpg');
    assert.equal(printable('a\x1b[2Jb\nc\rd\x07\x9b'), 'a\\u{1b}[2Jb\\u{a}c\\u{d}d\\u{7}\\u{9b}');
    assert.equal(printable('evil\u202egnp.exe'), 'evil\\u{202e}gnp.exe');
    assert.equal(printable(undefined), 'undefined');
    // in a template, only the values are changed; the template's own line breaks stay
    const name = 'x\ny';
    assert.equal(safe`one ${name}\ntwo ${3}`, 'one x\\u{a}y\ntwo 3');
    assert.equal(safe`no values`, 'no values');
});
