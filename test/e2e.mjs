// Live end-to-end test against the deployed Worker and real Telegram.
// Uses the owner's client config written by scripts/setup.mjs. Sends about 1.2 GB through the Worker.
// Run: node test/e2e.mjs            (everything)
//      node test/e2e.mjs --no-big   (skip the 1 GB round trip)
//      node test/e2e.mjs --no-wipe  (skip the step that empties the index and restores it from the
//                                    backup; anything saved by someone else during those seconds
//                                    would drop out of the index, so skip it while the store is in use)
import { readFileSync, mkdtempSync, openSync, writeSync, closeSync, rmSync, createReadStream } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, CHUNK, thumbPath } from '../client/lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(process.env.EDGE_STORE_CONFIG || join(homedir(), '.config', 'edge-store', 'config.json'), 'utf8'));
const store = new Store(config);
const tmp = mkdtempSync(join(tmpdir(), 'edge-store-e2e-'));
const prefix = `e2e-${Date.now()}/`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const secs = (t0) => ((Date.now() - t0) / 1000).toFixed(0) + 's';

let seq = 0;
function makeFile(size) {
    const path = join(tmp, `in-${seq++}`);
    const fd = openSync(path, 'w');
    for (let off = 0; off < size; off += 8 << 20) writeSync(fd, randomBytes(Math.min(8 << 20, size - off)));
    closeSync(fd);
    return path;
}
const shaOf = (path) => new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
});

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
    head.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const results = [];
async function step(name, fn) {
    const t0 = Date.now();
    try {
        const note = await fn();
        results.push(true);
        console.log(`PASS  ${name}  [${secs(t0)}]${note ? '  ' + note : ''}`);
    } catch (e) {
        results.push(false);
        console.log(`FAIL  ${name}  [${secs(t0)}]  ${e.message}`);
    }
}
const check = (cond, message) => { if (!cond) throw new Error(message); };

async function roundTrip(remote, local) {
    const out = join(tmp, `out-${seq++}`);
    await store.get(remote, out);
    check(await shaOf(out) === await shaOf(local), `${remote} came back different`);
    rmSync(out);
}

