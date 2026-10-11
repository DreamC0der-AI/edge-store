// Spike for claims tg-bytes, tg-replica, tg-liveness and tg-rate.
// Needs spike/.env with TG_BOT_TOKEN, TG_CHAT_A, TG_CHAT_B (two private channels, bot is admin in both).
// Run: node spike/tg.mjs            (all tests; uploads about 400 MB)
//      node spike/tg.mjs bytes replica liveness   (skip the rate test)
import { readFileSync, writeFileSync } from 'node:fs';
import { randomFillSync, createHash } from 'node:crypto';

const env = Object.fromEntries(readFileSync(new URL('./.env', import.meta.url), 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const { TG_BOT_TOKEN: T, TG_CHAT_A: A, TG_CHAT_B: B } = env;
if (!T || !A || !B) { console.error('spike/.env must set TG_BOT_TOKEN, TG_CHAT_A and TG_CHAT_B'); process.exit(2); }

const API = `https://api.telegram.org/bot${T}`;
const FILE = `https://api.telegram.org/file/bot${T}`;
const MiB = 1024 * 1024;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const rand = (n) => { const b = Buffer.alloc(n); randomFillSync(b); return b; };

const out = { startedAt: new Date().toISOString(), tests: {} };
const created = []; // [chat, message_id] to clean up
let throttled = [];

// Returns the raw Telegram reply; waits out rate limits and records them.
async function tg(method, body, isForm = false) {
    for (;;) {
        const r = await fetch(`${API}/${method}`, isForm
            ? { method: 'POST', body }
            : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (j.error_code === 429) {
            const wait = j.parameters?.retry_after ?? 5;
            throttled.push({ method, wait });
            console.log(`   429 on ${method}, waiting ${wait}s`);
            await sleep((wait + 1) * 1000);
            continue;
        }
        return j;
    }
}

async function upload(chat, bytes, name = 'c.bin') {
    const form = new FormData();
    form.append('chat_id', chat);
    form.append('disable_notification', 'true');
    form.append('document', new Blob([bytes], { type: 'application/octet-stream' }), name);
    const t = performance.now();
    const j = await tg('sendDocument', form, true);
    if (!j.ok) return { ok: false, error: j.description, secs: (performance.now() - t) / 1000 };
    created.push([chat, j.result.message_id]);
    const d = j.result.document;
    return { ok: true, message_id: j.result.message_id, file_id: d.file_id, unique: d.file_unique_id, size: d.file_size, secs: (performance.now() - t) / 1000 };
}

async function download(file_id, headers = {}, method = 'GET') {
    const g = await tg('getFile', { file_id });
    if (!g.ok) return { ok: false, stage: 'getFile', error: g.description };
    const r = await fetch(`${FILE}/${g.result.file_path}`, { method, headers });
    const buf = method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await r.arrayBuffer());
    return { ok: r.ok, status: r.status, bytes: buf.length, sha: buf.length ? sha(buf) : null, contentLength: r.headers.get('content-length'), contentRange: r.headers.get('content-range'), acceptRanges: r.headers.get('accept-ranges') };
}

// Forwarding returns the full message, so it both proves the message exists and yields a file_id.
async function forward(fromChat, message_id, toChat) {
    const j = await tg('forwardMessage', { chat_id: toChat, from_chat_id: fromChat, message_id, disable_notification: true });
    if (!j.ok) return { ok: false, error: j.description };
    created.push([toChat, j.result.message_id]);
    const d = j.result.document;
    return { ok: true, message_id: j.result.message_id, file_id: d?.file_id, unique: d?.file_unique_id };
}

const del = (chat, message_id) => tg('deleteMessage', { chat_id: chat, message_id });
const log = (name, value) => console.log(`${name.padEnd(44)} ${typeof value === 'string' ? value : JSON.stringify(value)}`);

// -------------------------------------------------------------------------

const tests = {
    async bytes() {
        const r = out.tests.bytes = {};
        const chunk = rand(16 * MiB + 16);
        const up = await upload(A, chunk);
        log('upload 16 MiB chunk', up.ok ? `ok in ${up.secs.toFixed(1)}s, size ${up.size}` : up.error);
        if (!up.ok) return;
        const dl = await download(up.file_id);
        r.identical = dl.ok && dl.sha === sha(chunk);
        log('download is byte-identical', String(r.identical));
        r.range = await download(up.file_id, { Range: 'bytes=0-1023' });
        log('Range bytes=0-1023', { status: r.range.status, bytes: r.range.bytes, contentRange: r.range.contentRange });
        r.rangeMatches = r.range.bytes === 1024 && r.range.sha === sha(chunk.subarray(0, 1024));
        log('Range content matches', String(r.rangeMatches));
        r.midRange = await download(up.file_id, { Range: `bytes=${8 * MiB}-${8 * MiB + 4095}` });
        r.midRangeMatches = r.midRange.sha === sha(chunk.subarray(8 * MiB, 8 * MiB + 4096));
        log('Range from the middle matches', { status: r.midRange.status, ok: r.midRangeMatches });
        r.head = await download(up.file_id, {}, 'HEAD');
        log('HEAD', { status: r.head.status, contentLength: r.head.contentLength, acceptRanges: r.head.acceptRanges });

        const big = rand(21 * MiB);
        const upBig = await upload(A, big);
        r.bigUpload = upBig.ok;
        log('upload 21 MiB', upBig.ok ? 'ok' : upBig.error);
        if (upBig.ok) {
            const dlBig = await download(upBig.file_id);
            r.bigDownload = dlBig.ok ? 'downloaded' : dlBig.error;
            log('download 21 MiB via getFile', r.bigDownload);
        }
        const up49 = await upload(A, rand(49 * MiB));
        r.upload49 = up49.ok ? `ok in ${up49.secs.toFixed(1)}s` : up49.error;
        log('upload 49 MiB', r.upload49);
        const up51 = await upload(A, rand(51 * MiB));
        r.upload51 = up51.ok ? 'ok' : up51.error;
        log('upload 51 MiB', r.upload51);
    },

    async replica() {
        const r = out.tests.replica = {};
        const chunk = rand(16 * MiB + 16);
        const want = sha(chunk);
        const orig = await upload(A, chunk);
        if (!orig.ok) return log('upload original', orig.error);

        const cp = await tg('copyMessage', { chat_id: B, from_chat_id: A, message_id: orig.message_id, disable_notification: true });
        r.copyOk = cp.ok;
        log('copyMessage A -> B', cp.ok ? `ok, message ${cp.result.message_id}` : cp.description);
        if (cp.ok) created.push([B, cp.result.message_id]);
        // a copy returns no file_id, so forward it within B to learn one
        const cpInfo = cp.ok ? await forward(B, cp.result.message_id, B) : { ok: false };
        r.copySharesFile = cpInfo.ok ? cpInfo.unique === orig.unique : null;
        log('copy shares the underlying file', String(r.copySharesFile));

        const second = await upload(B, chunk);
        r.secondUploadSharesFile = second.ok ? second.unique === orig.unique : null;
        log('second upload shares the underlying file', String(r.secondUploadSharesFile));

        const d = await del(A, orig.message_id);
        r.deletedOriginal = d.ok;
        log('delete original in A', d.ok ? 'ok' : d.description);
        await sleep(3000);

        const viaCopy = cpInfo.ok ? await download(cpInfo.file_id) : { ok: false };
        r.copySurvives = viaCopy.ok && viaCopy.sha === want;
        log('copy still downloads identical', String(r.copySurvives));
        const viaSecond = second.ok ? await download(second.file_id) : { ok: false };
        r.secondSurvives = viaSecond.ok && viaSecond.sha === want;
        log('second upload still downloads identical', String(r.secondSurvives));

        // liveness, part (a): does the old file_id notice that its message is gone?
        const l = out.tests.liveness = {};
        const stale = await download(orig.file_id, { Range: 'bytes=0-0' });
        l.fileIdOutlivesMessage = stale.ok;
        log('old file_id still works after delete', stale.ok ? `yes (status ${stale.status})` : `no: ${stale.error || stale.status}`);

        // part (b): forwarding as an existence check
        const fDead = await forward(A, orig.message_id, B);
        l.forwardDeleted = fDead.ok ? 'succeeded' : fDead.error;
        log('forward of deleted message', l.forwardDeleted);
        const fLive = await forward(B, second.message_id, B);
        l.forwardLive = fLive.ok ? 'succeeded' : fLive.error;
        l.forwardGivesSameFile = fLive.ok ? fLive.unique === second.unique : null;
        log('forward of live message', `${l.forwardLive}, same file: ${l.forwardGivesSameFile}`);

        // part (c): a check that leaves nothing behind
        const eDead = await tg('editMessageCaption', { chat_id: A, message_id: orig.message_id, caption: '' });
        l.editDeleted = eDead.ok ? 'succeeded' : eDead.description;
        log('edit caption of deleted message', l.editDeleted);
        const eLive = await tg('editMessageCaption', { chat_id: B, message_id: second.message_id, caption: '' });
        l.editLive = eLive.ok ? 'succeeded' : eLive.description;
        log('edit caption of live message (no change)', l.editLive);
    },

    async liveness() { /* runs inside replica(), which has the deleted message */ },

    async rate() {
        const r = out.tests.rate = { chunks: [] };
        const n = Number(env.TG_RATE_CHUNKS || 20);
        throttled = [];
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
            const up = await upload(A, rand(16 * MiB + 16));
            r.chunks.push(up.ok ? Number(up.secs.toFixed(1)) : up.error);
            console.log(`   chunk ${i + 1}/${n}: ${up.ok ? up.secs.toFixed(1) + 's' : up.error}`);
        }
        const secs = (performance.now() - t0) / 1000;
        r.totalSecs = Math.round(secs);
        r.failed = r.chunks.filter(c => typeof c !== 'number').length;
        r.throttled = throttled;
        r.gbPerHour = Number(((n - r.failed) * 16 / 1024 / (secs / 3600)).toFixed(2));
        log(`uploaded ${n - r.failed}/${n} chunks`, `${r.totalSecs}s total, ${r.gbPerHour} GB/hour, ${throttled.length} rate-limit waits`);
    },
};

const me = await tg('getMe', {});
if (!me.ok) { console.error('getMe failed:', me.description); process.exit(2); }
console.log(`bot: @${me.result.username}`);
for (const [name, chat] of [['A', A], ['B', B]]) {
    const c = await tg('getChat', { chat_id: chat });
    if (!c.ok) { console.error(`cannot see chat ${name}: ${c.description}`); process.exit(2); }
    console.log(`chat ${name}: ${c.result.type} "${c.result.title}"`);
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['bytes', 'replica', 'rate'];
try {
    for (const name of wanted) {
        console.log(`\n== ${name} ==`);
        await tests[name]();
    }
} finally {
    console.log(`\ncleaning up ${created.length} test messages`);
    let failed = 0;
    for (const [chat, id] of created) { const d = await del(chat, id); if (!d.ok && !/not found/.test(d.description)) failed++; }
    if (failed) console.log(`${failed} messages could not be deleted`);
    out.finishedAt = new Date().toISOString();
    writeFileSync(new URL('./tg-results.json', import.meta.url), JSON.stringify(out, null, 2));
    console.log('results written to spike/tg-results.json');
}
