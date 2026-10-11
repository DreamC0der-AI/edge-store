// Spike for claim `enc`: chunked client-side encryption with WebCrypto only.
// Run: node spike/enc.mjs
import { randomFillSync, createHash } from 'node:crypto';

const CHUNK = 16 * 1024 * 1024;
const subtle = globalThis.crypto.subtle;

// ---- format -------------------------------------------------------------

async function deriveMasterKey(passphrase, salt) {
    const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600_000 },
        base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

async function newFile(masterKey, totalChunks) {
    const fileId = crypto.getRandomValues(new Uint8Array(16));
    const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    const wrappedKey = new Uint8Array(await subtle.wrapKey('raw', key, masterKey, { name: 'AES-GCM', iv: wrapIv }));
    // header is what the metadata server stores; it never sees `key`
    return { key, header: { fileId, totalChunks, wrapIv, wrappedKey } };
}

async function openFile(masterKey, header) {
    return subtle.unwrapKey('raw', header.wrappedKey, masterKey, { name: 'AES-GCM', iv: header.wrapIv },
        { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

// The key is unique per file, so the chunk index is a safe nonce.
function nonce(index) {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setUint32(8, index);
    return iv;
}

// Binds a chunk to its file, its position and the file's chunk count.
function aad(fileId, index, totalChunks) {
    const a = new Uint8Array(24);
    a.set(fileId, 0);
    const v = new DataView(a.buffer);
    v.setUint32(16, index);
    v.setUint32(20, totalChunks);
    return a;
}

async function encryptChunk(key, header, index, plain) {
    return new Uint8Array(await subtle.encrypt(
        { name: 'AES-GCM', iv: nonce(index), additionalData: aad(header.fileId, index, header.totalChunks) }, key, plain));
}

async function decryptChunk(key, header, index, cipher) {
    return new Uint8Array(await subtle.decrypt(
        { name: 'AES-GCM', iv: nonce(index), additionalData: aad(header.fileId, index, header.totalChunks) }, key, cipher));
}

// ---- test ---------------------------------------------------------------

const sha = (parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest('hex'); };
const rejects = async (fn) => { try { await fn(); return false; } catch { return true; } };
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };

const SIZE = 200 * 1024 * 1024 + 12345; // not a multiple of the chunk size
const total = Math.ceil(SIZE / CHUNK);
const plain = [];
for (let i = 0; i < total; i++) {
    const n = Math.min(CHUNK, SIZE - i * CHUNK);
    const b = new Uint8Array(n);
    for (let o = 0; o < n; o += 1 << 30) randomFillSync(b, o, Math.min(1 << 30, n - o));
    plain.push(b);
}

let t = performance.now();
const master = await deriveMasterKey('correct horse battery staple', crypto.getRandomValues(new Uint8Array(16)));
console.log(`key derivation (PBKDF2, 600k rounds): ${(performance.now() - t).toFixed(0)} ms`);

const { key, header } = await newFile(master, total);

t = performance.now();
const cipher = [];
for (let i = 0; i < total; i++) cipher.push(await encryptChunk(key, header, i, plain[i]));
const encMs = performance.now() - t;

// decrypt with a key recovered from the header alone, as a second device would
const key2 = await openFile(master, header);
t = performance.now();
const back = [];
for (let i = 0; i < total; i++) back.push(await decryptChunk(key2, header, i, cipher[i]));
const decMs = performance.now() - t;

const mb = SIZE / 1e6;
console.log(`encrypt: ${(mb / (encMs / 1000)).toFixed(0)} MB/s   decrypt: ${(mb / (decMs / 1000)).toFixed(0)} MB/s   (${total} chunks, ${mb.toFixed(0)} MB)`);
console.log(`largest ciphertext chunk: ${Math.max(...cipher.map(c => c.length))} bytes`);

check('round trip is byte-identical', sha(plain) === sha(back));

const one = await decryptChunk(key2, header, 7, cipher[7]);
check('chunk 7 decrypts alone', sha([one]) === sha([plain[7]]));

const flipped = cipher[3].slice(); flipped[1000] ^= 1;
check('modified chunk is rejected', await rejects(() => decryptChunk(key2, header, 3, flipped)));

check('reordered chunk is rejected', await rejects(() => decryptChunk(key2, header, 2, cipher[5])));

// same key, different file id: isolates the file binding from the key
const otherHeader = { ...header, fileId: crypto.getRandomValues(new Uint8Array(16)) };
check('chunk moved to another file is rejected', await rejects(() => decryptChunk(key2, otherHeader, 3, cipher[3])));

// a server that drops the last chunk and reports one chunk fewer
const shortHeader = { ...header, totalChunks: total - 1 };
check('truncated file is rejected', await rejects(() => decryptChunk(key2, shortHeader, 0, cipher[0])));

const wrongMaster = await deriveMasterKey('wrong passphrase', crypto.getRandomValues(new Uint8Array(16)));
check('wrong passphrase cannot open the file key', await rejects(() => openFile(wrongMaster, header)));

console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
