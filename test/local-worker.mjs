// Runs the real Worker code locally (wrangler dev with a throwaway local D1) for the offline tests.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'worker');
// the template is enough here: a local database does not need a real id, so the tests run before any setup
const CONFIG = ['--config', 'wrangler.template.toml'];
export const TEST_TOKEN = 'test-access-token';

const freePort = () => new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

export async function startWorker({ tgApi }) {
    const state = mkdtempSync(join(tmpdir(), 'edge-store-test-'));
    const schema = spawnSync('npx', ['--no-install', 'wrangler', 'd1', 'execute', 'edge-store', ...CONFIG, '--local', '--persist-to', state, '--file', 'schema.sql'],
        { cwd: workerDir, encoding: 'utf8' });
    if (schema.status !== 0) throw new Error(`could not create the local database:\n${schema.stdout}${schema.stderr}`);

    const port = await freePort();
    const child = spawn('npx', ['--no-install', 'wrangler', 'dev', ...CONFIG, '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', state,
        '--test-scheduled', '--show-interactive-dev-session=false',
        '--var', `TG_API:${tgApi}`, '--var', `ACCESS_TOKEN:${TEST_TOKEN}`, '--var', 'TG_BOT_TOKEN:123456:FAKE'],
        { cwd: workerDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });

    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 90_000;
    for (;;) {
        try {
            const r = await fetch(`${url}/config`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
            if (r.ok) {
                const cfg = await r.json();
                if (cfg.tgApi !== tgApi) throw Object.assign(new Error(`Worker is not using the simulated Telegram (${cfg.tgApi})`), { fatal: true });
                break;
            }
        } catch (e) {
            if (e.fatal) { child.kill('SIGTERM'); throw e; }
        }
        if (child.exitCode !== null || Date.now() > deadline) {
            child.kill('SIGTERM');
            throw new Error(`local Worker did not start:\n${log.slice(-2000)}`);
        }
        await new Promise(r => setTimeout(r, 500));
    }

    return {
        url,
        token: TEST_TOKEN,
        log: () => log,
        async stop() {
            child.kill('SIGTERM');
            await new Promise(r => child.once('exit', r));
            rmSync(state, { recursive: true, force: true });
        },
    };
}
