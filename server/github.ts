import { Hono } from 'hono';
import { requireUser } from './authz';
import { decryptSecret, encryptSecret } from './crypto';
import { guardSameOrigin, jsonError, PRIVATE_HEADERS } from './http';
import { providerById } from './providers';
import type { AppDeps } from './deps';
import type { ConnectorRow, Env } from './types';

/**
 * GitHub integration for the Hellfire mobile IDE.
 *
 * The user connects a personal access token once; it is stored AES-GCM
 * encrypted in their connector pool like every other key, and all GitHub
 * traffic is proxied through this Worker so the token never reaches the
 * browser. Supports listing repos, reading the file tree, reading a file and
 * pushing single/multi-file commits (the auto-push path).
 */
const GH_API = 'https://api.github.com';

type GhOpts = { method?: string; body?: unknown };

async function ghFetch(token: string, path: string, opts: GhOpts = {}): Promise<Response> {
  return fetch(`${GH_API}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

/** Resolve the signed-in user's decrypted GitHub token, or null. */
export async function githubToken(env: Env, sub: string): Promise<string | null> {
  const row = await env.DB!.prepare(
    "SELECT * FROM connectors WHERE user_sub = ?1 AND provider = 'github' AND enabled = 1 ORDER BY created_at DESC LIMIT 1",
  )
    .bind(sub)
    .first<ConnectorRow>();
  if (!row?.api_key_enc) return null;
  try {
    return await decryptSecret(env.APP_SECRET ?? 'dev-secret', row.api_key_enc);
  } catch {
    return null;
  }
}

async function ghJson<T>(res: Response): Promise<T | { error: string; status: number }> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = '';
    try {
      detail = String((JSON.parse(text) as { message?: string }).message ?? '');
    } catch {
      /* non-JSON error body */
    }
    return { error: detail || `GitHub returned HTTP ${res.status}`, status: res.status };
  }
  return (await res.json()) as T;
}

const isError = (v: unknown): v is { error: string; status: number } =>
  typeof v === 'object' && v !== null && 'error' in v && 'status' in v;

export type GhRepo = { full_name: string; name: string; default_branch: string; private: boolean };
export type GhTreeEntry = { path: string; type: 'blob' | 'tree'; size?: number };

/** Default repository for fresh workspaces (the directive's target repo). */
export const DEFAULT_REPO = 'zarifsharker4/Jarvisai1';
export const DEFAULT_BRANCH = 'main';

/** Read + write operations, all proxied with the encrypted token. */
export const gh = {
  async user(token: string): Promise<{ login: string } | { error: string; status: number }> {
    return ghJson<{ login: string }>(await ghFetch(token, '/user'));
  },

  async repos(token: string): Promise<GhRepo[] | { error: string; status: number }> {
    const data = await ghJson<Array<{ full_name: string; name: string; default_branch: string; private: boolean }>>(
      await ghFetch(token, '/user/repos?per_page=100&sort=updated'),
    );
    if (isError(data)) return data;
    return data.map((r) => ({
      full_name: r.full_name,
      name: r.name,
      default_branch: r.default_branch || 'main',
      private: Boolean(r.private),
    }));
  },

  /** Recursive git tree as a flat, sorted list of blobs + folders. */
  async tree(
    token: string,
    repo: string,
    branch: string,
  ): Promise<GhTreeEntry[] | { error: string; status: number }> {
    const head = await ghJson<{ object: { sha: string } }>(
      await ghFetch(token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`),
    );
    if (isError(head)) return head;
    const data = await ghJson<{ tree: Array<{ path: string; type: string; size?: number }> }>(
      await ghFetch(token, `/repos/${repo}/git/trees/${head.object.sha}?recursive=1`),
    );
    if (isError(data)) return data;
    return data.tree
      .filter((t) => t.type === 'blob' || t.type === 'tree')
      .map((t): GhTreeEntry => ({ path: t.path, type: t.type === 'tree' ? 'tree' : 'blob', size: t.size }))
      .sort((a, b) => a.path.localeCompare(b.path));
  },

  async file(
    token: string,
    repo: string,
    path: string,
    branch: string,
  ): Promise<{ content: string; sha: string } | { error: string; status: number }> {
    const data = await ghJson<{ content?: string; sha?: string; encoding?: string; size?: number }>(
      await ghFetch(token, `/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`),
    );
    if (isError(data)) return data;
    if (data.size && data.size > 512_000) return { error: 'File larger than 512 KB', status: 413 };
    if (typeof data.content !== 'string' || typeof data.sha !== 'string') {
      return { error: 'File is not plain text', status: 415 };
    }
    const raw = data.content.replace(/\n/g, '');
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    return { content: new TextDecoder().decode(bytes), sha: data.sha };
  },
};

