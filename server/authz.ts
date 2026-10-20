import {
  randomId,
  randomTag,
  readCookie,
  serializeCookie,
  signOpaque,
  verifyOpaque,
  hashPin,
  verifyPin,
} from './crypto';
import { ensureSchema } from './schema';
import { sendWelcome } from './mail';
import type { AuthCodeRow, D1Database, Env, RequestUser, UserRow } from './types';

export const SESSION_COOKIE = 'mindflayer_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const PIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/** 6-digit codes live for 10 minutes and get exactly 5 guesses. */
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

/* ------------------------------------------------------------------ *
 * kv helpers
 * ------------------------------------------------------------------ */

export async function kvGet(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM kv WHERE key = ?1').bind(key).first();
  return row ? String(row.value) : null;
}

export async function kvSet(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      'INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime(\'now\')',
    )
    .bind(key, value)
    .run();
}

/* ------------------------------------------------------------------ *
 * Email + password helpers
 * ------------------------------------------------------------------ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length < 5 || email.length > 254) return null;
  return EMAIL_RE.test(email) ? email : null;
}

export function subForEmail(email: string): string {
  return `email:${email}`;
}

/** Human-readable reason the password is unacceptable, or null when it is fine. */
export function passwordProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'Password is required';
  if (value.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (value.length > PASSWORD_MAX_LENGTH) return 'Password is too long';
  return null;
}

export function randomOtp(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const n = new DataView(buf.buffer).getUint32(0) % 1_000_000;
  return String(n).padStart(6, '0');
}

export async function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?1').bind(email).first<UserRow>();
}

/**
 * Issue a fresh 6-digit code for an email. Any earlier unconsumed code for the
 * same purpose is burned first, so only the newest mail is valid.
 */
export async function createAuthCode(
  db: D1Database,
  input: {
    email: string;
    purpose: 'signup' | 'login';
    passwordHash?: string | null;
    displayName?: string | null;
  },
): Promise<{ code: string; id: string }> {
  await db
    .prepare('UPDATE auth_codes SET consumed = 1 WHERE email = ?1 AND purpose = ?2 AND consumed = 0')
    .bind(input.email, input.purpose)
    .run();
  const code = randomOtp();
  const id = randomId(12);
  await db
    .prepare(
      `INSERT INTO auth_codes (id, email, purpose, code_hash, password_hash, display_name, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', ?7))`,
    )
    .bind(
      id,
      input.email,
      input.purpose,
      await hashPin(code),
      input.passwordHash ?? null,
      input.displayName ?? null,
      `+${Math.round(OTP_TTL_MS / 1000)} seconds`,
    )
    .run();
  return { code, id };
}

/** True when a code for this email + purpose was issued inside the cooldown. */
export async function codeJustIssued(
  db: D1Database,
  email: string,
  purpose: 'signup' | 'login',
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM auth_codes
        WHERE email = ?1 AND purpose = ?2 AND created_at > datetime('now', ?3)
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(email, purpose, `-${Math.round(OTP_RESEND_COOLDOWN_MS / 1000)} seconds`)
    .first();
  return Boolean(row);
}

export type OtpResult =
  | { ok: true; row: AuthCodeRow }
  | { ok: false; reason: 'no_code' | 'expired' | 'too_many_attempts' | 'bad_code' };

/**
 * Check a 6-digit code. Wrong guesses cost an attempt; a correct code is
 * consumed immediately so it cannot be replayed.
 */
