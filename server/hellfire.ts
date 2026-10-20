import { Hono } from 'hono';
import { requireUser } from './authz';
import { guardSameOrigin, jsonError, PRIVATE_HEADERS, sseResponse, type Emit } from './http';
import { demoStream, llmStream, providerById, toClient, type ChatMessage, type LLMClient } from './providers';
import { createChat, saveMessage, unlockCheck } from './store';
import type { AppDeps } from './deps';
import type { ConnectorRow, Env } from './types';

/**
 * Hellfire group chat: the collaborative agent chat inside the Mobile Coding
 * Environment. Every message is broadcast to the project's assigned AI pool —
 * AI 1, AI 2, AI 3 … — each running on its own provider API key and tagged
 * with its field/sector. File context from the IDE is injected so the AIs
 * review real code. With no keys configured the offline demo engine answers,
 * clearly labelled, so the workspace never dead-ends.
 */
export type PoolMember = {
  slot: number;
  field: string;
  label: string;
  client: LLMClient | null;
};

export type Pool = { projectId: string | null; members: PoolMember[] };

/** Resolve a project's AI assignments (slot → connector) for one user. */
export async function resolvePool(env: Env, sub: string, projectId: string | null): Promise<Pool> {
  if (!projectId) return { projectId: null, members: [] };
  const rows = await env.DB!.prepare(
    `SELECT pa.slot, pa.field, c.id, c.provider, c.name, c.base_url, c.api_key_enc, c.model, c.enabled
       FROM project_ais pa
       LEFT JOIN connectors c ON c.id = pa.connector_id AND c.user_sub = pa.user_sub
      WHERE pa.project_id = ?1 AND pa.user_sub = ?2
      ORDER BY pa.slot ASC`,
  )
    .bind(projectId, sub)
    .all<{
      slot: number;
      field: string;
      id: string | null;
      provider: string | null;
      name: string | null;
      base_url: string | null;
      api_key_enc: string | null;
      model: string | null;
      enabled: number | null;
    }>();
  const secret = env.APP_SECRET ?? 'dev-secret';
  const members: PoolMember[] = [];
  for (const row of rows.results) {
    const slot = row.slot;
    const base: Omit<PoolMember, 'client'> = {
      slot,
      field: row.field || 'unassigned',
      label: `AI ${slot}`,
    };
    const usable =
      row.id &&
      row.api_key_enc &&
      row.enabled === 1 &&
      providerById(row.provider ?? '')?.kind === 'llm';
    if (!usable) {
      members.push({ ...base, client: null });
      continue;
    }
    const connector: ConnectorRow = {
      id: row.id!,
      user_sub: sub,
      provider: row.provider!,
      name: row.name ?? `AI ${slot}`,
      base_url: row.base_url,
      api_key_enc: row.api_key_enc,
      model: row.model,
      is_default: 0,
      is_vecna: 0,
      enabled: row.enabled!,
      created_at: '',
      updated_at: '',
    };
    members.push({ ...base, client: await toClient(connector, secret) });
  }
  return { projectId, members };
}

function aiSystem(member: PoolMember): string {
  return [
    `You are ${member.label}, a worker AI in the Hellfire group chat of the Mind Flayer workspace.`,
    `Your field/sector: ${member.field}. Stay in your lane but help with anything close to it.`,
    'The human is talking to the whole group. Answer directly, concisely and concretely.',
    'Code must be complete and runnable. Reference file paths when the message includes file context.',
  ].join(' ');
}

export function hellfireRoutes(deps: AppDeps) {
  const app = new Hono<{ Bindings: Env }>();

  /** Who is in the pool right now (used by the Hellfire roster header). */
  app.get('/api/hellfire/pool', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const projectId = c.req.query('projectId') || null;
    const pool = await resolvePool(c.env, gate.user.sub, projectId);
    return Response.json(
      {
        projectId: pool.projectId,
        members: pool.members.map((m) => ({
          slot: m.slot,
          label: m.label,
          field: m.field,
          online: Boolean(m.client),
        })),
      },
      { headers: PRIVATE_HEADERS },
    );
  });

  /**
   * POST /api/hellfire/message — one human line, N AI replies streamed with
   * per-slot tokens. `context` carries open files from the IDE; `targetSlot`
   * narrows the reply to a single AI (mention a specific worker).
   */
  app.post('/api/hellfire/message', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;

    const body = (await c.req.json().catch(() => null)) as {
      message?: string;
      projectId?: string | null;
      chatId?: string;
      history?: Array<{ role: string; content: string }>;
      context?: string;
      targetSlot?: number | null;
    } | null;
    const message = body?.message?.trim();
    if (!message) return jsonError('Message is required', 400);

    const user = gate.user;
    const projectId = typeof body?.projectId === 'string' && body.projectId ? body.projectId : null;
    let chatId = body?.chatId ?? null;

    if (chatId) {
      const blocked = await unlockCheck(c.env, user, chatId, c.req.header('x-mindflayer-pin'));
      if (blocked) return blocked;
    } else {
      chatId = await createChat(c.env, user.sub, message.slice(0, 60), 'hellfire', projectId);
    }

    const pool = await resolvePool(c.env, user.sub, projectId);
    let members = pool.members;
    if (typeof body?.targetSlot === 'number') {
      members = members.filter((m) => m.slot === body.targetSlot);
    }
    // No project / no assignments yet → AI 1 on the demo engine keeps chat alive.
    if (!members.length) members = [{ slot: 1, field: 'unassigned', label: 'AI 1', client: null }];

    const context = body?.context?.trim().slice(0, 24_000) ?? '';
    await saveMessage(c.env, chatId, user.sub, 'user', message, null, context ? { context } : null);

    const history: ChatMessage[] = (body?.history ?? [])
      .slice(-10)
      .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    return sseResponse(async (emit: Emit) => {
      await emit('meta', {
        chatId,
        projectId,
        mode: 'hellfire',
        pool: members.map((m) => ({ slot: m.slot, label: m.label, field: m.field, live: Boolean(m.client) })),
      });

      for (const member of members) {
        await emit('ai', { slot: member.slot, label: member.label, field: member.field, status: 'start' });
        const fence = '```';
        const prompt = context
          ? ['Open files from the mobile IDE:', fence, context, fence, '', message].join('\n')
          : message;
        const messages: ChatMessage[] = [
          ...history,
          { role: 'user', content: prompt },
        ];
        let text = '';
        const onToken = async (chunk: string) => {
          text += chunk;
          await emit('token', { slot: member.slot, text: chunk });
        };
        if (member.client) {
          await llmStream(member.client, [{ role: 'system', content: aiSystem(member) }, ...messages], onToken);
        } else {
          await demoStream('coder', `${member.label} (${member.field}) — ${prompt}`, onToken);
        }
        await saveMessage(c.env, chatId, user.sub, 'assistant', text, member.label, {
          slot: member.slot,
          field: member.field,
        });
        await emit('ai', {
          slot: member.slot,
          label: member.label,
          field: member.field,
          status: 'end',
          text,
        });
      }
      await emit('saved', { chatId });
    });
  });

  return app;
}
