import { Hono } from 'hono';
import { AGENTS, AGENT_ORDER } from './agents';
import {
  checkPinToken,
  clearSessionCookie,
  codeJustIssued,
  createAuthCode,
  ensureUserRecord,
  findUserByEmail,
  issuePinToken,
  issueSessionCookie,
  kvGet,
  kvSet,
  normalizeEmail,
  passwordProblem,
  PIN_PATTERN,
  PIN_RULES,
  requireUser,
  revokeSession,
  subForEmail,
  verifyAuthCode,
} from './authz';
import { encryptSecret, hashPin, randomId, verifyPin } from './crypto';
import { guardSameOrigin, jsonError, PRIVATE_HEADERS } from './http';
import { sendVecnaCode, VECNA_SENDER_ADDRESS, VECNA_SENDER_NAME } from './mail';
import { PROVIDERS, providerById, testConnection, toClient } from './providers';
import { DEFAULT_VOICES, listVoices } from './voice';
import { aiRoutes } from './ai';
import { githubRoutes } from './github';
import { vecnaRoutes } from './vecna';
import { hellfireRoutes } from './hellfire';
import { projectAiRoutes, projectRoutes } from './projects';
import { fieldRoutes } from './field';
import { ensureSchema } from './schema';
import type { AppDeps } from './deps';
import type { ChatRow, ConnectorRow, Env, UserRow } from './types';

/**
 * The Mind Flayer backend: email + password auth with 6-digit email codes,
 * the 4-digit PIN lock, unlimited API connectors, chat history, the 3-agent
 * pipeline / discussion / call surfaces (ai.ts), settings, themes and the
 * Vecna-branded mail outbox.
 */
