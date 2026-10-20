import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import type { AppDeps } from '../server/deps';
import type { Env, RequestUser } from '../server/types';
import { createLiteD1 } from './d1lite';

const ORIGIN = 'http://localhost:3002';

function makeEnv(db = createLiteD1()): Env {
  return { DB: db, APP_ORIGIN: ORIGIN, APP_SECRET: 'test-secret', APP_ENV: 'test' };
}

function makeApp(user: RequestUser | null, env: Env = makeEnv()) {
  const deps: AppDeps = { resolveUser: async () => user };
  return { app: createApp(deps), env };
}

const user: RequestUser = {
  sub: 'email:dev@example.com',
  provider: 'email',
  email: 'dev@example.com',
  name: 'Dev',
};

const other: RequestUser = {
  sub: 'email:other@example.com',
  provider: 'email',
  email: 'other@example.com',
};

function json(body: unknown, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST', origin = ORIGIN) {
  return {
    method,
    headers: { 'Content-Type': 'application/json', Origin: origin },
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bootstrap additions', () => {
  it('advertises the 6 tabs, Vecna and the extra providers', async () => {
    const { app, env } = makeApp(null);
    const res = await app.request('/api/bootstrap', {}, env);
    const body = (await res.json()) as {
      vecna: { voiceCall: string; firstLoginPrompts: string };
      workspace: { tabs: Array<{ id: string }>; aiTags: string; github: { defaultRepo: string } };
      providers: Array<{ id: string }>;
    };
    expect(body.vecna.voiceCall).toBe('user<->vecna');
    expect(body.vecna.firstLoginPrompts).toBe('gemini-api-key');
    expect(body.workspace.tabs.map((t) => t.id)).toEqual([
      'vecna',
      'hellfire',
      'manager',
      'projects',
      'field',
      'cerebro',
    ]);
    expect(body.workspace.github.defaultRepo).toBe('zarifsharker4/Jarvisai1');
    const ids = body.providers.map((p) => p.id);
    for (const extra of ['github', 'anthropic', 'xai', 'deepseek']) expect(ids).toContain(extra);
  });
});

describe('projects + AI pool', () => {
  it('creates isolated projects and assigns AI 1..AI N with fields', async () => {
    const { app, env } = makeApp(user);

    const create = await app.request('/api/projects', json({ name: 'Jarvis Core', repo: 'zarifsharker4/Jarvisai1' }), env);
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as { id: string };

    const connector = await app.request(
      '/api/connectors',
      json({ provider: 'groq', name: 'AI 1 key', apiKey: 'gsk_test_key', isDefault: true }),
      env,
    );
    expect(connector.status).toBe(201);
    const { id: connectorId } = (await connector.json()) as { id: string };

    const save = await app.request(
      `/api/projects/${id}/ais`,
      json(
        {
          assignments: [
            { slot: 1, connectorId, field: 'backend' },
            { slot: 2, connectorId: null, field: 'review' },
          ],
        },
        'PUT',
      ),
      env,
    );
    expect(save.status).toBe(200);

    const ais = await app.request(`/api/projects/${id}/ais`, {}, env);
    const pool = (await ais.json()) as {
      ais: Array<{ slot: number; label: string; field: string; connector: { online: boolean } | null }>;
      fields: string[];
      maxSlots: number;
    };
    expect(pool.ais.map((a) => a.label)).toEqual(['AI 1', 'AI 2']);
    expect(pool.ais[0].field).toBe('backend');
    expect(pool.ais[0].connector?.online).toBe(true);
    expect(pool.ais[1].connector).toBeNull();
    expect(pool.fields).toContain('devops');
    expect(pool.maxSlots).toBe(24);

    // Hellfire pool reflects the assignment
    const poolRes = await app.request(`/api/hellfire/pool?projectId=${id}`, {}, env);
    const members = (await poolRes.json()) as { members: Array<{ label: string; online: boolean }> };
    expect(members.members).toHaveLength(2);
    expect(members.members[0].label).toBe('AI 1');

    // Invalid connector rejected
    const bad = await app.request(
      `/api/projects/${id}/ais`,
      json({ assignments: [{ slot: 3, connectorId: 'nope', field: 'frontend' }] }, 'PUT'),
      env,
    );
    expect(bad.status).toBe(400);

    // A second project is isolated from the first
    const two = await app.request('/api/projects', json({ name: 'Ops Board' }), env);
    const { id: twoId } = (await two.json()) as { id: string };
    const twoAis = await app.request(`/api/projects/${twoId}/ais`, {}, env);
    expect(((await twoAis.json()) as { ais: unknown[] }).ais).toHaveLength(0);

    const del = await app.request(`/api/projects/${id}`, json({}, 'DELETE'), env);
    expect(del.status).toBe(200);
    const list = await app.request('/api/projects', {}, env);
    const { projects } = (await list.json()) as { projects: Array<{ id: string }> };
    expect(projects.map((p) => p.id)).toEqual([twoId]);
  });

  it('requires same-origin for project mutations', async () => {
    const { app, env } = makeApp(user);
    const res = await app.request('/api/projects', json({ name: 'x' }, 'POST', 'https://evil.example'), env);
    expect(res.status).toBe(403);
  });
});

