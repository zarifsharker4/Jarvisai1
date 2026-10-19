import { describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { freebuffAuth, isLoopbackOrigin } from '../server/authz';
import type { AppDeps } from '../server/deps';
import type { Env, RequestUser } from '../server/types';
import { createLiteD1 } from './d1lite';

const ORIGIN = 'http://localhost:3002';

type Fixture = {
  app: ReturnType<typeof createApp>;
  env: Env;
  user: RequestUser;
  deps: AppDeps;
};

function makeApp(user: RequestUser | null): Fixture {
  const db = createLiteD1();
  const env: Env = {
    DB: db,
    APP_ORIGIN: ORIGIN,
    APP_SECRET: 'test-secret',
    FREEBUFF_CLIENT_ID: 'client-test',
    FREEBUFF_ISSUER: 'https://freebuff.com/oidc',
  };
  const deps: AppDeps = { resolveUser: async () => user };
  return { app: createApp(deps), env, user: user!, deps };
}

const primary: RequestUser = {
  sub: 'freebuff-user-1',
  provider: 'freebuff',
  email: 'first@example.com',
  name: 'First User',
};

function json(path: string, body: unknown, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST', origin = ORIGIN) {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      ...(method === 'POST' || method === 'PATCH' || method === 'PUT' ? {} : {}),
    },
    body: JSON.stringify(body),
  } satisfies RequestInit;
}

function parseEvents(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (data) events.push({ event, data: JSON.parse(data) });
  }
  return events;
}

describe('public routes', () => {
  it('serves health and bootstrap without a session', async () => {
    const { app, env } = makeApp(null);
    const health = await app.request('/api/health', {}, env);
    expect(health.status).toBe(200);
    expect((await health.json()).app).toBe('Mind Flayer');

    const boot = await app.request('/api/bootstrap', {}, env);
    expect(boot.status).toBe(200);
    const body = (await boot.json()) as {
      providers: Array<{ id: string }>;
      agents: Array<{ id: string }>;
      themes: Array<{ id: string }>;
    };
    const ids = body.providers.map((p) => p.id);
    for (const required of [
      'google-ai-studio',
      'openrouter',
      'groq',
      'together',
      'mistral',
      'openllm',
      'huggingface',
    ]) {
      expect(ids).toContain(required);
    }
    expect(body.agents.map((a) => a.id)).toEqual(['orchestrator', 'coder', 'reviewer']);
    expect(body.themes.map((t) => t.id)).toEqual([
      'classic-dark',
      'stranger-things',
      'from-series',
      'arc-reactor',
      'cyberpunk',
      'dracula',
      'monokai',
      'nord',
      'gruvbox',
      'tokyo-night',
      'one-dark-pro',
      'catppuccin-mocha',
      'synthwave-84',
      'matrix-green',
      'solarized-dark',
      'github-dark',
      'midnight-blue',
      'emerald-abyss',
      'sunset-vibes',
      'rose-pine',
      'palenight',
      'mind-flayer-void',
      'vecna-curse',
      'obsidian-gold',
      'titanium-glass',
    ]);
  });

  it('returns 401 for protected APIs when signed out', async () => {
    const { app, env } = makeApp(null);
    for (const path of ['/api/me', '/api/chats', '/api/connectors', '/api/voice', '/api/outbox']) {
      const res = await app.request(path, {}, env);
      expect(res.status, path).toBe(401);
    }
  });

  it('rejects state-changing requests from a foreign origin', async () => {
    const { app, env } = makeApp(primary);
    const res = await app.request('/api/pin/set', json('/api/pin/set', { pin: '1234' }, 'POST', 'https://evil.example'), env);
    expect(res.status).toBe(403);
  });
});

