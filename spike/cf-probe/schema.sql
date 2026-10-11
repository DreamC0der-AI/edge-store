CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    header TEXT NOT NULL,
    manifest TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS replicas (
    id INTEGER PRIMARY KEY,
    file_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    replica INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    tg_file_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ok',
    checked_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS replicas_file ON replicas(file_id, idx);
CREATE INDEX IF NOT EXISTS replicas_due ON replicas(checked_at);
CREATE TABLE IF NOT EXISTS cron_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    rows INTEGER NOT NULL,
    fetches_ok INTEGER NOT NULL,
    err TEXT,
    wall_ms INTEGER NOT NULL
);
