import { Hono } from 'hono';
import { AGENTS, AGENT_ORDER } from './agents';
import {
  beginGoogleState,
  buildGoogleAuthUrl,
  checkPinToken,
  clearSessionCookie,
  consumeGoogleState,
  ensureUserRecord,
  exchangeGoogleCode,
  getGoogleConfig,
  issuePinToken,
  issueSessionCookie,
  requireUser,
  setGoogleConfig,
} from './authz';
import { encryptSecret, hashPin, randomId, verifyPin } from './crypto';
import { guardSameOrigin, jsonError, PRIVATE_HEADERS } from './http';
import { PROVIDERS, providerById, testConnection, toClient } from './providers';
import { DEFAULT_VOICES, listVoices } from './voice';
import { aiRoutes } from './ai';
import { ensureSchema } from './schema';
import type { AppDeps } from './deps';
import type { ChatRow, ConnectorRow, Env, UserRow } from './types';

const PIN_RULES = 'Use 4-12 digits';  /**
   * The Mind Flayer backend: auth + PIN lock, unlimited API connectors,
   * chat history, the 3-agent pipeline / discussion / call surfaces (ai.ts),
   * settings, themes and the branded outbox.
   */
export function createApp(deps: AppDeps): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/', aiRoutes(deps));

  /* ---------------------------------------------------------------- *
   * Public routes
   * ---------------------------------------------------------------- */
  app.get('/api/health', (c) =>
    Response.json({ ok: true, app: 'Mind Flayer', version: '1.0.0', time: Date.now() }),
  );

  app.get('/api/bootstrap', async (c) => {
    let googleConfigured = false;
    if (c.env.DB) {
      try {
        await ensureSchema(c.env.DB);
        googleConfigured = (await getGoogleConfig(c.env.DB)).configured;
      } catch (err) {
        console.error(`[bootstrap] ${c.env.APP_ENV ?? 'app'}: ${(err as Error).message}`);
        googleConfigured = false;
      }
    }
    return Response.json(
      {
        app: 'Mind Flayer',
        tagline: 'Mind Flayer · 3-agent collaborative coding',
        freebuff: Boolean(c.env.FREEBUFF_CLIENT_ID),
        google: { configured: googleConfigured },
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
   * Google OAuth: start + callback (configured from Settings)
   * ---------------------------------------------------------------- */
  app.get('/auth/google/start', async (c) => {
    if (!c.env.DB) return jsonError('Database not bound', 503);
    await ensureSchema(c.env.DB);
    const config = await getGoogleConfig(c.env.DB);
    if (!config.clientId) return c.redirect('/?auth_error=not_configured', 302);
    const state = await beginGoogleState(c.env.DB);
    return c.redirect(buildGoogleAuthUrl(config.clientId, c.env, state), 302);
  });

  app.get('/auth/google/callback', async (c) => {
    const url = new URL(c.req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');
    if (!c.env.DB) return c.redirect('/?auth_error=unavailable', 302);
    await ensureSchema(c.env.DB);
    if (oauthError || !code) return c.redirect('/?auth_error=denied', 302);
    if (!state || !(await consumeGoogleState(c.env.DB, state))) {
      return c.redirect('/?auth_error=state', 302);
    }
    try {
      const ru = await exchangeGoogleCode(c.env.DB, c.env, code);
      await ensureUserRecord(c.env.DB, c.env, ru);
      const cookie = await issueSessionCookie(c.env, ru.sub);
      return new Response(null, {
        status: 303,
        headers: { Location: '/', 'Set-Cookie': cookie },
      });
    } catch (err) {
      const detail = encodeURIComponent((err as Error).message.slice(0, 160));
      return c.redirect(`/?auth_error=${detail}`, 302);
    }
  });

  app.post('/api/auth/google/signout', (c) => {
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Set-Cookie': clearSessionCookie(c.env), ...PRIVATE_HEADERS },
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
          provider: user.provider,
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
    const        allowedThemes = ['classic-dark', 'stranger-things', 'from-series', 'arc-reactor', 'cyberpunk', 'dracula', 'monokai', 'nord', 'gruvbox', 'tokyo-night', 'one-dark-pro', 'catppuccin-mocha', 'synthwave-84', 'matrix-green', 'solarized-dark', 'github-dark', 'midnight-blue', 'emerald-abyss', 'sunset-vibes', 'rose-pine', 'palenight', 'mind-flayer-void', 'vecna-curse', 'obsidian-gold', 'titanium-glass'];
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
   * PIN lock for chat history
   * ---------------------------------------------------------------- */
  app.post('/api/pin/set', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    const body = (await c.req.json().catch(() => null)) as { pin?: string } | null;
    const pin = body?.pin ?? '';
    if (!/^\d{4,12}$/.test(pin)) return jsonError(`Invalid PIN. ${PIN_RULES}`, 400);
    const hashed = await hashPin(pin);
    await c.env.DB!.prepare('UPDATE users SET pin_hash = ?2 WHERE sub = ?1')
      .bind(gate.user.sub, hashed)
      .run();
    const token = await issuePinToken(c.env, gate.user.sub);
    return Response.json({ ok: true, token, pinEnabled: true }, { headers: PRIVATE_HEADERS });
  });

  app.post('/api/pin/verify', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    const body = (await c.req.json().catch(() => null)) as { pin?: string } | null;
    if (!gate.user.pin_hash) return jsonError('No PIN is set', 400);
    const ok = await verifyPin(body?.pin ?? '', gate.user.pin_hash);
    if (!ok) return jsonError('Wrong PIN', 403, { reason: 'bad_pin' });
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
      const ok = await verifyPin(body?.pin ?? '', gate.user.pin_hash);
      if (!ok) return jsonError('Wrong PIN', 403, { reason: 'bad_pin' });
    }
    await c.env.DB!.prepare('UPDATE users SET pin_hash = NULL WHERE sub = ?1')
      .bind(gate.user.sub)
      .run();
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
    await c.env.DB!.prepare(
      `INSERT INTO connectors (id, user_sub, provider, name, base_url, api_key_enc, model, is_default)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
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
      'SELECT id, title, mode, locked, created_at, updated_at FROM chats WHERE user_sub = ?1 ORDER BY updated_at DESC LIMIT 100',
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
   * Settings: Google OAuth credentials, voices, mail outbox
   * ---------------------------------------------------------------- */
  app.get('/api/settings/auth', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const google = await getGoogleConfig(c.env.DB!);
    return Response.json(
      {
        freebuff: { enabled: Boolean(c.env.FREEBUFF_CLIENT_ID), issuer: c.env.FREEBUFF_ISSUER ?? null },
        google: { configured: google.configured, clientId: google.clientId },
        session: { origin: c.env.APP_ORIGIN },
      },
      { headers: PRIVATE_HEADERS },
    );
  });

  app.post('/api/settings/google', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    const body = (await c.req.json().catch(() => null)) as { clientId?: string; clientSecret?: string } | null;
    if (!body?.clientId?.trim()) return jsonError('Google OAuth client ID is required', 400);
    await setGoogleConfig(c.env.DB!, c.env, body.clientId, body.clientSecret ?? '');
    return Response.json({ ok: true, configured: true }, { headers: PRIVATE_HEADERS });
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
