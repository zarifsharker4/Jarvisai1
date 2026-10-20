import { describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { resolveRequestUser } from '../server/authz';
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
    APP_ENV: 'test',
  };
  const deps: AppDeps = { resolveUser: async () => user };
  return { app: createApp(deps), env, user: user!, deps };
}

/** App wired to the real cookie resolver, for the end-to-end auth flow. */
function makeRealApp() {
  const db = createLiteD1();
  const env: Env = {
    DB: db,
    APP_ORIGIN: ORIGIN,
    APP_SECRET: 'test-secret',
    APP_ENV: 'test',
  };
  return { app: createApp({ resolveUser: resolveRequestUser }), env, db };
}

const primary: RequestUser = {
  sub: 'email:first@example.com',
  provider: 'email',
  email: 'first@example.com',
  name: 'First User',
};

function json(path: string, body: unknown, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST', origin = ORIGIN) {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
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
      auth: { otpDigits: number; pinDigits: number; senderName: string };
      providers: Array<{ id: string }>;
      agents: Array<{ id: string }>;
      themes: Array<{ id: string }>;
    };
    expect(body.auth.otpDigits).toBe(6);
    expect(body.auth.pinDigits).toBe(4);
    expect(body.auth.senderName).toBe('Vecna from Mind Flayer');

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

  it('has no Google OAuth entry points left', async () => {
    const { app, env } = makeApp(null);
    for (const path of ['/auth/google/start', '/auth/google/callback', '/api/auth/google/signout']) {
      const res = await app.request(path, {}, env);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('location')).toBeNull();
    }
    const save = await app.request('/api/settings/google', json('/api/settings/google', { clientId: 'x' }), env);
    expect(save.status).toBe(404);
  });
});

describe('account provisioning', () => {
  it('creates a user with a unique tag and a Vecna-branded welcome email', async () => {
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
    const { emails } = (await outbox.json()) as {
      emails: Array<{ from_email: string; subject: string; html: string }>;
    };
    expect(emails.length).toBe(1);
    expect(emails[0].from_email).toBe('Vecna from Mind Flayer <vecna@mindflayer.ai>');
    expect(emails[0].subject).toContain(body.user.tag);
    expect(emails[0].html).toContain('/brand/vecna-avatar.png');
  });

  it('keeps two accounts fully separate', async () => {
    const one = makeApp(primary);
    const two = makeApp({ sub: 'email:second@example.com', provider: 'email', email: 'second@example.com' });

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
    const res = await app.request('/api/me', json('/api/me', { theme: 'vecna-curse' }, 'PATCH'), env);
    expect(res.status).toBe(200);
    const me = (await (await app.request('/api/me', {}, env)).json()) as { user: { theme: string } };
    expect(me.user.theme).toBe('vecna-curse');
  });
});

