#!/usr/bin/env node
// edge-store command line.
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Store, printable, safe } from './lib.mjs';

const CONFIG = process.env.EDGE_STORE_CONFIG || join(homedir(), '.config', 'edge-store', 'config.json');

const USAGE = `edge-store: stable file storage on Telegram, indexed by a Cloudflare Worker

  edge init <worker-url> <key>            save connection settings (owner token or an app key)
  edge whoami                             what this key may do
  edge web [--link] [--read-only] [--prefix <path/>]   open the web page with a new key to sign in with
  edge key add <name> [--read-only|--admin] [--prefix <path/>]   grant a key to an app (shown once)
  edge key ls                             list keys and when they were last used
  edge key revoke <key-id>                stop a key working
  edge channel add <chat-id> <slot>       register a channel for replica slot 0 or 1
  edge channel rm <chat-id>               stop uploading to a channel
  edge put <local-file> [remote-path]     upload (resumes an interrupted upload)
  edge get <remote-path> [local-file]     download and verify
  edge ls [prefix]                        list files
  edge rm <remote-path>                   delete a file
  edge status                             replica health and scrubber progress
  edge verify [prefix]                    download every replica and check its hash
  edge repair                             re-upload replicas marked missing
  edge clean                              remove uploads abandoned more than a day ago, and previews of deleted pictures
  edge backup                             snapshot the index into the channels now
  edge restore                            rebuild the index from the pinned snapshot
  edge pause | resume                     stop or restart the scheduled scrubber

Files are stored as given. Encrypt them first if they are private.`;