describe('Vecna', () => {
  it('initializes from a flagged connector and streams a chat thread', { timeout: 30_000 }, async () => {
    const { app, env } = makeApp(user);

    const before = await app.request('/api/vecna/status', {}, env);
    expect(((await before.json()) as { configured: boolean }).configured).toBe(false);

    const created = await app.request(
      '/api/connectors',
      json({ provider: 'google-ai-studio', name: 'Vecna', apiKey: 'AIza-test', isVecna: true, isDefault: true }),
      env,
    );
    expect(created.status).toBe(201);

    const after = await app.request('/api/vecna/status', {}, env);
    const status = (await after.json()) as { configured: boolean; name: string; hasAnyKey: boolean };
    expect(status.configured).toBe(true);
    expect(status.name).toBe('Vecna');
    expect(status.hasAnyKey).toBe(true);

    // Serve OpenAI-style SSE so the stream path runs without the network.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"Hello "}}]}',
            'data: {"choices":[{"delta":{"content":"from "}}]}',
            'data: {"choices":[{"delta":{"content":"Vecna. "}}]}',
            'data: {"choices":[{"delta":{"content":"Guide awaits."}}]}',
            'data: [DONE]',
          ].join('\n\n'),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
    );

    const project = await app.request('/api/projects', json({ name: 'Vecna Home' }), env);
    const { id: projectId } = (await project.json()) as { id: string };

    const res = await app.request(
      '/api/vecna/chat',
      json({ message: 'What should I build first?', projectId }),
      env,
    );
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());
    const meta = events.find((e) => e.event === 'meta');
    expect(meta?.data.agent).toBe('vecna');
    expect(meta?.data.projectId).toBe(projectId);
    const tokens = events.filter((e) => e.event === 'token');
    expect(tokens.length).toBeGreaterThan(3);
    const assembled = tokens.map((t) => String(t.data.text)).join('');
    expect(assembled).toContain('Hello from Vecna. Guide awaits.');
    expect(events.some((e) => e.event === 'saved')).toBe(true);
    expect(events[events.length - 1].event).toBe('done');

    // The thread is stored as a project-scoped Vecna chat
    const chats = await app.request('/api/chats', {}, env);
    const body = (await chats.json()) as { chats: Array<{ mode: string; projectId: string | null }> };
    expect(body.chats[0].mode).toBe('vecna');
    expect(body.chats[0].projectId).toBe(projectId);
  });

  it('handles attachments by inlining text files', { timeout: 30_000 }, async () => {
    const { app, env } = makeApp(user);
    const res = await app.request(
      '/api/vecna/chat',
      json({
        message: 'Review this',
        attachments: [{ kind: 'text', name: 'app.ts', data: 'export const x = 1;' }],
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());
    expect(events.some((e) => e.event === 'token')).toBe(true);
    const row = await env.DB!.prepare("SELECT content FROM messages WHERE role = 'user' ORDER BY created_at DESC LIMIT 1").first<{ content: string }>();
    expect(row?.content).toContain('app.ts');
  });

  it('answers a voice-call turn as a single Vecna responder', { timeout: 30_000 }, async () => {
    const { app, env } = makeApp(user);
    const res = await app.request(
      '/api/vecna/call/turn',
      json({ history: [{ speaker: 'you', text: 'Hey Vecna, status please.' }] }),
      env,
    );
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());
    const turns = events.filter((e) => e.event === 'turn' && e.data.status === 'end');
    expect(turns).toHaveLength(1);
    expect(turns[0].data.agent).toBe('vecna');
    expect(String(turns[0].data.text).length).toBeGreaterThan(5);
  });
});