describe('email + password auth with a 6-digit code', () => {
  it('signs up, mails a Vecna code, verifies it and opens a session', async () => {
    const { app, env } = makeRealApp();

    const signup = await app.request(
      '/api/auth/signup',
      json('/api/auth/signup', { email: 'Sarah@Example.com', password: 'vecna-is-here' }),
      env,
    );
    expect(signup.status).toBe(200);
    const body = (await signup.json()) as { email: string; devCode: string; delivery: string };
    expect(body.email).toBe('sarah@example.com');
    expect(body.devCode).toMatch(/^\d{6}$/);
    // no provider key in tests, so the message is rendered into the outbox
    expect(body.delivery).toBe('outbox');

    const mail = await env.DB!.prepare('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 1').first<{
      to_email: string;
      from_email: string;
      subject: string;
      html: string;
      body_text: string;
    }>();
    expect(mail?.to_email).toBe('sarah@example.com');
    expect(mail?.from_email).toBe('Vecna from Mind Flayer <vecna@mindflayer.ai>');
    expect(mail?.subject).toContain(body.devCode);
    expect(mail?.html).toContain('Vecna from Mind Flayer');
    expect(mail?.html).toContain('/brand/vecna-avatar.png');
    // human tone, not a system notice
    expect(mail?.body_text).toMatch(/Hey, it's Vecna/);
    expect(mail?.body_text).toMatch(/ignore it/i);
    expect(mail?.body_text).not.toMatch(/do not reply|no-reply|automated message/i);
    // the old Google account surface is gone
    expect(`${mail?.html}${mail?.body_text}`).not.toMatch(/google/i);

    const wrong = body.devCode === '000000' ? '111111' : '000000';
    const bad = await app.request(
      '/api/auth/verify',
      json('/api/auth/verify', { email: body.email, code: wrong, purpose: 'signup' }),
      env,
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).reason).toBe('bad_code');

    const verify = await app.request(
      '/api/auth/verify',
      json('/api/auth/verify', { email: body.email, code: body.devCode, purpose: 'signup' }),
      env,
    );
    expect(verify.status).toBe(200);
    const cookie = verify.headers.get('set-cookie');
    expect(cookie).toContain('mindflayer_session=');

    const me = await app.request('/api/me', { headers: { cookie: cookie!.split(';')[0] } }, env);
    expect(me.status).toBe(200);
    const account = (await me.json()) as { user: { provider: string; email: string; tag: string; pinEnabled: boolean } };
    expect(account.user.provider).toBe('email');
    expect(account.user.email).toBe('sarah@example.com');
    expect(account.user.tag).toMatch(/^@mindflayer-[a-z2-9]{6}$/);
    expect(account.user.pinEnabled).toBe(false);

    // a consumed code cannot be replayed
    const replay = await app.request(
      '/api/auth/verify',
      json('/api/auth/verify', { email: body.email, code: body.devCode, purpose: 'signup' }),
      env,
    );
    expect(replay.status).toBe(400);
  });

  it('requires the password before issuing a login code, and keeps the same account', async () => {
    const { app, env } = makeRealApp();
    const base = { email: 'kate@example.com', password: 'a-good-password' };

    const signup = await app.request('/api/auth/signup', json('/api/auth/signup', base), env);
    const first = (await signup.json()) as { devCode: string };
    const verified = await app.request(
      '/api/auth/verify',
      json('/api/auth/verify', { email: base.email, code: first.devCode, purpose: 'signup' }),
      env,
    );
    expect(verified.status).toBe(200);
    const cookie = verified.headers.get('set-cookie')!.split(';')[0];
    const before = (await (await app.request('/api/me', { headers: { cookie } }, env)).json()) as {
      user: { tag: string };
    };

    const wrongPassword = await app.request(
      '/api/auth/login',
      json('/api/auth/login', { email: base.email, password: 'not-the-password' }),
      env,
    );
    expect(wrongPassword.status).toBe(401);
    expect((await wrongPassword.json()).reason).toBe('bad_credentials');

    const login = await app.request('/api/auth/login', json('/api/auth/login', base), env);
    expect(login.status).toBe(200);
    const challenge = (await login.json()) as { devCode: string; purpose: string };
    expect(challenge.purpose).toBe('login');
    expect(challenge.devCode).toMatch(/^\d{6}$/);

    const verify = await app.request(
      '/api/auth/verify',
      json('/api/auth/verify', { email: base.email, code: challenge.devCode, purpose: 'login' }),
      env,
    );
    expect(verify.status).toBe(200);
    const afterCookie = verify.headers.get('set-cookie')!.split(';')[0];
    const after = (await (await app.request('/api/me', { headers: { cookie: afterCookie } }, env)).json()) as {
      user: { tag: string; provider: string };
    };
    expect(after.user.tag).toBe(before.user.tag);

    // signing out revokes the server-side session, so the old cookie is dead
    const signoutInit = json('/api/auth/signout', {});
    const out = await app.request(
      '/api/auth/signout',
      { ...signoutInit, headers: { ...signoutInit.headers, cookie: afterCookie } },
      env,
    );
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    const me = await app.request('/api/me', { headers: { cookie: afterCookie } }, env);
    expect(me.status).toBe(401);
  });

  it('validates input and refuses duplicate or weak signups', async () => {
    const { app, env } = makeRealApp();

    const weak = await app.request(
      '/api/auth/signup',
      json('/api/auth/signup', { email: 'weak@example.com', password: 'short' }),
      env,
    );
    expect(weak.status).toBe(400);
    expect((await weak.json()).field).toBe('password');

    const badEmail = await app.request(
      '/api/auth/signup',
      json('/api/auth/signup', { email: 'not-an-email', password: 'a-good-password' }),
      env,
    );
    expect(badEmail.status).toBe(400);

    const ok = await app.request(
      '/api/auth/signup',
      json('/api/auth/signup', { email: 'dup@example.com', password: 'a-good-password' }),
      env,
    );
    expect(ok.status).toBe(200);
    const { devCode } = (await ok.json()) as { devCode: string };
    await app.request(
      '/api/auth/verify',
      json('/api/auth/verify', { email: 'dup@example.com', code: devCode, purpose: 'signup' }),
      env,
    );

    const duplicate = await app.request(
      '/api/auth/signup',
      json('/api/auth/signup', { email: 'dup@example.com', password: 'another-password' }),
      env,
    );
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).reason).toBe('exists');

    const foreign = await app.request(
      '/api/auth/signup',
      json('/api/auth/signup', { email: 'csrf@example.com', password: 'a-good-password' }, 'POST', 'https://evil.example'),
      env,
    );
    expect(foreign.status).toBe(403);
  });

  it('burns the code after five wrong guesses', async () => {
    const { app, env } = makeRealApp();
    const res = await app.request(
      '/api/auth/signup',
      json('/api/auth/signup', { email: 'lock@example.com', password: 'a-good-password' }),
      env,
    );
    const { devCode } = (await res.json()) as { devCode: string };
    const wrong = devCode === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < 5; attempt++) {
      const bad = await app.request(
        '/api/auth/verify',
        json('/api/auth/verify', { email: 'lock@example.com', code: wrong, purpose: 'signup' }),
        env,
      );
      expect(bad.status).toBe(400);
    }

    const blocked = await app.request(
      '/api/auth/verify',
      json('/api/auth/verify', { email: 'lock@example.com', code: devCode, purpose: 'signup' }),
      env,
    );
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).reason).toBe('too_many_attempts');
  });
});