function d1(sql) {
    const r = spawnSync('npx', ['--no-install', 'wrangler', 'd1', 'execute', 'edge-store', '--remote', '-y', '--command', sql], { cwd: join(root, 'worker'), encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`d1 "${sql}" failed`);
}

// a message's caption can only be "edited" if the message exists
async function messageExists(r, fileId, idx) {
    try {
        await store.telegram('editMessageCaption', { chat_id: r.chat_id, message_id: r.message_id, caption: `${fileId}:${idx}` });
        return true;
    } catch (e) {
        if (/not modified/.test(e.message)) return true;
        if (/not found/.test(e.message)) return false;
        throw e;
    }
}

// -------------------------------------------------------------------------

const small = makeFile(1000);
const two = makeFile(CHUNK + 1);
const three = makeFile(3 * CHUNK - 12345);

await step('requests without the access token are refused', async () => {
    check((await fetch(`${config.url}/status`)).status === 401, 'expected 401');
});

await step('the store starts healthy', async () => {
    const s = await store.status();
    check(!s.kv.paused, 'scrubber is paused');
    check((s.replicas.missing || 0) === 0, `${s.replicas.missing} replicas already missing`);
    check(s.channels.filter(c => c.active).length >= 2, 'need an open channel for each slot');
});

await step('a small file and a two-chunk file round-trip byte-identical', async () => {
    await store.put(small, prefix + 'small.bin');
    await store.put(two, prefix + 'two.bin');
    await roundTrip(prefix + 'small.bin', small);
    await roundTrip(prefix + 'two.bin', two);
    const m = await store.manifest(prefix + 'two.bin');
    check(m.chunks === 2 && m.chunkList.every(c => c.replicas.length === 2), 'expected 2 chunks with 2 replicas each');
    check(new Set(m.chunkList.flatMap(c => c.replicas.map(r => r.chat_id))).size === 2, 'replicas should be in two channels');
});

let appKey;
await step('an app key can be granted, is confined to its prefix, and plain HTTP works with it', async () => {
    const k = await store.keyAdd('e2e app', { prefix: prefix + 'app/' });
    appKey = k;
    const app = new Store({ url: config.url, token: k.key });
    const me = await app.whoami();
    check(me.role === 'write' && me.prefix === prefix + 'app/', `unexpected identity ${JSON.stringify(me)}`);
    const local = makeFile(200_000);
    await app.put(local, prefix + 'app/doc.bin');
    const out = join(tmp, `out-${seq++}`);
    await app.get(prefix + 'app/doc.bin', out);
    check(await shaOf(out) === await shaOf(local), 'app round trip differs');

    // one-request upload and download, as curl would do it
    const auth = { authorization: `Bearer ${k.key}` };
    const bytes = randomBytes(50_000);
    const put = await fetch(`${config.url}/raw/${prefix}app/raw.bin`, { method: 'PUT', headers: auth, body: bytes });
    check(put.status === 200, `raw PUT gave ${put.status}`);
    const got = await fetch(`${config.url}/raw/${prefix}app/raw.bin`, { headers: auth });
    check(Buffer.from(await got.arrayBuffer()).equals(bytes), 'raw GET returned different bytes');

    // outside its prefix, and for administration, the key is refused
    for (const [method, path] of [['GET', `/file?path=${encodeURIComponent(prefix + 'small.bin')}`], ['GET', `/raw/${prefix}small.bin`], ['GET', '/status'], ['GET', '/keys'], ['GET', '/config']]) {
        const r = await fetch(config.url + path, { method, headers: auth });
        check(r.status === 403, `${method} ${path} gave ${r.status}, expected 403`);
    }
    const cfg = JSON.stringify(await store.api('GET', '/config')) + JSON.stringify(await app.whoami());
    check(!/botToken|\d{8,}:[\w-]{30,}/.test(cfg), 'something that looks like a bot token was returned');
});

await step('the web page, in a real browser, saves a file through the deployed Worker and gets it back', async () => {
    const home = await fetch(`${config.url}/`);
    check(home.status === 200 && /text\/html/.test(home.headers.get('content-type')), `the page gave ${home.status}`);
    check(/default-src 'none'/.test(home.headers.get('content-security-policy') || ''), 'the page came without its content security policy');
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome' });
    try {
        const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
        const problems = [];
        page.on('pageerror', (e) => problems.push(e.message));
        page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
        // the key is confined to its folder, so that is where the page starts
        await page.goto(`${config.url}/#key=${appKey.key}`);
        await page.click('#handover-ok'); // a key from a link is used only once this is pressed
        await page.locator('#file-list li').first().waitFor({ timeout: 60_000 });
        check(await page.textContent('#drop-target') === prefix + 'app/', 'the page did not start in the key\'s folder');
        check(!page.url().includes('es_'), 'the key stayed in the address bar');

        const t0 = Date.now();
        await page.setInputFiles('#file-input', [{ name: 'from-page.bin', mimeType: 'application/octet-stream', buffer: readFileSync(two) }]);
        await page.locator('#transfer-list li[data-state="done"]').waitFor({ timeout: 300_000 });
        const up = secs(t0);
        await roundTrip(prefix + 'app/from-page.bin', two); // the command-line client reads what the page stored

        const item = page.locator(`#file-list li[data-path="${prefix}app/from-page.bin"]`);
        const t1 = Date.now();
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 300_000 }), item.getByRole('button', { name: 'Download' }).click()]);
        const out = join(tmp, `out-${seq++}`);
        await dl.saveAs(out);
        check(await shaOf(out) === await shaOf(two), 'the page downloaded different bytes');
        const down = secs(t1);

        await item.locator('button.danger').click();
        await item.locator('button.danger').click();
        await item.waitFor({ state: 'detached', timeout: 60_000 });
        check(!(await store.ls(prefix)).some(f => f.path.endsWith('from-page.bin')), 'the file is still listed after deleting it in the page');

        // a picture: its preview is stored beside it, it opens in the page, and both go when it is deleted
        const shot = prefix + 'app/shot.png';
        await page.setInputFiles('#file-input', [{ name: 'shot.png', mimeType: 'image/png', buffer: png(800, 500) }]);
        const pic = page.locator(`#file-list li[data-path="${shot}"]`);
        await pic.locator('.tile img').waitFor({ timeout: 120_000 });
        const id = (await store.manifest(shot)).id;
        let preview = null;
        for (let i = 0; i < 60 && !preview; i++) {
            preview = (await store.ls(prefix)).find(f => f.path === thumbPath(shot, id));
            if (!preview) await sleep(1000);
        }
        check(preview && preview.size < 20_000, `no small preview was stored beside the picture (${preview?.size})`);
        await page.reload();
        await pic.locator('.tile img').waitFor({ timeout: 60_000 });
        await pic.locator('button.f-name').click();
        const seen = await page.locator('#viewer-body img').evaluate(async (img) => { await img.decode(); return `${img.naturalWidth}x${img.naturalHeight}`; }, null, { timeout: 60_000 });
        check(seen === '800x500', `the viewer showed ${seen}`);
        await page.click('#viewer-close');
        await pic.locator('button.danger').click();
        await pic.locator('button.danger').click();
        await pic.waitFor({ state: 'detached', timeout: 60_000 });
        for (let i = 0; i < 30 && (await store.ls(prefix + 'app/.thumbs/')).length; i++) await sleep(1000);
        check(!(await store.ls(prefix)).some(f => f.path.includes('shot.png') || f.path.includes('.thumbs/')), 'the picture or its preview outlived the delete');
        check(problems.length === 0, `the page logged: ${problems.join('; ')}`);
        return `16 MB up in ${up}, down in ${down}; picture preview ${preview.size} B`;
    } finally {
        await browser.close();
    }
});

