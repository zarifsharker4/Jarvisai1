import { Hono } from 'hono';
import { requireUser } from './authz';
import { guardSameOrigin, jsonError, PRIVATE_HEADERS, sseResponse, type Emit } from './http';
import {
  composeUserContent,
  demoStream,
  llmStream,
  providerById,
  resolveEngine,
  toClient,
  type Attachment,
  type ChatMessage,
  type ResolvedEngine,
} from './providers';
import { createChat, saveMessage, unlockCheck } from './store';
import type { AppDeps } from './deps';
import type { ConnectorRow, Env, ProjectRow } from './types';

/**
 * Vecna — the Supreme Guide. Always active, always separate from the worker
 * AIs: Vecna runs on its own connector (flagged is_vecna, initialized with a
 * Gemini key on first login) and never on a project's AI pool. Routes cover
 * the continuous chat thread (text + image + file uploads) and the
 * user ↔ Vecna voice call turn handler.
 */
export const VECNA_SYSTEM = [
  'You are Vecna, the Supreme Guide of the Mind Flayer workspace.',
  'You are always active and you answer for yourself — you never speak as or on behalf of the worker AIs (AI 1, AI 2, ...).',
  'Tone: casual, human, warm-but-sharp — like a smart friend texting, not a system notice. No corporate filler.',
  'You guide the user through their projects, their AI pool, code reviews and architecture decisions.',
  'Keep answers tight. Use markdown for code. When code is asked for, give complete runnable code.',
].join(' ');

function isVecnaConnector(row: ConnectorRow): boolean {
  return providerById(row.provider)?.kind === 'llm' && row.enabled === 1;
}

/** Vecna's engine: the flagged connector first, then the default LLM, then demo. */
async function vecnaEngine(env: Env, sub: string): Promise<ResolvedEngine> {
  const rows = await env.DB!.prepare(
    'SELECT * FROM connectors WHERE user_sub = ?1 ORDER BY is_vecna DESC, is_default DESC, created_at ASC',
  )
    .bind(sub)
    .all<ConnectorRow>();
  const secret = env.APP_SECRET ?? 'dev-secret';
  const flagged = rows.results.find((r) => r.is_vecna && r.api_key_enc && isVecnaConnector(r));
  if (flagged) return { engine: 'llm', client: await toClient(flagged, secret) };
  return resolveEngine(env, rows.results, secret);
}

