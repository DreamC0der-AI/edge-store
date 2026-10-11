// Deploys the Worker: refreshes worker/wrangler.toml from the template, then runs wrangler deploy.
// Run: npm run deploy        (after scripts/setup.mjs has been run once)
import { spawnSync } from 'node:child_process';
import { databaseId, writeConfig, workerDir } from './wrangler-config.mjs';

const id = databaseId();
if (!id) {
    console.error('worker/wrangler.toml does not exist yet; run node scripts/setup.mjs first');
    process.exit(1);
}
writeConfig(id);
const r = spawnSync('npx', ['--no-install', 'wrangler', 'deploy', ...process.argv.slice(2)], { cwd: workerDir, stdio: 'inherit' });
process.exit(r.status ?? 1);
