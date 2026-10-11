// The web page in a real browser (playwright-core driving the Chrome that is already installed),
// served by the real Worker code under wrangler dev, against a simulated Telegram.
// EDGE_WEB_BROWSER picks another browser: chrome (default), msedge, or webkit / firefox if
// playwright has them installed.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, CHUNK, thumbPath } from '../client/lib.mjs';
import { startFakeTelegram } from './fake-telegram.mjs';
import { startWorker } from './local-worker.mjs';

const A = '-1001', B = '-1002';
const BOT_TOKEN = '123456:FAKE'; // what local-worker.mjs gives the Worker
const WHICH = process.env.EDGE_WEB_BROWSER || 'chrome';
let tgm, worker, store, tmp, browser, whyNot, seq = 0;
const contexts = [];

before(async () => {
    try {
        const pw = await import('playwright-core');
        browser = ['webkit', 'firefox'].includes(WHICH) ? await pw[WHICH].launch() : await pw.chromium.launch({ channel: WHICH });
    } catch (e) {
        whyNot = `no browser to test with (${String(e.message).split('\n')[0]}); run "npm install" and have Chrome installed`;
        return;
    }
    tgm = await startFakeTelegram();
    tgm.addChat(A, 'channel A');
    tgm.addChat(B, 'channel B');
    worker = await startWorker({ tgApi: tgm.url });
    store = new Store({ url: worker.url, token: worker.token, sleep: async () => {} });
    await store.api('POST', '/channels', { chat_id: A, slot: 0 });
    await store.api('POST', '/channels', { chat_id: B, slot: 1 });
    tmp = mkdtempSync(join(tmpdir(), 'edge-store-web-'));
}, { timeout: 180_000 });

after(async () => {
    await browser?.close();
    await worker?.stop();
    await tgm?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
});

afterEach(async () => {
    if (!browser) return;
    for (const c of contexts.splice(0)) await c.close();
    tgm.rateLimit('sendDocument', 0);
    for (const f of await store.ls('', { all: true })) await store.rmById(f.id);
    for (const k of await store.keyList()) if (!k.revoked_at) await store.keyRevoke(k.id);
});

const inBrowser = (name, fn) => test(name, { timeout: 180_000 }, async (t) => {
    if (!browser) return t.skip(whyNot);
    await fn(t);
});

function makeFile(name, size) {
    const dir = mkdtempSync(join(tmp, 'in-'));
    const path = join(dir, name);
    writeFileSync(path, randomBytes(size));
    return path;
}
function fileWith(name, bytes) {
    const path = join(mkdtempSync(join(tmp, 'in-')), name);
    writeFileSync(path, bytes);
    return path;
}

// A real picture: a w x h PNG with a colour gradient.
function png(w, h) {
    const crc = (buf) => {
        let c = ~0;
        for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
        return ~c >>> 0;
    };
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const out = Buffer.alloc(body.length + 8);
        out.writeUInt32BE(data.length, 0);
        body.copy(out, 4);
        out.writeUInt32BE(crc(body), body.length + 4);
        return out;
    };
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([Math.floor(255 * x / w), Math.floor(255 * y / h), 120], y * (w * 3 + 1) + 1 + x * 3);
    const head = Buffer.alloc(13);
    head.writeUInt32BE(w, 0);
    head.writeUInt32BE(h, 4);
    head.set([8, 2, 0, 0, 0], 8); // 8 bits per channel, RGB
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// One second of a quiet tone as a WAV file.
function wav() {
    const n = 8000;
    const out = Buffer.alloc(44 + n);
    out.write('RIFF', 0); out.writeUInt32LE(36 + n, 4); out.write('WAVEfmt ', 8);
    out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
    out.writeUInt32LE(8000, 24); out.writeUInt32LE(8000, 28); out.writeUInt16LE(1, 32); out.writeUInt16LE(8, 34);
    out.write('data', 36); out.writeUInt32LE(n, 40);
    for (let i = 0; i < n; i++) out[44 + i] = 128 + Math.round(20 * Math.sin(i / 3));
    return out;
}

