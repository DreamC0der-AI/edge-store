-- edge-store index. D1 bills one write per row and one more per index entry,
-- so indexes are kept to what the queries need.

-- A slot is one of the two replica positions; a slot can have several channels over time.
CREATE TABLE IF NOT EXISTS channels (
    chat_id TEXT PRIMARY KEY,
    slot INTEGER NOT NULL,
    title TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    messages INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT,
    chunk_size INTEGER NOT NULL,
    chunks INTEGER NOT NULL,
    state TEXT NOT NULL,            -- uploading | complete
    created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS files_path ON files(path, state);

CREATE TABLE IF NOT EXISTS chunks (
    file_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (file_id, idx)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS replicas (
    id INTEGER PRIMARY KEY,
    file_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    tg_file_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'ok',   -- ok | missing
    attempts INTEGER NOT NULL DEFAULT 0,
    UNIQUE (file_id, idx, slot)
);
CREATE INDEX IF NOT EXISTS replicas_bad ON replicas(state) WHERE state != 'ok';

CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT
);

-- Access keys for apps. Only a hash of each key is stored.
CREATE TABLE IF NOT EXISTS keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hash TEXT NOT NULL,
    role TEXT NOT NULL,             -- read | write | admin
    prefix TEXT NOT NULL DEFAULT '',-- the key only sees paths starting with this
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_used_at INTEGER
) WITHOUT ROWID;