await step('an interrupted upload resumes', async () => {
    let uploads = 0;
    const flaky = new Store({ ...config, sleep: async () => {}, fetch: (url, init) => {
        if (init.method === 'PUT' && /\/chunks\/\d+/.test(String(url)) && ++uploads > 1) throw new TypeError('fetch failed');
        return fetch(url, init);
    } });
    let failed = false;
    try { await flaky.put(three, prefix + 'three.bin'); } catch { failed = true; }
    check(failed, 'the interrupted upload should have failed');
    check(!(await store.ls(prefix)).some(f => f.path.endsWith('three.bin')), 'a half-uploaded file must not be listed');
    const r = await store.put(three, prefix + 'three.bin');
    check(r.resumed, 'expected the second run to resume');
    await roundTrip(prefix + 'three.bin', three);
});

// The root claim: delete one replica by hand, and the scheduled job alone restores it.
await step('the scheduled job detects a hand-deleted replica and restores it', async () => {
    const before = await store.manifest(prefix + 'three.bin');
    const victim = before.chunkList[1].replicas.find(r => r.slot === 1);
    await store.telegram('deleteMessage', { chat_id: victim.chat_id, message_id: victim.message_id });
    check(!(await messageExists(victim, before.id, 1)), 'the message should be gone');

    // normally a pass starts at most every 6 hours; for the test, let passes follow each other
    const interval = (await store.status()).kv.scrub_interval_min ?? 360;
    await store.api('PUT', '/settings', { scrubIntervalMinutes: 0 });
    const t0 = Date.now();
    let detectedAt = null, now = null;
    try {
        while (Date.now() - t0 < 12 * 60_000) {
            await sleep(10_000);
            now = (await store.manifest(prefix + 'three.bin')).chunkList[1].replicas.find(r => r.id === victim.id);
            if (now.state === 'missing' && !detectedAt) detectedAt = Date.now();
            if (now.state === 'ok' && now.message_id !== victim.message_id) break;
        }
    } finally {
        await store.api('PUT', '/settings', { scrubIntervalMinutes: interval });
    }
    check(now.state === 'ok' && now.message_id !== victim.message_id, `not repaired after ${secs(t0)} (state ${now.state})`);
    check(await messageExists(now, before.id, 1), 'the new replica message should exist');
    const events = (await store.status()).events.filter(e => e.detail.includes(`replica ${victim.id} `));
    check(events.some(e => e.kind === 'missing') && events.some(e => e.kind === 'repaired'), 'expected missing and repaired events');
    const v = await store.verify(prefix + 'three.bin');
    check(v.bad.length === 0 && v.replicas === 6, `deep verify: ${v.bad.length} bad of ${v.replicas}`);
    await roundTrip(prefix + 'three.bin', three);
    return `detected after ${detectedAt ? Math.round((detectedAt - t0) / 1000) + 's' : '(between polls)'}, restored after ${secs(t0)}`;
});