const PDF = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj
trailer<</Root 1 0 R>>
%%EOF
`);

// A one-second 64x48 video, if ffmpeg is on this machine.
function mp4() {
    const out = join(mkdtempSync(join(tmp, 'vid-')), 'clip.mp4');
    const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10:duration=1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', out]);
    return r.status === 0 ? readFileSync(out) : null;
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const shaOf = (path) => sha(readFileSync(path));
const outPath = () => join(tmp, `out-${seq++}`);
const grant = async (name, opts) => (await store.keyAdd(name, opts)).key;
const stored = () => tgm.messages(A).size + tgm.messages(B).size;

// A fresh browser profile on the page, signed in if a key is given. Anything the page logs as an
// error (a blocked script or style, an uncaught exception) fails the test that opened it.
async function open(key, { path = '' } = {}) {
    const context = await browser.newContext({ acceptDownloads: true });
    contexts.push(context);
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (e) => { problems.push(`uncaught: ${e.message}`); if (process.env.EDGE_WEB_DEBUG) console.error('PAGE ERROR', e.stack); });
    page.on('console', (m) => {
        // a refused request (401, 403, 429) is logged by the browser itself and is expected here
        if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(m.text());
    });
    await page.goto(`${worker.url}/${key ? `#key=${key}` : ''}`);
    if (key) await accept(page);
    if (path) {
        await page.evaluate((hash) => { location.hash = hash; }, path);
        await page.locator('#drop-target', { hasText: path.slice(2) }).waitFor({ state: 'attached' }); // hidden for a key that cannot write
    }
    return { page, problems };
}

// A key that arrives in a link is only used once "Sign in" is pressed.
async function accept(page) {
    await page.click('#handover-ok');
    await page.locator('#app').waitFor();
}

// which of the Worker's addresses the page asked for from here on
function watch(page) {
    const paths = [];
    page.on('request', (r) => paths.push(decodeURIComponent(new URL(r.url()).pathname)));
    return { thumbs: () => paths.filter(p => p.includes('/.thumbs/')).length, chunks: () => paths.filter(p => p.includes('/chunks/')).length };
}
const tileSize = (page, path) => row(page, path).locator('.tile img').evaluate(async (img) => { await img.decode(); return [img.naturalWidth, img.naturalHeight]; });
const keptPreviews = (page) => page.evaluate(() => new Promise((res) => {
    const open = indexedDB.open('edge-store', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('thumbs');
    open.onsuccess = () => { const q = open.result.transaction('thumbs').objectStore('thumbs').count(); q.onsuccess = () => { open.result.close(); res(q.result); }; };
}));
async function until(what, check, ms = 10_000) {
    for (const end = Date.now() + ms; Date.now() < end;) {
        if (await check()) return;
        await new Promise(r => setTimeout(r, 100));
    }
    assert.fail(`${what}: not within ${ms} ms`);
}

const transfersDone = (page, n, state = 'done') => page.locator(`#transfer-list li[data-state="${state}"]`).nth(n - 1).waitFor({ timeout: 120_000 });
const row = (page, path) => page.locator(`#file-list li[data-path="${path.replace(/["\\]/g, '\\$&')}"]`);

async function download(page, path) {
    const [dl] = await Promise.all([page.waitForEvent('download'), row(page, path).getByRole('button', { name: 'Download' }).click()]);
    const out = outPath();
    await dl.saveAs(out);
    return { out, name: dl.suggestedFilename() };
}

// ---- tests ------------------------------------------------------------------

