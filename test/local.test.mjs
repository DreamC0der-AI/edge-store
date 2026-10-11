// Offline integration tests: the real Worker code (wrangler dev, local D1) and the real client,
// against a simulated Telegram that can be broken on purpose.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, openSync, writeSync, closeSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, CHUNK, ApiError, BACKUP_TAG, sha256, thumbPath } from '../client/lib.mjs';
import { startFakeTelegram } from './fake-telegram.mjs';
import { startWorker } from './local-worker.mjs';

const A = '-1001', B = '-1002';
const BOT_TOKEN = '123456:FAKE'; // what local-worker.mjs gives the Worker
let tgm, worker, store, tmp, seq = 0;

before(async () => {
    tgm = await startFakeTelegram();
    tgm.addChat(A, 'channel A');
    tgm.addChat(B, 'channel B');
    worker = await startWorker({ tgApi: tgm.url });
    store = new Store({ url: worker.url, token: worker.token, sleep: async () => {} });
    await store.api('POST', '/channels', { chat_id: A, slot: 0 });
    await store.api('POST', '/channels', { chat_id: B, slot: 1 });
    tmp = mkdtempSync(join(tmpdir(), 'edge-store-files-'));
}, { timeout: 180_000 });

after(async () => {
    await worker?.stop();
    await tgm?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
});

afterEach(async () => {
    for (const f of await store.ls('', { all: true })) await store.rmById(f.id);
});

function makeFile(size) {
    const path = join(tmp, `in-${seq++}`);
    const fd = openSync(path, 'w');
    for (let off = 0; off < size; off += 8 << 20) writeSync(fd, randomBytes(Math.min(8 << 20, size - off)));
    closeSync(fd);
    return path;
}
const shaOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const outPath = () => join(tmp, `out-${seq++}`);
const tick = () => store.api('POST', '/tick');
const missing = async () => (await store.status()).replicas.missing || 0;
const as = (token, extra = {}) => new Store({ url: worker.url, token, sleep: async () => {}, ...extra });
const denied = (status) => (e) => e instanceof ApiError && e.status === status;
const call = (token, method, path, init = {}) => fetch(worker.url + path, { method, ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });

async function roundTrip(remote, local, using = store) {
    const out = outPath();
    await using.get(remote, out);
    assert.equal(shaOf(out), shaOf(local), `${remote} came back different`);
}

async function ticksUntil(done, what, max = 40) {
    for (let i = 0; i < max; i++) {
        const t = await tick();
        if (await done(t)) return;
    }
    assert.fail(`${what}: not reached after ${max} scrubber runs`);
}

// Runs the scrubber until it has started a fresh pass from the top of the table.
const freshPass = () => ticksUntil(t => t.wrapped, 'scrubber wrap');

async function replicas(remote) {
    const m = await store.manifest(remote);
    return m.chunkList.flatMap(c => c.replicas.map(r => ({ ...r, chunk: c, file: m })));
}

// A client whose chunk uploads stop reaching the store after `allowed` have gone through.
function flakyStore(allowed) {
    let uploads = 0;
    return as(worker.token, {
        fetch: (url, init) => {
            if (init.method === 'PUT' && /\/chunks\/\d+/.test(String(url)) && ++uploads > allowed) throw new TypeError('fetch failed');
            return fetch(url, init);
        },
    });
}

// ---- access -------------------------------------------------------------

test('requests without a valid key are refused', async () => {
    assert.equal((await fetch(`${worker.url}/status`)).status, 401);
    assert.equal((await call('wrong', 'GET', '/status')).status, 401);
    assert.equal((await call(`${worker.token}x`, 'GET', '/whoami')).status, 401);
    assert.equal((await call(`es_00000000_${'0'.repeat(64)}`, 'GET', '/whoami')).status, 401);
});

test('a granted key works, is listed without its secret, and stops working when revoked', async () => {
    const k = await store.keyAdd('photo app');
    assert.match(k.key, /^es_[0-9a-f]{8}_[0-9a-f]{64}$/);
    const app = as(k.key);
    assert.deepEqual(await app.whoami(), { name: 'photo app', role: 'write', prefix: '', maxChunk: 19 * 1024 * 1024 });

    const local = makeFile(5000);
    await app.put(local, 'photos/a.jpg');
    await roundTrip('photos/a.jpg', local, app);
    assert.deepEqual((await app.ls('photos/')).map(f => f.path), ['photos/a.jpg']);

    const listed = (await store.keyList()).find(x => x.id === k.id);
    assert.equal(listed.name, 'photo app');
    assert.ok(listed.last_used_at > 0);
    assert.ok(!JSON.stringify(await store.keyList()).includes(k.key.split('_')[2]), 'the secret must not be stored or listed');

    // the right id with the wrong secret is not enough
    assert.equal((await call(`es_${k.id}_${'f'.repeat(64)}`, 'GET', '/whoami')).status, 401);

    await store.keyRevoke(k.id);
    await assert.rejects(app.whoami(), denied(401));
    await assert.rejects(app.get('photos/a.jpg', outPath()), denied(401));
    await assert.rejects(store.keyRevoke(k.id), denied(404));
    assert.ok((await store.keyList()).find(x => x.id === k.id).revoked_at > 0);
    await roundTrip('photos/a.jpg', local); // the owner still can
});

