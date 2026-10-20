import { Hono } from 'hono';
import { requireUser } from './authz';
import { randomId } from './crypto';
import { guardSameOrigin, jsonError, PRIVATE_HEADERS } from './http';
import type { AppDeps } from './deps';
import type { Env, FieldEntryRow } from './types';

/**
 * The Field — the community showcase. Users publish their custom apps with a
 * Stranger-Things-flavoured Cerebro handle (`1234.3456`). The same handle is
 * what Cerebro Search resolves, so an entry is both a listing and a runnable
 * sandbox target (optional embedded HTML, capped and run client-side only).
 */
export const HANDLE_PATTERN = /^\d{4}\.\d{4}$/;
export const MAX_HTML_BYTES = 300_000;

/** Mint a unique `NNNN.NNNN` handle. */
export function randomHandle(existing: (value: string) => boolean): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const block = () => String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
    const handle = `${block()}.${block()}`;
    if (!existing(handle)) return handle;
  }
  throw new Error('Could not mint a unique handle');
}

function publicEntry(row: FieldEntryRow, includeHtml: boolean) {
  return {
    handle: row.handle,
    title: row.title,
    description: row.description,
    appUrl: row.app_url,
    authorTag: row.author_tag,
    tags: row.tags ? row.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    stars: row.stars,
    hasApp: Boolean(row.html) || Boolean(row.app_url),
    html: includeHtml ? row.html : undefined,
    owned: undefined as boolean | undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cerebroUrl: `https://cerebro.mindflayer.app/${row.handle}`,
  };
}