inBrowser('the page is served without a key and gives nothing away; the API still wants one', async () => {
    const page = await fetch(`${worker.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'.*script-src 'self'.*frame-ancestors 'self'/);
    for (const name of ['', 'app.js', 'util.js', 'app.css']) {
        const r = await fetch(`${worker.url}/${name}`);
        const text = await r.text();
        assert.equal(r.status, 200, name);
        assert.ok(!text.includes(worker.token) && !text.includes(BOT_TOKEN) && !text.includes(tgm.url), `${name} leaks`);
    }
    for (const path of ['/whoami', '/files', '/config', '/raw/app.js', '/app.jsx']) {
        assert.equal((await fetch(worker.url + path)).status, 401, path);
    }
});

inBrowser('a wrong key is refused; a good one opens the files, is remembered, and leaves the address bar', async () => {
    const key = await grant('browser');
    const { page, problems } = await open();
    await page.locator('#signin').waitFor();
    assert.ok(await page.locator('#app').isHidden());

    await page.fill('#key-input', `es_00000000_${'0'.repeat(64)}`);
    await page.click('#signin-form button');
    await page.locator('#signin-error', { hasText: 'not accepted' }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.length), 0);

    await page.fill('#key-input', key);
    await page.click('#signin-form button');
    await page.locator('#app').waitFor();
    assert.match(await page.textContent('#who'), /key "browser", can read and write/);
    await page.reload();
    await page.locator('#app').waitFor();

    await page.click('#signout');
    await page.locator('#signin').waitFor();
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    await page.reload();
    await page.locator('#signin').waitFor();

    // the link "edge web" opens, here arriving in a tab that already shows the page:
    // it says whose key it is and does nothing until it is told to
    await page.goto(`${worker.url}/#key=${key}`);
    await page.locator('#handover-who', { hasText: 'It is key "browser", can read and write.' }).waitFor();
    assert.ok(!page.url().includes(key), 'the key stayed in the address');
    assert.ok(await page.locator('#app').isHidden());
    assert.ok(await page.locator('#handover-now').isHidden());
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    await accept(page);
    assert.equal(await page.evaluate(() => localStorage.getItem('edge-store-key')), key);
    assert.deepEqual(problems, []);
});

inBrowser('a link cannot swap the key a browser is signed in with, or sign it in, without being confirmed', async () => {
    await store.put(makeFile('mine.txt', 100), 'mine.txt');
    await store.put(makeFile('theirs.txt', 100), 'drop-box/theirs.txt');
    const mine = await grant('my own key');
    const theirs = await grant('someone else', { prefix: 'drop-box/' });
    const { page, problems } = await open(mine);
    await row(page, 'mine.txt').waitFor();
    const kept = () => page.evaluate(() => localStorage.getItem('edge-store-key'));

    // a link carrying somebody else's key, followed while signed in
    await page.goto(`${worker.url}/#key=${theirs}`);
    await page.locator('#handover-who', { hasText: 'It is key "someone else", can read and write, limited to drop-box/.' }).waitFor();
    assert.match(await page.textContent('#handover-now'), /signed in with key "my own key".*will be forgotten here/);
    assert.ok(!page.url().includes(theirs));
    assert.equal(await kept(), mine);
    assert.match(await page.textContent('#who'), /key "my own key"/);

    // turned down: nothing has changed, and a file saved now still goes where this key's files go
    await page.click('#handover-cancel');
    assert.equal(await kept(), mine);
    await page.setInputFiles('#file-input', [makeFile('after.txt', 50)]);
    await transfersDone(page, 1);
    assert.ok((await store.ls()).some(f => f.path === 'after.txt'));
    await page.reload();
    await row(page, 'mine.txt').waitFor();
    assert.ok(await page.locator('#handover').isHidden());

    // the same link in a fresh tab of the same browser: Escape turns it down as well
    await page.goto(`${worker.url}/#key=${theirs}`);
    await page.locator('#handover-who', { hasText: 'someone else' }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await kept(), mine);

    // a link carrying the key already in use asks nothing
    await page.goto(`${worker.url}/#key=${mine}`);
    await row(page, 'mine.txt').waitFor();
    assert.ok(await page.locator('#handover').isHidden());
    assert.ok(!page.url().includes(mine));

    // accepted: only now is the key replaced
    await page.goto(`${worker.url}/#key=${theirs}`);
    await page.locator('#handover-who', { hasText: 'someone else' }).waitFor();
    await page.click('#handover-ok');
    await row(page, 'drop-box/theirs.txt').waitFor();
    assert.equal(await kept(), theirs);
    assert.match(await page.textContent('#who'), /key "someone else"/);

    // a link whose key does not work says so and changes nothing
    await page.goto(`${worker.url}/#key=es_00000000_${'0'.repeat(64)}`);
    await page.locator('#handover-title', { hasText: 'does not work' }).waitFor();
    assert.ok(await page.locator('#handover-ok').isHidden());
    await page.click('#handover-cancel');
    assert.equal(await kept(), theirs);
    await row(page, 'drop-box/theirs.txt').waitFor();
    assert.deepEqual(problems, []);
});

inBrowser('"edge web --link" grants a key for the page and prints a link that signs the browser in', async () => {
    const config = join(tmp, 'config.json');
    writeFileSync(config, JSON.stringify({ url: worker.url, token: worker.token }));
    const edge = (...args) => execFileSync(process.execPath, ['client/edge.mjs', ...args], { encoding: 'utf8', env: { ...process.env, EDGE_STORE_CONFIG: config } });
    const out = edge('web', '--link', '--prefix', 'web/');
    const link = out.match(/^http\S+#key=es_\S+$/m)?.[0];
    assert.ok(link?.startsWith(`${worker.url}/#key=`), out);
    const [k] = (await store.keyList()).filter(x => !x.revoked_at);
    assert.deepEqual([k.role, k.prefix], ['write', 'web/']);
    assert.match(k.name, /^web page, \d{4}-\d\d-\d\d$/);
    assert.ok(out.includes(`edge key revoke ${k.id}`));

    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(link);
    await accept(page);
    assert.equal(page.url(), `${worker.url}/`);
    assert.equal(await page.textContent('#drop-target'), 'web/');
    assert.match(edge('web', '--link', '--read-only'), /#key=es_/);
    assert.ok((await store.keyList()).some(x => x.role === 'read' && x.prefix === ''));
});

inBrowser('files chosen in the page are stored whole in two copies, and the command line reads them back identical', async () => {
    const empty = makeFile('empty.dat', 0);
    const small = makeFile('notes with spaces & ünïcode.txt', 1000);
    const big = makeFile('big.bin', 2 * CHUNK + 12345);
    const { page, problems } = await open(await grant('browser'));
    await page.locator('#empty', { hasText: 'Nothing stored yet' }).waitFor();

    await page.setInputFiles('#file-input', [empty, small, big]);
    await transfersDone(page, 3);
    assert.equal(stored(), (0 + 1 + 3) * 2);
    for (const [remote, local] of [['empty.dat', empty], ['notes with spaces & ünïcode.txt', small], ['big.bin', big]]) {
        await row(page, remote).waitFor();
        const out = outPath();
        await store.get(remote, out); // checks every chunk hash and the whole-file hash the page computed
        assert.equal(shaOf(out), shaOf(local), remote);
    }
    assert.match(await page.textContent('#summary'), /3 files here/);

    // the same file again is not stored twice
    await page.setInputFiles('#file-input', [small]);
    await page.locator('#transfer-list li[data-state="error"]', { hasText: 'Already stored here' }).waitFor();
    assert.equal(stored(), 8);

    // coming back later: a fresh load of the page still lists them
    await page.reload();
    for (const remote of ['empty.dat', 'big.bin']) await row(page, remote).waitFor();
    assert.match(await row(page, 'big.bin').textContent(), /32\.0 MB · saved /);
    assert.deepEqual(problems, []);
});

inBrowser('files dropped on the page are saved into the folder on show, and folders can be browsed', async () => {
    const { page, problems } = await open(await grant('browser'), { path: '#/trip/day 1/' });
    const dt = await page.evaluateHandle(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['hello from a drop'], 'a.txt'));
        dt.items.add(new File([new Uint8Array(3000)], 'b.bin'));
        dt.items.add(new File(['x'], '.DS_Store'));
        return dt;
    });
    await page.dispatchEvent('body', 'dragenter', { dataTransfer: dt });
    await page.locator('#drop-veil').waitFor();
    await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
    await transfersDone(page, 2);
    assert.ok(await page.locator('#drop-veil').isHidden());
    assert.deepEqual((await store.ls()).map(f => f.path), ['trip/day 1/a.txt', 'trip/day 1/b.bin']);
    const out = outPath();
    await store.get('trip/day 1/a.txt', out);
    assert.equal(readFileSync(out, 'utf8'), 'hello from a drop');

    // a reload stays in the folder and still shows what was just saved there
    await row(page, 'trip/day 1/a.txt').waitFor();
    await page.reload();
    await row(page, 'trip/day 1/a.txt').waitFor();
    assert.equal(await page.textContent('#drop-target'), 'trip/day 1/');

    // up to the top, then back down through the folder links
    await page.locator('#crumbs a', { hasText: 'All files' }).click();
    const folder = page.locator('#file-list a.f-name', { hasText: 'trip' });
    await folder.waitFor();
    assert.match(await page.locator('#file-list li').first().textContent(), /2 files/);
    await folder.click();
    await page.locator('#file-list a.f-name', { hasText: 'day 1' }).click();
    await row(page, 'trip/day 1/a.txt').waitFor();

    // the filter looks below the folder on show
    await page.locator('#crumbs a', { hasText: 'All files' }).click();
    await page.fill('#filter', 'B.BIN');
    await row(page, 'trip/day 1/b.bin').waitFor();
    assert.equal(await page.locator('#file-list li').count(), 1);
    assert.deepEqual(problems, []);
});