export async function verifyAuthCode(
  db: D1Database,
  email: string,
  code: string,
  purpose: 'signup' | 'login',
): Promise<OtpResult> {
  const row = await db
    .prepare(
      `SELECT * FROM auth_codes
        WHERE email = ?1 AND purpose = ?2 AND consumed = 0
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(email, purpose)
    .first<AuthCodeRow>();
  if (!row) return { ok: false, reason: 'no_code' };
  if (row.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  const fresh = await db
    .prepare("SELECT (expires_at > datetime('now')) AS alive FROM auth_codes WHERE id = ?1")
    .bind(row.id)
    .first<{ alive: number }>();
  if (!fresh?.alive) return { ok: false, reason: 'expired' };

  const matches = /^\d{6}$/.test(code) && (await verifyPin(code, row.code_hash));
  if (!matches) {
    await db.prepare('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?1').bind(row.id).run();
    return { ok: false, reason: 'bad_code' };
  }
  await db.prepare('UPDATE auth_codes SET consumed = 1 WHERE id = ?1').bind(row.id).run();
  return { ok: true, row };
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

const SESSION_KEY = 'session:';

/**
 * Sessions are signed tokens that carry a random id, and the id maps to the
 * account in `kv`. That keeps them stateless to verify but revocable: signing
 * out deletes the row, so a copied cookie stops working immediately.
 */
export async function resolveRequestUser(request: Request, env: Env): Promise<RequestUser | null> {
  const sub = await sessionSubFromCookie(request, env);
  if (!sub) return null;
  const row = await env.DB!.prepare('SELECT * FROM users WHERE sub = ?1').bind(sub).first<UserRow>();
  if (!row) return null;
  return {
    sub: row.sub,
    provider: 'email',
    email: row.email ?? undefined,
    name: row.display_name ?? undefined,
    picture: row.picture ?? undefined,
  };
}

export async function issueSessionCookie(env: Env, sub: string): Promise<string> {
  const secret = env.APP_SECRET ?? 'dev-secret';
  const sid = randomId(12);
  const expiresAt = Date.now() + SESSION_TTL_MS;
  if (env.DB) await kvSet(env.DB, `${SESSION_KEY}${sid}`, `${sub}|${expiresAt}`);
  const token = await signOpaque(secret, `sess:${sid}`, SESSION_TTL_MS);
  return serializeCookie(SESSION_COOKIE, token, {
    maxAge: SESSION_TTL_MS,
    secure: env.APP_ORIGIN.startsWith('https://'),
  });
}

export function clearSessionCookie(env: Env): string {
  return serializeCookie(SESSION_COOKIE, '', { secure: env.APP_ORIGIN.startsWith('https://') });
}

/** Session id from a valid cookie, or null. */
async function sessionIdFromCookie(request: Request, env: Env): Promise<string | null> {
  if (!env.APP_SECRET) return null;
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const payload = await verifyOpaque(env.APP_SECRET, token);
  if (!payload?.startsWith('sess:')) return null;
  return payload.slice('sess:'.length);
}

/** Raw session sub when the cookie is valid and not revoked, else null. */
export async function sessionSubFromCookie(request: Request, env: Env): Promise<string | null> {
  if (!env.DB) return null;
  const sid = await sessionIdFromCookie(request, env);
  if (!sid) return null;
  const stored = await kvGet(env.DB, `${SESSION_KEY}${sid}`);
  if (!stored) return null;
  const [sub, expiresAt] = stored.split('|');
  if (!sub) return null;
  if (Number(expiresAt) && Number(expiresAt) < Date.now()) {
    await env.DB.prepare('DELETE FROM kv WHERE key = ?1').bind(`${SESSION_KEY}${sid}`).run();
    return null;
  }
  return sub;
}

/** Delete the session behind this request so its cookie can never be replayed. */
export async function revokeSession(env: Env, request: Request): Promise<void> {
  if (!env.DB) return;
  const sid = await sessionIdFromCookie(request, env);
  if (!sid) return;
  await env.DB.prepare('DELETE FROM kv WHERE key = ?1').bind(`${SESSION_KEY}${sid}`).run();
}

/* ------------------------------------------------------------------ *
 * PIN lock (exactly 4 digits, archive style)
 * ------------------------------------------------------------------ */

export const PIN_PATTERN = /^\d{4}$/;
export const PIN_RULES = 'Use exactly 4 digits';

export async function issuePinToken(env: Env, sub: string): Promise<string> {
  return signOpaque(env.APP_SECRET ?? 'dev-secret', `pin:${sub}`, PIN_TOKEN_TTL_MS);
}

export async function checkPinToken(
  env: Env,
  token: string | null | undefined,
  sub: string,
): Promise<boolean> {
  if (!token || !env.APP_SECRET) return false;
  return (await verifyOpaque(env.APP_SECRET, token)) === `pin:${sub}`;
}

/* ------------------------------------------------------------------ *
 * User records + unique tags
 * ------------------------------------------------------------------ */

export async function findUser(db: D1Database, sub: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE sub = ?1').bind(sub).first<UserRow>();
}

/**
 * Upsert the account row, minting a unique @mindflayer-xxxxxx tag on first
 * sign-in. `passwordHash` is only supplied by the email signup flow.
 */
export async function ensureUserRecord(
  db: D1Database,
  env: Env,
  ru: RequestUser,
  opts: { passwordHash?: string | null; displayName?: string | null } = {},
): Promise<UserRow> {
  await ensureSchema(db);
  const existing = await findUser(db, ru.sub);

  if (existing) {
    const passwordHash = opts.passwordHash ?? existing.password_hash;
    await db
      .prepare(
        `UPDATE users
           SET last_login_at = datetime('now'),
               email = ?2,
               display_name = ?3,
               picture = ?4,
               password_hash = ?5
         WHERE sub = ?1`,
      )
      .bind(
        ru.sub,
        ru.email ?? existing.email,
        ru.name ?? existing.display_name,
        ru.picture ?? existing.picture,
        passwordHash,
      )
      .run();
    const row = {
      ...existing,
      password_hash: passwordHash,
      email: ru.email ?? existing.email,
      display_name: ru.name ?? existing.display_name,
      picture: ru.picture ?? existing.picture,
      last_login_at: new Date().toISOString(),
    };
    if (!row.welcomed) {
      try {
        await sendWelcome(env, db, row);
      } catch {
        /* mail is best-effort */
      }
    }
    return row;
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const tag = randomTag();
    try {
      await db
        .prepare(
          `INSERT INTO users (sub, provider, tag, display_name, email, picture, password_hash)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        .bind(
          ru.sub,
          ru.provider,
          tag,
          ru.name ?? opts.displayName ?? null,
          ru.email ?? null,
          ru.picture ?? null,
          opts.passwordHash ?? null,
        )
        .run();
      const row = await findUser(db, ru.sub);
      if (row) {
        try {
          await sendWelcome(env, db, row);
        } catch {
          /* mail is best-effort */
        }
        return row;
      }
    } catch (err) {
      lastError = err; // unique tag collision, retry with a fresh tag
    }
  }
  throw lastError ?? new Error('Could not provision account');
}

/* ------------------------------------------------------------------ *
 * Auth gate used by every protected route
 * ------------------------------------------------------------------ */

export type AuthGate =
  | { ok: true; requestUser: RequestUser; user: UserRow }
  | { ok: false; response: Response };

export async function requireUser(
  request: Request,
  env: Env,
  deps: { resolveUser: (req: Request, env: Env) => Promise<RequestUser | null> },
): Promise<AuthGate> {
  if (!env.DB) {
    return { ok: false, response: Response.json({ error: 'Database not bound' }, { status: 503 }) };
  }
  const ru = await deps.resolveUser(request, env);
  if (!ru) {
    return {
      ok: false,
      response: Response.json(
        { error: 'Sign in required' },
        { status: 401, headers: { 'Cache-Control': 'private, no-store' } },
      ),
    };
  }
  const user = await ensureUserRecord(env.DB, env, ru);
  return { ok: true, requestUser: ru, user };
}