test('a read-only key can download and list but not change anything', async () => {
    const local = makeFile(3000);
    await store.put(local, 'docs/r.bin');
    const ro = as((await store.keyAdd('reader', { role: 'read' })).key);
    await roundTrip('docs/r.bin', local, ro);
    assert.equal((await ro.ls()).length, 1);
    await assert.rejects(ro.put(makeFile(10), 'docs/new.bin'), denied(403));
    await assert.rejects(ro.rm('docs/r.bin'), denied(403));
    assert.equal((await call(ro.token, 'PUT', '/raw/docs/x.bin', { body: 'x' })).status, 403);
    assert.equal((await store.ls()).length, 1);
});

test('an app key cannot administer the store', async () => {
    const app = as((await store.keyAdd('app')).key);
    for (const [method, path, body] of [
        ['GET', '/keys'], ['POST', '/keys', { name: 'more' }], ['DELETE', '/keys/abcdef01'], ['GET', '/status'], ['GET', '/config'],
        ['GET', '/replicas'], ['POST', '/tick'], ['POST', '/backup'], ['POST', '/backup/latest', { chats: [A] }], ['POST', '/import', { table: 'keys', rows: [] }],
        ['PUT', '/settings', { paused: true }], ['POST', '/channels', { chat_id: A, slot: 0 }], ['DELETE', `/channels/${A}`],
        ['POST', '/telegram/deleteMessage', { chat_id: A, message_id: 1 }],
    ]) {
        await assert.rejects(app.api(method, path, body), denied(403), `${method} ${path} should be refused`);
    }
    assert.equal((await store.status()).kv.paused, undefined);
});

test('a key limited to a prefix sees and touches nothing outside it', async () => {
    const outside = makeFile(2000);
    await store.put(outside, 'private/secret.bin');
    const app = as((await store.keyAdd('notes app', { prefix: 'apps/notes/' })).key);
    assert.equal((await app.whoami()).prefix, 'apps/notes/');

    const mine = makeFile(1000);
    await app.put(mine, 'apps/notes/n1.txt');
    await roundTrip('apps/notes/n1.txt', mine, app);
    assert.deepEqual((await app.ls()).map(f => f.path), ['apps/notes/n1.txt'], 'listing is confined to the prefix');
    // an app sees which replicas exist, not where they sit in Telegram
    const seen = (await app.manifest('apps/notes/n1.txt')).chunkList[0].replicas;
    assert.deepEqual(seen.map(r => Object.keys(r).sort()), [['id', 'idx', 'slot', 'state'], ['id', 'idx', 'slot', 'state']]);
    // path tricks do not get out of the prefix
    assert.equal((await call(app.token, 'GET', '/raw/apps/notes/../../private/secret.bin')).status, 403);
    assert.equal((await call(app.token, 'GET', '/raw/apps/notes/%2e%2e/%2e%2e/private/secret.bin')).status, 403);
    assert.equal((await call(app.token, 'GET', `/file?path=${encodeURIComponent('/private/secret.bin')}`)).status, 403);

    const other = await store.manifest('private/secret.bin');
    await assert.rejects(app.ls('private/'), denied(403));
    await assert.rejects(app.ls('apps/'), denied(403));
    await assert.rejects(app.manifest('private/secret.bin'), denied(403));
    await assert.rejects(app.get('private/secret.bin', outPath()), denied(403));
    await assert.rejects(app.api('GET', `/files/${other.id}`), denied(403));
    await assert.rejects(app.downloadChunk(other.id, 0), denied(403));
    await assert.rejects(app.api('DELETE', `/files/${other.id}`), denied(403));
    await assert.rejects(app.api('POST', `/replicas/${other.chunkList[0].replicas[0].id}`, { state: 'missing' }), denied(403));
    await assert.rejects(app.put(makeFile(10), 'private/planted.bin'), denied(403));
    assert.equal((await call(app.token, 'GET', '/raw/private/secret.bin')).status, 403);
    assert.equal((await call(app.token, 'PUT', '/raw/elsewhere.bin', { body: 'x' })).status, 403);

    await roundTrip('private/secret.bin', outside);
    assert.equal(await missing(), 0);
    assert.equal((await store.ls()).length, 2);
});

test('the bot token is never handed out', async () => {
    await store.put(makeFile(100), 'leak-check.bin');
    const m = await store.manifest('leak-check.bin');
    const k = await store.keyAdd('probe', { role: 'admin' });
    for (const path of ['/whoami', '/config', '/status', '/keys', '/replicas', '/files', `/files/${m.id}`, '/file?path=leak-check.bin']) {
        const text = await (await call(k.key, 'GET', path)).text();
        assert.ok(!text.includes(BOT_TOKEN) && !text.includes('FAKE'), `${path} leaks the bot token`);
    }
    const res = await call(k.key, 'GET', `/files/${m.id}/chunks/0`);
    assert.ok(![...res.headers].some(([, v]) => v.includes('FAKE')));
    assert.equal((await call(k.key, 'POST', '/telegram/getMe', { body: '{}' })).status, 400, 'only the allow-listed Telegram methods pass');
});