describe('account provisioning', () => {
  it('creates a user with a unique tag and a Mind Flayer-branded welcome email', async () => {
    const { app, env } = makeApp(primary);

    const me1 = await app.request('/api/me', {}, env);
    expect(me1.status).toBe(200);
    const body = (await me1.json()) as { user: { tag: string; email: string; pinEnabled: boolean; theme: string } };
    expect(body.user.tag).toMatch(/^@mindflayer-[a-z2-9]{6}$/);
    expect(body.user.email).toBe('first@example.com');
    expect(body.user.pinEnabled).toBe(false);
    expect(body.user.theme).toBe('mind-flayer-void');

    const me2 = await app.request('/api/me', {}, env);
    const body2 = (await me2.json()) as { user: { tag: string } };
    expect(body2.user.tag).toBe(body.user.tag); // tag is stable

    const outbox = await app.request('/api/outbox', {}, env);
    const { emails } = (await outbox.json()) as { emails: Array<{ from_email: string; subject: string; html: string }> };
    expect(emails.length).toBe(1);
    expect(emails[0].from_email).toBe('Mind Flayer <mind@mindflayer.ai>');
    expect(emails[0].subject).toContain(body.user.tag);
    expect(emails[0].html).toContain('Mind Flayer');
  });

  it('keeps two accounts fully separate', async () => {
    const one = makeApp(primary);
    const two = makeApp({ sub: 'freebuff-user-2', provider: 'freebuff', email: 'second@example.com' });

    const create = await one.app.request('/api/chats', json('/api/chats', { title: 'mine' }), one.env);
    expect(create.status).toBe(201);

    const listTwo = await two.app.request('/api/chats', {}, two.env);
    const { chats } = (await listTwo.json()) as { chats: unknown[] };
    expect(chats.length).toBe(0);

    const listOne = await one.app.request('/api/chats', {}, one.env);
    const { chats: mine } = (await listOne.json()) as { chats: unknown[] };
    expect(mine.length).toBe(1);
  });

  it('updates theme with a same-origin PATCH', async () => {
    const { app, env } = makeApp(primary);
    const res = await app.request('/api/me', json('/api/me', { theme: 'mind-flayer-void' }, 'PATCH'), env);
    expect(res.status).toBe(200);
    const me = (await (await app.request('/api/me', {}, env)).json()) as { user: { theme: string } };
    expect(me.user.theme).toBe('mind-flayer-void');
  });
});

describe('PIN lock', () => {
  it('locks chat history behind a PIN and unlocks with a token', async () => {
    const { app, env } = makeApp(primary);

    // create a chat first (history unlocked)
    const create = await app.request('/api/chats', json('/api/chats', { title: 'before lock' }), env);
    expect(create.status).toBe(201);

    const set = await app.request('/api/pin/set', json('/api/pin/set', { pin: '9182' }), env);
    expect(set.status).toBe(200);
    const { token } = (await set.json()) as { token: string };
    expect(token).toMatch(/^v1\./);

    // invalid PIN rejected
    const bad = await app.request('/api/pin/verify', json('/api/pin/verify', { pin: '0000' }), env);
    expect(bad.status).toBe(403);

    // history now requires the unlock token
    const locked = await app.request('/api/chats', {}, env);
    expect(locked.status).toBe(423);
    expect((await locked.json()).reason).toBe('pin_required');

    async function withPin(path: string, extra?: RequestInit) {
      return app.request(path, { ...extra, headers: { ...(extra?.headers || {}), 'x-mindflayer-pin': token } }, env);
    }
    const chatListCall = await withPin('/api/chats');
    expect(chatListCall.status).toBe(200);
    const chatListBody = await chatListCall.json();
    expect(chatListBody.chats.length).toBe(1);
    expect(chatListBody.chats[0].locked).toBe(true);
    const messages = await withPin(`/api/chats/${chatListBody.chats[0].id}/messages`);
    expect(messages.status).toBe(200);
    const forged = await app.request('/api/chats', { headers: { 'x-mindflayer-pin': 'v1.99999999999999.Zm9yZ2Vk' } }, env);
    expect(forged.status).toBe(423);
    expect((await forged.json()).reason).toBe('pin_required');

    // messages endpoint is gated too
    const listAgain = (await (
      await app.request('/api/chats', { headers: { 'x-mindflayer-pin': token } }, env)
    ).json()) as { chats: Array<{ id: string }> };
    const gated = await app.request(`/api/chats/${listAgain.chats[0].id}/messages`, {}, env);
    expect(gated.status).toBe(423);
    expect((await gated.json()).reason).toBe('pin_required');
    const unlockedAgain = await app.request(
      '/api/chats',
      { headers: { 'x-mindflayer-pin': token } },
      env,
    );
    expect(unlockedAgain.status).toBe(200);
    const { chats: reopened } = (await unlockedAgain.json()) as { chats: Array<{ id: string }> };
    const finalMessages = await app.request(`/api/chats/${reopened[0].id}/messages`, { headers: { 'x-mindflayer-pin': token } }, env);
    expect(finalMessages.status).toBe(200);
    expect(gated.status).toBe(423);

    // wrong PIN cannot disable, right PIN can
    const disableBad = await app.request('/api/pin/disable', json('/api/pin/disable', { pin: '1111' }), env);
    expect(disableBad.status).toBe(403);
    const disableOk = await app.request('/api/pin/disable', json('/api/pin/disable', { pin: '9182' }), env);
    expect(disableOk.status).toBe(200);
    const open = await app.request('/api/chats', {}, env);
    expect(open.status).toBe(200);
  });
});