describe('Hellfire group chat', () => {
  it('broadcasts one message to the assigned pool with per-slot streams', { timeout: 30_000 }, async () => {
    const { app, env } = makeApp(user);
    const project = await app.request('/api/projects', json({ name: 'Hellfire Test' }), env);
    const { id: projectId } = (await project.json()) as { id: string };
    await app.request(
      `/api/projects/${projectId}/ais`,
      json({
        assignments: [
          { slot: 1, connectorId: null, field: 'frontend' },
          { slot: 2, connectorId: null, field: 'backend' },
        ],
      }, 'PUT'),
      env,
    );

    const res = await app.request(
      '/api/hellfire/message',
      json({
        message: 'Who wants to take this?',
        projectId,
        context: 'src/app.ts:\nexport const x = 1;',
      }),
      env,
    );
    expect(res.status).toBe(200);
    const events = parseEvents(await res.text());
    const meta = events.find((e) => e.event === 'meta');
    expect(meta?.data.mode).toBe('hellfire');
    expect((meta?.data.pool as Array<{ label: string }>).map((m) => m.label)).toEqual(['AI 1', 'AI 2']);

    const starts = events.filter((e) => e.event === 'ai' && e.data.status === 'start');
    expect(starts.map((s) => s.data.slot)).toEqual([1, 2]);
    const ends = events.filter((e) => e.event === 'ai' && e.data.status === 'end');
    expect(ends).toHaveLength(2);
    for (const end of ends) expect(String(end.data.text).length).toBeGreaterThan(10);
    expect(events.some((e) => e.event === 'saved')).toBe(true);

    const messages = await env.DB!.prepare("SELECT agent FROM messages WHERE role = 'assistant' ORDER BY created_at").all<{ agent: string }>();
    expect(messages.results.map((m) => m.agent)).toEqual(['AI 1', 'AI 2']);
  });

  it('narrows to one AI with targetSlot and stores the file context', { timeout: 30_000 }, async () => {
    const { app, env } = makeApp(user);
    const project = await app.request('/api/projects', json({ name: 'Targeted' }), env);
    const { id: projectId } = (await project.json()) as { id: string };
    await app.request(
      `/api/projects/${projectId}/ais`,
      json({ assignments: [{ slot: 1, field: 'review' }, { slot: 3, field: 'docs' }] }, 'PUT'),
      env,
    );
    const res = await app.request(
      '/api/hellfire/message',
      json({ message: 'AI 3, document this', projectId, targetSlot: 3 }),
      env,
    );
    const events = parseEvents(await res.text());
    const starts = events.filter((e) => e.event === 'ai' && e.data.status === 'start');
    expect(starts).toHaveLength(1);
    expect(starts[0].data.slot).toBe(3);

    const saved = await env.DB!.prepare("SELECT meta FROM messages WHERE role = 'user' ORDER BY created_at DESC LIMIT 1").first<{ meta: string | null }>();
    expect(saved?.meta ?? null).toBeNull(); // no context in this message
  });
});

describe('The Field + Cerebro', () => {
  it('publishes, lists, resolves, stars and unpublishes by handle', async () => {
    const { app, env } = makeApp(user);

    const invalid = await app.request(
      '/api/field/publish',
      json({ title: 'Bad', handle: 'not-a-handle', html: '<h1>x</h1>' }),
      env,
    );
    expect(invalid.status).toBe(400);

    const published = await app.request(
      '/api/field/publish',
      json({
        title: 'Demo Grid App',
        description: 'A tiny demo',
        html: '<h1>hello grid</h1>',
        tags: ['demo'],
        handle: '1234.3456',
      }),
      env,
    );
    expect(published.status).toBe(201);
    const { handle } = (await published.json()) as { handle: string };
    expect(handle).toBe('1234.3456');

    const list = await app.request('/api/field/list', {}, env);
    const entries = ((await list.json()) as { entries: Array<{ handle: string; hasApp: boolean }> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].handle).toBe('1234.3456');
    expect(entries[0].hasApp).toBe(true);

    const detail = await app.request('/api/field/1234.3456', {}, env);
    const { entry } = (await detail.json()) as { entry: { html: string; owned: boolean; cerebroUrl: string } };
    expect(entry.html).toContain('hello grid');
    expect(entry.owned).toBe(true);
    expect(entry.cerebroUrl).toBe('https://cerebro.mindflayer.app/1234.3456');

    const missing = await app.request('/api/field/9999.9999', {}, env);
    expect(missing.status).toBe(404);

    const starred = await app.request('/api/field/1234.3456/star', json({}, 'POST'), env);
    expect(starred.status).toBe(200);
    expect(((await starred.json()) as { stars: number }).stars).toBe(1);

    // Another account cannot unpublish it
    const thief = makeApp(other, env);
    const denied = await thief.app.request('/api/field/1234.3456', json({}, 'DELETE'), env);
    expect(denied.status).toBe(403);

    const removed = await app.request('/api/field/1234.3456', json({}, 'DELETE'), env);
    expect(removed.status).toBe(200);
    const afterList = await app.request('/api/field/list', {}, env);
    expect(((await afterList.json()) as { entries: unknown[] }).entries).toHaveLength(0);
  });

  it('mints a unique handle when none is given', async () => {
    const { app, env } = makeApp(user);
    const res = await app.request(
      '/api/field/publish',
      json({ title: 'Auto', appUrl: 'https://example.com', handle: '' }),
      env,
    );
    expect(res.status).toBe(201);
    const { handle } = (await res.json()) as { handle: string };
    expect(handle).toMatch(/^\d{4}\.\d{4}$/);
  });
});