// ---- plain HTTP, as an app in any language would use it -----------------

test('one-request upload and download of a small file over plain HTTP', async () => {
    const k = (await store.keyAdd('curl user')).key;
    const bytes = randomBytes(70_000);
    const put = await call(k, 'PUT', '/raw/http/small.bin', { body: bytes });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).sha256, sha256(bytes));
    assert.equal((await call(k, 'PUT', '/raw/http/small.bin', { body: bytes })).status, 409);

    const got = await call(k, 'GET', '/raw/http/small.bin');
    assert.equal(got.headers.get('x-sha256'), sha256(bytes));
    assert.equal(got.headers.get('content-length'), '70000');
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);
    assert.equal((await call(k, 'GET', '/raw/http/nothing.bin')).status, 404);

    // two replicas, like any other file, and readable with the ordinary client
    const m = await store.manifest('http/small.bin');
    assert.deepEqual(m.chunkList[0].replicas.map(r => r.chat_id), [A, B]);
    const out = outPath();
    await store.get('http/small.bin', out);
    assert.equal(shaOf(out), sha256(bytes));

    const empty = await call(k, 'PUT', '/raw/http/empty.bin', { body: '' });
    assert.equal(empty.status, 200);
    assert.equal((await (await call(k, 'GET', '/raw/http/empty.bin')).arrayBuffer()).byteLength, 0);
    assert.equal((await call(k, 'PUT', '/raw/http/huge.bin', { body: Buffer.alloc(20 * 1024 * 1024) })).status, 413);
});

test('a multi-chunk file downloads in one request, up to the per-request limit', { timeout: 60_000 }, async () => {
    const small = as(worker.token, { chunkSize: 1000 });
    const local = makeFile(23_500); // 24 chunks
    await small.put(local, 'raw/many.bin');
    const got = await call(worker.token, 'GET', '/raw/raw/many.bin');
    assert.equal(got.status, 200);
    assert.equal(sha256(Buffer.from(await got.arrayBuffer())), shaOf(local));

    // a broken first copy of a chunk in the middle does not break the stream
    const reps = await replicas('raw/many.bin');
    tgm.dropFile(reps.find(r => r.idx === 10 && r.slot === 0).tg_file_id);
    assert.equal(sha256(Buffer.from(await (await call(worker.token, 'GET', '/raw/raw/many.bin')).arrayBuffer())), shaOf(local));
    assert.equal(await missing(), 1);

    await small.put(makeFile(24_500), 'raw/toomany.bin'); // 25 chunks
    const refused = await call(worker.token, 'GET', '/raw/raw/toomany.bin');
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /chunk by chunk/);
});

test('the chunk API works over plain HTTP: begin, send chunks, commit, read chunks', async () => {
    const k = (await store.keyAdd('chunk user')).key;
    const parts = [randomBytes(1500), randomBytes(1500), randomBytes(700)];
    const whole = Buffer.concat(parts);
    const json = (body) => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const begin = await (await call(k, 'POST', '/files', json({ path: 'http/chunked.bin', size: whole.length, chunkSize: 1500, chunks: 3 }))).json();
    assert.equal(begin.resumed, false);
    for (const [i, part] of parts.entries()) {
        const r = await call(k, 'PUT', `/files/${begin.id}/chunks/${i}?sha256=${sha256(part)}`, { body: part });
        assert.deepEqual(await r.json(), { ok: true, slots: [0, 1] });
    }
    // sending a chunk again stores nothing new
    assert.deepEqual(await (await call(k, 'PUT', `/files/${begin.id}/chunks/0?sha256=${sha256(parts[0])}`, { body: parts[0] })).json(), { ok: true, slots: [] });
    assert.equal(tgm.messages(A).size, 3);
    assert.equal((await call(k, 'POST', `/files/${begin.id}/commit`, json({ sha256: sha256(whole) }))).status, 200);

    for (const [i, part] of parts.entries()) {
        for (const slot of ['', '?slot=0', '?slot=1']) {
            const r = await call(k, 'GET', `/files/${begin.id}/chunks/${i}${slot}`);
            assert.equal(r.headers.get('x-sha256'), sha256(part));
            assert.deepEqual(Buffer.from(await r.arrayBuffer()), part);
        }
    }
    assert.equal((await call(k, 'GET', `/files/${begin.id}/chunks/3`)).status, 404);
});

