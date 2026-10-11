// Checks the bot token in spike/.env, finds the two channels from the bot's updates,
// and writes TG_CHAT_A / TG_CHAT_B into spike/.env. Never prints the token.
// Run: node spike/tg-setup.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('./.env', import.meta.url);
const raw = readFileSync(path, 'utf8');
const m = raw.match(/^\s*TG_BOT_TOKEN\s*=\s*(\S+)/m);
if (!m) {
    console.log('No TG_BOT_TOKEN=... line found. Keys present:', raw.split('\n').map(l => l.split('=')[0].trim()).filter(Boolean));
    process.exit(1);
}
const T = m[1].replace(/^["']|["']$/g, '');
console.log('token format looks right:', /^\d+:[\w-]{30,}$/.test(T));

const api = (method, body = {}) => fetch(`https://api.telegram.org/bot${T}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json());

const me = await api('getMe');
console.log('bot:', me.ok ? '@' + me.result.username : me.description);
if (!me.ok) process.exit(1);

const hook = await api('getWebhookInfo');
if (hook.result?.url) console.log('warning: a webhook is set, so updates cannot be read this way');

// Wait (default 10 minutes) for a post in two different channels. Updates are read without
// an offset, so nothing is acknowledged or taken away from another program using this bot.
// allowed_updates: [] restores Telegram's default set, which includes channel posts.
const deadline = Date.now() + Number(process.argv[2] || 600) * 1000;
const chats = new Map();
let channels = [];
console.log('waiting for a new post in each of the two channels...');
while (Date.now() < deadline) {
    const up = await api('getUpdates', { allowed_updates: [], timeout: 25 });
    if (!up.ok) { console.log('getUpdates:', up.description); await new Promise(r => setTimeout(r, 3000)); continue; }
    for (const u of up.result) {
        const c = (u.channel_post || u.edited_channel_post || u.my_chat_member || u.message)?.chat;
        if (c && !chats.has(c.id)) { chats.set(c.id, c); console.log(`  saw ${c.type} ${c.id} ${JSON.stringify(c.title || c.username || '')}`); }
    }
    channels = [...chats.values()].filter(c => c.type === 'channel');
    if (channels.length >= 2) break;
    if (up.result.length) await new Promise(r => setTimeout(r, 2000)); // unacknowledged updates return at once
}
if (channels.length !== 2) {
    console.log(`Expected exactly 2 channels, found ${channels.length}. Post a new message in each channel and run this again.`);
    process.exit(1);
}
for (const c of channels) {
    const mem = await api('getChatMember', { chat_id: c.id, user_id: me.result.id });
    console.log(`  bot in ${JSON.stringify(c.title)}: ${mem.result?.status}, can post: ${mem.result?.can_post_messages}, can delete: ${mem.result?.can_delete_messages}`);
}
let out = raw.replace(/^\s*TG_CHAT_[AB]\s*=.*\n?/mg, '');
if (!out.endsWith('\n')) out += '\n';
out += `TG_CHAT_A=${channels[0].id}\nTG_CHAT_B=${channels[1].id}\n`;
writeFileSync(path, out);
console.log('wrote TG_CHAT_A and TG_CHAT_B to spike/.env');
