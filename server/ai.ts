import { Hono } from 'hono';
import { AGENT_ORDER, callTurn, isAgentId, runDiscussion, runPipeline } from './agents';
import { checkPinToken, requireUser } from './authz';
import { randomId } from './crypto';
import { guardSameOrigin, jsonError, PRIVATE_HEADERS, sseResponse, type Emit } from './http';
import { demoStream, llmStream, resolveEngine, type ChatMessage } from './providers';
import { listVoices, loadVoices, synthesize, voiceManifest } from './voice';
import type { AppDeps } from './deps';
import type { ChatRow, ConnectorRow, Env, UserRow } from './types';

const JARVIS_SYSTEM =   'You are the Mind Flayer assistant. Be direct, technically precise and concise. Prefer short paragraphs and markdown for code.';

/**
 * AI routes: chat, the 3-agent collaborative pipeline, the AI-to-AI  * discussion space, the Call Mind Flayer turn handler and ElevenLabs TTS.
 */
export function aiRoutes(deps: AppDeps) {
  const app = new Hono<{ Bindings: Env }>();

  async function connectorsFor(env: Env, sub: string): Promise<ConnectorRow[]> {
    const rows = await env.DB!.prepare(
      'SELECT * FROM connectors WHERE user_sub = ?1 ORDER BY is_default DESC, created_at ASC',
    )
      .bind(sub)
      .all<ConnectorRow>();
    return rows.results;
  }

  async function engineFor(env: Env, sub: string) {
    const connectors = await connectorsFor(env, sub);
    return resolveEngine(env, connectors, env.APP_SECRET ?? 'dev-secret');
  }

  async function saveMessage(
    env: Env,
    chatId: string,
    sub: string,
    role: string,
    content: string,
    agent: string | null,
    meta: Record<string, unknown> | null,
  ): Promise<void> {
    await env.DB!.prepare(
      'INSERT INTO messages (id, chat_id, user_sub, role, agent, content, meta) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    )
      .bind(randomId(12), chatId, sub, role, agent, content, meta ? JSON.stringify(meta) : null)
      .run();
    await env.DB!.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?1")
      .bind(chatId)
      .run();
  }

  /** PIN gate for touching an existing chat when history is locked. */
  async function unlockCheck(
    env: Env,
    user: UserRow,
    chatId: string,
    header: string | undefined,
  ): Promise<Response | null> {
    const chat = await env.DB!.prepare('SELECT * FROM chats WHERE id = ?1 AND user_sub = ?2')
      .bind(chatId, user.sub)
      .first<ChatRow>();
    if (!chat) return jsonError('Chat not found', 404);
    if (user.pin_hash || chat.locked) {
      const ok = await checkPinToken(env, header, user.sub);
      if (!ok) {
        return jsonError('PIN required to unlock chat history', 423, { reason: 'pin_required' });
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * POST /api/chat — single-assistant chat with streamed tokens
   * ---------------------------------------------------------------- */
  app.post('/api/chat', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;

    const body = (await c.req.json().catch(() => null)) as {
      message?: string;
      chatId?: string;
      history?: Array<{ role: string; content: string }>;
    } | null;
    const message = body?.message?.trim();
    if (!message) return jsonError('Message is required', 400);

    const db = c.env.DB!;
    const user = gate.user;
    let chatId = body?.chatId ?? null;

    if (chatId) {
      const blocked = await unlockCheck(c.env, user, chatId, c.req.header('x-mindflayer-pin'));
      if (blocked) return blocked;
    } else {
      chatId = randomId(12);
      await db
        .prepare('INSERT INTO chats (id, user_sub, title, mode) VALUES (?1, ?2, ?3, ?4)')
        .bind(chatId, user.sub, message.slice(0, 60), 'chat')
        .run();
    }

    await saveMessage(c.env, chatId, user.sub, 'user', message, null, null);

    const engine = await engineFor(c.env, user.sub);
    const history: ChatMessage[] = (body?.history ?? [])
      .slice(-10)
      .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    history.push({ role: 'user', content: message });

    return sseResponse(async (emit: Emit) => {
      await emit('meta', {
        chatId,
        engine: engine.engine,
        model: engine.engine === 'llm' ? engine.client.model : 'offline-demo',
        agent: 'Mind Flayer',
        name: 'Mind Flayer',
      });
      let assembled = '';
      const onToken = async (text: string) => {
        assembled += text;
        await emit('token', { text });
      };
      if (engine.engine === 'demo') {
        const prompt = history.map((m) => `${m.role}: ${m.content}`).join('\n');
        await demoStream('chat', prompt, onToken);
      } else {
        await llmStream(engine.client, [{ role: 'system', content: JARVIS_SYSTEM }, ...history], onToken);
      }
      await saveMessage(c.env, chatId, user.sub, 'assistant', assembled, 'Mind Flayer', {
        engine: engine.engine,
      });
      await emit('saved', { chatId });
    });
  });

  /* ---------------------------------------------------------------- *
   * POST /api/pipeline — 3-agent collaborative pipeline
   * ---------------------------------------------------------------- */
  app.post('/api/pipeline', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;

    const body = (await c.req.json().catch(() => null)) as { request?: string; chatId?: string } | null;
    const request = body?.request?.trim();
    if (!request) return jsonError('Request is required', 400);

    const db = c.env.DB!;
    const user = gate.user;
    let chatId = body?.chatId ?? null;

    if (chatId) {
      const blocked = await unlockCheck(c.env, user, chatId, c.req.header('x-mindflayer-pin'));
      if (blocked) return blocked;
    } else {
      chatId = randomId(12);
      await db
        .prepare('INSERT INTO chats (id, user_sub, title, mode) VALUES (?1, ?2, ?3, ?4)')
        .bind(chatId, user.sub, request.slice(0, 60), 'pipeline')
        .run();
    }
    await saveMessage(c.env, chatId, user.sub, 'user', request, null, null);

    const engine = await engineFor(c.env, user.sub);
    const transcript: Record<string, string> = {};

    return sseResponse(async (emit) => {
      await emit('meta', { chatId, engine: engine.engine, mode: 'pipeline' });
      await runPipeline(engine, request, async (event, data) => {
        if (
          event === 'stage' &&
          data.status === 'end' &&
          typeof data.text === 'string' &&
          typeof data.agent === 'string'
        ) {
          const existing = transcript[data.agent] ?? '';
          transcript[data.agent] = existing ? `${existing}\n\n${data.text}` : data.text;
        }
        await emit(event, data);
      });
      const summary = AGENT_ORDER.map((a) => `### ${a}\n${transcript[a] ?? ''}`).join('\n\n');
      await saveMessage(c.env, chatId, user.sub, 'assistant', summary, 'pipeline', {
        engine: engine.engine,
        mode: 'pipeline',
      });
      await emit('saved', { chatId });
    });
  });

  /* ---------------------------------------------------------------- *
   * POST /api/discussion — live AI-to-AI discussion space
   * ---------------------------------------------------------------- */
  app.post('/api/discussion', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;

    const body = (await c.req.json().catch(() => null)) as {
      topic?: string;
      rounds?: number;
      interjection?: string;
    } | null;
    const topic = body?.topic?.trim();
    if (!topic) return jsonError('Topic is required', 400);

    const engine = await engineFor(c.env, gate.user.sub);
    const rounds = Number(body?.rounds) || 6;

    return sseResponse(async (emit) => {
      await emit('meta', { engine: engine.engine, mode: 'discussion', topic, rounds });
      await runDiscussion(engine, topic, rounds, emit, body?.interjection?.trim() || undefined);
    });
  });

  /* ---------------------------------------------------------------- *    * POST /api/call/turn — one turn of the Call Mind Flayer voice room
   * ---------------------------------------------------------------- */
  app.post('/api/call/turn', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;

    const body = (await c.req.json().catch(() => null)) as {
      history?: Array<{ speaker: string; text: string }>;
    } | null;
    const history = Array.isArray(body?.history)
      ? body.history.filter((h) => h && typeof h.text === 'string' && typeof h.speaker === 'string').slice(-20)
      : [];
    const last = history.length ? history[history.length - 1].speaker : 'you';
    const lastSpeaker = isAgentId(last) ? last : 'you';

    const engine = await engineFor(c.env, gate.user.sub);
    return sseResponse(async (emit) => {
      await emit('meta', { engine: engine.engine, mode: 'call' });
      await callTurn(engine, history, lastSpeaker, emit);
    });
  });

  /* ---------------------------------------------------------------- *
   * POST /api/tts — ElevenLabs speech for one agent (binary mp3)
   * ---------------------------------------------------------------- */
  app.post('/api/tts', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;

    const body = (await c.req.json().catch(() => null)) as { text?: string; agent?: string } | null;
    if (!isAgentId(body?.agent)) return jsonError('Unknown agent', 400);
    const text = body?.text?.trim();
    if (!text) return jsonError('Text is required', 400);

    const connectors = await connectorsFor(c.env, gate.user.sub);
    const result = await synthesize(
      c.env,
      connectors,
      c.env.APP_SECRET ?? 'dev-secret',
      body.agent,
      text,
      loadVoices(gate.user),
    );
    if (!result.ok) {
      return jsonError(result.detail, result.reason === 'no_key' ? 424 : 502, { reason: result.reason });
    }
    return new Response(result.bytes, {
      headers: {
        'Content-Type': result.contentType,
        'Cache-Control': 'private, no-store',
        'X-Voice-Engine': result.engine,
        'X-Voice-Id': result.voiceId,
      },
    });
  });

  /* ---------------------------------------------------------------- *
   * GET /api/voice — voice manifest + optional ElevenLabs catalogue
   * ---------------------------------------------------------------- */
  app.get('/api/voice', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const manifest = voiceManifest(loadVoices(gate.user));
    const connectors = await connectorsFor(c.env, gate.user.sub);
    const catalogue = await listVoices(
      c.env,
      connectors,
      c.env.APP_SECRET ?? 'dev-secret',
    ).catch(() => ({ ok: false, voices: [] as Array<{ voiceId: string; name: string }>, detail: 'unavailable' }));
    return Response.json({ ...manifest, catalogue }, { headers: PRIVATE_HEADERS });
  });

  return app;
}
