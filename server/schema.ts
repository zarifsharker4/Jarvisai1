import type { D1Database } from './types';

/**
 * Idempotent D1 schema, applied lazily on first request per deployment
 * (guarded by the kv schema_version flag) so a fresh database self-provisions.
 *
 * Statements are executed through `batch()`, not `exec()`: D1's exec() splits
 * input on newlines, which breaks multi-line CREATE TABLE statements.
 */
export const SCHEMA_VERSION = 1;

const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS kv (
     key TEXT PRIMARY KEY,
     value TEXT,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS users (
     sub TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     tag TEXT NOT NULL UNIQUE,
     display_name TEXT,
     email TEXT,
     picture TEXT,
     pin_hash TEXT,
     theme TEXT NOT NULL DEFAULT 'mind-flayer-void',
     voice_profile TEXT,
     welcomed INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_login_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS chats (
     id TEXT PRIMARY KEY,
     user_sub TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT 'New chat',
     mode TEXT NOT NULL DEFAULT 'chat',
     locked INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_sub, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY,
     chat_id TEXT NOT NULL,
     user_sub TEXT NOT NULL,
     role TEXT NOT NULL,
     agent TEXT,
     content TEXT NOT NULL,
     meta TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS connectors (
     id TEXT PRIMARY KEY,
     user_sub TEXT NOT NULL,
     provider TEXT NOT NULL,
     name TEXT NOT NULL,
     base_url TEXT,
     api_key_enc TEXT,
     model TEXT,
     is_default INTEGER NOT NULL DEFAULT 0,
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_connectors_user ON connectors(user_sub, created_at)`,
  `CREATE TABLE IF NOT EXISTS outbox (
     id TEXT PRIMARY KEY,
     user_sub TEXT,
     to_email TEXT NOT NULL,
     from_email TEXT NOT NULL,
     subject TEXT NOT NULL,
     html TEXT NOT NULL,
     body_text TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'queued',
     provider TEXT,
     error TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     sent_at TEXT
   )`,
];

const schemaReady = new WeakSet<D1Database>();

export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady.has(db)) return;
  let current: { value?: unknown } | null = null;
  let probeFailed = false;
  try {
    current = await db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").first();
  } catch {
    probeFailed = true; // fresh database: the kv table does not exist yet
  }
  if (!probeFailed && current && Number(current.value) >= SCHEMA_VERSION) {
    schemaReady.add(db);
    return;
  }

  await db.batch(STATEMENTS.map((sql) => db.prepare(sql)));
  await db
    .prepare(
      "INSERT INTO kv (key, value) VALUES ('schema_version', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(String(SCHEMA_VERSION))
    .run();
  schemaReady.add(db);
}