test('the API rejects malformed uploads', async () => {
    const bad = async (fn, status) => assert.rejects(fn, denied(status), `expected HTTP ${status}`);
    await bad(() => store.api('POST', '/files', { path: 'x', size: 10, chunkSize: CHUNK, chunks: 2 }), 400);
    await bad(() => store.api('POST', '/files', { path: '', size: 10, chunkSize: CHUNK, chunks: 1 }), 400);
    await bad(() => store.api('POST', '/files', { path: 'x', size: 10, chunkSize: 64 << 20, chunks: 1 }), 400);
    await bad(() => store.api('GET', '/files/nope'), 404);
    await bad(() => store.api('GET', '/nowhere'), 404);

    const f = await store.api('POST', '/files', { path: 'proto.bin', size: 10, chunkSize: CHUNK, chunks: 1 });
    const ten = Buffer.alloc(10, 7);
    const h = sha256(ten);
    await bad(() => store.api('POST', `/files/${f.id}/commit`, { sha256: h }), 409);
    await bad(() => store.sendBytes('PUT', `/files/${f.id}/chunks/0?sha256=${h}`, Buffer.alloc(11)), 400);
    await bad(() => store.sendBytes('PUT', `/files/${f.id}/chunks/0?sha256=nope`, ten), 400);
    await bad(() => store.sendBytes('PUT', `/files/${f.id}/chunks/0`, ten), 400);
    await bad(() => store.sendBytes('PUT', `/files/${f.id}/chunks/1?sha256=${h}`, ten), 400);
    assert.equal(tgm.messages(A).size, 0, 'a rejected chunk must not reach Telegram');
    await store.sendBytes('PUT', `/files/${f.id}/chunks/0?sha256=${h}`, ten);
    await store.api('POST', `/files/${f.id}/commit`, { sha256: h });
    await bad(() => store.sendBytes('PUT', `/files/${f.id}/chunks/0?sha256=${h}`, ten), 409);
    await bad(() => store.api('POST', '/channels', { chat_id: '-404', slot: 0 }), 400);
    await bad(() => store.api('POST', '/channels', { chat_id: A, slot: 5 }), 400);
    await bad(() => store.api('POST', '/keys', { name: '' }), 400);
    await bad(() => store.api('POST', '/keys', { name: 'x', role: 'god' }), 400);
});

// ---- files --------------------------------------------------------------

test('files of awkward sizes round-trip byte-identical, two replicas per chunk', { timeout: 120_000 }, async () => {
    for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK + 12345]) {
        const local = makeFile(size);
        const remote = `sizes/${size}.bin`;
        await store.put(local, remote);
        const m = await store.manifest(remote);
        assert.equal(m.chunks, Math.ceil(size / CHUNK));
        assert.equal(m.chunkList.length, m.chunks);
        assert.equal(m.sha256, shaOf(local));
        for (const c of m.chunkList) {
            assert.deepEqual(c.replicas.map(r => r.chat_id), [A, B]);
            for (const r of c.replicas) {
                assert.equal(tgm.message(r.chat_id, r.message_id).caption, `${m.id}:${c.idx}`);
                assert.equal(sha256(tgm.bytes(r.tg_file_id)), c.sha256);
            }
        }
        await roundTrip(remote, local);
    }
    assert.equal((await store.ls('sizes/')).length, 6);
    assert.equal((await store.ls('nothing-here/')).length, 0);
});

test('an existing path is not overwritten; after rm the messages are gone and the path is free', async () => {
    const local = makeFile(1000);
    await store.put(local, 'dup.bin');
    await assert.rejects(store.put(makeFile(2000), 'dup.bin'), denied(409));
    await roundTrip('dup.bin', local);
    await store.rm('dup.bin');
    assert.equal(tgm.messages(A).size, 0);
    assert.equal(tgm.messages(B).size, 0);
    await assert.rejects(store.manifest('dup.bin'), denied(404));
    await store.put(local, 'dup.bin');
});

test('an interrupted upload resumes without re-sending finished chunks', { timeout: 120_000 }, async () => {
    const local = makeFile(4 * CHUNK - 100);
    const before = tgm.calls.sendDocument || 0;
    await assert.rejects(flakyStore(2).put(local, 'resume.bin'));
    assert.equal((await store.ls('resume')).length, 0, 'a half-uploaded file must not be listed');
    const r = await store.put(local, 'resume.bin');
    assert.equal(r.resumed, true);
    assert.equal(tgm.messages(A).size, 4);
    assert.equal(tgm.messages(B).size, 4);
    assert.equal(tgm.calls.sendDocument - before, 8, 'each chunk is sent to Telegram exactly twice in total');
    await roundTrip('resume.bin', local);
});

test('a different file at the same path replaces a stale upload and leaves no stray messages', { timeout: 120_000 }, async () => {
    const first = makeFile(2 * CHUNK);
    await assert.rejects(flakyStore(1).put(first, 'stale.bin'));
    const sameSize = makeFile(2 * CHUNK);
    await store.put(sameSize, 'stale.bin');
    assert.equal(tgm.messages(A).size, 2);
    assert.equal(tgm.messages(B).size, 2);
    await roundTrip('stale.bin', sameSize);
    await store.rm('stale.bin');

    await assert.rejects(flakyStore(1).put(first, 'stale.bin'));
    const otherSize = makeFile(CHUNK + 5);
    await store.put(otherSize, 'stale.bin');
    assert.equal(tgm.messages(A).size, 2);
    assert.equal(tgm.messages(B).size, 2);
    await roundTrip('stale.bin', otherSize);
});