inBrowser('a download from the page is identical, and a damaged copy is noticed and the other one used', async () => {
    const local = makeFile('film.bin', 2 * CHUNK + 777);
    await store.put(local, 'media/film.bin');
    const { page, problems } = await open(await grant('browser'), { path: '#/media/' });
    let got = await download(page, 'media/film.bin');
    assert.equal(got.name, 'film.bin');
    assert.equal(shaOf(got.out), shaOf(local));
    await page.locator('#transfer-list li[data-state="done"]', { hasText: 'Downloaded and checked' }).waitFor();

    const m = await store.manifest('media/film.bin');
    tgm.corruptFile(m.chunkList[1].replicas.find(r => r.slot === 0).tg_file_id);
    got = await download(page, 'media/film.bin');
    assert.equal(shaOf(got.out), shaOf(local));
    // the page reported the bad copy, so the scrubber will re-make it
    for (let i = 0; i < 50 && !(await store.status()).replicas.missing; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal((await store.status()).replicas.missing, 1);

    // with both copies of a part damaged the download fails instead of handing over bad data
    tgm.corruptFile(m.chunkList[1].replicas.find(r => r.slot === 1).tg_file_id);
    await row(page, 'media/film.bin').getByRole('button', { name: 'Download' }).click();
    await page.locator('#transfer-list li[data-state="error"]', { hasText: 'part 2 could not be read from either copy' }).waitFor();
    assert.deepEqual(problems, []);
});

inBrowser('a large download is written straight to the chosen file, part by part', async () => {
    const local = makeFile('huge.bin', 2 * CHUNK + 5);
    await store.put(local, 'huge.bin');
    const { page, problems } = await open(await grant('browser'));
    // stands in for the save dialog, which a test cannot click through
    await page.evaluate(() => {
        window.saved = { writes: [], closed: false, asked: null };
        window.showSaveFilePicker = async (opts) => {
            window.saved.asked = opts.suggestedName;
            return { createWritable: async () => ({
                write: async (w) => { window.saved.writes.push(w); },
                close: async () => { window.saved.closed = true; },
                abort: async () => {},
            }) };
        };
        window.edgeStore.streamAbove = 0;
    });
    await row(page, 'huge.bin').getByRole('button', { name: 'Download' }).click();
    await transfersDone(page, 1);
    const result = await page.evaluate(async () => {
        const size = Math.max(...window.saved.writes.map(w => w.position + w.data.length));
        const all = new Uint8Array(size);
        for (const w of window.saved.writes) all.set(w.data, w.position);
        const digest = await crypto.subtle.digest('SHA-256', all);
        return { size, closed: window.saved.closed, asked: window.saved.asked, writes: window.saved.writes.length,
            sha: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('') };
    });
    assert.deepEqual(result, { size: 2 * CHUNK + 5, closed: true, asked: 'huge.bin', writes: 3, sha: shaOf(local) });
    assert.deepEqual(problems, []);
});

inBrowser('on a phone-sized screen nothing is cut off or scrolls sideways', async () => {
    await store.put(makeFile('x', 100), `${'a-very-long-unbroken-name-'.repeat(8)}.mov`);
    await store.put(makeFile('y', 100), 'a folder with quite a long name too, for good measure/inside.txt');
    const key = await grant('a key with a long name so that the line at the top has to be shortened', { prefix: '' });
    const context = await browser.newContext({ viewport: { width: 360, height: 700 } });
    contexts.push(context);
    const page = await context.newPage();
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await page.goto(`${worker.url}/`);
    await page.locator('#signin').waitFor();
    assert.ok(await fits(), 'the sign-in form is wider than the screen');
    await page.goto(`${worker.url}/#key=${key}`);
    await page.locator('#handover-who').waitFor();
    assert.ok(await fits(), 'the question about the key in a link is wider than the screen');
    await accept(page);
    await page.locator('#file-list li').nth(1).waitFor();
    await page.setInputFiles('#file-input', [makeFile(`${'another-long-unbroken-name-'.repeat(6)}.bin`, 100)]);
    await transfersDone(page, 1);
    assert.ok(await fits(), 'the file list is wider than the screen');
    // the viewer as well, with its buttons within reach
    await page.locator('#file-list button.f-name').first().click();
    await page.locator('#viewer-body p').waitFor();
    assert.ok(await fits(), 'the viewer is wider than the screen');
    for (const id of ['viewer-close', 'viewer-download', 'viewer-next']) {
        const box = await page.locator(`#${id}`).boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= 360 && box.y >= 0, `${id} is off the screen`);
    }
    await page.click('#viewer-close');
    for (const id of ['signout', 'choose', 'refresh', 'filter']) assert.ok(await page.locator(`#${id}`).isVisible(), id);
});

