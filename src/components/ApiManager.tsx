import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { useApp } from '../state';
import type { Connector, Project, ProjectAi, VecnaStatus } from '../types';

/**
 * Button 3 — API & Field Manager: the unlimited key pool (any provider,
 * encrypted server-side) plus the dynamic AI 1..AI N field assignment board.
 */
export function ApiManager() {
  const { bootstrap, projects, activeProjectId, setActiveProjectId, refreshProjects } = useApp();

  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [vecna, setVecna] = useState<VecnaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /* Add-key form */
  const [provider, setProvider] = useState('google-ai-studio');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [isVecna, setIsVecna] = useState(false);
  const [busy, setBusy] = useState(false);

  /* Assignment board */
  const [ais, setAis] = useState<ProjectAi[]>([]);
  const [assignProject, setAssignProject] = useState<string>(activeProjectId ?? '');
  const [assignBusy, setAssignBusy] = useState(false);

  const preset = bootstrap?.providers?.find((p) => p.id === provider);
  const llmProviders = (bootstrap?.providers ?? []).filter((p) => p.kind === 'llm');
  const fields = (bootstrap ? ['unassigned'] : ['unassigned']).concat([
    'frontend',
    'backend',
    'fullstack',
    'review',
    'testing',
    'docs',
    'devops',
    'research',
    'design',
  ]);

  const load = useCallback(async () => {
    try {
      const res = await api<{ connectors: Connector[] }>('/api/connectors');
      setConnectors(res.connectors);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load keys');
    }
    api<VecnaStatus>('/api/vecna/status').then(setVecna).catch(() => undefined);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!assignProject && projects.length) setAssignProject(activeProjectId ?? projects[0].id);
  }, [projects, activeProjectId, assignProject]);

  const loadAis = useCallback(async (projectId: string) => {
    if (!projectId) {
      setAis([]);
      return;
    }
    try {
      const res = await api<{ ais: ProjectAi[] }>(`/api/projects/${projectId}/ais`);
      setAis(res.ais);
    } catch {
      setAis([]);
    }
  }, []);

  useEffect(() => {
    void loadAis(assignProject);
  }, [assignProject, loadAis]);

  const addKey = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('/api/connectors', {
        method: 'POST',
        body: {
          provider,
          name: name.trim() || undefined,
          apiKey: apiKey.trim(),
          model: model.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
          isDefault,
          isVecna,
        },
      });
      setApiKey('');
      setName('');
      setModel('');
      setIsDefault(false);
      setIsVecna(false);
      setNotice(
        isVecna
          ? 'Key stored — Vecna now runs on it.'
          : 'Key stored encrypted. It is available for assignment as an AI right away.',
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not store the key');
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    try {
      await api(`/api/connectors/${id}`, { method: 'PUT', body });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Update failed');
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Delete this key? Any AI assigned to it falls back to the demo engine.')) return;
    try {
      await api(`/api/connectors/${id}`, { method: 'DELETE' });
      await load();
      await refreshProjects();
    } catch {
      setError('Delete failed');
    }
  };

  const test = async (id: string) => {
    setNotice(null);
    try {
      const res = await api<{ ok: boolean; detail: string }>(`/api/connectors/${id}/test`, {
        method: 'POST',
        body: {},
      });
      setNotice(`${res.ok ? '✅' : '⛔'} ${res.detail}`);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Test failed');
    }
  };

  const setField = (slot: number, field: string) => {
    setAis((prev) => prev.map((a) => (a.slot === slot ? { ...a, field } : a)));
  };

  const saveAssignments = async () => {
    if (!assignProject) return;
    setAssignBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${assignProject}/ais`, {
        method: 'PUT',
        body: {
          assignments: ais.map((a) => ({ slot: a.slot, connectorId: a.connectorId, field: a.field })),
        },
      });
      setNotice('AI pool saved — the Hellfire chat picks it up immediately.');
      await refreshProjects();
      await loadAis(assignProject);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save assignments');
    } finally {
      setAssignBusy(false);
    }
  };

  const addSlot = () => {
    setAis((prev) => {
      const nextSlot = Math.max(0, ...prev.map((a) => a.slot)) + 1;
      if (nextSlot > 24) return prev;
      return [...prev, { id: `new-${nextSlot}`, slot: nextSlot, label: `AI ${nextSlot}`, field: 'unassigned', connectorId: null, connector: null }];
    });
  };

  const removeSlot = (slot: number) => {
    setAis((prev) => prev.filter((a) => a.slot !== slot));
  };

  return (
    <div className="manager">
      <header className="panel-head">
        <div>
          <h2>API & Field Manager</h2>
          <p className="muted">
            Unlimited keys, any provider — stored encrypted — and the live AI 1..AI N assignment
            board for every project.
          </p>
        </div>
        <div className="vecna-pill" title="Vecna's connector">
          <span className={`dot ${vecna?.configured ? 'on' : 'off'}`} />
          {vecna?.configured ? `Vecna · ${vecna.model ?? 'Gemini'}` : 'Vecna not initialized'}
        </div>
      </header>

      {error ? <div className="inline-error">{error}</div> : null}
      {notice ? <div className="inline-note">{notice}</div> : null}

      <div className="manager-grid">
        {/* --------- Key pool --------- */}
        <section className="panel">
          <h3>Key pool · {connectors.filter((c) => c.kind !== 'github').length} keys</h3>
          <div className="connector-list">
            {connectors.map((c) => (
              <article key={c.id} className={`connector-card ${c.enabled ? '' : 'disabled'}`}>
                <header>
                  <strong>{c.name}</strong>
                  <div className="connector-badges">
                    {c.isVecna ? <span className="mini-badge vecna">Vecna</span> : null}
                    {c.isDefault ? <span className="mini-badge">default</span> : null}
                    <span className="mini-badge kind">{c.kind}</span>
                  </div>
                </header>
                <div className="connector-meta">
                  {c.providerLabel} · {c.model ?? 'no model'} · {c.keyHint}
                </div>
                <footer>
                  <label className="tiny-toggle">
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      onChange={(e) => void patch(c.id, { enabled: e.target.checked })}
                    />
                    enabled
                  </label>
                  <button className="btn btn-ghost btn-sm" onClick={() => void test(c.id)}>
                    Test
                  </button>
                  {c.kind === 'llm' && !c.isDefault ? (
                    <button className="btn btn-ghost btn-sm" onClick={() => void patch(c.id, { isDefault: true })}>
                      Default
                    </button>
                  ) : null}
                  <button className="btn btn-ghost btn-sm danger" onClick={() => void remove(c.id)}>
                    Delete
                  </button>
                </footer>
              </article>
            ))}
            {connectors.length === 0 ? (
              <div className="empty-hint">No keys yet — add one below, or initialize Vecna first.</div>
            ) : null}
          </div>

          <form className="key-form" onSubmit={(e) => void addKey(e)}>
            <h4>Add a key</h4>
            <div className="key-form-row">
              <select className="input select" value={provider} onChange={(e) => setProvider(e.target.value)}>
                {llmProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <input
                className="input"
                type="password"
                placeholder="API key"
                required
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="key-form-row">
              <input
                className="input"
                placeholder="Label (e.g. AI 2 key)"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <input
                className="input"
                placeholder={preset?.defaultModel ?? 'model'}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                spellCheck={false}
              />
            </div>
            {provider === 'custom' ? (
              <input
                className="input"
                placeholder="Base URL (https://…/v1)"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                spellCheck={false}
              />
            ) : null}
            <div className="key-form-checks">
              <label>
                <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
                Make default engine
              </label>
              <label>
                <input type="checkbox" checked={isVecna} onChange={(e) => setIsVecna(e.target.checked)} />
                Power Vecna with this key
              </label>
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy || !apiKey.trim()}>
              {busy ? 'Storing…' : 'Store key (encrypted)'}
            </button>
            <p className="muted small">
              Keys never leave the server unencrypted. Get free Gemini keys at
              aistudio.google.com/apikey.
            </p>
          </form>
        </section>

        {/* --------- Field assignment board --------- */}
        <section className="panel">
          <h3>AI field assignment</h3>
          <div className="assign-toolbar">
            <select
              className="input select"
              value={assignProject}
              onChange={(e) => {
                setAssignProject(e.target.value);
                setActiveProjectId(e.target.value || null);
              }}
            >
              {projects.length === 0 ? <option value="">No projects yet</option> : null}
              {projects.map((p: Project) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost btn-sm" onClick={addSlot}>
              ＋ Add AI
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => void saveAssignments()} disabled={assignBusy || !assignProject}>
              {assignBusy ? 'Saving…' : 'Save board'}
            </button>
          </div>

          {ais.length === 0 ? (
            <div className="empty-hint">
              {projects.length === 0
                ? 'Create a project in the Project Switcher first.'
                : 'No AIs assigned — add one and point it at a key.'}
            </div>
          ) : (
            <div className="assign-table">
              <div className="assign-row head">
                <span>Tag</span>
                <span>Key</span>
                <span>Field</span>
                <span />
              </div>
              {ais.map((a) => (
                <div key={a.slot} className="assign-row">
                  <span className="ai-tag" style={{ ['--slot' as string]: `hsl(${a.slot * 47} 80% 65%)` }}>
                    {a.label}
                  </span>
                  <select
                    className="input select"
                    value={a.connectorId ?? ''}
                    onChange={(e) => {
                      const id = e.target.value || null;
                      setAis((prev) =>
                        prev.map((row) =>
                          row.slot === a.slot
                            ? {
                                ...row,
                                connectorId: id,
                                connector: id
                                  ? (connectors.find((c) => c.id === id) as Connector | undefined)
                                      ? {
                                          id,
                                          name: connectors.find((c) => c.id === id)?.name ?? null,
                                          providerLabel: connectors.find((c) => c.id === id)?.providerLabel ?? null,
                                          model: connectors.find((c) => c.id === id)?.model ?? null,
                                          online: connectors.find((c) => c.id === id)?.enabled ?? false,
                                        }
                                      : row.connector
                                  : null,
                              }
                            : row,
                        ),
                      );
                    }}
                  >
                    <option value="">— demo engine —</option>
                    {connectors
                      .filter((c) => c.kind === 'llm')
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.providerLabel})
                        </option>
                      ))}
                  </select>
                  <select
                    className="input select"
                    value={a.field}
                    onChange={(e) => setField(a.slot, e.target.value)}
                  >
                    {fields.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                  <button className="icon-btn" onClick={() => removeSlot(a.slot)} title={`Remove ${a.label}`}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="muted small">
            Slots are the permanent AI tags: AI 1, AI 2, AI 3 … Reassign keys or fields any time;
            each project keeps its own board.
          </p>
        </section>
      </div>
    </div>
  );
}