test('when only one of the two uploads of a chunk fails, nothing is left that the index does not know about', { timeout: 120_000 }, async () => {
    const local = makeFile(2 * CHUNK);
    tgm.failChat(B, 1000);
    await assert.rejects(store.put(local, 'lopsided.bin'));
    assert.equal(tgm.messages(A).size, 2, 'the slot that works is stored once per chunk, however often the client retried');
    assert.equal(tgm.messages(B).size, 0);

    // a second run only sends what is still missing
    tgm.failChat(B, 0);
    const sentBefore = tgm.calls.sendDocument;
    const r = await store.put(local, 'lopsided.bin');
    assert.equal(r.resumed, true);
    assert.equal(tgm.calls.sendDocument - sentBefore, 2);
    assert.equal(tgm.messages(A).size, 2);
    assert.equal(tgm.messages(B).size, 2);
    await roundTrip('lopsided.bin', local);
    await store.rm('lopsided.bin');

    // and if it is abandoned instead, clean removes every message
    tgm.failChat(B, 1000);
    await assert.rejects(store.put(local, 'lopsided.bin'));
    tgm.failChat(B, 0);
    assert.deepEqual(await store.clean(0), ['lopsided.bin']);
    assert.equal(tgm.messages(A).size, 0);
});

test('uploads wait out Telegram rate limits', async () => {
    const local = makeFile(3000);
    tgm.rateLimit('sendDocument', 3);
    await store.put(local, 'limited.bin');
    await roundTrip('limited.bin', local);
    assert.equal(tgm.messages(A).size, 1);
    assert.equal(tgm.messages(B).size, 1);
});

test('uploads retry when Telegram reports a server-side hiccup as a bad request', async () => {
    const local = makeFile(3000);
    tgm.failWith('sendDocument', 'Bad Request: internal Server Error during file upload', 3);
    await store.put(local, 'hiccup.bin');
    await roundTrip('hiccup.bin', local);
    assert.equal(tgm.messages(A).size, 1);
    assert.equal(tgm.messages(B).size, 1);
});

test('clean removes an abandoned upload and its messages', { timeout: 60_000 }, async () => {
    await assert.rejects(flakyStore(1).put(makeFile(2 * CHUNK), 'abandoned.bin'));
    assert.equal(tgm.messages(A).size + tgm.messages(B).size, 2);
    assert.deepEqual(await store.clean(60_000), [], 'a recent upload is left alone');
    assert.deepEqual(await store.clean(0), ['abandoned.bin']);
    assert.equal((await store.ls('', { all: true })).length, 0);
    assert.equal(tgm.messages(A).size + tgm.messages(B).size, 0);
});

test('rm takes a picture\'s stored preview with it, and clean removes previews whose picture is gone', { timeout: 60_000 }, async () => {
    // the web page stores previews like this: a small file beside the picture, named after the picture's id
    const preview = async (path) => {
        const { id } = await store.manifest(path);
        const r = await call(worker.token, 'PUT', `/raw/${thumbPath(path, id)}`, { body: randomBytes(900) });
        assert.equal(r.status, 200);
        return thumbPath(path, id);
    };
    for (const path of ['album/a.jpg', 'album/b.jpg', 'album/c.jpg']) await store.put(makeFile(2000), path);
    const [pa, pb, pc] = [await preview('album/a.jpg'), await preview('album/b.jpg'), await preview('album/c.jpg')];
    await store.put(makeFile(100), 'album/.thumbs/my-own-file.jpg');
    assert.equal(tgm.messages(A).size + tgm.messages(B).size, 14);

    const removed = await store.rm('album/a.jpg');
    assert.equal(removed.messages, 4);
    assert.ok(!(await store.ls()).some(f => f.path === pa || f.path === 'album/a.jpg'));

    // b is deleted by something that knows nothing of previews, which leaves its preview behind
    await store.rmById((await store.manifest('album/b.jpg')).id);
    assert.deepEqual(await store.clean(), [pb]);
    assert.deepEqual((await store.ls()).map(f => f.path).sort(), ['album/.thumbs/my-own-file.jpg', 'album/c.jpg', pc].sort());
    assert.equal(tgm.messages(A).size + tgm.messages(B).size, 6);
    assert.deepEqual(await store.clean(0), []);

    // a key confined elsewhere cannot reach a preview through rm
    const k = await store.keyAdd('other', { prefix: 'other/' });
    await assert.rejects(as(k.key).rm('album/c.jpg'), denied(403));
});

// ---- damage and repair --------------------------------------------------

