import type { D1Database } from './types';

/**
 * Idempotent D1 schema, applied lazily on first request per deployment
 * (guarded by the kv schema_version flag) so a fresh database self-provisions.
 *
 * Statements are executed through `batch()`, not `exec()`: D1's exec() splits
 * input on newlines, which breaks multi-line CREATE TABLE statements.
 * Column additions for pre-existing databases run individually so one
 * "duplicate column name" cannot abort the rest of the migration.
 */
export const SCHEMA_VERSION = 3;

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
     password_hash TEXT,
     pin_hash TEXT,
     theme TEXT NOT NULL DEFAULT 'mind-flayer-void',
     voice_profile TEXT,
     welcomed INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_login_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
  `CREATE TABLE IF NOT EXISTS auth_codes (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL,
     purpose TEXT NOT NULL,
     code_hash TEXT NOT NULL,
     password_hash TEXT,
     display_name TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     consumed INTEGER NOT NULL DEFAULT 0,
     expires_at TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_codes_lookup ON auth_codes(email, purpose, created_at DESC)`,
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
  `CREATE TABLE IF NOT EXISTS projects (
     id TEXT PRIMARY KEY,
     user_sub TEXT NOT NULL,
     name TEXT NOT NULL,
     description TEXT,
     repo_full_name TEXT,
     repo_branch TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_sub, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS project_ais (
     id TEXT PRIMARY KEY,
     user_sub TEXT NOT NULL,
     project_id TEXT NOT NULL,
     connector_id TEXT,
     slot INTEGER NOT NULL,
     field TEXT NOT NULL DEFAULT 'unassigned',
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE(project_id, slot)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_project_ais_project ON project_ais(project_id, slot)`,
  `CREATE TABLE IF NOT EXISTS field_entries (
     id TEXT PRIMARY KEY,
     user_sub TEXT NOT NULL,
     author_tag TEXT NOT NULL,
     handle TEXT NOT NULL UNIQUE,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     app_url TEXT,
     html TEXT,
     tags TEXT NOT NULL DEFAULT '',
     stars INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_field_entries_created ON field_entries(created_at DESC)`,
];

/** Additive migrations for databases created before a column existed. */
const MIGRATIONS: string[] = [
  `ALTER TABLE users ADD COLUMN password_hash TEXT`,
  `ALTER TABLE users ADD COLUMN pin_hash TEXT`,
  `ALTER TABLE connectors ADD COLUMN is_vecna INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE chats ADD COLUMN project_id TEXT`,
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
  for (const sql of MIGRATIONS) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* column already exists on this database */
    }
  }
  await db
    .prepare(
      "INSERT INTO kv (key, value) VALUES ('schema_version', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(String(SCHEMA_VERSION))
    .run();
  schemaReady.add(db);
}