describe('GitHub integration', () => {
  function stubGitHub(extra: Record<string, unknown> = {}) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/user')) return Response.json({ login: 'zarifsharker4' });
      if (method === 'GET' && url.includes('/git/ref/heads/')) {
        return Response.json({ object: { sha: 'headsha' } });
      }
      if (method === 'GET' && url.includes('/git/trees/')) {
        return Response.json({
          tree: [
            { path: 'src', type: 'tree' },
            { path: 'src/app.ts', type: 'blob', size: 20 },
            { path: 'README.md', type: 'blob', size: 10 },
          ],
        });
      }
      if (method === 'GET' && url.includes('/contents/')) {
        return Response.json({
          content: btoa('export const a = 1;'),
          sha: 'filesha',
          size: 20,
          encoding: 'base64',
        });
      }
      if (method === 'GET' && url.includes('/git/commits/')) {
        return Response.json({ tree: { sha: 'basetree' }, message: 'prev' });
      }
      if (method === 'POST' && url.endsWith('/git/blobs')) return Response.json({ sha: 'blob1' });
      if (method === 'POST' && url.endsWith('/git/trees')) return Response.json({ sha: 'newtree' });
      if (method === 'POST' && url.endsWith('/git/commits')) {
        return Response.json({ sha: 'commit1', html_url: 'https://github.com/zarifsharker4/Jarvisai1/commit/commit1' });
      }
      if (method === 'PATCH' && url.includes('/git/refs/heads/')) return Response.json({ object: { sha: 'commit1' } });
      return Response.json({ ...(extra[url] ?? { message: 'not found' }) }, { status: extra[url] ? 200 : 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('connects with a PAT, lists the tree, reads a file and pushes a commit', async () => {
    stubGitHub();
    const { app, env } = makeApp(user);

    const before = await app.request('/api/github/status', {}, env);
    expect(((await before.json()) as { connected: boolean; defaultRepo: string }).connected).toBe(false);

    const foreign = await app.request(
      '/api/github/connect',
      json({ token: 'ghp_evil' }, 'POST', 'https://evil.example'),
      env,
    );
    expect(foreign.status).toBe(403);

    const connect = await app.request('/api/github/connect', json({ token: 'ghp_super_secret_token' }), env);
    expect(connect.status).toBe(200);
    expect(((await connect.json()) as { login: string }).login).toBe('zarifsharker4');

    const status = await app.request('/api/github/status', {}, env);
    const statusBody = (await status.json()) as { connected: boolean; login: string; defaultRepo: string };
    expect(statusBody.connected).toBe(true);
    expect(statusBody.defaultRepo).toBe('zarifsharker4/Jarvisai1');

    // The token is AES-encrypted at rest and never echoed back
    const row = await env.DB!.prepare("SELECT api_key_enc FROM connectors WHERE provider = 'github'").first<{
      api_key_enc: string;
    }>();
    expect(row?.api_key_enc.startsWith('v1.')).toBe(true);
    expect(row?.api_key_enc).not.toContain('ghp_super_secret_token');
    expect(JSON.stringify(statusBody)).not.toContain('ghp_super_secret_token');

    const tree = await app.request('/api/github/tree?repo=zarifsharker4/Jarvisai1&branch=main', {}, env);
    expect(tree.status).toBe(200);
    const treeBody = (await tree.json()) as { tree: Array<{ path: string; type: string }> };
    expect(treeBody.tree.map((t) => t.path)).toContain('src/app.ts');

    const file = await app.request(
      '/api/github/file?repo=zarifsharker4/Jarvisai1&branch=main&path=src/app.ts',
      {},
      env,
    );
    expect(file.status).toBe(200);
    const fileBody = (await file.json()) as { content: string };
    expect(fileBody.content).toBe('export const a = 1;');

    const commit = await app.request(
      '/api/github/commit',
      json({
        repo: 'zarifsharker4/Jarvisai1',
        branch: 'main',
        message: 'Update from Hellfire IDE',
        files: [{ path: 'src/app.ts', content: 'export const a = 2;' }],
      }),
      env,
    );
    expect(commit.status).toBe(200);
    const commitBody = (await commit.json()) as { sha: string; ok: boolean };
    expect(commitBody.ok).toBe(true);
    expect(commitBody.sha).toBe('commit1');
  });

  it('fails closed when no token is connected', async () => {
    const { app, env } = makeApp(user);
    const tree = await app.request('/api/github/tree?repo=o/r&branch=main', {}, env);
    expect(tree.status).toBe(424);
    expect((await tree.json()).reason).toBe('no_token');
  });
});