if (!process.argv.includes('--no-wipe')) await step('the index backup is pinned, and restore rebuilds a wiped index', async () => {
    await store.api('PUT', '/settings', { paused: true });
    try {
        const b = await store.backup();
        check(b.messages.length === 2, `backup reached ${b.messages.length} channel(s): ${b.problems.join('; ')}`);
        check(b.problems.length === 0, b.problems.join('; '));
        for (const t of ['replicas', 'chunks', 'files', 'channels', 'keys']) d1(`DELETE FROM ${t}`);
        check((await fetch(`${config.url}/whoami`, { headers: { authorization: `Bearer ${appKey.key}` } })).status === 401, 'the app key should be unknown after the wipe');
        check((await store.ls(prefix)).length === 0, 'index should be empty after the wipe');
        const r = await store.restore(config.chats);
        check(r.counts.files >= 5 && r.counts.channels >= 2 && r.counts.keys >= 1, `restored ${JSON.stringify(r.counts)}`);
        check((await store.ls(prefix)).length === 5, 'expected the five test files back');
        check((await fetch(`${config.url}/whoami`, { headers: { authorization: `Bearer ${appKey.key}` } })).status === 200, 'the app key should work again after restore');
        await roundTrip(prefix + 'two.bin', two);
        await roundTrip(prefix + 'three.bin', three);
        return `restored ${JSON.stringify(r.counts)}`;
    } finally {
        await store.api('PUT', '/settings', { paused: false });
    }
});

if (!process.argv.includes('--no-big')) {
    await step('a 1 GB file round-trips byte-identical', async () => {
        const big = makeFile(1 << 30);
        const app = new Store({ url: config.url, token: appKey.key });
        const t0 = Date.now();
        await app.put(big, prefix + 'app/big.bin');
        const up = (Date.now() - t0) / 1000;
        const t1 = Date.now();
        const out = join(tmp, `out-${seq++}`);
        await app.get(prefix + 'app/big.bin', out);
        check(await shaOf(out) === await shaOf(big), 'the 1 GB file came back different');
        rmSync(out);
        const down = (Date.now() - t1) / 1000;
        const m = await store.manifest(prefix + 'app/big.bin');
        check(m.chunks === 64, `expected 64 chunks, got ${m.chunks}`);
        rmSync(big);
        return `upload ${up.toFixed(0)}s (${(1024 / up).toFixed(1)} MB/s, two replicas), download ${down.toFixed(0)}s (${(1024 / down).toFixed(1)} MB/s)`;
    });
}

await step('rm deletes the Telegram messages and the index entries', async () => {
    const files = await store.ls(prefix);
    const sample = await store.manifest(prefix + 'two.bin');
    for (const f of files) await store.rm(f.path);
    check((await store.ls(prefix)).length === 0, 'files still listed');
    for (const c of sample.chunkList) for (const r of c.replicas) check(!(await messageExists(r, sample.id, c.idx)), 'a message survived rm');
    return `${files.length} files removed`;
});

await step('a revoked key stops working at once', async () => {
    await store.keyRevoke(appKey.id);
    const r = await fetch(`${config.url}/whoami`, { headers: { authorization: `Bearer ${appKey.key}` } });
    check(r.status === 401, `revoked key gave ${r.status}`);
    check((await store.keyList()).find(k => k.id === appKey.id)?.revoked_at > 0, 'key not shown as revoked');
});

await step('the store ends healthy', async () => {
    const s = await store.status();
    check((s.replicas.missing || 0) === 0, `${s.replicas.missing} replicas missing`);
    check(s.chunksWithNoCopy === 0, 'a chunk has no copy');
    check(!s.kv.paused, 'scrubber left paused');
    return `scrubber last ran ${new Date(s.kv.scrub.lastTickAt).toISOString()}, ${s.kv.scrub.checked} checks so far`;
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
