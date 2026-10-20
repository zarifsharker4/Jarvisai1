import { Hono } from 'hono';
import { requireUser } from './authz';
import { randomId } from './crypto';
import { guardSameOrigin, jsonError, PRIVATE_HEADERS } from './http';
import { providerById } from './providers';
import type { AppDeps } from './deps';
import type { ConnectorRow, Env, ProjectAiRow, ProjectRow } from './types';

/**
 * Multi-project management. Each project is an isolated workspace: its own
 * name, its own GitHub repo/branch, its own AI pool (AI 1, AI 2, … each
 * assigned a connector + field) and its own dedicated Vecna chat thread
 * (chats.project_id scopes the Vecna/Hellfire threads).
 */
export const MAX_AI_SLOTS = 24;

export const FIELDS = [
  'unassigned',
  'frontend',
  'backend',
  'fullstack',
  'review',
  'testing',
  'docs',
  'devops',
  'research',
  'design',
] as const;

export function projectRoutes(deps: AppDeps) {
  const app = new Hono<{ Bindings: Env }>();

  function parseRepo(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const clean = value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
    return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(clean) ? clean : null;
  }

  async function loadProject(env: Env, sub: string, id: string): Promise<ProjectRow | null> {
    return env.DB!.prepare('SELECT * FROM projects WHERE id = ?1 AND user_sub = ?2')
      .bind(id, sub)
      .first<ProjectRow>();
  }

  async function aiCount(env: Env, sub: string, projectId: string): Promise<number> {
    const row = await env.DB!.prepare(
      'SELECT COUNT(*) AS n FROM project_ais WHERE project_id = ?1 AND user_sub = ?2',
    )
      .bind(projectId, sub)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  /** GET /api/projects — every workspace with its AI count + repo. */
  app.get('/api/projects', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const rows = await c.env.DB!.prepare(
      'SELECT * FROM projects WHERE user_sub = ?1 ORDER BY created_at ASC',
    )
      .bind(gate.user.sub)
      .all<ProjectRow>();
    const projects = await Promise.all(
      rows.results.map(async (p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        repo: p.repo_full_name,
        branch: p.repo_branch || 'main',
        aiCount: await aiCount(c.env, gate.user.sub, p.id),
        createdAt: p.created_at,
      })),
    );
    return Response.json({ projects }, { headers: PRIVATE_HEADERS });
  });

  /** POST /api/projects — create an isolated workspace. */
  app.post('/api/projects', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      description?: string;
      repo?: string;
      branch?: string;
    } | null;
    const name = body?.name?.trim().slice(0, 60);
    if (!name) return jsonError('Project name is required', 400, { field: 'name' });
    const repo = parseRepo(body?.repo);
    if (body?.repo && !repo) return jsonError('Repo must look like "owner/name"', 400, { field: 'repo' });

    const id = randomId(10);
    await c.env.DB!.prepare(
      `INSERT INTO projects (id, user_sub, name, description, repo_full_name, repo_branch)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(
        id,
        gate.user.sub,
        name,
        body?.description?.trim().slice(0, 400) || null,
        repo,
        body?.branch?.trim().slice(0, 100) || 'main',
      )
      .run();
    return Response.json({ ok: true, id }, { status: 201, headers: PRIVATE_HEADERS });
  });

  app.patch('/api/projects/:id', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    const project = await loadProject(c.env, gate.user.sub, c.req.param('id'));
    if (!project) return jsonError('Project not found', 404);
    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      description?: string;
      repo?: string | null;
      branch?: string;
    } | null;

    const updates: string[] = [];
    const values: unknown[] = [];
    if (typeof body?.name === 'string' && body.name.trim()) {
      updates.push('name = ?');
      values.push(body.name.trim().slice(0, 60));
    }
    if (typeof body?.description === 'string') {
      updates.push('description = ?');
      values.push(body.description.trim().slice(0, 400) || null);
    }
    if (body?.repo !== undefined) {
      if (body.repo === null || body.repo === '') {
        updates.push('repo_full_name = ?');
        values.push(null);
      } else {
        const repo = parseRepo(body.repo);
        if (!repo) return jsonError('Repo must look like "owner/name"', 400, { field: 'repo' });
        updates.push('repo_full_name = ?');
        values.push(repo);
      }
    }
    if (typeof body?.branch === 'string' && body.branch.trim()) {
      updates.push('repo_branch = ?');
      values.push(body.branch.trim().slice(0, 100));
    }
    if (!updates.length) return jsonError('Nothing to update', 400);
    updates.push("updated_at = datetime('now')");
    values.push(project.id, gate.user.sub);
    await c.env.DB!.prepare(
      `UPDATE projects SET ${updates.join(', ')} WHERE id = ?${values.length - 1} AND user_sub = ?${values.length}`,
    )
      .bind(...values)
      .run();
    return Response.json({ ok: true }, { headers: PRIVATE_HEADERS });
  });

  app.delete('/api/projects/:id', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    const id = c.req.param('id');
    const project = await loadProject(c.env, gate.user.sub, id);
    if (!project) return jsonError('Project not found', 404);
    await c.env.DB!.prepare('DELETE FROM project_ais WHERE project_id = ?1 AND user_sub = ?2')
      .bind(id, gate.user.sub)
      .run();
    await c.env.DB!.prepare('DELETE FROM projects WHERE id = ?1 AND user_sub = ?2')
      .bind(id, gate.user.sub)
      .run();
    return Response.json({ ok: true }, { headers: PRIVATE_HEADERS });
  });

  return app;
}

/** AI pool assignment routes, mounted after the project routes. */
export function projectAiRoutes(deps: AppDeps) {
  const app = new Hono<{ Bindings: Env }>();

  /** GET /api/projects/:id/ais — slots with their connector + field. */
  app.get('/api/projects/:id/ais', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const projectId = c.req.param('id');
    const project = await c.env.DB!.prepare('SELECT id FROM projects WHERE id = ?1 AND user_sub = ?2')
      .bind(projectId, gate.user.sub)
      .first();
    if (!project) return jsonError('Project not found', 404);

    const rows = await c.env.DB!.prepare(
      `SELECT pa.id, pa.slot, pa.field, pa.connector_id,
              c.name AS connector_name, c.provider, c.model, c.enabled, c.api_key_enc
         FROM project_ais pa
         LEFT JOIN connectors c ON c.id = pa.connector_id AND c.user_sub = pa.user_sub
        WHERE pa.project_id = ?1 AND pa.user_sub = ?2
        ORDER BY pa.slot ASC`,
    )
      .bind(projectId, gate.user.sub)
      .all<{
        id: string;
        slot: number;
        field: string;
        connector_id: string | null;
        connector_name: string | null;
        provider: string | null;
        model: string | null;
        enabled: number | null;
        api_key_enc: string | null;
      }>();
    return Response.json(
      {
        ais: rows.results.map((r) => ({
          id: r.id,
          slot: r.slot,
          label: `AI ${r.slot}`,
          field: r.field,
          connectorId: r.connector_id,
          connector: r.connector_id
            ? {
                id: r.connector_id,
                name: r.connector_name,
                providerLabel: providerById(r.provider ?? '')?.label ?? r.provider,
                model: r.model,
                online: Boolean(r.enabled && r.api_key_enc),
              }
            : null,
        })),
        fields: FIELDS,
        maxSlots: MAX_AI_SLOTS,
      },
      { headers: PRIVATE_HEADERS },
    );
  });

  /**
   * PUT /api/projects/:id/ais — replace the pool:
   * [{ slot, connectorId | null, field }]. Slots are the AI 1..N tags.
   */
  app.put('/api/projects/:id/ais', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    const projectId = c.req.param('id');
    const project = await c.env.DB!.prepare('SELECT id FROM projects WHERE id = ?1 AND user_sub = ?2')
      .bind(projectId, gate.user.sub)
      .first();
    if (!project) return jsonError('Project not found', 404);

    const body = (await c.req.json().catch(() => null)) as {
      assignments?: Array<{ slot?: number; connectorId?: string | null; field?: string }>;
    } | null;
    const assignments = Array.isArray(body?.assignments) ? body.assignments : null;
    if (!assignments) return jsonError('assignments array is required', 400);
    if (assignments.length > MAX_AI_SLOTS) {
      return jsonError(`A project can host at most ${MAX_AI_SLOTS} AIs`, 400);
    }

    // Validate every referenced connector belongs to this user and is an LLM key.
    const connectorIds = [...new Set(assignments.map((a) => a.connectorId).filter((v): v is string => typeof v === 'string'))];
    const owned = new Map<string, ConnectorRow>();
    for (let i = 0; i < connectorIds.length; i += 20) {
      const chunk = connectorIds.slice(i, i + 20);
      const placeholders = chunk.map((_, idx) => `?${idx + 2}`).join(', ');
      const rows = await c.env.DB!.prepare(
        `SELECT * FROM connectors WHERE user_sub = ?1 AND id IN (${placeholders})`,
      )
        .bind(gate.user.sub, ...chunk)
        .all<ConnectorRow>();
      for (const row of rows.results) owned.set(row.id, row);
    }
    const clean: Array<{ slot: number; connectorId: string | null; field: string }> = [];
    const seenSlots = new Set<number>();
    for (const a of assignments) {
      const slot = Number(a.slot);
      if (!Number.isInteger(slot) || slot < 1 || slot > MAX_AI_SLOTS) {
        return jsonError(`slot must be 1..${MAX_AI_SLOTS}`, 400);
      }
      if (seenSlots.has(slot)) return jsonError(`duplicate slot ${slot}`, 400);
      seenSlots.add(slot);
      let connectorId: string | null = null;
      if (a.connectorId) {
        const row = owned.get(a.connectorId);
        if (!row) return jsonError(`Unknown connector for slot ${slot}`, 400);
        if (providerById(row.provider)?.kind !== 'llm') {
          return jsonError(`Connector for slot ${slot} is not an LLM key`, 400);
        }
        connectorId = row.id;
      }
      const field = FIELDS.includes((a.field ?? 'unassigned') as (typeof FIELDS)[number])
        ? (a.field as string)
        : 'unassigned';
      clean.push({ slot, connectorId, field });
    }

    await c.env.DB!.prepare('DELETE FROM project_ais WHERE project_id = ?1 AND user_sub = ?2')
      .bind(projectId, gate.user.sub)
      .run();
    for (const a of clean) {
      await c.env.DB!.prepare(
        `INSERT INTO project_ais (id, user_sub, project_id, connector_id, slot, field)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
        .bind(randomId(10), gate.user.sub, projectId, a.connectorId, a.slot, a.field)
        .run();
    }
    return Response.json({ ok: true, count: clean.length }, { headers: PRIVATE_HEADERS });
  });

  return app;
}

export type { ProjectAiRow };