type CommitFile = { path: string; content: string | null };

/**
 * Push a batch of file changes as one commit through the git data API:
 * blobs → tree → commit → ref update. `content: null` deletes the file.
 */
export async function pushFiles(
  token: string,
  repo: string,
  branch: string,
  files: CommitFile[],
  message: string,
): Promise<{ ok: true; sha: string; url: string } | { error: string; status: number }> {
  if (!files.length) return { error: 'No files to commit', status: 400 };
  if (files.length > 100) return { error: 'Too many files in one commit (max 100)', status: 400 };

  const head = await ghJson<{ object: { sha: string } }>(
    await ghFetch(token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`),
  );
  if (isError(head)) return head;
  const baseCommit = await ghJson<{ tree: { sha: string }; message?: string }>(
    await ghFetch(token, `/repos/${repo}/git/commits/${head.object.sha}`),
  );
  if (isError(baseCommit)) return baseCommit;

  const tree: Array<Record<string, unknown>> = [];
  for (const file of files) {
    if (file.content === null) {
      tree.push({ path: file.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const blob = await ghJson<{ sha: string }>(
      await ghFetch(token, `/repos/${repo}/git/blobs`, {
        method: 'POST',
        body: { content: file.content, encoding: 'utf-8' },
      }),
    );
    if (isError(blob)) return blob;
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await ghJson<{ sha: string }>(
    await ghFetch(token, `/repos/${repo}/git/trees`, {
      method: 'POST',
      body: { base_tree: baseCommit.tree.sha, tree },
    }),
  );
  if (isError(newTree)) return newTree;

  const commit = await ghJson<{ sha: string; html_url?: string }>(
    await ghFetch(token, `/repos/${repo}/git/commits`, {
      method: 'POST',
      body: {
        message: message.slice(0, 200) || `Update ${files.length} file(s) from Mind Flayer`,
        tree: newTree.sha,
        parents: [head.object.sha],
      },
    }),
  );
  if (isError(commit)) return commit;

  const updated = await ghJson<{ object: { sha: string } }>(
    await ghFetch(token, `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'PATCH',
      body: { sha: commit.sha },
    }),
  );
  if (isError(updated)) return updated;
  return { ok: true, sha: commit.sha, url: commit.html_url ?? `https://github.com/${repo}/commit/${commit.sha}` };
}

