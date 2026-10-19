import { createFreebuffAuth, type FreebuffAuth, type FreebuffUser } from '@freebuff/auth';
import {
  encryptSecret,
  decryptSecret,
  randomId,
  randomTag,
  readCookie,
  serializeCookie,
  signOpaque,
  verifyOpaque,
} from './crypto';
import { ensureSchema } from './schema';
import { sendWelcome } from './mail';
import type { D1Database, Env, RequestUser, UserRow } from './types';

export const SESSION_COOKIE = 'mindflayer_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const PIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
export const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000;

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
 * Sign in with Mind Flayer (primary, fully working auth)
 * ------------------------------------------------------------------ */

let authInstance: FreebuffAuth | null = null;
let authKey = '';

export const AUTH_PROVIDER_LABEL = 'Mind Flayer';

export function isLoopbackOrigin(origin: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(origin);
}

export function freebuffAuth(env: Env): FreebuffAuth {
  const key = `${env.FREEBUFF_CLIENT_ID ?? ''}|${env.FREEBUFF_ISSUER ?? ''}|${env.APP_ORIGIN}`;
  if (!authInstance || authKey !== key) {
    authInstance = createFreebuffAuth({
      clientId: env.FREEBUFF_CLIENT_ID ?? '',
      issuer: env.FREEBUFF_ISSUER,
      baseUrl: env.APP_ORIGIN,
      // Local workerd dev serves plain http on a loopback host; the SDK allows
      // that only when explicitly opted in, and only for loopback origins.
      allowInsecureLocalhost: isLoopbackOrigin(env.APP_ORIGIN),
    });
    authKey = key;
  }
  return authInstance;
}

