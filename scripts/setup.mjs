// One-time deployment: creates the D1 database, deploys the Worker, sets its secrets,
// writes the client config and registers the two channels. Prints no secret values.
// Run: node scripts/setup.mjs [path-to-env-file]     (default: spike/.env)
// The env file must define TG_BOT_TOKEN, TG_CHAT_A and TG_CHAT_B.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { root, workerDir, databaseId, writeConfig } from './wrangler-config.mjs';

const configPath = process.env.EDGE_STORE_CONFIG || join(homedir(), '.config', 'edge-store', 'config.json');

const envFile = resolve(process.argv[2] || join(root, 'spike', '.env'));
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
for (const k of ['TG_BOT_TOKEN', 'TG_CHAT_A', 'TG_CHAT_B']) if (!env[k]) throw new Error(`${envFile} does not define ${k}`);

function wrangler(args, input) {
    const r = spawnSync('npx', ['--no-install', 'wrangler', ...args], { cwd: workerDir, input, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed:\n${(r.stdout + r.stderr).split('\n').filter(l => !/WARNING|k2\.|Oauth/.test(l)).slice(-12).join('\n')}`);
    return r.stdout + r.stderr;
}

let id = databaseId();
if (!id) {
    // a database made by an earlier setup, on another machine for instance, is used again
    const listed = wrangler(['d1', 'list', '--json']);
    id = JSON.parse(listed.slice(listed.indexOf('['), listed.lastIndexOf(']') + 1)).find(d => d.name === 'edge-store')?.uuid;
    if (id) {
        console.log('using the existing D1 database edge-store');
    } else {
        const out = wrangler(['d1', 'create', 'edge-store']);
        id = out.match(/"database_id":\s*"([0-9a-f-]{36})"/)?.[1] || out.match(/database_id\s*=\s*"([0-9a-f-]{36})"/)?.[1];
        if (!id) throw new Error('could not read the new database id from wrangler');
        console.log('created D1 database edge-store');
    }
}
writeConfig(id);

wrangler(['d1', 'execute', 'edge-store', '--remote', '-y', '--file', 'schema.sql']);
console.log('schema applied');

const deployed = wrangler(['deploy']);
const url = deployed.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];
if (!url) throw new Error('could not read the Worker URL from wrangler');
console.log(`deployed ${url}`);

let config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const token = config.url === url && config.token ? config.token : randomBytes(32).toString('hex');
wrangler(['secret', 'put', 'ACCESS_TOKEN'], token);
wrangler(['secret', 'put', 'TG_BOT_TOKEN'], env.TG_BOT_TOKEN);
console.log('secrets set: ACCESS_TOKEN, TG_BOT_TOKEN');

config = { url, token, chats: [env.TG_CHAT_A, env.TG_CHAT_B] };
mkdirSync(dirname(configPath), { recursive: true });
writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
chmodSync(configPath, 0o600);
console.log(`client config written to ${configPath}`);

// a new secret takes a moment to reach the Worker
for (const [slot, chat_id] of [[0, env.TG_CHAT_A], [1, env.TG_CHAT_B]]) {
    let last;
    for (let i = 0; i < 10; i++) {
        const r = await fetch(`${url}/channels`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ chat_id, slot }) });
        last = await r.json().catch(() => ({}));
        if (r.ok) break;
        await new Promise(res => setTimeout(res, 3000));
    }
    if (last?.error) throw new Error(`registering slot ${slot} failed: ${last.error}`);
    console.log(`slot ${slot}: channel "${last.title}"`);
}
console.log('done');