inBrowser('a picture saved in the page gets a small preview stored beside it, which later visits fetch in place of the picture', async () => {
    const sky = fileWith('sky.png', png(600, 400));
    const { page, problems } = await open(await grant('browser'), { path: '#/pics/' });
    await page.setInputFiles('#file-input', [sky, fileWith('notes.txt', 'just words'), fileWith('broken.jpg', randomBytes(5000))]);
    await transfersDone(page, 3);
    assert.deepEqual(await tileSize(page, 'pics/sky.png'), [256, 171]);

    // the preview is an ordinary small file, named after the picture's id, and only real pictures get one
    const listed = await store.ls();
    const picture = listed.find(f => f.path === 'pics/sky.png');
    assert.deepEqual(listed.map(f => f.path).sort(), ['pics/broken.jpg', 'pics/notes.txt', 'pics/sky.png', thumbPath('pics/sky.png', picture.id)].sort());
    const out = outPath();
    await store.get(thumbPath('pics/sky.png', picture.id), out);
    const small = readFileSync(out);
    assert.deepEqual([...small.subarray(0, 3)], [0xff, 0xd8, 0xff], 'the preview is a JPEG');
    assert.ok(small.length < 20_000 && small.length < readFileSync(sky).length, `preview of ${small.length} bytes`);
    assert.equal(stored(), 4 * 2);

    // the page does not show the previews as files of their own
    assert.equal(await page.locator('#file-list li').count(), 3);
    assert.match(await page.textContent('#summary'), /3 files here .* 3 files in total/);
    assert.equal(await row(page, 'pics/broken.jpg').locator('.tile').textContent(), 'jpg');
    assert.equal(await row(page, 'pics/notes.txt').locator('.tile img').count(), 0);

    // another browser: one small request for the preview, and the picture itself is not downloaded
    const other = await open(await grant('second browser'));
    const asked = watch(other.page);
    await other.page.locator('#file-list a.f-name', { hasText: 'pics' }).click();
    assert.deepEqual(await tileSize(other.page, 'pics/sky.png'), [256, 171]);
    // redrawing the list while the preview is on its way must not ask for it again
    await other.page.fill('#filter', 's');
    await other.page.fill('#filter', '');
    await other.page.waitForTimeout(300);
    assert.deepEqual([asked.thumbs(), asked.chunks()], [1, 0]);
    // and from then on that browser has it at hand
    await other.page.reload();
    assert.deepEqual(await tileSize(other.page, 'pics/sky.png'), [256, 171]);
    assert.deepEqual([asked.thumbs(), asked.chunks()], [1, 0]);
    assert.equal(await keptPreviews(other.page), 1);

    // signing out leaves no previews behind in the browser
    await other.page.click('#signout');
    await until('previews forgotten', async () => await keptPreviews(other.page) === 0);
    assert.deepEqual([...problems, ...other.problems], []);
});