/** Never let a misconfigured auth instance take down the whole Worker. */
export function tryFreebuffAuth(env: Env): FreebuffAuth | null {
  try {
    return freebuffAuth(env);
  } catch (err) {
    console.error(`[auth] configuration rejected: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Resolve whoever is calling: a Mind Flayer session or a Google
 * account session issued by our own OAuth callback.
 */
export async function resolveRequestUser(request: Request, env: Env): Promise<RequestUser | null> {
  if (env.FREEBUFF_CLIENT_ID) {
    try {
      const user: FreebuffUser | null = await freebuffAuth(env).getUser(request);
      if (user?.sub) {
        return {
          sub: user.sub,
          provider: 'freebuff',
          email: user.email,
          name: user.name,
          picture: user.picture,
        };
      }
    } catch {
      /* fall through to the Google session cookie */
    }
  }
  if (env.APP_SECRET && env.DB) {
    const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
    const payload = await verifyOpaque(env.APP_SECRET, token);
    if (payload?.startsWith('sess:')) {
      const sub = payload.slice('sess:'.length);
      const row = await env.DB.prepare('SELECT * FROM users WHERE sub = ?1')
        .bind(sub)
        .first<UserRow>();
      if (row) {
        return {
          sub: row.sub,
          provider: row.provider === 'google' ? 'google' : 'freebuff',
          email: row.email ?? undefined,
          name: row.display_name ?? undefined,
          picture: row.picture ?? undefined,
        };
      }
    }
  }
  return null;
}

/** Cookie helpers for the Google session. */
export async function issueSessionCookie(env: Env, sub: string): Promise<string> {
  const secret = env.APP_SECRET ?? 'dev-secret';
  const token = await signOpaque(secret, `sess:${sub}`, SESSION_TTL_MS);
  return serializeCookie(SESSION_COOKIE, token, {
    maxAge: SESSION_TTL_MS,
    secure: env.APP_ORIGIN.startsWith('https://'),
  });
}

export function clearSessionCookie(env: Env): string {
  return serializeCookie(SESSION_COOKIE, '', { secure: env.APP_ORIGIN.startsWith('https://') });
}

/**
 * Returns the raw session sub from the Google cookie when valid, else null.
 */
export async function sessionSubFromCookie(request: Request, env: Env): Promise<string | null> {
  if (!env.APP_SECRET) return null;
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const payload = await verifyOpaque(env.APP_SECRET, token);
  if (!payload?.startsWith('sess:')) return null;
  return payload.slice('sess:'.length);
}

/* ------------------------------------------------------------------ *
 * PIN lock
 * ------------------------------------------------------------------ */

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
 * Google OAuth (configured from Settings -> Authentication)
 * ------------------------------------------------------------------ */

export type GoogleConfig = { clientId: string | null; configured: boolean };

export async function getGoogleConfig(db: D1Database): Promise<GoogleConfig> {
  const clientId = await kvGet(db, 'google_client_id');
  return { clientId, configured: Boolean(clientId) };
}

export async function setGoogleConfig(
  db: D1Database,
  env: Env,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  await kvSet(db, 'google_client_id', clientId.trim());
  if (clientSecret.trim()) {
    const packed = await encryptSecret(env.APP_SECRET ?? 'dev-secret', clientSecret.trim());
    await kvSet(db, 'google_client_secret', packed);
  }
}

export function buildGoogleAuthUrl(clientId: string, env: Env, state: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', `${env.APP_ORIGIN}/auth/google/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export async function beginGoogleState(db: D1Database): Promise<string> {
  const state = randomId(18);
  await kvSet(db, `oauth_state:${state}`, String(Date.now() + GOOGLE_STATE_TTL_MS));
  return state;
}

export async function consumeGoogleState(db: D1Database, state: string): Promise<boolean> {
  if (!state || state.length > 128) return false;
  const key = `oauth_state:${state}`;
  const value = await kvGet(db, key);
  if (!value) return false;
  await db.prepare('DELETE FROM kv WHERE key = ?1').bind(key).run();
  return Number(value) >= Date.now();
}

export async function exchangeGoogleCode(
  db: D1Database,
  env: Env,
  code: string,
): Promise<RequestUser> {
  const clientId = await kvGet(db, 'google_client_id');
  const packedSecret = await kvGet(db, 'google_client_secret');
  if (!clientId) throw new Error('Google sign-in is not configured yet');
  const clientSecret = packedSecret
    ? await decryptSecret(env.APP_SECRET ?? 'dev-secret', packedSecret)
    : '';

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${env.APP_ORIGIN}/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Google token exchange failed (HTTP ${tokenRes.status})`);
  }
  const tokens = (await tokenRes.json()) as { access_token?: string };
  if (!tokens.access_token) throw new Error('Google returned no access token');

  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoRes.ok) throw new Error(`Google userinfo failed (HTTP ${infoRes.status})`);
  const info = (await infoRes.json()) as {
    sub?: string;
    email?: string;
    name?: string;
    picture?: string;
  };
  if (!info.sub) throw new Error('Google account has no subject');
  return {
    sub: `google:${info.sub}`,
    provider: 'google',
    email: info.email,
    name: info.name,
    picture: info.picture,
  };
}

/* ------------------------------------------------------------------ *
 * User records + unique tags
 * ------------------------------------------------------------------ */

export async function findUser(db: D1Database, sub: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE sub = ?1').bind(sub).first<UserRow>();
}/**
   * Upsert the account row, minting a unique @mindflayer-xxxxxx tag on first sign-in.
   */
export async function ensureUserRecord(
  db: D1Database,
  env: Env,
  ru: RequestUser,
): Promise<UserRow> {
  await ensureSchema(db);
  const existing = await findUser(db, ru.sub);

  if (existing) {
    await db
      .prepare(
        `UPDATE users
           SET last_login_at = datetime('now'),
               email = ?2,
               display_name = ?3,
               picture = ?4
         WHERE sub = ?1`,
      )
      .bind(ru.sub, ru.email ?? existing.email, ru.name ?? existing.display_name, ru.picture ?? existing.picture)
      .run();
    const row = { ...existing };
    if (!row.welcomed) {
      try {
        await sendWelcome(env, db, row);
      } catch {
        /* mail is best-effort */
      }
    }
    return {
      ...row,
      email: ru.email ?? row.email,
      display_name: ru.name ?? row.display_name,
      picture: ru.picture ?? row.picture,
      last_login_at: new Date().toISOString(),
    };
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {      const tag = randomTag();
    try {
      await db
        .prepare(
          `INSERT INTO users (sub, provider, tag, display_name, email, picture)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(ru.sub, ru.provider, tag, ru.name ?? null, ru.email ?? null, ru.picture ?? null)
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