/** HTTP routes: connect a token, list repos, read tree/files, push commits. */
export function githubRoutes(deps: AppDeps) {
  const app = new Hono<{ Bindings: Env }>();

  async function tokenGate(c: { req: { raw: Request; json: () => Promise<unknown>; query: (k: string) => string | undefined; header: (k: string) => string | undefined }; env: Env }) {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return { gate: null, error: gate.response };
    const token = await githubToken(c.env, gate.user.sub);
    if (!token) {
      return { gate: null, error: jsonError('Connect a GitHub account first', 424, { reason: 'no_token' }) };
    }
    return { gate, error: null as Response | null, token };
  }

  function repoBranch(c: { req: { query: (key: string) => string | undefined } }): { repo: string; branch: string } {
    const repo = (c.req.query('repo') || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
    const branch = (c.req.query('branch') || '').trim();
    return { repo, branch };
  }

  /** Connection state for the GitHub panel. */
  app.get('/api/github/status', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const token = await githubToken(c.env, gate.user.sub);
    if (!token) {
      return Response.json(
        { connected: false, defaultRepo: DEFAULT_REPO, defaultBranch: DEFAULT_BRANCH },
        { headers: PRIVATE_HEADERS },
      );
    }
    const account = await gh.user(token);
    if (isError(account)) {
      return Response.json(
        { connected: false, error: account.error, defaultRepo: DEFAULT_REPO, defaultBranch: DEFAULT_BRANCH },
        { headers: PRIVATE_HEADERS },
      );
    }
    return Response.json(
      {
        connected: true,
        login: account.login,
        defaultRepo: DEFAULT_REPO,
        defaultBranch: DEFAULT_BRANCH,
      },
      { headers: PRIVATE_HEADERS },
    );
  });

  /** Store (or replace) the encrypted GitHub token. */
  app.post('/api/github/connect', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    const body = (await c.req.json().catch(() => null)) as { token?: string } | null;
    const token = body?.token?.trim();
    if (!token || token.length < 8) return jsonError('Enter a GitHub personal access token', 400, { field: 'token' });

    const probe = await gh.user(token);
    if (isError(probe)) {
      return jsonError(
        probe.status === 401 ? 'GitHub rejected that token — create a new fine-grained or classic PAT' : probe.error,
        400,
        { reason: 'bad_token', upstream: probe.status },
      );
    }

    const existing = await c.env.DB!.prepare(
      "SELECT id FROM connectors WHERE user_sub = ?1 AND provider = 'github' ORDER BY created_at ASC",
    )
      .bind(gate.user.sub)
      .all<{ id: string }>();
    const encrypted = await encryptSecret(c.env.APP_SECRET ?? 'dev-secret', token);
    if (existing.results.length) {
      await c.env.DB!.prepare(
        "UPDATE connectors SET api_key_enc = ?2, name = ?3, enabled = 1, updated_at = datetime('now') WHERE id = ?1",
      )
        .bind(existing.results[0].id, encrypted, `GitHub · ${probe.login}`)
        .run();
      for (const row of existing.results.slice(1)) {
        await c.env.DB!.prepare('DELETE FROM connectors WHERE id = ?1').bind(row.id).run();
      }
    } else {
      const preset = providerById('github');
      await c.env.DB!.prepare(
        `INSERT INTO connectors (id, user_sub, provider, name, base_url, api_key_enc, model)
         VALUES (?1, ?2, 'github', ?3, ?4, ?5, ?6)`,
      )
        .bind(
          `gh_${gate.user.sub.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}_${Date.now().toString(36)}`,
          gate.user.sub,
          `GitHub · ${probe.login}`,
          preset?.baseUrl ?? GH_API,
          encrypted,
          null,
        )
        .run();
    }
    return Response.json({ ok: true, login: probe.login }, { headers: PRIVATE_HEADERS });
  });

  /** Disconnect: delete the stored GitHub token. */
  app.delete('/api/github/connect', async (c) => {
    const gate = await requireUser(c.req.raw, c.env, deps);
    if (!gate.ok) return gate.response;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    await c.env.DB!.prepare("DELETE FROM connectors WHERE user_sub = ?1 AND provider = 'github'")
      .bind(gate.user.sub)
      .run();
    return Response.json({ ok: true }, { headers: PRIVATE_HEADERS });
  });

  app.get('/api/github/repos', async (c) => {
    const res = await tokenGate(c as never);
    if (!res.gate) return res.error;
    const repos = await gh.repos(res.token!);
    if (isError(repos)) return jsonError(repos.error, 502, { upstream: repos.status });
    return Response.json({ repos }, { headers: PRIVATE_HEADERS });
  });

  app.get('/api/github/tree', async (c) => {
    const res = await tokenGate(c as never);
    if (!res.gate) return res.error;
    const { repo, branch } = repoBranch(c);
    if (!repo || !repo.includes('/')) return jsonError('repo must be "owner/name"', 400);
    const tree = await gh.tree(res.token!, repo, branch || DEFAULT_BRANCH);
    if (isError(tree)) return jsonError(tree.error, 502, { upstream: tree.status, reason: 'upstream' });
    return Response.json({ repo, branch: branch || DEFAULT_BRANCH, tree }, { headers: PRIVATE_HEADERS });
  });

  app.get('/api/github/file', async (c) => {
    const res = await tokenGate(c as never);
    if (!res.gate) return res.error;
    const { repo, branch } = repoBranch(c);
    const path = c.req.query('path') ?? '';
    if (!repo || !repo.includes('/') || !path) return jsonError('repo and path are required', 400);
    const file = await gh.file(res.token!, repo, path, branch || DEFAULT_BRANCH);
    if (isError(file)) return jsonError(file.error, 502, { upstream: file.status, reason: 'upstream' });
    return Response.json({ path, ...file }, { headers: PRIVATE_HEADERS });
  });

  /** One call, one commit: create/update/delete files (auto-push target). */
  app.post('/api/github/commit', async (c) => {
    const res = await tokenGate(c as never);
    if (!res.gate) return res.error;
    const sameOrigin = guardSameOrigin(c.req.raw, c.env);
    if (sameOrigin) return sameOrigin;
    const body = (await c.req.json().catch(() => null)) as {
      repo?: string;
      branch?: string;
      message?: string;
      files?: CommitFile[];
    } | null;
    const repo = body?.repo?.trim() ?? '';
    if (!repo.includes('/')) return jsonError('repo must be "owner/name"', 400);
    const files = Array.isArray(body?.files)
      ? body.files
          .filter((f) => f && typeof f.path === 'string' && f.path.length > 0)
          .map((f) => ({ path: f.path.replace(/^\/+/, ''), content: typeof f.content === 'string' ? f.content : null }))
          .slice(0, 100)
      : [];
    const result = await pushFiles(
      res.token!,
      repo,
      body?.branch?.trim() || DEFAULT_BRANCH,
      files,
      body?.message?.trim() || '',
    );
    if (isError(result)) return jsonError(result.error, 502, { upstream: result.status, reason: 'upstream' });
    return Response.json(result, { headers: PRIVATE_HEADERS });
  });

  return app;
}