test('download falls back to the other replica and reports the broken one; the scrubber then repairs it', { timeout: 120_000 }, async () => {
    const local = makeFile(2 * CHUNK);
    await store.put(local, 'fallback.bin');
    const reps = await replicas('fallback.bin');
    tgm.dropFile(reps.find(r => r.idx === 1 && r.slot === 0).tg_file_id);
    tgm.corruptFile(reps.find(r => r.idx === 0 && r.slot === 0).tg_file_id);
    await roundTrip('fallback.bin', local);
    assert.equal(await missing(), 2);
    // asking for the broken slot by name is an error, not silently another copy
    await assert.rejects(store.downloadChunk(reps[0].file.id, 1, 0), denied(404));
    await ticksUntil(async () => await missing() === 0, 'repair of reported replicas');
    assert.equal((await store.verify('fallback.bin')).bad.length, 0);
});

test('the scrubber finds a deleted message and restores the replica', { timeout: 120_000 }, async () => {
    const local = makeFile(3 * CHUNK - 7);
    await store.put(local, 'deleted.bin');
    const victim = (await replicas('deleted.bin')).find(r => r.idx === 1 && r.slot === 1);
    tgm.deleteMessage(B, victim.message_id);

    await ticksUntil(async () => await missing() === 1, 'detection of the deleted message');
    await ticksUntil(async () => await missing() === 0, 'repair');

    const now = (await replicas('deleted.bin')).find(r => r.id === victim.id);
    assert.equal(now.state, 'ok');
    assert.notEqual(now.message_id, victim.message_id);
    assert.equal(now.chat_id, B);
    assert.equal(tgm.message(B, now.message_id).caption, `${victim.file.id}:1`);
    assert.equal(sha256(tgm.bytes(now.tg_file_id)), victim.chunk.sha256);
    assert.equal(tgm.messages(B).size, 3);
    const kinds = (await store.status()).events.map(e => e.kind);
    assert.ok(kinds.includes('missing') && kinds.includes('repaired'));
    await roundTrip('deleted.bin', local);
});

test('the scrubber notices a stored file that is gone or the wrong size', { timeout: 120_000 }, async () => {
    const local = makeFile(2 * CHUNK);
    await store.put(local, 'gone.bin');
    const reps = await replicas('gone.bin');
    tgm.dropFile(reps.find(r => r.idx === 0 && r.slot === 0).tg_file_id);
    tgm.truncateFile(reps.find(r => r.idx === 1 && r.slot === 1).tg_file_id);
    await ticksUntil(async () => await missing() === 2, 'detection');
    await ticksUntil(async () => await missing() === 0, 'repair');
    assert.equal((await store.verify('gone.bin')).bad.length, 0);
    // the replaced messages are cleaned up, not left as clutter
    assert.equal(tgm.messages(A).size, 2);
    assert.equal(tgm.messages(B).size, 2);
    await roundTrip('gone.bin', local);
});

test('with both messages of a chunk deleted, it is rebuilt from the files Telegram still serves', { timeout: 120_000 }, async () => {
    const local = makeFile(CHUNK + 99);
    await store.put(local, 'both.bin');
    for (const r of (await replicas('both.bin')).filter(r => r.idx === 0)) tgm.deleteMessage(r.chat_id, r.message_id);
    await ticksUntil(async () => await missing() === 2, 'detection');
    assert.equal((await store.status()).chunksWithNoCopy, 1);
    await ticksUntil(async () => await missing() === 0, 'repair');
    assert.equal(tgm.messages(A).size, 2);
    assert.equal(tgm.messages(B).size, 2);
    await roundTrip('both.bin', local);
});

test('a chunk with no readable copy is never written off and recovers when a copy returns', { timeout: 120_000 }, async () => {
    const local = makeFile(CHUNK + 99);
    await store.put(local, 'nocopy.bin');
    const reps = (await replicas('nocopy.bin')).filter(r => r.idx === 0);
    for (const r of reps) tgm.dropFile(r.tg_file_id);
    await ticksUntil(async () => await missing() === 2, 'detection');
    for (let i = 0; i < 5; i++) await tick();
    const s = await store.status();
    assert.equal(s.replicas.missing, 2);
    assert.equal(s.chunksWithNoCopy, 1);
    assert.ok(s.events.some(e => e.kind === 'repair-failed'));
    await assert.rejects(store.get('nocopy.bin', outPath()), /no readable replica/);

    tgm.restoreFile(reps[1].tg_file_id);
    await ticksUntil(async () => await missing() === 0, 'recovery once a copy is back');
    assert.equal((await store.status()).chunksWithNoCopy, 0);
    await roundTrip('nocopy.bin', local);
});

test('a corrupt copy is caught when the scrubber tries to repair from it', { timeout: 120_000 }, async () => {
    const local = makeFile(CHUNK + 99);
    await store.put(local, 'corrupt.bin');
    const reps = (await replicas('corrupt.bin')).filter(r => r.idx === 0);
    tgm.corruptFile(reps.find(r => r.slot === 1).tg_file_id);
    tgm.deleteMessage(A, reps.find(r => r.slot === 0).message_id);
    await ticksUntil(async () => (await store.status()).events.some(e => e.kind === 'corrupt'), 'corrupt source noticed');
    await ticksUntil(async () => await missing() === 0, 'repair of both');
    assert.equal((await store.verify('corrupt.bin')).bad.length, 0);
    await roundTrip('corrupt.bin', local);
});