export function fieldRoutes(deps: AppDeps) {
  const app = new Hono<{ Bindings: Env }>();

  /** GET /api/field/list?q= — browse the showcase (never ships HTML bodies). */
  app.get('/api/field/list', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const q = (c.req.query('q') ?? '').trim().toLowerCase().slice(0, 60);
    const rows = q
      ? await c.env.DB!.prepare(
          `SELECT * FROM field_entries
            WHERE lower(title) LIKE ?1 OR lower(description) LIKE ?1 OR lower(tags) LIKE ?1 OR handle = ?2
            ORDER BY stars DESC, created_at DESC LIMIT 100`,
        )
          .bind(`%${q}%`, q)
          .all<FieldEntryRow>()
      : await c.env.DB!.prepare('SELECT * FROM field_entries ORDER BY stars DESC, created_at DESC LIMIT 100')
          .all<FieldEntryRow>();
    const entries = rows.results.map((row) => ({
      ...publicEntry(row, false),
      owned: row.user_sub === gate.user.sub,
    }));
    return Response.json({ entries }, { headers: PRIVATE_HEADERS });
  });

  /** GET /api/field/:handle — full detail incl. embedded app for Cerebro. */
  app.get('/api/field/:handle', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const handle = c.req.param('handle');
    if (!HANDLE_PATTERN.test(handle)) return jsonError('Handle looks like 1234.3456', 400);
    const row = await c.env.DB!.prepare('SELECT * FROM field_entries WHERE handle = ?1')
      .bind(handle)
      .first<FieldEntryRow>();
    if (!row) return jsonError('No app on the grid with that handle', 404, { reason: 'not_found' });
    return Response.json(
      { entry: { ...publicEntry(row, true), owned: row.user_sub === gate.user.sub } },
      { headers: PRIVATE_HEADERS },
    );
  });

  /** POST /api/field/publish — list (or update) my app on The Field. */
  app.post('/api/field/publish', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;

    const body = (await c.req.json().catch(() => null)) as {
      title?: string;
      description?: string;
      handle?: string;
      appUrl?: string;
      html?: string;
      tags?: string[];
    } | null;
    const title = body?.title?.trim().slice(0, 80);
    if (!title) return jsonError('Give the app a title', 400, { field: 'title' });

    let handle = body?.handle?.trim() ?? '';
    if (handle && !HANDLE_PATTERN.test(handle)) {
      return jsonError('Handle must be 4 digits, a dot, 4 digits — like 1234.3456', 400, { field: 'handle' });
    }
    const html = typeof body?.html === 'string' ? body.html : '';
    if (html.length > MAX_HTML_BYTES) {
      return jsonError('Embedded app exceeds 300 KB — link to it instead', 400, { field: 'html' });
    }
    let appUrl: string | null = null;
    if (body?.appUrl?.trim()) {
      try {
        const parsed = new URL(body.appUrl.trim());
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('scheme');
        appUrl = parsed.toString().slice(0, 400);
      } catch {
        return jsonError('App URL must be a valid http(s) URL', 400, { field: 'appUrl' });
      }
    }
    if (!appUrl && !html) return jsonError('Add an app URL or paste embedded HTML', 400, { field: 'html' });

    const requestedHandle = handle;

    if (!handle) {
      handle = randomHandle((candidate) => {
        // Synchronous check is impossible over D1; do the uniqueness loop async below.
        return candidate === '0000.0000' || candidate === '';
      });
      for (let attempt = 0; attempt < 10; attempt++) {
        const clash = await c.env.DB!.prepare('SELECT handle FROM field_entries WHERE handle = ?1')
          .bind(handle)
          .first();
        if (!clash) break;
        handle = `${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}.${String(
          Math.floor(Math.random() * 10_000),
        ).padStart(4, '0')}`;
      }
    }

    const tags = (Array.isArray(body?.tags) ? body.tags : [])
      .map((t) => String(t).trim().toLowerCase().slice(0, 24))
      .filter(Boolean)
      .slice(0, 6)
      .join(',');

    if (requestedHandle) {
      // Existing handle → only the owner may update their listing.
      const row = await c.env.DB!.prepare('SELECT user_sub FROM field_entries WHERE handle = ?1')
        .bind(handle)
        .first<{ user_sub: string }>();
      if (row) {
        if (row.user_sub !== gate.user.sub) return jsonError('That handle belongs to someone else', 403);
        await c.env.DB!.prepare(
          `UPDATE field_entries SET title = ?2, description = ?3, app_url = ?4, html = ?5, tags = ?6,
                  updated_at = datetime('now') WHERE handle = ?1`,
        )
          .bind(
            handle,
            title,
            body?.description?.trim().slice(0, 600) ?? '',
            appUrl,
            html || null,
            tags,
          )
          .run();
        return Response.json({ ok: true, handle, updated: true }, { headers: PRIVATE_HEADERS });
      }
      // Fresh handle requested → fall through to the insert below.
    }

    const clash = await c.env.DB!.prepare('SELECT handle FROM field_entries WHERE handle = ?1')
      .bind(handle)
      .first();
    if (clash) return jsonError('That handle is taken — try another', 409, { field: 'handle' });

    await c.env.DB!.prepare(
      `INSERT INTO field_entries (id, user_sub, author_tag, handle, title, description, app_url, html, tags)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(
        randomId(12),
        gate.user.sub,
        gate.user.tag,
        handle,
        title,
        body?.description?.trim().slice(0, 600) ?? '',
        appUrl,
        html || null,
        tags,
      )
      .run();
    return Response.json({ ok: true, handle }, { status: 201, headers: PRIVATE_HEADERS });
  });

  /** POST /api/field/:handle/star — one star per session per app (kept simple). */
  app.post('/api/field/:handle/star', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    const handle = c.req.param('handle');
    const row = await c.env.DB!.prepare('SELECT stars FROM field_entries WHERE handle = ?1')
      .bind(handle)
      .first<{ stars: number }>();
    if (!row) return jsonError('No app with that handle', 404);
    await c.env.DB!.prepare('UPDATE field_entries SET stars = stars + 1 WHERE handle = ?1')
      .bind(handle)
      .run();
    return Response.json({ ok: true, stars: row.stars + 1 }, { headers: PRIVATE_HEADERS });
  });

  /** DELETE /api/field/:handle — unpublish my app. */
  app.delete('/api/field/:handle', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    const row = await c.env.DB!.prepare('SELECT user_sub FROM field_entries WHERE handle = ?1')
      .bind(c.req.param('handle'))
      .first<{ user_sub: string }>();
    if (!row) return jsonError('No app with that handle', 404);
    if (row.user_sub !== gate.user.sub) return jsonError('That app is not yours', 403);
    await c.env.DB!.prepare('DELETE FROM field_entries WHERE handle = ?1')
      .bind(c.req.param('handle'))
      .run();
    return Response.json({ ok: true }, { headers: PRIVATE_HEADERS });
  });

  return app;
}