inBrowser('a picture stored some other way is not downloaded for the list; opening it makes its preview', async () => {
    const local = fileWith('photo.png', png(400, 800));
    await store.put(local, 'cli/photo.png');
    await store.put(local, 'cli/second.png');
    const { page, problems } = await open(await grant('browser'), { path: '#/cli/' });
    const asked = watch(page);
    await page.reload();
    await row(page, 'cli/photo.png').waitFor();
    await page.waitForTimeout(700);
    assert.deepEqual([asked.thumbs(), asked.chunks()], [0, 0], 'the list fetched something for a preview');
    assert.equal(await row(page, 'cli/photo.png').locator('.tile').textContent(), 'png');

    await row(page, 'cli/photo.png').locator('button.f-name').click();
    const shownAt = await page.locator('#viewer-body img').evaluate(async (img) => { await img.decode(); return [img.naturalWidth, img.naturalHeight]; });
    assert.deepEqual(shownAt, [400, 800]);
    assert.equal(asked.chunks(), 1);
    await page.keyboard.press('Escape');
    assert.deepEqual(await tileSize(page, 'cli/photo.png'), [128, 256]);
    const id = (await store.manifest('cli/photo.png')).id;
    await until('the preview to be stored', async () => (await store.ls()).some(f => f.path === thumbPath('cli/photo.png', id)));
    assert.equal(await row(page, 'cli/second.png').locator('.tile img').count(), 0);

    // a key that may only read cannot store a preview, so it keeps one in its own browser
    const viewer = await open(await grant('viewer', { role: 'read' }), { path: '#/cli/' });
    await row(viewer.page, 'cli/second.png').locator('button.tile').click();
    await viewer.page.locator('#viewer-body img').waitFor();
    assert.deepEqual(await tileSize(viewer.page, 'cli/second.png'), [128, 256]);
    assert.equal(await keptPreviews(viewer.page), 2);
    assert.equal((await store.ls()).length, 3);
    assert.deepEqual([...problems, ...viewer.problems], []);
});