test('a rate limit pauses the scrubber without skipping any replica', { timeout: 120_000 }, async () => {
    await store.put(makeFile(3 * CHUNK), 'paced.bin'); // 6 replicas
    await freshPass();
    const checkedBefore = (await store.status()).kv.scrub.checked;
    tgm.rateLimit('editMessageCaption', 2);
    const first = await tick();
    assert.ok(first.checked < 6, `expected a partial run, checked ${first.checked}`);
    assert.equal(first.wrapped, false);
    assert.equal(first.missing, 0);
    await freshPass();
    assert.equal((await store.status()).kv.scrub.checked - checkedBefore, 6);
    assert.equal(await missing(), 0);
});

test('an unrecognised answer about a message never marks a replica missing, and the file is still checked', { timeout: 120_000 }, async () => {
    const local = makeFile(2 * CHUNK);
    await store.put(local, 'unclear.bin');
    await freshPass();
    tgm.failWith('editMessageCaption', "Bad Request: message can't be edited", 1000);
    await freshPass();
    const s = await store.status();
    assert.equal(s.replicas.missing || 0, 0);
    assert.match(s.kv.scrub.unclear.why, /can't be edited/);
    assert.equal(s.events.filter(e => /unclear/.test(e.kind)).length, 0, 'no event per replica');

    // the stored file is still looked at, so a file that is gone is caught even now
    tgm.dropFile((await replicas('unclear.bin')).find(r => r.idx === 0 && r.slot === 1).tg_file_id);
    await ticksUntil(async () => await missing() === 1, 'detection through the file check');
    tgm.failWith('editMessageCaption', '', 0);
    await ticksUntil(async () => await missing() === 0, 'repair');
    await roundTrip('unclear.bin', local);
});

test('an empty store does not count scrubber passes', async () => {
    const before = (await store.status()).kv.scrub.passes;
    for (let i = 0; i < 3; i++) assert.equal((await tick()).wrapped, false);
    assert.equal((await store.status()).kv.scrub.passes, before);
});

test('verify finds a corrupt replica and client-side repair fixes it', { timeout: 120_000 }, async () => {
    const local = makeFile(2 * CHUNK);
    await store.put(local, 'verify.bin');
    assert.deepEqual((await store.verify('verify.bin')).bad, []);
    const bad = (await replicas('verify.bin')).find(r => r.idx === 1 && r.slot === 0);
    tgm.corruptFile(bad.tg_file_id);
    const v = await store.verify('verify.bin');
    assert.equal(v.replicas, 4);
    assert.deepEqual(v.bad.map(b => [b.idx, b.slot]), [[1, 0]]);
    assert.equal(await missing(), 1);
    const r = await store.repair();
    assert.deepEqual([r.repaired, r.failed.length], [1, 0]);
    assert.equal(await missing(), 0);
    assert.deepEqual((await store.verify('verify.bin')).bad, []);
    assert.equal(tgm.messages(A).size, 2, 'the replaced message is removed');
});

// ---- the schedule -------------------------------------------------------

test('the scheduled handler runs the scrubber and respects pause', { timeout: 60_000 }, async () => {
    await store.put(makeFile(10), 'cron.bin');
    const lastRun = async () => (await store.status()).kv.scrub?.lastTickAt || 0;
    const fire = async () => {
        const r = await fetch(`${worker.url}/__scheduled?cron=*+*+*+*+*`);
        await r.text();
        await new Promise(res => setTimeout(res, 300));
    };
    // with files present and no backup yet, the first scheduled run is spent on the index backup
    assert.equal((await store.status()).kv.backup, undefined);
    await fire();
    const backup = (await store.status()).kv.backup;
    assert.equal(backup.messages.length, 2);
    assert.ok(tgm.pinned(A) && tgm.pinned(B));

    const t0 = await lastRun();
    await fire();
    const t1 = await lastRun();
    assert.ok(t1 > t0, 'a scheduled run should have been recorded');

    await store.api('PUT', '/settings', { paused: true });
    await fire();
    assert.equal(await lastRun(), t1, 'a paused scrubber must not run');
    await store.api('PUT', '/settings', { paused: false });
    await fire();
    assert.ok(await lastRun() > t1);
});

test('scheduled runs rest between passes instead of re-checking everything every minute', { timeout: 60_000 }, async () => {
    await store.put(makeFile(10), 'rest.bin'); // 2 replicas
    const fire = async () => { await (await fetch(`${worker.url}/__scheduled?cron=*+*+*+*+*`)).text(); };
    const checked = async () => (await store.status()).kv.scrub.checked;
    await store.api('PUT', '/settings', { scrubIntervalMinutes: 0 });
    try {
        await freshPass();
        const c0 = await checked();
        await fire();
        assert.equal(await checked(), c0 + 2, 'with no rest interval a scheduled run checks the replicas');

        await store.api('PUT', '/settings', { scrubIntervalMinutes: 360 });
        const c1 = await checked();
        await fire();
        await fire();
        assert.equal(await checked(), c1, 'a pass finished a moment ago is not repeated');

        // a broken replica reported by a client is still repaired while the scrubber rests
        const victim = (await replicas('rest.bin'))[0];
        tgm.dropFile(victim.tg_file_id);
        await store.report(victim.id, 'test');
        await fire();
        assert.equal(await missing(), 0);
    } finally {
        await store.api('PUT', '/settings', { scrubIntervalMinutes: 360 });
    }
});

// ---- losing the index or a channel --------------------------------------

test('the index backup is pinned in both channels; a brand-new empty index is rebuilt from it, keys included', { timeout: 180_000 }, async () => {
    const one = makeFile(CHUNK + 1), two = makeFile(500);
    await store.put(one, 'backup/one.bin');
    await store.put(two, 'backup/two.bin');
    const appKey = (await store.keyAdd('survivor', { prefix: 'backup/' })).key;
    const b = await store.backup();
    assert.equal(b.messages.length, 2);
    assert.deepEqual(b.problems, []);
    for (const chat of [A, B]) assert.ok(tgm.message(chat, tgm.pinned(chat)).caption.startsWith(BACKUP_TAG));

    // a second Worker with an empty database, as after losing the D1 database entirely
    const fresh = await startWorker({ tgApi: tgm.url });
    try {
        const admin = as(fresh.token, { url: fresh.url });
        assert.equal((await admin.ls()).length, 0);
        const r = await admin.restore([A, B]);
        assert.deepEqual([r.counts.files, r.counts.chunks, r.counts.replicas, r.counts.channels], [2, 3, 6, 2]);
        assert.ok(r.counts.keys >= 1);
        const out = outPath();
        await admin.get('backup/one.bin', out);
        assert.equal(shaOf(out), shaOf(one));
        // an app's key keeps working against the rebuilt index, with its limits
        const app = as(appKey, { url: fresh.url });
        const out2 = outPath();
        await app.get('backup/two.bin', out2);
        assert.equal(shaOf(out2), shaOf(two));
        assert.equal((await app.whoami()).prefix, 'backup/');
    } finally {
        await fresh.stop();
    }

    // a newer backup replaces the old messages
    const b2 = await store.backup();
    for (const m of b.messages) assert.equal(tgm.message(m.chat_id, m.message_id), undefined);
    for (const m of b2.messages) assert.equal(tgm.pinned(m.chat_id), m.message_id);
    for (const m of b2.messages) tgm.deleteMessage(m.chat_id, m.message_id);
});

test('restore fails clearly when no backup is pinned', async () => {
    tgm.addChat('-1999', 'empty');
    await assert.rejects(store.restore(['-1999']), /no pinned index backup/);
});

test('uploads move to a new channel when the current ones are full', { timeout: 60_000 }, async () => {
    await store.put(makeFile(10), 'full/first.bin');
    await store.api('PUT', '/settings', { channelLimit: 1 });
    try {
        await assert.rejects(store.put(makeFile(10), 'full/second.bin'), (e) => e.status === 507 && /slot 0/.test(e.message));
        tgm.addChat('-1003', 'channel C');
        tgm.addChat('-1004', 'channel D');
        await store.api('POST', '/channels', { chat_id: '-1003', slot: 0 });
        await store.api('POST', '/channels', { chat_id: '-1004', slot: 1 });
        const local = makeFile(10);
        await store.put(local, 'full/second.bin');
        assert.deepEqual((await replicas('full/second.bin')).map(r => r.chat_id), ['-1003', '-1004']);
        await roundTrip('full/second.bin', local);
    } finally {
        await store.api('PUT', '/settings', { channelLimit: 500_000 });
        await store.api('DELETE', '/channels/-1003');
        await store.api('DELETE', '/channels/-1004');
    }
});

test('when a whole channel is lost, its replicas are rebuilt in a replacement channel', { timeout: 120_000 }, async () => {
    const local = makeFile(2 * CHUNK);
    await store.put(local, 'channel-loss.bin');
    assert.deepEqual([...new Set((await replicas('channel-loss.bin')).map(r => r.chat_id))], [A, B]);
    tgm.killChat(B);
    await ticksUntil(async () => await missing() === 2, 'detection of the dead channel');
    for (let i = 0; i < 3; i++) await tick();
    assert.equal(await missing(), 2, 'nothing can be repaired while the slot has no working channel');
    await roundTrip('channel-loss.bin', local); // still readable from the other slot

    tgm.addChat('-1005', 'channel B2');
    await store.api('POST', '/channels', { chat_id: '-1005', slot: 1 });
    await store.api('DELETE', `/channels/${B}`);
    await ticksUntil(async () => await missing() === 0, 'rebuild in the replacement channel');
    assert.deepEqual((await replicas('channel-loss.bin')).filter(r => r.slot === 1).map(r => r.chat_id), ['-1005', '-1005']);
    assert.equal((await store.verify('channel-loss.bin')).bad.length, 0);
});
