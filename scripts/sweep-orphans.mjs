// Finds bot messages in the store's channels that the index does not know about, and deletes them.
// Such messages can be left behind when a run is killed between an upload and its index write.
// It probes message ids one by one, so it is only practical on small channels.
// Run: node scripts/sweep-orphans.mjs [--delete] [extra-ids-to-probe-beyond-the-newest-known]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Store, pool, printable } from '../client/lib.mjs';

const store = new Store(JSON.parse(readFileSync(process.env.EDGE_STORE_CONFIG || join(homedir(), '.config', 'edge-store', 'config.json'), 'utf8')));
const doDelete = process.argv.includes('--delete');
const margin = Number(process.argv.find(a => /^\d+$/.test(a)) || 300);

const status = await store.status();
const keep = new Map(status.channels.map(c => [c.chat_id, new Set()]));
for (const m of status.kv.backup?.messages || []) keep.get(m.chat_id)?.add(m.message_id);
for (const f of await store.ls('', { all: true })) {
    const m = await store.api('GET', `/files/${f.id}`);
    for (const c of m.chunkList) for (const r of c.replicas) keep.get(r.chat_id)?.add(r.message_id);
}

for (const ch of status.channels) {
    const known = keep.get(ch.chat_id);
    // a pinned backup tells us roughly how far the ids go
    const pin = (await store.telegram('getChat', { chat_id: ch.chat_id }).catch(() => null))?.pinned_message;
    const top = Math.max(0, ...known, pin?.message_id || 0) + margin;
    const orphans = [];
    let foreign = 0;
    // Forwarding is the only way a bot can read an old message without changing it. A message counts
    // as an orphan only if it carries a document captioned the way edge-store captions its own.
    const ours = /^([0-9a-f]{8}-[0-9a-f-]{27}:\d+|edge-store-backup .*)$/;
    await pool([...Array(top).keys()].map(i => i + 1).filter(id => !known.has(id)), 3, async (id) => {
        let copy;
        try {
            copy = await store.telegram('forwardMessage', { chat_id: ch.chat_id, from_chat_id: ch.chat_id, message_id: id, disable_notification: true });
        } catch (e) {
            if (/not found|MESSAGE_ID_INVALID|can't be forwarded/i.test(e.message)) return;
            throw e;
        }
        await store.telegram('deleteMessage', { chat_id: ch.chat_id, message_id: copy.message_id }).catch(() => {});
        if (copy.document && ours.test(copy.caption || '')) orphans.push(id);
        else foreign++;
    });
    orphans.sort((a, b) => a - b);
    console.log(`"${printable(ch.title)}": probed ids 1-${top}, ${known.size} known to the index, ${orphans.length} orphan(s)${orphans.length ? ' ' + JSON.stringify(orphans) : ''}, ${foreign} other message(s) left alone`);
    if (doDelete && orphans.length) {
        for (let i = 0; i < orphans.length; i += 100) await store.telegram('deleteMessages', { chat_id: ch.chat_id, message_ids: orphans.slice(i, i + 100) });
        console.log(`  deleted ${orphans.length}`);
    }
}
if (!doDelete) console.log('dry run: pass --delete to remove the orphans');