export function vecnaRoutes(deps: AppDeps) {
  const app = new Hono<{ Bindings: Env }>();

  /** Is Vecna initialized? Used by the chat header and first-login onboarding. */
  app.get('/api/vecna/status', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const rows = await c.env.DB!.prepare(
      'SELECT * FROM connectors WHERE user_sub = ?1 ORDER BY is_vecna DESC, is_default DESC, created_at ASC',
    )
      .bind(gate.user.sub)
      .all<ConnectorRow>();
    const flagged = rows.results.find((r) => r.is_vecna && r.api_key_enc);
    const anyLlm = rows.results.some((r) => r.api_key_enc && isVecnaConnector(r));
    return Response.json(
      {
        configured: Boolean(flagged),
        model: flagged?.model ?? null,
        provider: flagged?.provider ?? null,
        name: flagged?.name ?? 'Vecna',
        hasAnyKey: anyLlm,
      },
      { headers: PRIVATE_HEADERS },
    );
  });

  /**
   * POST /api/vecna/chat — continuous Vecna thread (per-project when a
   * projectId is given). Accepts image + text file attachments.
   */
  app.post('/api/vecna/chat', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;

    const body = (await c.req.json().catch(() => null)) as {
      message?: string;
      chatId?: string;
      projectId?: string | null;
      history?: Array<{ role: string; content: string }>;
      attachments?: Attachment[];
    } | null;
    const message = body?.message?.trim();
    if (!message) return jsonError('Message is required', 400);
    const attachments = (Array.isArray(body?.attachments) ? body.attachments : []).slice(0, 6);

    const db = c.env.DB!;
    const user = gate.user;
    let chatId = body?.chatId ?? null;
    let projectId = body?.projectId ?? null;

    if (chatId) {
      const blocked = await unlockCheck(c.env, user, chatId, c.req.header('x-mindflayer-pin'));
      if (blocked) return blocked;
      const chat = await db
        .prepare('SELECT project_id FROM chats WHERE id = ?1 AND user_sub = ?2')
        .bind(chatId, user.sub)
        .first<{ project_id: string | null }>();
      projectId = chat?.project_id ?? projectId;
    } else {
      chatId = await createChat(
        c.env,
        user.sub,
        message.slice(0, 60),
        'vecna',
        projectId && typeof projectId === 'string' ? projectId : null,
      );
    }

    const attachmentNote = attachments.length
      ? ` [sent ${attachments.length} attachment${attachments.length > 1 ? 's' : ''}: ${attachments
          .map((a) => a.name)
          .join(', ')}]`
      : '';
    await saveMessage(c.env, chatId, user.sub, 'user', `${message}${attachmentNote}`, null, null);

    const engine = await vecnaEngine(c.env, user.sub);
    const history: ChatMessage[] = (body?.history ?? [])
      .slice(-12)
      .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    history.push({ role: 'user', content: composeUserContent(message, attachments) });

    return sseResponse(async (emit: Emit) => {
      await emit('meta', {
        chatId,
        projectId,
        engine: engine.engine,
        model: engine.engine === 'llm' ? engine.client.model : 'offline-demo',
        agent: 'vecna',
        name: 'Vecna',
      });
      let assembled = '';
      const onToken = async (text: string) => {
        assembled += text;
        await emit('token', { text });
      };
      if (engine.engine === 'demo') {
        const prompt =
          typeof history[history.length - 1]?.content === 'string'
            ? (history[history.length - 1].content as string)
            : message;
        await demoStream('chat', `topic: Vecna, guide the user through: ${prompt}`, onToken);
      } else {
        await llmStream(engine.client, [{ role: 'system', content: VECNA_SYSTEM }, ...history], onToken);
      }
      await saveMessage(c.env, chatId, user.sub, 'assistant', assembled, 'Vecna', {
        engine: engine.engine,
      });
      await emit('saved', { chatId });
    });
  });

  /**
   * POST /api/vecna/call/turn — one turn of the live voice call.
   * Strictly the user and Vecna: a single responder, spoken back by the
   * browser with Vecna's voice profile.
   */
  app.post('/api/vecna/call/turn', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;

    const body = (await c.req.json().catch(() => null)) as {
      history?: Array<{ speaker: string; text: string }>;
      projectId?: string | null;
    } | null;
    const history = Array.isArray(body?.history)
      ? body.history
          .filter((h) => h && typeof h.text === 'string' && typeof h.speaker === 'string')
          .slice(-20)
          .map((h) => ({ speaker: h.speaker === 'vecna' ? 'Vecna' : 'you', text: String(h.text) }))
      : [];
    const engine = await vecnaEngine(c.env, gate.user.sub);
    const projectId = typeof body?.projectId === 'string' ? body.projectId : null;

    // Project context so Vecna knows which workspace the call is about.
    let context = '';
    if (projectId) {
      const project = await c.env.DB!.prepare(
        'SELECT * FROM projects WHERE id = ?1 AND user_sub = ?2',
      )
        .bind(projectId, gate.user.sub)
        .first<ProjectRow>();
      if (project) {
        context = `Active project: ${project.name}${project.repo_full_name ? ` (repo ${project.repo_full_name})` : ''}.`;
      }
    }

    return sseResponse(async (emit: Emit) => {
      await emit('meta', { engine: engine.engine, mode: 'vecna-call' });
      const transcript = history
        .slice(-10)
        .map((h) => `${h.speaker === 'Vecna' ? 'Vecna' : 'The user'}: ${h.text}`)
        .join('\n');
      const prompt = [
        context,
        transcript ? `Call transcript so far:\n${transcript}` : 'The call just connected — greet the user briefly.',
        '',
        'Reply as Vecna in 1-3 short spoken sentences. Plain speech only: no markdown, no lists.',
      ]
        .filter(Boolean)
        .join('\n');

      await emit('turn', { agent: 'vecna', name: 'Vecna', status: 'start' });
      let text = '';
      const onToken = (chunk: string) => {
        text += chunk;
        return emit('token', { text: chunk });
      };
      if (engine.engine === 'demo') {
        await demoStream('call', prompt, onToken);
      } else {
        await llmStream(
          engine.client,
          [
            { role: 'system', content: `${VECNA_SYSTEM} You are on a live voice call — answers must sound natural spoken aloud.` },
            { role: 'user', content: prompt },
          ],
          onToken,
        );
      }
      await emit('turn', { agent: 'vecna', name: 'Vecna', status: 'end', text });
    });
  });

  /** Status helper reused by onboarding: cheap check for any configured key. */
  app.post('/api/vecna/ready', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const row = await c.env.DB!.prepare(
      "SELECT id FROM connectors WHERE user_sub = ?1 AND provider != 'github' AND api_key_enc IS NOT NULL LIMIT 1",
    )
      .bind(gate.user.sub)
      .first<{ id: string }>();
    return Response.json({ ready: Boolean(row) }, { headers: PRIVATE_HEADERS });
  });

  return app;
}
