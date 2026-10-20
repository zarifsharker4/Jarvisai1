import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { useApp } from '../state';
import type { PoolMember, Project } from '../types';

/**
 * Button 4 — Project Switcher: isolated workspaces, each with its own
 * GitHub repo/branch, its own AI pool (AI 1..AI N) and its own dedicated
 * Vecna chat thread. Switching re-scopes the Vecna and Hellfire tabs.
 */
export function Projects() {
  const {
    projects,
    activeProjectId,
    setActiveProjectId,
    refreshProjects,
    setActiveTab,
    setActiveChatId,
  } = useApp();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repo, setRepo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pools, setPools] = useState<Record<string, PoolMember[]>>({});
  const [editingRepo, setEditingRepo] = useState<string | null>(null);
  const [repoDraft, setRepoDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, PoolMember[]> = {};
      for (const project of projects) {
        try {
          const res = await api<{ members: PoolMember[] }>(
            `/api/hellfire/pool?projectId=${encodeURIComponent(project.id)}`,
          );
          next[project.id] = res.members;
        } catch {
          next[project.id] = [];
        }
        if (cancelled) return;
      }
      if (!cancelled) setPools(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [projects]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ id: string }>('/api/projects', {
        method: 'POST',
        body: { name: name.trim(), description: description.trim() || undefined, repo: repo.trim() || undefined },
      });
      setName('');
      setDescription('');
      setRepo('');
      await refreshProjects();
      setActiveProjectId(res.id);
      setActiveChatId(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the project');
    } finally {
      setBusy(false);
    }
  };

  const rename = async (project: Project) => {
    const next = window.prompt('Project name', project.name);
    if (!next?.trim()) return;
    try {
      await api(`/api/projects/${project.id}`, { method: 'PATCH', body: { name: next.trim() } });
      await refreshProjects();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Rename failed');
    }
  };

  const saveRepo = async (project: Project) => {
    try {
      await api(`/api/projects/${project.id}`, {
        method: 'PATCH',
        body: { repo: repoDraft.trim() || null },
      });
      setEditingRepo(null);
      await refreshProjects();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the repo');
    }
  };

  const remove = async (project: Project) => {
    if (!window.confirm(`Delete "${project.name}"? Its AI assignments go with it; chats are kept.`)) return;
    try {
      await api(`/api/projects/${project.id}`, { method: 'DELETE' });
      if (activeProjectId === project.id) setActiveProjectId(null);
      await refreshProjects();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Delete failed');
    }
  };

  const switchTo = (project: Project) => {
    setActiveProjectId(project.id);
    setActiveChatId(null); // fresh context → dedicated Vecna thread for this project
  };

  return (
    <div className="projects">
      <header className="panel-head">
        <div>
          <h2>Project Switcher</h2>
          <p className="muted">
            Isolated workspaces — split your AI pool across projects (e.g. 10 AIs each). Every
            project gets its own Vecna thread, repo and Hellfire room.
          </p>
        </div>
      </header>

      {error ? <div className="inline-error">{error}</div> : null}

      <form className="project-create" onSubmit={(e) => void create(e)}>
        <input
          className="input"
          placeholder="Project name (e.g. Jarvis Core)"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="input"
          placeholder="One-line description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <input
          className="input"
          placeholder="GitHub repo · owner/name (optional)"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          spellCheck={false}
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : '＋ Create project'}
        </button>
      </form>

      {projects.length === 0 ? (
        <div className="empty-state compact">
          <h3>No projects yet</h3>
          <p className="muted">Create your first isolated workspace above — it takes one line.</p>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map((project) => {
            const active = project.id === activeProjectId;
            const members = pools[project.id] ?? [];
            return (
              <article key={project.id} className={`project-card ${active ? 'active' : ''}`}>
                <header className="project-card-head">
                  <div>
                    <strong>{project.name}</strong>
                    {active ? <span className="mini-badge vecna">active</span> : null}
                  </div>
                  <span className="ai-count">{project.aiCount} AIs</span>
                </header>
                {project.description ? <p className="project-desc">{project.description}</p> : null}

                <div className="project-repo">
                  {editingRepo === project.id ? (
                    <div className="repo-edit">
                      <input
                        className="input"
                        value={repoDraft}
                        onChange={(e) => setRepoDraft(e.target.value)}
                        placeholder="owner/name"
                        spellCheck={false}
                        autoFocus
                      />
                      <button className="btn btn-primary btn-sm" onClick={() => void saveRepo(project)}>
                        Save
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditingRepo(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      className="link-btn repo-link"
                      onClick={() => {
                        setEditingRepo(project.id);
                        setRepoDraft(project.repo ?? '');
                      }}
                      title="Click to set the repository"
                    >
                      {project.repo ? `⌥ ${project.repo}@${project.branch}` : '＋ attach a GitHub repo'}
                    </button>
                  )}
                </div>

                <div className="project-pool">
                  {members.length === 0 ? (
                    <span className="muted small">No AIs assigned — pool falls back to AI 1 (demo).</span>
                  ) : (
                    members.map((m) => (
                      <span
                        key={m.slot}
                        className={`roster-chip ${m.online ? 'online' : 'offline'}`}
                        style={{ ['--slot' as string]: `hsl(${m.slot * 47} 80% 65%)` }}
                      >
                        {m.label} <em>{m.field}</em>
                      </span>
                    ))
                  )}
                </div>

                <footer className="project-card-foot">
                  <button
                    className={`btn btn-sm ${active ? 'btn-ghost' : 'btn-primary'}`}
                    onClick={() => switchTo(project)}
                    disabled={active}
                  >
                    {active ? '✓ Switched' : 'Switch to this project'}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setActiveProjectId(project.id);
                      setActiveTab('manager');
                    }}
                  >
                    Reassign AIs
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => void rename(project)}>
                    Rename
                  </button>
                  <button className="btn btn-ghost btn-sm danger" onClick={() => void remove(project)}>
                    Delete
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      <p className="muted small">
        The Vecna tab follows the active project: switching here opens that project's dedicated
        Vecna thread and Hellfire room.
      </p>
    </div>
  );
}