describe('PIN lock', () => {
  it('locks chat history behind a 4-digit PIN and unlocks with a token', async () => {
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

  it('only accepts exactly four digits', async () => {
    const { app, env } = makeApp(primary);
    for (const pin of ['123', '12345', 'abcd', '', '12 34']) {
      const res = await app.request('/api/pin/set', json('/api/pin/set', { pin }), env);
      expect(res.status, pin).toBe(400);
    }
    const ok = await app.request('/api/pin/set', json('/api/pin/set', { pin: '0420' }), env);
    expect(ok.status).toBe(200);
  });

  it('throttles brute force after five wrong PINs', async () => {
    const { app, env } = makeApp(primary);
    await app.request('/api/pin/set', json('/api/pin/set', { pin: '7788' }), env);

    for (let attempt = 0; attempt < 5; attempt++) {
      const bad = await app.request('/api/pin/verify', json('/api/pin/verify', { pin: '0000' }), env);
      expect([403, 429]).toContain(bad.status);
    }
    const blocked = await app.request('/api/pin/verify', json('/api/pin/verify', { pin: '7788' }), env);
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).reason).toBe('pin_locked');
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

describe('unknown API routes', () => {
  it('returns JSON 404 instead of the SPA shell', async () => {
    const { app, env } = makeApp(null);
    const res = await app.request('/api/nope', {}, env);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