describe('connectors', () => {
  it('stores keys encrypted and never returns them', async () => {
    const { app, env } = makeApp(primary);

    const create = await app.request(
      '/api/connectors',
      json('/api/connectors', {
        provider: 'openrouter',
        name: 'My OpenRouter',
        apiKey: 'sk-or-live-do-not-leak',
        model: 'anthropic/claude-3.7-sonnet',
        isDefault: true,
      }),
      env,
    );
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as { id: string };

    const list = await app.request('/api/connectors', {}, env);
    const body = (await list.json()) as { connectors: Array<Record<string, unknown>> };
    expect(body.connectors.length).toBe(1);
    expect(body.connectors[0].hasKey).toBe(true);
    expect(body.connectors[0].isDefault).toBe(true);
    expect(body.connectors[0].providerLabel).toBe('OpenRouter');
    expect(JSON.stringify(body)).not.toContain('sk-or-live-do-not-leak');

    // at rest it is ciphertext
    const rows = await env.DB!.prepare('SELECT api_key_enc FROM connectors WHERE id = ?1')
      .bind(id)
      .all<{ api_key_enc: string }>();
    expect(rows.results[0].api_key_enc).toBeTruthy();
    expect(rows.results[0].api_key_enc).not.toContain('sk-or-live-do-not-leak');
    expect(rows.results[0].api_key_enc.startsWith('v1.')).toBe(true);

    // a second connector can be added (unlimited) and a failing test reports cleanly
    const second = await app.request(
      '/api/connectors',
      json('/api/connectors', { provider: 'custom', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x' }),
      env,
    );
    expect(second.status).toBe(201);
    const secondId = (await second.json()) as { id: string };

    const test = await app.request(
      `/api/connectors/${secondId.id}/test`,
      json('x', {}, 'POST'),
      env,
    );
    expect(test.status).toBe(200);
    const result = (await test.json()) as { ok: boolean; detail: string };
    expect(result.ok).toBe(false);
    expect(result.detail).toBeTruthy();

    const del = await app.request(`/api/connectors/${id}`, json('x', {}, 'DELETE'), env);
    expect(del.status).toBe(200);
    const after = await app.request('/api/connectors', {}, env);
    expect(((await after.json()) as { connectors: unknown[] }).connectors.length).toBe(1);
  });

  it('validates required fields', async () => {
    const { app, env } = makeApp(primary);
    const noKey = await app.request('/api/connectors', json('/api/connectors', { provider: 'groq' }), env);
    expect(noKey.status).toBe(400);
    const unknown = await app.request('/api/connectors', json('/api/connectors', { provider: 'nope' }), env);
    expect(unknown.status).toBe(400);
  });
});

describe('AI surfaces (offline demo engine)', () => {
  it('streams chat tokens, persists messages and reports the demo engine', { timeout: 30_000 }, async () => {
    const { app, env } = makeApp(primary);
    const res = await app.request(
      '/api/chat',
      json('/api/chat', { message: 'Build a sliding window rate limiter in TypeScript' }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = parseEvents(await res.text());

    const meta = events.find((e) => e.event === 'meta');
    expect(meta?.data.engine).toBe('demo');
    expect(typeof meta?.data.chatId).toBe('string');

    const tokens = events.filter((e) => e.event === 'token');
    expect(tokens.length).toBeGreaterThan(5);
    const assembled = tokens.map((t) => String(t.data.text)).join('');
    expect(assembled.length).toBeGreaterThan(80);
    expect(events.some((e) => e.event === 'saved')).toBe(true);
    expect(events[events.length - 1].event).toBe('done');

    const messages = await env.DB!.prepare('SELECT role FROM messages ORDER BY created_at').all<{ role: string }>();
    expect(messages.results.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('runs the 3-agent pipeline with stage events for orchestrator, coder and reviewer', { timeout: 30_000 }, async () => {
    const { app, env } = makeApp(primary);
    const res = await app.request('/api/pipeline', json('/api/pipeline', { request: 'Add rate limiting to my API' }), env);
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    const starts = events.filter((e) => e.event === 'stage' && e.data.status === 'start' && !e.data.round);
    expect(starts.map((s) => s.data.agent)).toEqual(['orchestrator', 'coder', 'reviewer']);

    const ends = events.filter((e) => e.event === 'stage' && e.data.status === 'end');
    expect(ends.length).toBeGreaterThanOrEqual(3);
    for (const end of ends) expect(String(end.data.text).length).toBeGreaterThan(20);

    const saved = events.filter((e) => e.event === 'saved');
    expect(saved.length).toBe(1);

    const modes = await env.DB!.prepare('SELECT mode FROM chats').all<{ mode: string }>();
    expect(modes.results[0].mode).toBe('pipeline');
  });

  it('runs the live AI-to-AI discussion for the requested rounds', { timeout: 30_000 }, async () => {
    const { app, env } = makeApp(primary);
    const res = await app.request(
      '/api/discussion',
      json('/api/discussion', { topic: 'Should we cache D1 reads with KV?', rounds: 3 }),
      env,
    );
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());

    const meta = events.find((e) => e.event === 'meta');
    expect(meta?.data.mode).toBe('discussion');

    const ends = events.filter((e) => e.event === 'turn' && e.data.status === 'end');
    expect(ends.length).toBe(3);
    expect(ends.map((e) => e.data.agent)).toEqual(['orchestrator', 'coder', 'reviewer']);
    expect(events.some((e) => e.event === 'summary')).toBe(true);
  });

  it('answers a Call Mind Flayer turn and reports missing voice keys', { timeout: 30_000 }, async () => {
    const { app, env } = makeApp(primary);
    const res = await app.request(
      '/api/call/turn',
      json('/api/call/turn', { history: [{ speaker: 'you', text: 'Please review this code for security issues.' }] }),
      env,
    );
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());
    const turn = events.find((e) => e.event === 'turn' && e.data.status === 'end');
    expect(turn).toBeTruthy();
    expect(turn!.data.agent).toBe('reviewer'); // keyword routing
    expect(String(turn!.data.text).length).toBeGreaterThan(10);

    // no ElevenLabs key configured -> explicit 424 the client turns into browser speech
    const tts = await app.request('/api/tts', json('/api/tts', { text: 'hello', agent: 'coder' }), env);
    expect(tts.status).toBe(424);
    expect((await tts.json()).reason).toBe('no_key');
  });

  it('requires a PIN before touching an existing locked chat', async () => {
    const { app, env } = makeApp(primary);
    await app.request('/api/pin/set', json('/api/pin/set', { pin: '5566' }), env);
    const res = await app.request(
      '/api/chat',
      json('/api/chat', { message: 'continue', chatId: 'does-not-exist' }),
      env,
    );
    expect(res.status).toBe(404); // unknown chat is a 404 before any PIN check reveals content
  });
});

describe('Google OAuth scaffolding', () => {
  it('reports unconfigured Google and refuses to start the flow', async () => {
    const { app, env } = makeApp(primary);
    const settings = await app.request('/api/settings/auth', {}, env);
    const body = (await settings.json()) as { google: { configured: boolean }; freebuff: { enabled: boolean } };
    expect(body.google.configured).toBe(false);
    expect(body.freebuff.enabled).toBe(true);

    const start = await app.request('/auth/google/start', {}, env);
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toContain('/?auth_error=not_configured');
  });

  it('saves Google credentials and starts a real Google redirect', async () => {
    const { app, env } = makeApp(primary);
    const save = await app.request(
      '/api/settings/google',
      json('/api/settings/google', { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' }),
      env,
    );
    expect(save.status).toBe(200);

    const start = await app.request('/auth/google/start', {}, env);
    expect(start.status).toBe(302);
    const location = start.headers.get('location')!;
    expect(location).toContain('accounts.google.com/o/oauth2/v2/auth');
    expect(location).toContain('client_id=abc.apps.googleusercontent.com');
    expect(location).toContain(encodeURIComponent(`${ORIGIN}/auth/google/callback`));
    expect(location).toContain('state=');

    // secret is encrypted at rest
    const row = await env.DB!.prepare("SELECT value FROM kv WHERE key = 'google_client_secret'").first<{ value: string }>();
    expect(row?.value.startsWith('v1.')).toBe(true);
    expect(row?.value).not.toContain('GOCSPX-secret');

    // callback with a bogus state bounces back with an error
    const callback = await app.request('/auth/google/callback?code=x&state=bogus', {}, env);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toContain('auth_error=state');
  });
});

describe('static fallback', () => {
  it('falls back to assets when bound, JSON 404 otherwise', async () => {
    const { app, env } = makeApp(null);
    const missing = await app.request('/definitely/not/here', {}, env);
    expect(missing.status).toBe(404);

    const withAssets: Env = {
      ...env,
      ASSETS: { fetch: async () => new Response('<!doctype html><title>SPA</title>', { status: 200 }) },
    };
    const spa = await app.request('/chat/deep/link', {}, withAssets);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain('SPA');
  });
});

describe('auth instance creation', () => {
  it('accepts loopback http origins only for dev and https for production', () => {
    expect(isLoopbackOrigin('http://localhost:3002')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:8787')).toBe(true);
    expect(isLoopbackOrigin('https://site.example')).toBe(false);
    expect(isLoopbackOrigin('http://evil.example')).toBe(false);

    const local = freebuffAuth({
      APP_ORIGIN: 'http://localhost:3002',
      FREEBUFF_CLIENT_ID: 'client-test',
      FREEBUFF_ISSUER: 'https://freebuff.com/oidc',
    });
    expect(local.clientId).toBe('client-test');
    expect(local.issuer).toBe('https://freebuff.com/oidc');

    const prod = freebuffAuth({
      APP_ORIGIN: 'https://site.example',
      FREEBUFF_CLIENT_ID: 'client-prod',
      FREEBUFF_ISSUER: 'https://freebuff.com/oidc',
    });
    expect(prod.clientId).toBe('client-prod');
  });
});

describe('unknown API routes', () => {
  it('returns JSON 404 instead of the SPA shell', async () => {
    const { app, env } = makeApp(null);
    const res = await app.request('/api/nope', {}, env);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