export function createApp(deps: AppDeps): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/', aiRoutes(deps));
  app.route('/', githubRoutes(deps));
  app.route('/', vecnaRoutes(deps));
  app.route('/', hellfireRoutes(deps));
  app.route('/', projectRoutes(deps));
  app.route('/', projectAiRoutes(deps));
  app.route('/', fieldRoutes(deps));

  /* ---------------------------------------------------------------- *
   * Public routes
   * ---------------------------------------------------------------- */
  app.get('/api/health', (c) =>
    Response.json({ ok: true, app: 'Mind Flayer', version: '1.0.0', time: Date.now() }),
  );

  app.get('/api/bootstrap', async (c) => {
    // Provision the schema on first request of a fresh deployment.
    if (c.env.DB) {
      try {
        await ensureSchema(c.env.DB);
      } catch (err) {
        console.error(`[bootstrap] ${c.env.APP_ENV ?? 'app'}: ${(err as Error).message}`);
      }
    }
    return Response.json(
      {
        app: 'Mind Flayer',
        tagline: 'Mind Flayer · Vecna + AI pool mobile coding workspace',
        vecna: {
          name: 'Vecna',
          role: 'Supreme Guide — always active, separate from the worker AIs',
          firstLoginPrompts: 'gemini-api-key',
          voiceCall: 'user<->vecna',
          ringtone: 'stranger-things-kids-theme',
        },
        workspace: {
          aiTags: 'AI 1, AI 2, AI 3 …',
          multiProject: true,
          github: { defaultRepo: 'zarifsharker4/Jarvisai1', defaultBranch: 'main' },
          tabs: [
            { id: 'vecna', label: 'Vecna Chat' },
            { id: 'hellfire', label: 'Hellfire · Group Chat & File IDE' },
            { id: 'manager', label: 'API & Field Manager' },
            { id: 'projects', label: 'Project Switcher' },
            { id: 'field', label: 'The Field' },
            { id: 'cerebro', label: 'Cerebro Search' },
          ],
        },
        auth: {
          method: 'email+password',
          otpDigits: 6,
          otpMinutes: 10,
          pinDigits: 4,
          senderName: VECNA_SENDER_NAME,
          senderAddress: VECNA_SENDER_ADDRESS,
          mailConfigured: Boolean(c.env.KNOCK_API_KEY),
        },
        providers: PROVIDERS,
        agents: AGENT_ORDER.map((id) => AGENTS[id]),
        themes: [
          { id: 'classic-dark', label: 'Classic Dark' },
          { id: 'stranger-things', label: 'Stranger Things' },
          { id: 'from-series', label: 'From Series' },
          { id: 'arc-reactor', label: 'Arc Reactor' },
          { id: 'cyberpunk', label: 'Cyberpunk' },
          { id: 'dracula', label: 'Dracula' },
          { id: 'monokai', label: 'Monokai' },
          { id: 'nord', label: 'Nord' },
          { id: 'gruvbox', label: 'Gruvbox' },
          { id: 'tokyo-night', label: 'Tokyo Night' },
          { id: 'one-dark-pro', label: 'One Dark Pro' },
          { id: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
          { id: 'synthwave-84', label: 'Synthwave 84' },
          { id: 'matrix-green', label: 'Matrix Green' },
          { id: 'solarized-dark', label: 'Solarized Dark' },
          { id: 'github-dark', label: 'GitHub Dark' },
          { id: 'midnight-blue', label: 'Midnight Blue' },
          { id: 'emerald-abyss', label: 'Emerald Abyss' },
          { id: 'sunset-vibes', label: 'Sunset Vibes' },
          { id: 'rose-pine', label: 'Rose Pine' },
          { id: 'palenight', label: 'Palenight' },
          { id: 'mind-flayer-void', label: 'Mind Flayer Void' },
          { id: 'vecna-curse', label: 'Vecna Curse' },
          { id: 'obsidian-gold', label: 'Obsidian Gold' },
          { id: 'titanium-glass', label: 'Titanium Glass' },
        ],
      },
      { headers: PRIVATE_HEADERS },
    );
  });

  app.get('/api/providers', (c) => Response.json({ providers: PROVIDERS }, { headers: PRIVATE_HEADERS }));

  /* ---------------------------------------------------------------- *
   * Email + password auth with a 6-digit emailed code
   * ---------------------------------------------------------------- */

  type AuthBody = {
    email?: string;
    password?: string;
    name?: string;
    code?: string;
    purpose?: string;
  };

  type Delivery = { status: string; provider: string; error?: string };

  /**
   * Delivery state for the client. The code itself is echoed back only outside
   * production (local dev, tests, previews) and only when the mail never left
   * the building — a production deploy without a provider fails closed instead
   * of handing out codes, and the UI says the operator must set KNOCK_API_KEY.
   */
  function deliveryPayload(
    c: { env: Env },
    delivery: Delivery,
    code: string,
  ): Record<string, unknown> {
    const canDeliver = Boolean(c.env.KNOCK_API_KEY);
    const allowDevCode = (c.env.APP_ENV ?? 'local') !== 'production';
    return {
      delivery: delivery.status,
      provider: delivery.provider,
      error: delivery.error ?? null,
      canDeliver,
      ...(allowDevCode && delivery.status !== 'sent' ? { devCode: code } : {}),
    };
  }

  async function issueCode(
    c: { env: Env },
    email: string,
    purpose: 'signup' | 'login',
    extra: { passwordHash?: string | null; displayName?: string | null },
  ) {
    const { code } = await createAuthCode(c.env.DB!, {
      email,
      purpose,
      passwordHash: extra.passwordHash ?? null,
      displayName: extra.displayName ?? null,
    });
    let delivery: Delivery = { status: 'outbox', provider: 'outbox' };
    try {
      // Filed under the account so the message is readable in Settings -> Outbox.
      delivery = await sendVecnaCode(c.env, c.env.DB!, email, code, purpose, subForEmail(email));
    } catch (err) {
      delivery = { status: 'failed', provider: 'outbox', error: (err as Error).message };
    }
    return { code, delivery };
  }

  app.post('/api/auth/signup', async (c) => {
    if (!c.env.DB) return jsonError('Database not bound', 503);
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    await ensureSchema(c.env.DB);

    const body = (await c.req.json().catch(() => null)) as AuthBody | null;
    const email = normalizeEmail(body?.email);
    if (!email) return jsonError('Enter a valid email address', 400, { field: 'email' });
    const pwProblem = passwordProblem(body?.password);
    if (pwProblem) return jsonError(pwProblem, 400, { field: 'password' });

    const existing = await findUserByEmail(c.env.DB, email);
    if (existing?.password_hash) {
      return jsonError('That email already has an account — sign in instead', 409, { reason: 'exists' });
    }
    if (await codeJustIssued(c.env.DB, email, 'signup')) {
      return jsonError('A code was just sent. Give it a minute before asking for another', 429, {
        reason: 'cooldown',
      });
    }

    const name = body?.name?.trim().slice(0, 60) || null;
    const { code, delivery } = await issueCode(c, email, 'signup', {
      passwordHash: await hashPin(body!.password!),
      displayName: name,
    });

    return Response.json(
      {
        ok: true,
        email,
        purpose: 'signup',
        otpDigits: 6,
        expiresInSeconds: 600,
        ...deliveryPayload(c, delivery, code),
      },
      { headers: PRIVATE_HEADERS },
    );
  });

  app.post('/api/auth/login', async (c) => {
    if (!c.env.DB) return jsonError('Database not bound', 503);
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    await ensureSchema(c.env.DB);

    const body = (await c.req.json().catch(() => null)) as AuthBody | null;
    const email = normalizeEmail(body?.email);
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password) return jsonError('Email and password are required', 400);

    const user = await findUserByEmail(c.env.DB, email);
    const bad = () => jsonError('Email or password is incorrect', 401, { reason: 'bad_credentials' });
    if (!user?.password_hash) {
      // Spend the same PBKDF2 work so the response does not reveal which emails exist.
      await hashPin(password);
      return bad();
    }
    if (!(await verifyPin(password, user.password_hash))) return bad();
    if (await codeJustIssued(c.env.DB, email, 'login')) {
      return jsonError('A code was just sent. Give it a minute before asking for another', 429, {
        reason: 'cooldown',
      });
    }

    const { code, delivery } = await issueCode(c, email, 'login', {});
    return Response.json(
      {
        ok: true,
        email,
        purpose: 'login',
        otpDigits: 6,
        expiresInSeconds: 600,
        ...deliveryPayload(c, delivery, code),
      },
      { headers: PRIVATE_HEADERS },
    );
  });

  app.post('/api/auth/resend', async (c) => {
    if (!c.env.DB) return jsonError('Database not bound', 503);
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    await ensureSchema(c.env.DB);

    const body = (await c.req.json().catch(() => null)) as AuthBody | null;
    const email = normalizeEmail(body?.email);
    const purpose = body?.purpose === 'signup' ? 'signup' : 'login';
    if (!email) return jsonError('Enter a valid email address', 400);

    if (await codeJustIssued(c.env.DB, email, purpose)) {
      return jsonError('A code was just sent. Give it a minute before asking for another', 429, {
        reason: 'cooldown',
      });
    }

    const previous = await c.env.DB.prepare(
      'SELECT password_hash, display_name FROM auth_codes WHERE email = ?1 AND purpose = ?2 ORDER BY created_at DESC LIMIT 1',
    )
      .bind(email, purpose)
      .first<{ password_hash: string | null; display_name: string | null }>();
    if (purpose === 'signup' && !previous?.password_hash) {
      return jsonError('Start the signup again — that request expired', 400, { reason: 'restart' });
    }
    if (purpose === 'login' && !(await findUserByEmail(c.env.DB, email))) {
      return jsonError('Email or password is incorrect', 401, { reason: 'bad_credentials' });
    }

    const { code, delivery } = await issueCode(c, email, purpose, {
      passwordHash: previous?.password_hash ?? null,
      displayName: previous?.display_name ?? null,
    });
    return Response.json(
      {
        ok: true,
        email,
        purpose,
        otpDigits: 6,
        expiresInSeconds: 600,
        ...deliveryPayload(c, delivery, code),
      },
      { headers: PRIVATE_HEADERS },
    );
  });

  app.post('/api/auth/verify', async (c) => {
    if (!c.env.DB) return jsonError('Database not bound', 503);
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    await ensureSchema(c.env.DB);

    const body = (await c.req.json().catch(() => null)) as AuthBody | null;
    const email = normalizeEmail(body?.email);
    const code = typeof body?.code === 'string' ? body.code.replace(/\D/g, '').slice(0, 6) : '';
    const purpose = body?.purpose === 'signup' ? 'signup' : 'login';
    if (!email) return jsonError('Enter a valid email address', 400);
    if (code.length !== 6) return jsonError('Enter the 6-digit code from the email', 400, { field: 'code' });

    const result = await verifyAuthCode(c.env.DB, email, code, purpose);
    if (!result.ok) {
      switch (result.reason) {
        case 'too_many_attempts':
          return jsonError('Too many wrong codes — request a new one', 429, { reason: 'too_many_attempts' });
        case 'expired':
        case 'no_code':
          return jsonError('That code expired. Request a new one', 400, { reason: 'expired' });
        default:
          return jsonError('That code is not right', 400, { reason: 'bad_code' });
      }
    }

    const sub = subForEmail(email);
    if (purpose === 'signup') {
      if (!result.row.password_hash) {
        return jsonError('Start the signup again — that request expired', 400, { reason: 'restart' });
      }
      await ensureUserRecord(
        c.env.DB,
        c.env,
        { sub, provider: 'email', email },
        { passwordHash: result.row.password_hash, displayName: result.row.display_name },
      );
    } else {
      const existing = await findUserByEmail(c.env.DB, email);
      if (!existing) return jsonError('Email or password is incorrect', 401, { reason: 'bad_credentials' });
      await ensureUserRecord(c.env.DB, c.env, { sub, provider: 'email', email });
    }

    const user = await findUserByEmail(c.env.DB, email);
    const cookie = await issueSessionCookie(c.env, sub);
    return new Response(
      JSON.stringify({
        ok: true,
        user: {
          sub,
          provider: 'email',
          tag: user?.tag ?? null,
          email,
          displayName: user?.display_name ?? null,
          pinEnabled: Boolean(user?.pin_hash),
          theme: user?.theme ?? 'mind-flayer-void',
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie, ...PRIVATE_HEADERS },
      },
    );
  });

  app.post('/api/auth/signout', async (c) => {
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    await revokeSession(c.env, c.req.raw);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Set-Cookie': clearSessionCookie(c.env), ...PRIVATE_HEADERS },
    });
  });

  /** Form fallback so a plain POST (no fetch) can also end the session. */
  app.post('/auth/signout', async (c) => {
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    await revokeSession(c.env, c.req.raw);
    return new Response(null, {
      status: 303,
      headers: { Location: '/', 'Set-Cookie': clearSessionCookie(c.env) },
    });
  });

  /* ---------------------------------------------------------------- *
   * Session + account
   * ---------------------------------------------------------------- */
  app.get('/api/me', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const user = gate.user;
    return Response.json(
      {
        user: {
          sub: user.sub,
          provider: 'email',
          tag: user.tag,
          displayName: user.display_name,
          email: user.email,
          picture: user.picture,
          theme: user.theme,
          pinEnabled: Boolean(user.pin_hash),
          voiceProfile: user.voice_profile ? JSON.parse(user.voice_profile) : null,
          createdAt: user.created_at,
        },
      },
      { headers: PRIVATE_HEADERS },
    );
  });

  app.patch('/api/me', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;

    const body = (await c.req.json().catch(() => null)) as {
      theme?: string;
      displayName?: string;
      voiceProfile?: Record<string, unknown>;
    } | null;
    const allowedThemes = [
      'classic-dark', 'stranger-things', 'from-series', 'arc-reactor', 'cyberpunk', 'dracula',
      'monokai', 'nord', 'gruvbox', 'tokyo-night', 'one-dark-pro', 'catppuccin-mocha',
      'synthwave-84', 'matrix-green', 'solarized-dark', 'github-dark', 'midnight-blue',
      'emerald-abyss', 'sunset-vibes', 'rose-pine', 'palenight', 'mind-flayer-void',
      'vecna-curse', 'obsidian-gold', 'titanium-glass',
    ];
    const updates: string[] = [];
    const values: unknown[] = [];
    if (body?.theme && allowedThemes.includes(body.theme)) {
      updates.push('theme = ?');
      values.push(body.theme);
    }
    if (typeof body?.displayName === 'string') {
      const name = body.displayName.trim().slice(0, 60);
      updates.push('display_name = ?');
      values.push(name || null);
    }
    if (body?.voiceProfile && typeof body.voiceProfile === 'object') {
      updates.push('voice_profile = ?');
      values.push(JSON.stringify(body.voiceProfile).slice(0, 4000));
    }
    if (!updates.length) return jsonError('Nothing to update', 400);
    values.push(gate.user.sub);
    await c.env.DB!.prepare(`UPDATE users SET ${updates.join(', ')} WHERE sub = ?${values.length}`)
      .bind(...values)
      .run();
    return Response.json({ ok: true }, { headers: PRIVATE_HEADERS });
  });

  /* ---------------------------------------------------------------- *
   * 4-digit PIN lock for chat history
   * ---------------------------------------------------------------- */
  const PIN_LOCK_AFTER = 5;
  const PIN_LOCK_MS = 15 * 60 * 1000;

  async function pinLockRemaining(env: Env, sub: string): Promise<number> {
    const raw = await kvGet(env.DB!, `pin_lock:${sub}`);
    if (!raw) return 0;
    const [failsRaw, untilRaw] = raw.split(':');
    const fails = Number(failsRaw) || 0;
    const until = Number(untilRaw) || 0;
    if (fails < PIN_LOCK_AFTER) return 0;
    return Math.max(0, until - Date.now());
  }

  async function penalisePin(env: Env, sub: string): Promise<number> {
    const raw = await kvGet(env.DB!, `pin_lock:${sub}`);
    const [failsRaw] = (raw ?? '').split(':');
    const fails = (Number(failsRaw) || 0) + 1;
    const until = fails >= PIN_LOCK_AFTER ? Date.now() + PIN_LOCK_MS : 0;
    await kvSet(env.DB!, `pin_lock:${sub}`, `${fails}:${until}`);
    return fails >= PIN_LOCK_AFTER ? Math.ceil((until - Date.now()) / 60000) : 0;
  }

  app.post('/api/pin/set', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    const body = (await c.req.json().catch(() => null)) as { pin?: string } | null;
    const pin = (body?.pin ?? '').trim();
    if (!PIN_PATTERN.test(pin)) return jsonError(`Invalid PIN. ${PIN_RULES}`, 400, { field: 'pin' });
    const hashed = await hashPin(pin);
    await c.env.DB!.prepare('UPDATE users SET pin_hash = ?2 WHERE sub = ?1')
      .bind(gate.user.sub, hashed)
      .run();
    await kvSet(c.env.DB!, `pin_lock:${gate.user.sub}`, '0:0');
    const token = await issuePinToken(c.env, gate.user.sub);
    return Response.json({ ok: true, token, pinEnabled: true }, { headers: PRIVATE_HEADERS });
  });

  app.post('/api/pin/verify', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    if (!gate.user.pin_hash) return jsonError('No PIN is set', 400);

    const lockedFor = await pinLockRemaining(c.env, gate.user.sub);
    if (lockedFor > 0) {
      return jsonError(`Too many wrong PINs. Try again in ${Math.ceil(lockedFor / 60000)} minutes`, 429, {
        reason: 'pin_locked',
      });
    }

    const body = (await c.req.json().catch(() => null)) as { pin?: string } | null;
    const pin = (body?.pin ?? '').trim();
    const ok = PIN_PATTERN.test(pin) && (await verifyPin(pin, gate.user.pin_hash));
    if (!ok) {
      const minutes = await penalisePin(c.env, gate.user.sub);
      return jsonError(
        minutes > 0 ? `Too many wrong PINs. Locked for ${minutes} minutes` : 'Wrong PIN',
        minutes > 0 ? 429 : 403,
        { reason: minutes > 0 ? 'pin_locked' : 'bad_pin' },
      );
    }
    await kvSet(c.env.DB!, `pin_lock:${gate.user.sub}`, '0:0');
    const token = await issuePinToken(c.env, gate.user.sub);
    return Response.json({ ok: true, token }, { headers: PRIVATE_HEADERS });
  });

  app.post('/api/pin/disable', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    const body = (await c.req.json().catch(() => null)) as { pin?: string } | null;
    if (gate.user.pin_hash) {
      const lockedFor = await pinLockRemaining(c.env, gate.user.sub);
      if (lockedFor > 0) {
        return jsonError(`Too many wrong PINs. Try again in ${Math.ceil(lockedFor / 60000)} minutes`, 429, {
          reason: 'pin_locked',
        });
      }
      const pin = (body?.pin ?? '').trim();
      const ok = PIN_PATTERN.test(pin) && (await verifyPin(pin, gate.user.pin_hash));
      if (!ok) {
        await penalisePin(c.env, gate.user.sub);
        return jsonError('Wrong PIN', 403, { reason: 'bad_pin' });
      }
    }
    await c.env.DB!.prepare('UPDATE users SET pin_hash = NULL WHERE sub = ?1')
      .bind(gate.user.sub)
      .run();
    await kvSet(c.env.DB!, `pin_lock:${gate.user.sub}`, '0:0');
    return Response.json({ ok: true, pinEnabled: false }, { headers: PRIVATE_HEADERS });
  });

  /* ---------------------------------------------------------------- *
   * Unlimited API connectors
   * ---------------------------------------------------------------- */
  app.get('/api/connectors', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const rows = await c.env.DB!.prepare(
      'SELECT * FROM connectors WHERE user_sub = ?1 ORDER BY is_default DESC, created_at ASC',
    )
      .bind(gate.user.sub)
      .all<ConnectorRow>();
    return Response.json(
      {
        connectors: rows.results.map((row) => ({
          id: row.id,
          provider: row.provider,
          providerLabel: providerById(row.provider)?.label ?? row.provider,
          name: row.name,
          baseUrl: row.base_url,
          model: row.model,
          isDefault: Boolean(row.is_default),
          isVecna: Boolean(row.is_vecna),
          enabled: Boolean(row.enabled),
          kind: providerById(row.provider)?.kind ?? 'llm',
          hasKey: Boolean(row.api_key_enc),
          keyHint: row.api_key_enc ? '•••••••• stored encrypted' : 'not set',
          createdAt: row.created_at,
        })),
      },
      { headers: PRIVATE_HEADERS },
    );
  });

  app.post('/api/connectors', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;

    const body = (await c.req.json().catch(() => null)) as {
      provider?: string;
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      isDefault?: boolean;
      isVecna?: boolean;
    } | null;
    const preset = providerById(body?.provider ?? '');
    if (!preset) return jsonError('Unknown provider', 400, { providers: PROVIDERS.map((p) => p.id) });
    const baseUrl = (body?.baseUrl?.trim() || preset.baseUrl || '').replace(/\/+$/, '');
    if (preset.kind === 'llm' && !baseUrl) return jsonError('Base URL is required', 400);
    if (preset.kind === 'llm' && !body?.apiKey?.trim() && !preset.local)
      return jsonError('API key is required', 400);

    const id = randomId(12);
    const secret = c.env.APP_SECRET ?? 'dev-secret';
    const encrypted = body?.apiKey?.trim() ? await encryptSecret(secret, body.apiKey.trim()) : null;
    if (body?.isDefault) {
      await c.env.DB!.prepare('UPDATE connectors SET is_default = 0 WHERE user_sub = ?1')
        .bind(gate.user.sub)
        .run();
    }
    if (body?.isVecna) {
      // Vecna runs on exactly one connector — demote any previous one.
      await c.env.DB!.prepare('UPDATE connectors SET is_vecna = 0 WHERE user_sub = ?1')
        .bind(gate.user.sub)
        .run();
    }
    await c.env.DB!.prepare(
      `INSERT INTO connectors (id, user_sub, provider, name, base_url, api_key_enc, model, is_default, is_vecna)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(
        id,
        gate.user.sub,
        preset.id,
        body?.name?.trim() || preset.label,
        baseUrl,
        encrypted,
        body?.model?.trim() || preset.defaultModel || null,
        body?.isDefault ? 1 : 0,
        body?.isVecna ? 1 : 0,
      )
      .run();
    return Response.json({ ok: true, id }, { status: 201, headers: PRIVATE_HEADERS });
  });

  app.put('/api/connectors/:id', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;

    const id = c.req.param('id');
    const row = await c.env.DB!.prepare('SELECT * FROM connectors WHERE id = ?1 AND user_sub = ?2')
      .bind(id, gate.user.sub)
      .first<ConnectorRow>();
    if (!row) return jsonError('Connector not found', 404);

    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      enabled?: boolean;
      isDefault?: boolean;
    } | null;
    const secret = c.env.APP_SECRET ?? 'dev-secret';
    const updates: string[] = [];
    const values: unknown[] = [];
    if (typeof body?.name === 'string') {
      updates.push('name = ?');
      values.push(body.name.trim().slice(0, 60) || row.name);
    }
    if (typeof body?.baseUrl === 'string') {
      updates.push('base_url = ?');
      values.push(body.baseUrl.trim().replace(/\/+$/, '') || row.base_url);
    }
    if (typeof body?.model === 'string') {
      updates.push('model = ?');
      values.push(body.model.trim() || null);
    }
    if (typeof body?.enabled === 'boolean') {
      updates.push('enabled = ?');
      values.push(body.enabled ? 1 : 0);
    }
    if (body?.apiKey?.trim()) {
      updates.push('api_key_enc = ?');
      values.push(await encryptSecret(secret, body.apiKey.trim()));
    }
    if (body?.isDefault) {
      await c.env.DB!.prepare('UPDATE connectors SET is_default = 0 WHERE user_sub = ?1')
        .bind(gate.user.sub)
        .run();
      updates.push('is_default = 1');
      values.push(1);
    }
    if (!updates.length) return jsonError('Nothing to update', 400);
    updates.push("updated_at = datetime('now')");
    values.push(id, gate.user.sub);
    await c.env.DB!.prepare(
      `UPDATE connectors SET ${updates.join(', ')} WHERE id = ?${updates.length} AND user_sub = ?${updates.length + 1}`,
    )
      .bind(...values)
      .run();
    return Response.json({ ok: true }, { headers: PRIVATE_HEADERS });
  });

  app.delete('/api/connectors/:id', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    await c.env.DB!.prepare('DELETE FROM connectors WHERE id = ?1 AND user_sub = ?2')
      .bind(c.req.param('id'), gate.user.sub)
      .run();
    return Response.json({ ok: true }, { headers: PRIVATE_HEADERS });
  });

  app.post('/api/connectors/:id/test', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    const row = await c.env.DB!.prepare('SELECT * FROM connectors WHERE id = ?1 AND user_sub = ?2')
      .bind(c.req.param('id'), gate.user.sub)
      .first<ConnectorRow>();
    if (!row) return jsonError('Connector not found', 404);
    if (row.provider === 'elevenlabs') {
      const result = await listVoices(c.env, [row], c.env.APP_SECRET ?? 'dev-secret');
      return Response.json(
        { ok: result.ok, detail: result.ok ? `${result.voices.length} voices available` : result.detail ?? 'failed' },
        { headers: PRIVATE_HEADERS },
      );
    }
    const client = await toClient(row, c.env.APP_SECRET ?? 'dev-secret');
    const result = await testConnection(client);
    return Response.json(result, { headers: PRIVATE_HEADERS });
  });

  /* ---------------------------------------------------------------- *
   * Chat history (PIN-gated)
   * ---------------------------------------------------------------- */
  app.get('/api/chats', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    if (gate.user.pin_hash) {
      const ok = await checkPinToken(c.env, c.req.header('x-mindflayer-pin'), gate.user.sub);
      if (!ok) return jsonError('PIN required to unlock chat history', 423, { reason: 'pin_required' });
    }
    const rows = await c.env.DB!.prepare(
      'SELECT id, title, mode, locked, project_id, created_at, updated_at FROM chats WHERE user_sub = ?1 ORDER BY updated_at DESC LIMIT 100',
    )
      .bind(gate.user.sub)
      .all<ChatRow>();
    return Response.json(
      {
        chats: rows.results.map((row) => ({
          id: row.id,
          title: row.title,
          mode: row.mode,
          locked: Boolean(row.locked) || Boolean(gate.user.pin_hash),
          projectId: row.project_id ?? null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      },
      { headers: PRIVATE_HEADERS },
    );
  });

  app.post('/api/chats', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    const body = (await c.req.json().catch(() => null)) as { title?: string; mode?: string } | null;
    const id = randomId(12);
    await c.env.DB!.prepare('INSERT INTO chats (id, user_sub, title, mode) VALUES (?1, ?2, ?3, ?4)')
      .bind(id, gate.user.sub, body?.title?.trim().slice(0, 80) || 'New chat', body?.mode ?? 'chat')
      .run();
    return Response.json({ ok: true, id }, { status: 201, headers: PRIVATE_HEADERS });
  });

  app.get('/api/chats/:id/messages', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const chat = await c.env.DB!.prepare('SELECT * FROM chats WHERE id = ?1 AND user_sub = ?2')
      .bind(c.req.param('id'), gate.user.sub)
      .first<ChatRow>();
    if (!chat) return jsonError('Chat not found', 404);
    if (gate.user.pin_hash || chat.locked) {
      const ok = await checkPinToken(c.env, c.req.header('x-mindflayer-pin'), gate.user.sub);
      if (!ok) return jsonError('PIN required to unlock chat history', 423, { reason: 'pin_required' });
    }
    const rows = await c.env.DB!.prepare(
      'SELECT id, role, agent, content, meta, created_at FROM messages WHERE chat_id = ?1 AND user_sub = ?2 ORDER BY created_at ASC LIMIT 500',
    )
      .bind(chat.id, gate.user.sub)
      .all();
    return Response.json(
      { chat: { id: chat.id, title: chat.title, mode: chat.mode, locked: Boolean(chat.locked) }, messages: rows.results },
      { headers: PRIVATE_HEADERS },
    );
  });

  app.delete('/api/chats/:id', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    const id = c.req.param('id');
    if (gate.user.pin_hash) {
      const ok = await checkPinToken(c.env, c.req.header('x-mindflayer-pin'), gate.user.sub);
      if (!ok) return jsonError('PIN required to unlock chat history', 423, { reason: 'pin_required' });
    }
    await c.env.DB!.prepare('DELETE FROM messages WHERE chat_id = ?1 AND user_sub = ?2')
      .bind(id, gate.user.sub)
      .run();
    await c.env.DB!.prepare('DELETE FROM chats WHERE id = ?1 AND user_sub = ?2')
      .bind(id, gate.user.sub)
      .run();
    return Response.json({ ok: true }, { headers: PRIVATE_HEADERS });
  });

  app.patch('/api/chats/:id', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    const body = (await c.req.json().catch(() => null)) as { locked?: boolean; title?: string } | null;
    const updates: string[] = [];
    const values: unknown[] = [];
    if (typeof body?.locked === 'boolean') {
      updates.push('locked = ?');
      values.push(body.locked ? 1 : 0);
    }
    if (typeof body?.title === 'string') {
      updates.push('title = ?');
      values.push(body.title.trim().slice(0, 80));
    }
    if (!updates.length) return jsonError('Nothing to update', 400);
    values.push(c.req.param('id'), gate.user.sub);
    await c.env.DB!.prepare(
      `UPDATE chats SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?${values.length - 1} AND user_sub = ?${values.length}`,
    )
      .bind(...values)
      .run();
    return Response.json({ ok: true }, { headers: PRIVATE_HEADERS });
  });

  /* ---------------------------------------------------------------- *
   * Settings: session info, voices, mail outbox
   * ---------------------------------------------------------------- */
  app.get('/api/settings/auth', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    return Response.json(
      {
        email: gate.user.email,
        passwordSet: Boolean(gate.user.password_hash),
        pinDigits: 4,
        sender: {
          name: VECNA_SENDER_NAME,
          address: VECNA_SENDER_ADDRESS,
          avatar: `${c.env.APP_ORIGIN.replace(/\/+$/, '')}/brand/vecna-avatar.png`,
          mailConfigured: Boolean(c.env.KNOCK_API_KEY),
        },
        session: { origin: c.env.APP_ORIGIN },
      },
      { headers: PRIVATE_HEADERS },
    );
  });

  app.get('/api/outbox', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const rows = await c.env.DB!.prepare(
      'SELECT id, to_email, from_email, subject, html, body_text, status, provider, error, created_at, sent_at FROM outbox WHERE user_sub = ?1 ORDER BY created_at DESC LIMIT 25',
    )
      .bind(gate.user.sub)
      .all();
    return Response.json({ emails: rows.results }, { headers: PRIVATE_HEADERS });
  });

  app.get('/api/agents', (c) =>
    Response.json(
      {
        agents: AGENT_ORDER.map((id) => AGENTS[id]),
        voices: DEFAULT_VOICES,
      },
      { headers: PRIVATE_HEADERS },
    ),
  );

  /* Fallback JSON for unknown API routes (never fall into the SPA). */
  app.all('/api/*', (c) => jsonError(`Unknown API route: ${c.req.method} ${new URL(c.req.url).pathname}`, 404));
  app.all('/auth/*', (c) => jsonError(`Unknown auth route: ${new URL(c.req.url).pathname}`, 404));

  /** Never leak stack traces to the browser; details go to Worker logs. */
  app.onError((err, c) => {
    console.error(`[error] ${c.req.method} ${new URL(c.req.url).pathname}: ${err.message}`);
    return jsonError('Internal server error', 500);
  });

  /** Everything else is a static asset (or the SPA shell when assets are bound). */
  app.notFound(async (c) => {
    if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
    return jsonError(`Not found: ${c.req.method} ${new URL(c.req.url).pathname}`, 404);
  });

  return app;
}

/** Re-exported for tests that need a user row type. */
export type { UserRow };
