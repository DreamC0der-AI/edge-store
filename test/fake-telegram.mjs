// A small in-memory stand-in for the Telegram Bot API, with switches to break things on purpose.
// It mirrors the behaviours measured against the real service (see spike/tg-results.json):
// a deleted message's file stays downloadable, getFile refuses files of 20 MB or more, and
// editing a caption to the same text answers "message is not modified".
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const MB = 1024 * 1024;

export async function startFakeTelegram() {
    const chats = new Map();   // chat id -> { title, nextId, messages: Map<id, message>, pinned, dead }
    const files = new Map();   // file id -> { bytes, gone }
    const calls = {};          // method -> number of calls
    const limits = new Map();  // method -> number of upcoming calls to answer with 429
    const failures = new Map(); // method -> { description, times }: upcoming calls answered with that error
    const chatFailures = new Map(); // chat id -> number of upcoming uploads to that chat that fail

    const send = (res, status, body) => {
        const data = Buffer.from(JSON.stringify(body));
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length });
        res.end(data);
    };
    const ok = (res, result) => send(res, 200, { ok: true, result });
    const bad = (res, description, code = 400) => send(res, code, { ok: false, error_code: code, description });

    const methods = {
        getMe: (res) => ok(res, { id: 123456, is_bot: true, username: 'fake_bot' }),
        getChatMember: (res) => ok(res, { status: 'administrator', can_post_messages: true, can_delete_messages: true }),
        getChat(res, p) {
            const chat = liveChat(res, p.chat_id);
            if (!chat) return;
            const result = { id: Number(p.chat_id), type: 'channel', title: chat.title };
            if (chat.pinned && chat.messages.has(chat.pinned)) result.pinned_message = chat.messages.get(chat.pinned);
            ok(res, result);
        },
        sendDocument(res, p) {
            const chat = liveChat(res, p.chat_id);
            if (!chat) return;
            if (chatFailures.get(String(p.chat_id)) > 0) {
                chatFailures.set(String(p.chat_id), chatFailures.get(String(p.chat_id)) - 1);
                return bad(res, 'Bad Request: simulated failure for this chat');
            }
            const bytes = p.document.bytes;
            if (bytes.length === 0) return bad(res, 'Bad Request: file must be non-empty');
            if (bytes.length > 50 * MB) return bad(res, 'Request Entity Too Large', 413);
            const file_id = 'F' + randomBytes(12).toString('hex');
            files.set(file_id, { bytes, gone: false });
            const message = {
                message_id: chat.nextId++,
                date: Math.floor(Date.now() / 1000),
                chat: { id: Number(p.chat_id), type: 'channel' },
                caption: p.caption,
                document: { file_id, file_unique_id: 'U' + randomBytes(6).toString('hex'), file_name: p.document.name, file_size: bytes.length },
            };
            chat.messages.set(message.message_id, message);
            ok(res, message);
        },
        getFile(res, p) {
            const f = files.get(p.file_id);
            if (!f || f.gone) return bad(res, 'Bad Request: wrong file_id or the file is temporarily unavailable');
            if (f.bytes.length >= 20 * MB) return bad(res, 'Bad Request: file is too big');
            ok(res, { file_id: p.file_id, file_size: f.bytes.length, file_path: `documents/${p.file_id}` });
        },
        editMessageCaption(res, p) {
            const chat = liveChat(res, p.chat_id);
            if (!chat) return;
            const m = chat.messages.get(Number(p.message_id));
            if (!m) return bad(res, 'Bad Request: message to edit not found');
            if ((m.caption || '') === (p.caption || '')) {
                return bad(res, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message');
            }
            m.caption = p.caption;
            ok(res, m);
        },
        deleteMessage(res, p) {
            const chat = liveChat(res, p.chat_id);
            if (!chat) return;
            if (!chat.messages.delete(Number(p.message_id))) return bad(res, 'Bad Request: message to delete not found');
            ok(res, true);
        },
        deleteMessages(res, p) {
            const chat = liveChat(res, p.chat_id);
            if (!chat) return;
            for (const id of p.message_ids) chat.messages.delete(Number(id));
            ok(res, true);
        },
        pinChatMessage(res, p) {
            const chat = liveChat(res, p.chat_id);
            if (!chat) return;
            if (!chat.messages.has(Number(p.message_id))) return bad(res, 'Bad Request: message to pin not found');
            chat.pinned = Number(p.message_id);
            ok(res, true);
        },
    };

    function liveChat(res, chatId) {
        const chat = chats.get(String(chatId));
        if (!chat || chat.dead) { bad(res, 'Bad Request: chat not found'); return null; }
        return chat;
    }

    async function params(req, body) {
        const type = req.headers['content-type'] || '';
        if (!type.startsWith('multipart/')) return body.length ? JSON.parse(body.toString('utf8')) : {};
        const form = await new Request('http://local/', { method: 'POST', headers: { 'content-type': type }, body }).formData();
        const out = {};
        for (const [k, v] of form) out[k] = typeof v === 'string' ? v : { name: v.name, bytes: Buffer.from(await v.arrayBuffer()) };
        return out;
    }

    const server = http.createServer((req, res) => {
        const parts = [];
        req.on('data', d => parts.push(d));
        req.on('end', async () => {
            try {
                const path = new URL(req.url, 'http://local').pathname;
                const file = path.match(/^\/file\/bot[^/]+\/documents\/(\w+)$/);
                if (file) {
                    const f = files.get(file[1]);
                    if (!f || f.gone) { res.writeHead(404); return res.end(); }
                    res.writeHead(200, { 'content-length': f.bytes.length, 'accept-ranges': 'bytes' });
                    return res.end(req.method === 'HEAD' ? undefined : f.bytes);
                }
                const method = path.match(/^\/bot[^/]+\/(\w+)$/)?.[1];
                calls[method] = (calls[method] || 0) + 1;
                if (limits.get(method) > 0) {
                    limits.set(method, limits.get(method) - 1);
                    return send(res, 429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 0', parameters: { retry_after: 0 } });
                }
                if (failures.get(method)?.times > 0) {
                    failures.get(method).times--;
                    return bad(res, failures.get(method).description);
                }
                if (!methods[method]) return bad(res, 'Not Found', 404);
                await methods[method](res, await params(req, Buffer.concat(parts)));
            } catch (e) {
                send(res, 500, { ok: false, error_code: 500, description: `fake telegram: ${e.message}` });
            }
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));

    return {
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(r => server.close(r)),
        calls,
        addChat(id, title) { chats.set(String(id), { title, nextId: 1, messages: new Map(), pinned: null, dead: false }); },
        messages: (chatId) => chats.get(String(chatId)).messages,
        message: (chatId, id) => chats.get(String(chatId)).messages.get(Number(id)),
        bytes: (fileId) => files.get(fileId)?.bytes,
        pinned: (chatId) => chats.get(String(chatId)).pinned,
        // ---- ways to break things ----
        deleteMessage: (chatId, id) => chats.get(String(chatId)).messages.delete(Number(id)),
        dropFile(fileId) { files.get(fileId).gone = true; },
        restoreFile(fileId) { files.get(fileId).gone = false; },
        corruptFile(fileId) { const f = files.get(fileId); f.bytes = Buffer.from(f.bytes); f.bytes[0] ^= 0xff; },
        truncateFile(fileId) { const f = files.get(fileId); f.bytes = f.bytes.subarray(0, f.bytes.length - 1); },
        killChat(chatId) { chats.get(String(chatId)).dead = true; },
        rateLimit(method, times) { limits.set(method, times); },
        failWith(method, description, times) { failures.set(method, { description, times }); },
        failChat(chatId, times) { chatFailures.set(String(chatId), times); },
    };
}
