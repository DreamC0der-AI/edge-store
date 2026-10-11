// worker/wrangler.toml is made from worker/wrangler.template.toml by filling in the id of the
// D1 database. The id differs for every deployment, so the made file is not committed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const workerDir = join(root, 'worker');
export const TEMPLATE = 'wrangler.template.toml';
const tomlPath = join(workerDir, 'wrangler.toml');
const templatePath = join(workerDir, TEMPLATE);

// The database id this checkout was set up with, or null before scripts/setup.mjs has run.
export function databaseId() {
    if (!existsSync(tomlPath)) return null;
    return readFileSync(tomlPath, 'utf8').match(/^database_id\s*=\s*"([0-9a-f-]{36})"/m)?.[1] ?? null;
}

export function writeConfig(id) {
    const template = readFileSync(templatePath, 'utf8');
    if (!template.includes('REPLACE_ME')) throw new Error(`${TEMPLATE} has no REPLACE_ME to fill in`);
    const settings = template.replace(/^(#.*\n)+/, ''); // the template's own heading does not apply to the copy
    writeFileSync(tomlPath, `# Made from ${TEMPLATE} by scripts/setup.mjs and "npm run deploy". Edit the template, not this file.\n${settings.replace('REPLACE_ME', id)}`);
}