const size = (n) => {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const when = (ms) => ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : 'never';

async function loadConfig() {
    try {
        return JSON.parse(await readFile(CONFIG, 'utf8'));
    } catch {
        throw new Error(`not set up yet: run "edge init <worker-url> <access-token>" (looked in ${CONFIG})`);
    }
}

async function saveConfig(cfg) {
    await mkdir(dirname(CONFIG), { recursive: true });
    await writeFile(CONFIG, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    await chmod(CONFIG, 0o600);
}

function progress(verb) {
    let done = 0;
    let bytes = 0;
    const started = Date.now();
    return ({ chunks, bytes: b, skipped }) => {
        done++;
        if (!skipped) bytes += b;
        const rate = bytes / Math.max(1, (Date.now() - started) / 1000);
        process.stderr.write(`\r${verb} chunk ${done}/${chunks}  ${size(rate)}/s   `);
        if (done === chunks) process.stderr.write('\n');
    };
}

function openInBrowser(link) {
    const [bin, ...rest] = process.platform === 'darwin' ? ['open', link]
        : process.platform === 'win32' ? ['cmd', '/c', 'start', '', link]
        : ['xdg-open', link];
    return new Promise((res, rej) => {
        const child = spawn(bin, rest, { stdio: 'ignore', detached: true });
        child.on('error', rej);
        child.on('spawn', () => { child.unref(); res(); });
    });
}

async function main([cmd, ...args]) {
    if (!cmd || cmd === 'help' || cmd === '--help') return console.log(USAGE);

    if (cmd === 'init') {
        const [url, token] = args;
        if (!url || !token) throw new Error('usage: edge init <worker-url> <access-token>');
        const store = new Store({ url, token });
        const me = await store.whoami();
        // the owner's copy remembers the channels, so the index can be restored even if it is lost
        const chats = me.role === 'admin' ? (await store.api('GET', '/config')).channels.map(c => c.chat_id) : undefined;
        await saveConfig({ url, token, chats });
        return console.log(safe`saved ${CONFIG}; signed in as "${me.name}" with ${me.role} access${me.prefix ? ` to ${me.prefix}` : ''}`);
    }

    const config = await loadConfig();
    const store = new Store(config);

    switch (cmd) {
        case 'whoami': {
            const me = await store.whoami();
            return console.log(safe`"${me.name}": ${me.role} access${me.prefix ? `, limited to ${me.prefix}` : ''}`);
        }
        case 'web': {
            const url = config.url.replace(/\/+$/, '');
            const role = args.includes('--read-only') ? 'read' : 'write';
            const prefix = args.includes('--prefix') ? args[args.indexOf('--prefix') + 1] : '';
            // the page gets a key of its own, so it can be revoked without touching anything else
            const k = await store.keyAdd(`web page, ${new Date().toISOString().slice(0, 10)}`, { role, prefix });
            const link = `${url}/#key=${k.key}`;
            const after = safe`The browser remembers the key until you sign out there; afterwards just open ${url}` + '\n' + safe`Revoke it with: edge key revoke ${k.id}`;
            if (args.includes('--link')) {
                console.log(printable(link));
                return console.log(safe`Open this link once in the browser you want to sign in and press "Sign in" there (it carries new key ${k.id}).` + '\n' + after);
            }
            try {
                await openInBrowser(link);
            } catch {
                await store.keyRevoke(k.id);
                throw new Error(`could not start a browser here; run "edge web --link" and open the link yourself`);
            }
            return console.log(safe`opened ${url} with new key ${k.id} ("${k.name}"); press "Sign in" there.` + '\n' + after);
        }
        case 'key': {
            const [sub, ...rest] = args;
            if (sub === 'add') {
                const name = rest.find(a => !a.startsWith('--') && a !== rest[rest.indexOf('--prefix') + 1]);
                if (!name) throw new Error('usage: edge key add <name> [--read-only|--admin] [--prefix <path/>]');
                const role = rest.includes('--admin') ? 'admin' : rest.includes('--read-only') ? 'read' : 'write';
                const prefix = rest.includes('--prefix') ? rest[rest.indexOf('--prefix') + 1] : '';
                const k = await store.keyAdd(name, { role, prefix });
                console.log(safe`key "${k.name}" (${k.id}): ${k.role} access${k.prefix ? `, limited to ${k.prefix}` : ''}`);
                console.log(printable(k.key));
                return console.log(safe`This is the only time the key is shown. Revoke it with: edge key revoke ${k.id}`);
            }
            if (sub === 'ls') {
                const keys = await store.keyList();
                for (const k of keys) {
                    console.log(safe`${k.id}  ${k.role.padEnd(5)}  ${(k.prefix || '(everything)').padEnd(20)}  ${k.revoked_at ? 'REVOKED ' + when(k.revoked_at) : 'last used ' + when(k.last_used_at)}  ${k.name}`);
                }
                return console.log(safe`${keys.filter(k => !k.revoked_at).length} active key(s), ${keys.filter(k => k.revoked_at).length} revoked`);
            }
            if (sub === 'revoke') {
                if (!rest[0]) throw new Error('usage: edge key revoke <key-id>');
                await store.keyRevoke(rest[0]);
                return console.log(safe`key ${rest[0]} revoked`);
            }
            throw new Error('usage: edge key add <name> [...] | edge key ls | edge key revoke <key-id>');
        }
        case 'channel': {
            const [sub, chatId, slot] = args;
            if (sub === 'add') {
                const c = await store.api('POST', '/channels', { chat_id: chatId, slot: Number(slot) });
                await saveConfig({ ...config, chats: [...new Set([...(config.chats || []), c.chat_id])] });
                return console.log(safe`channel "${c.title}" registered for slot ${c.slot}`);
            }
            if (sub === 'rm') {
                await store.api('DELETE', `/channels/${encodeURIComponent(chatId)}`);
                return console.log(safe`channel ${chatId} retired; existing replicas there are still used`);
            }
            throw new Error('usage: edge channel add <chat-id> <slot> | edge channel rm <chat-id>');
        }
        case 'put': {
            const [local, remote = local && basename(local)] = args;
            if (!local) throw new Error('usage: edge put <local-file> [remote-path]');
            const r = await store.put(local, remote, { onProgress: progress('uploaded') });
            return console.log(safe`${remote}: ${size(r.size)} in ${r.chunks} chunk(s), two replicas each${r.resumed ? ' (resumed)' : ''}`);
        }
        case 'get': {
            const [remote, local = remote && basename(remote)] = args;
            if (!remote) throw new Error('usage: edge get <remote-path> [local-file]');
            const f = await store.get(remote, local, { onProgress: progress('downloaded') });
            return console.log(safe`${local}: ${size(f.size)}, hash verified`);
        }
        case 'ls': {
            const files = await store.ls(args[0] || '');
            for (const f of files) console.log(safe`${size(f.size).padStart(10)}  ${when(f.created_at)}  ${f.path}`);
            return console.log(safe`${files.length} file(s), ${size(files.reduce((n, f) => n + f.size, 0))}`);
        }
        case 'rm': {
            if (!args[0]) throw new Error('usage: edge rm <remote-path>');
            const r = await store.rm(args[0]);
            return console.log(safe`${args[0]}: removed (${r.messages} messages)`);
        }
        case 'status': {
            const s = await store.status();
            const scrub = s.kv.scrub || {};
            console.log(safe`files:     ${s.files.complete?.n || 0} complete (${size(s.files.complete?.bytes || 0)}), ${s.files.uploading?.n || 0} uploading`);
            console.log(safe`replicas:  ${s.replicas.ok || 0} ok, ${s.replicas.missing || 0} missing`);
            console.log(safe`chunks with no readable copy on record: ${s.chunksWithNoCopy}`);
            const every = s.kv.scrub_interval_min ?? 360;
            console.log(safe`scrubber:  ${s.kv.paused ? 'PAUSED' : 'running'}, last run ${when(scrub.lastTickAt)}, ${scrub.passes || 0} full pass(es), last finished ${when(scrub.passDoneAt)}`);
            console.log(safe`           a pass starts at most every ${every} minute(s); current pass started ${when(scrub.passStartedAt)}`);
            if (scrub.unclear) console.log(safe`           note: ${scrub.unclear.count} check(s) got an unrecognised answer at ${when(scrub.unclear.at)}: ${scrub.unclear.why}`);
            console.log(safe`backup:    last ${when(s.kv.backup?.at)}${s.kv.backup?.problems?.length ? ' (' + s.kv.backup.problems.join('; ') + ')' : ''}`);
            for (const c of s.channels) console.log(safe`channel:   slot ${c.slot} "${c.title}" ${c.active ? 'open' : 'retired'}, ${c.messages} messages`);
            for (const e of s.events.slice(0, 10)) console.log(safe`event:     ${when(e.at)} ${e.kind} ${e.detail}`);
            return;
        }
        case 'verify': {
            const r = await store.verify(args[0] || '', { onProgress: ({ path, idx, slot, ok }) => { if (!ok) console.log(safe`BAD  ${path} chunk ${idx} slot ${slot}`); } });
            console.log(safe`${r.files} file(s), ${r.replicas} replica(s) read, ${r.bad.length} bad`);
            if (r.bad.length) process.exitCode = 1;
            return;
        }
        case 'repair': {
            const r = await store.repair({ onProgress: (p) => console.log(safe`${p.ok ? 'repaired' : 'FAILED  '} ${p.path} chunk ${p.idx}${p.ok ? '' : ': ' + p.why}`) });
            console.log(safe`${r.repaired} repaired, ${r.failed.length} failed`);
            if (r.failed.length) process.exitCode = 1;
            return;
        }
        case 'clean': {
            const paths = await store.clean();
            return console.log(safe`${paths.length} abandoned upload(s) and leftover preview(s) removed${paths.length ? ': ' + paths.join(', ') : ''}`);
        }
        case 'backup': {
            const b = await store.backup();
            return console.log(safe`index backed up: ${b.rows} rows, ${size(b.bytes)}, ${b.messages.length} channel(s)${b.problems.length ? '; ' + b.problems.join('; ') : ''}`);
        }
        case 'restore': {
            if (!config.chats?.length) throw new Error('this config has no channel list; restore must be run with the owner token');
            const r = await store.restore(config.chats);
            return console.log(safe`index restored from the backup of ${when(r.takenAt)}: ${Object.entries(r.counts).map(([t, n]) => `${n} ${t}`).join(', ')}`);
        }
        case 'pause':
        case 'resume':
            await store.api('PUT', '/settings', { paused: cmd === 'pause' });
            return console.log(safe`scrubber ${cmd === 'pause' ? 'paused' : 'running'}`);
        default:
            throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
    }
}

main(process.argv.slice(2)).catch((e) => {
    console.error(`edge: ${String(e.message).split('\n').map(printable).join('\n')}`);
    process.exit(1);
});