inBrowser('pictures, text, sound, video and PDFs open in the page; anything in them stays inert', async () => {
    const clip = mp4();
    const web = '<script>window.pwned = 1</script><b>bold</b><img src=x onerror="window.pwned = 2">';
    const put = async (name, bytes) => store.put(fileWith(name, bytes), `mix/${name}`);
    await put('a.png', png(320, 200));
    await put('b.txt', 'first line\nsecond line');
    await put('c.wav', wav());
    await put('d.pdf', PDF);
    if (clip) await put('e.mp4', clip);
    await put('f.bin', randomBytes(100));
    await put('g.html', web);
    await put('h.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30" onload="window.pwned = 3"><script>window.pwned = 4; parent.pwned = 5</script><rect width="40" height="30" fill="red"/></svg>`);
    await put('i.jpg', randomBytes(3000));
    await put('j.log', 'x'.repeat(5000));
    const { page, problems } = await open(await grant('viewer', { role: 'read' }), { path: '#/mix/' });
    const show = (name) => row(page, `mix/${name}`).locator('button.f-name').click();
    const body = page.locator('#viewer-body');

    await show('a.png');
    assert.deepEqual(await body.locator('img').evaluate(async (img) => { await img.decode(); return [img.naturalWidth, img.naturalHeight]; }), [320, 200]);
    assert.equal(await page.textContent('#viewer-name'), 'a.png');
    assert.ok(await page.locator('#viewer-prev').isDisabled());

    // the arrows, on screen and on the keyboard, step through the files that can be shown
    await page.click('#viewer-next');
    assert.equal(await body.locator('pre').textContent(), 'first line\nsecond line');
    await page.keyboard.press('ArrowRight');
    await body.locator('audio').waitFor();
    await until('the sound to be readable', () => body.locator('audio').evaluate((a) => a.readyState >= 1 && Math.round(a.duration) === 1));
    await page.keyboard.press('ArrowLeft');
    await body.locator('pre').waitFor();
    await page.keyboard.press('Escape');
    assert.ok(!(await page.locator('#viewer').evaluate((d) => d.open)));

    await show('d.pdf');
    assert.match(await body.locator('iframe').getAttribute('src'), /^blob:/);
    assert.match(await body.locator('a', { hasText: 'Open in a new tab' }).getAttribute('href'), /^blob:/);
    if (clip) {
        await page.click('#viewer-next');
        await until('the video to be readable', () => body.locator('video').evaluate((v) => v.videoWidth === 64 && v.videoHeight === 48));
    }
    await page.click('#viewer-close');

    // a web page is shown as its text, a picture with a script in it as a picture
    await show('g.html');
    assert.equal(await body.locator('pre').textContent(), web);
    assert.equal(await body.locator('pre *').count(), 0);
    await page.click('#viewer-next');
    assert.equal(await page.textContent('#viewer-name'), 'h.svg');
    assert.deepEqual(await body.locator('img').evaluate(async (img) => { await img.decode(); return [img.naturalWidth, img.naturalHeight]; }), [40, 30]);
    assert.equal(await page.evaluate(() => window.pwned), undefined);

    // what cannot be shown says so
    await page.click('#viewer-next');
    await body.locator('p', { hasText: 'This browser cannot show this file' }).waitFor();
    assert.equal(await row(page, 'mix/f.bin').locator('button').count(), 1, 'only Download for a file that cannot be shown');
    await page.evaluate(() => { window.edgeStore.previewMax = 100; window.edgeStore.textMax = 1000; });
    await page.click('#viewer-prev');
    await body.locator('p', { hasText: 'too large to show here' }).waitFor();
    await page.click('#viewer-next');
    await page.click('#viewer-next');
    assert.match(await body.locator('pre').textContent(), /^x{1000}\n\n… this is the first 1000 B of 4\.9 KB$/);

    // Download in the viewer hands over the real file
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#viewer-download')]);
    assert.equal(dl.suggestedFilename(), 'j.log');
    assert.deepEqual(problems, []);
});

inBrowser('deleting a picture in the page deletes its stored preview with it', async () => {
    const { page, problems } = await open(await grant('browser'));
    await page.setInputFiles('#file-input', [fileWith('one.png', png(300, 300)), fileWith('two.png', png(300, 300))]);
    await transfersDone(page, 2);
    await until('both previews to be stored', async () => (await store.ls()).length === 4);
    const del = row(page, 'one.png').locator('button.danger');
    await del.click();
    await del.click();
    await row(page, 'one.png').waitFor({ state: 'detached' });
    const two = (await store.manifest('two.png')).id;
    await until('the preview to go', async () => (await store.ls()).length === 2);
    assert.deepEqual((await store.ls()).map(f => f.path).sort(), [thumbPath('two.png', two), 'two.png'].sort());
    assert.equal(stored(), 4);
    assert.equal(await keptPreviews(page), 1);
    assert.deepEqual(problems, []);
});

inBrowser('deleting asks twice, then removes the file and its stored copies', async () => {
    await store.put(makeFile('old.txt', 500), 'old.txt');
    await store.put(makeFile('keep.txt', 500), 'keep.txt');
    const { page, problems } = await open(await grant('browser'));
    const del = row(page, 'old.txt').locator('button.danger');
    await del.click();
    assert.equal(await del.textContent(), 'Really delete?');
    assert.equal((await store.ls()).length, 2);
    await del.click();
    await row(page, 'old.txt').waitFor({ state: 'detached' });
    assert.deepEqual((await store.ls()).map(f => f.path), ['keep.txt']);
    assert.equal(stored(), 2);
    assert.deepEqual(problems, []);
});

inBrowser('a read-only key can look and download but is offered no way to change anything', async () => {
    const local = makeFile('report.pdf', 4000);
    await store.put(local, 'report.pdf');
    const { page, problems } = await open(await grant('viewer', { role: 'read' }));
    await row(page, 'report.pdf').waitFor();
    assert.match(await page.textContent('#who'), /can only read/);
    assert.ok(await page.locator('#drop').isHidden());
    assert.equal(await page.locator('button.danger').count(), 0);
    assert.ok(await page.locator('#health').isHidden());
    // a drop is ignored as well
    const dt = await page.evaluateHandle(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'sneak.txt')); return dt; });
    await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
    assert.equal(shaOf((await download(page, 'report.pdf')).out), shaOf(local));
    assert.deepEqual((await store.ls('', { all: true })).map(f => f.path), ['report.pdf']);
    assert.deepEqual(problems, []);
});

inBrowser('a key limited to a folder starts there, sees nothing else, and cannot save outside it', async () => {
    await store.put(makeFile('secret.txt', 100), 'private/secret.txt');
    await store.put(makeFile('mine.txt', 100), 'apps/photos/mine.txt');
    const { page, problems } = await open(await grant('photos', { prefix: 'apps/photos/' }));
    await row(page, 'apps/photos/mine.txt').waitFor();
    assert.equal(await page.textContent('#drop-target'), 'apps/photos/');
    assert.match(await page.textContent('#summary'), /1 file in total/);

    await page.setInputFiles('#file-input', [makeFile('new.jpg', 2000)]);
    await transfersDone(page, 1);
    await page.locator('#crumbs a', { hasText: 'All files' }).click();
    await page.locator('#file-list a.f-name', { hasText: 'apps' }).waitFor();
    assert.equal(await page.locator('#file-list li').count(), 1); // only the "apps" folder
    await page.setInputFiles('#file-input', [makeFile('outside.jpg', 2000)]);
    await page.locator('#transfer-list li[data-state="error"]', { hasText: 'limited to paths starting with "apps/photos/"' }).waitFor();
    assert.deepEqual((await store.ls()).map(f => f.path), ['apps/photos/mine.txt', 'apps/photos/new.jpg', 'private/secret.txt']);
    assert.deepEqual(problems, []);
});

inBrowser('an upload that was interrupted earlier is picked up without re-sending what is stored', async () => {
    const local = makeFile('resume.bin', 2 * CHUNK + 99);
    const bytes = readFileSync(local);
    // an earlier attempt got the first chunk in and then stopped
    const begin = await store.api('POST', '/files', { path: 'resume.bin', size: bytes.length, chunkSize: CHUNK, chunks: 3 });
    const first = bytes.subarray(0, CHUNK);
    await store.sendBytes('PUT', `/files/${begin.id}/chunks/0?sha256=${sha(first)}`, first);
    assert.equal(stored(), 2);

    const { page, problems } = await open(await grant('browser'));
    await page.setInputFiles('#file-input', [local]);
    await page.locator('#transfer-list li[data-state="done"]', { hasText: 'picked up an earlier, unfinished upload' }).waitFor({ timeout: 120_000 });
    assert.equal(stored(), 6);
    const out = outPath();
    await store.get('resume.bin', out);
    assert.equal(shaOf(out), shaOf(local));
    assert.deepEqual(problems, []);
});

inBrowser('an upload held up by Telegram says so, and cancelling it takes it back out of the store', async () => {
    const { page, problems } = await open(await grant('browser'));
    // one small file goes through first, so that something is stored when the hold-up starts
    await page.setInputFiles('#file-input', [makeFile('first.txt', 100)]);
    await transfersDone(page, 1);
    tgm.rateLimit('sendDocument', 100_000);
    await page.setInputFiles('#file-input', [makeFile('stuck.bin', CHUNK + 10)]);
    const stuck = page.locator('#transfer-list li', { hasText: 'stuck.bin' });
    await stuck.locator('.t-status', { hasText: 'Waiting to try again' }).waitFor({ timeout: 60_000 });
    assert.deepEqual((await store.ls('', { all: true })).map(f => [f.path, f.state]), [['first.txt', 'complete'], ['stuck.bin', 'uploading']]);

    await stuck.getByRole('button', { name: 'Cancel' }).click();
    await page.locator('#transfer-list li[data-state="cancelled"]', { hasText: 'stuck.bin' }).waitFor({ timeout: 60_000 });
    tgm.rateLimit('sendDocument', 0);
    assert.deepEqual((await store.ls('', { all: true })).map(f => f.path), ['first.txt']);
    assert.equal(stored(), 2);

    await page.click('#clear-transfers');
    assert.ok(await page.locator('#transfers').isHidden());
    assert.deepEqual(problems, []);
});

inBrowser('a key that is revoked while the page is open is signed out and forgotten', async () => {
    const k = await store.keyAdd('browser');
    const { page, problems } = await open(k.key);
    await page.locator('#empty', { hasText: 'Nothing stored yet' }).waitFor();
    await store.keyRevoke(k.id);
    await page.click('#refresh');
    await page.locator('#signin-error', { hasText: 'not accepted' }).waitFor();
    assert.ok(await page.locator('#app').isHidden());
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    assert.deepEqual(problems, []);
});

inBrowser('the owner also sees whether every stored copy is in place', async () => {
    await store.put(makeFile('doc.txt', 100), 'doc.txt');
    const { page, problems } = await open(worker.token);
    assert.match(await page.textContent('#who'), /owner token, full control/);
    await page.locator('#health', { hasText: 'All 2 stored copies are in place. No full check has finished yet.' }).waitFor();

    const m = await store.manifest('doc.txt');
    await store.api('POST', `/replicas/${m.chunkList[0].replicas[0].id}`, { state: 'missing', why: 'test' });
    await page.click('#refresh');
    await page.locator('#health.warn', { hasText: '1 copy went missing and is being re-made' }).waitFor();
    assert.deepEqual(problems, []);
});

inBrowser('a file name cannot run as part of the page', async () => {
    const evil = '<img src=x onerror="window.pwned=1">.txt';
    const local = makeFile('plain.txt', 10);
    await store.put(local, evil);
    await store.put(local, '<script>window.pwned=1</script>/inner.txt');
    const { page } = await open(await grant('browser'));
    await page.locator('#file-list li').nth(1).waitFor();
    assert.equal(await page.locator('#file-list img, #file-list script').count(), 0);
    assert.equal(await row(page, evil).locator('.f-name').textContent(), evil);
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    assert.equal((await download(page, evil)).name.includes('onerror'), true);
});
