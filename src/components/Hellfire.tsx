import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, apiSSE, toHistory } from '../api';
import { Markdown } from '../markdown';
import { useApp } from '../state';
import type { ChatMessage, GhStatus, GhTreeEntry, PoolMember } from '../types';
import { Call } from './Call';

type UiMsg = {
  id: string;
  role: 'user' | 'ai';
  slot?: number;
  label?: string;
  field?: string;
  content: string;
  streaming?: boolean;
  error?: boolean;
};

const uid = () => Math.random().toString(36).slice(2, 10);
const AUTOPUSH_KEY = 'mindflayer_autopush';

const SLOT_COLORS = ['#ff4d6d', '#4dd2ff', '#ffd166', '#7cff9b', '#c792ea', '#ff9f43', '#f368e0', '#54a0ff'];

function colorFor(slot: number): string {
  return SLOT_COLORS[(slot - 1) % SLOT_COLORS.length];
}

/**
 * Button 2 — Hellfire: the collaborative group chat with the project's AI
 * pool (AI 1, AI 2, …) fused with a mobile coding environment: a live File
 * Tree & File Viewer fed by the device workspace and/or the connected GitHub
 * repo, with save + push (optional auto-push) and a group voice room.
 */
export function Hellfire() {
  const { activeChatId, setActiveChatId, refreshChats, requestUnlock, activeProjectId, projects, setActiveTab } =
    useApp();
  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  /* ---------------- File workspace (device + GitHub) ---------------- */
  const [files, setFiles] = useState<Record<string, string>>({});
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [buffer, setBuffer] = useState('');
  const [dirty, setDirty] = useState(false);
  const [tree, setTree] = useState<GhTreeEntry[]>([]);
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [ghRepo, setGhRepo] = useState('zarifsharker4/Jarvisai1');
  const [ghBranch, setGhBranch] = useState('main');
  const [ghToken, setGhToken] = useState('');
  const [fileBusy, setFileBusy] = useState(false);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState('');
  const [autoPush, setAutoPush] = useState(() => {
    try {
      return localStorage.getItem(AUTOPUSH_KEY) === '1';
    } catch {
      return false;
    }
  });
  const dirHandles = useRef<Map<string, FileSystemFileHandle>>(new Map());
  const dirRef = useRef<FileSystemDirectoryHandle | null>(null);

  /* ---------------- Group chat ---------------- */
  const [pool, setPool] = useState<PoolMember[]>([]);
  const [messages, setMessages] = useState<UiMsg[]>([]);
  const [input, setInput] = useState('');
  const [target, setTarget] = useState<number | 'all'>('all');
  const [withContext, setWithContext] = useState(true);
  const [busy, setBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [voiceRoom, setVoiceRoom] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const chatScrollRef = useRef<HTMLDivElement>(null);

  /* ---------------- Effects ---------------- */
  useEffect(() => {
    api<GhStatus>('/api/github/status')
      .then((s) => {
        setGh(s);
        setGhRepo(s.defaultRepo);
        setGhBranch(s.defaultBranch);
      })
      .catch(() => setGh(null));
  }, []);

  useEffect(() => {
    api<{ members: PoolMember[] }>(
      `/api/hellfire/pool?projectId=${encodeURIComponent(activeProjectId ?? '')}`,
    )
      .then((res) => setPool(res.members))
      .catch(() => setPool([]));
  }, [activeProjectId]);

  useEffect(() => {
    let cancelled = false;
    if (!activeChatId) return;
    (async () => {
      try {
        const res = await api<{ chat: { title: string }; messages: ChatMessage[] }>(
          `/api/chats/${activeChatId}/messages`,
        );
        if (cancelled) return;
        setMessages(
          res.messages.map((m) => {
            const meta = m.meta ? (JSON.parse(m.meta) as { slot?: number; field?: string }) : {};
            return {
              id: m.id ?? uid(),
              role: m.role === 'user' ? 'user' : 'ai',
              slot: meta.slot,
              label: m.agent ?? 'AI',
              field: meta.field,
              content: m.content,
            };
          }),
        );
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 423) requestUnlock();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeChatId, requestUnlock]);

  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /* ---------------- GitHub + file actions ---------------- */
  const connectGithub = async () => {
    setFileBusy(true);
    setFileNote(null);
    try {
      const res = await api<{ login: string }>('/api/github/connect', {
        method: 'POST',
        body: { token: ghToken.trim() },
      });
      setGh({ connected: true, login: res.login, defaultRepo: ghRepo, defaultBranch: ghBranch });
      setGhToken('');
      setFileNote(`Connected as ${res.login} — pull, edit, push with zero restrictions.`);
    } catch (err) {
      setFileNote(err instanceof ApiError ? err.message : 'Could not connect GitHub');
    } finally {
      setFileBusy(false);
    }
  };

  const disconnectGithub = async () => {
    try {
      await api('/api/github/connect', { method: 'DELETE' });
      setGh({ connected: false, defaultRepo: ghRepo, defaultBranch: ghBranch });
      setTree([]);
      setFileNote('GitHub disconnected.');
    } catch {
      /* already gone */
    }
  };

  const pullTree = async () => {
    if (!gh?.connected) return;
    setFileBusy(true);
    setFileNote(null);
    try {
      const res = await api<{ tree: GhTreeEntry[] }>(
        `/api/github/tree?repo=${encodeURIComponent(ghRepo)}&branch=${encodeURIComponent(ghBranch)}`,
      );
      setTree(res.tree);
      setFileNote(`Tree loaded — ${res.tree.filter((t) => t.type === 'blob').length} files in ${ghRepo}.`);
    } catch (err) {
      setFileNote(err instanceof ApiError ? err.message : 'Pull failed');
    } finally {
      setFileBusy(false);
    }
  };

  const openFile = async (path: string) => {
    if (dirty && openPath && !window.confirm(`Discard unsaved changes to ${openPath}?`)) return;
    setOpenPath(path);
    setDirty(false);
    if (path in files) {
      setBuffer(files[path]);
      return;
    }
    if (!gh?.connected) {
      setBuffer('');
      setFileNote('Not pulled yet — connect GitHub and pull the tree, or create this file locally.');
      return;
    }
    setFileBusy(true);
    try {
      const res = await api<{ content: string }>(
        `/api/github/file?repo=${encodeURIComponent(ghRepo)}&branch=${encodeURIComponent(ghBranch)}&path=${encodeURIComponent(path)}`,
      );
      setFiles((prev) => ({ ...prev, [path]: res.content }));
      setBuffer(res.content);
      setFileNote(null);
    } catch (err) {
      setFileNote(err instanceof ApiError ? err.message : 'Could not open file');
    } finally {
      setFileBusy(false);
    }
  };

  const saveFile = useCallback(async (): Promise<boolean> => {
    if (!openPath) return false;
    const next = { ...files, [openPath]: buffer };
    setFiles(next);
    setDirty(false);

    // Device storage: write back to the folder handle when one is open.
    const handle = dirHandles.current.get(openPath);
    if (handle) {
      try {
        const writable = await handle.createWritable();
        await writable.write(buffer);
        await writable.close();
        setFileNote(`Saved ${openPath} to device folder.`);
      } catch (err) {
        setFileNote(`Device save failed: ${(err as Error).message}`);
      }
    } else {
      setFileNote(`Saved ${openPath} in the workspace.`);
    }

    if (autoPush && gh?.connected) {
      try {
        const res = await api<{ sha: string }>('/api/github/commit', {
          method: 'POST',
          body: {
            repo: ghRepo,
            branch: ghBranch,
            message: commitMsg.trim() || `Update ${openPath} from Hellfire IDE`,
            files: [{ path: openPath, content: buffer }],
          },
        });
        setFileNote(`Auto-pushed ${openPath} → ${ghRepo}@${ghBranch} (${res.sha.slice(0, 7)}).`);
      } catch (err) {
        setFileNote(err instanceof ApiError ? err.message : 'Auto-push failed');
      }
    }
    return true;
  }, [autoPush, buffer, commitMsg, files, gh, ghBranch, ghRepo, openPath]);

  const pushChanges = async () => {
    if (!gh?.connected) return;
    if (dirty) await saveFile();
    const changed = Object.keys(files).filter((p) => p === openPath || !(p in files));
    const payload = (openPath ? [openPath] : changed).map((p) => ({ path: p, content: files[p] ?? '' }));
    if (!payload.length) {
      setFileNote('Nothing to push — open a file and edit it first.');
      return;
    }
    setFileBusy(true);
    try {
      const res = await api<{ sha: string; url: string }>('/api/github/commit', {
        method: 'POST',
        body: {
          repo: ghRepo,
          branch: ghBranch,
          message: commitMsg.trim() || `Update ${payload.length} file(s) from Hellfire IDE`,
          files: payload,
        },
      });
      setFileNote(`Pushed ${payload.length} file(s) → commit ${res.sha.slice(0, 7)} on ${ghBranch}.`);
      setCommitMsg('');
    } catch (err) {
      setFileNote(err instanceof ApiError ? err.message : 'Push failed');
    } finally {
      setFileBusy(false);
    }
  };

  const newLocalFile = async () => {
    const path = window.prompt('New file path (e.g. src/utils.ts)');
    if (!path) return;
    const clean = path.replace(/^\/+/, '');
    setFiles((prev) => ({ ...prev, [clean]: '' }));
    setOpenPath(clean);
    setBuffer('');
    setDirty(true);
    if (dirRef.current && !dirHandles.current.has(clean)) {
      try {
        const handle = await dirRef.current.getFileHandle(clean, { create: true });
        dirHandles.current.set(clean, handle);
      } catch {
        /* nested path creation varies by browser */
      }
    }
  };

  const deleteFile = async () => {
    if (!openPath || !window.confirm(`Delete ${openPath} from the workspace?`)) return;
    setFiles((prev) => {
      const next = { ...prev };
      delete next[openPath];
      return next;
    });
    if (gh?.connected) {
      try {
        await api('/api/github/commit', {
          method: 'POST',
          body: { repo: ghRepo, branch: ghBranch, message: `Delete ${openPath}`, files: [{ path: openPath, content: null }] },
        });
        setFileNote(`Deleted ${openPath} (committed to ${ghRepo}).`);
      } catch (err) {
        setFileNote(err instanceof ApiError ? err.message : 'Delete commit failed');
      }
    }
    setOpenPath(null);
    setBuffer('');
    setDirty(false);
  };

  const openDeviceFolder = async () => {
    const w = window as unknown as {
      showDirectoryPicker?: (opts?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
    };
    if (!w.showDirectoryPicker) {
      setFileNote('This browser has no File System Access API — the workspace stays in-memory and on GitHub.');
      return;
    }
    try {
      const dir = await w.showDirectoryPicker({ mode: 'readwrite' });
      dirRef.current = dir;
      dirHandles.current = new Map();
      const loaded: Record<string, string> = {};
      let count = 0;
      type DirWithEntries = FileSystemDirectoryHandle & {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
      };
      const walk = async (handle: FileSystemDirectoryHandle, prefix: string, depth: number) => {
        if (depth > 5 || count > 300) return;
        for await (const [name, child] of (handle as DirWithEntries).entries()) {
          if (child.kind === 'file') {
            const file = await (child as FileSystemFileHandle).getFile();
            if (file.size > 300_000) continue;
            const path = prefix ? `${prefix}/${name}` : name;
            loaded[path] = await file.text();
            dirHandles.current.set(path, child as FileSystemFileHandle);
            count += 1;
            if (count > 300) break;
          } else if (child.name !== 'node_modules' && child.name !== '.git') {
            await walk(child as FileSystemDirectoryHandle, prefix ? `${prefix}/${child.name}` : child.name, depth + 1);
          }
        }
      };
      await walk(dir, '', 0);
      setFiles((prev) => ({ ...prev, ...loaded }));
      setFileNote(`Device folder linked — ${Object.keys(loaded).length} files loaded.`);
    } catch {
      /* user cancelled the picker */
    }
  };

  /* ---------------- Group chat send ---------------- */
  const send = async () => {
    const message = input.trim();
    if (!message || busy) return;
    if (!activeProjectId) {
      setChatError('Pick or create a project first — the AI pool lives per project.');
      setActiveTab('projects');
      return;
    }
    setBusy(true);
    setChatError(null);
    setInput('');
    const history = toHistory(messages.filter((m) => m.role === 'user' || !m.streaming) as ChatMessage[]);
    setMessages((prev) => [...prev, { id: uid(), role: 'user', content: message }]);

    const context =
      withContext && openPath && openPath in files
        ? `${openPath}:\n${files[openPath].slice(0, 8000)}`
        : '';

    try {
      await apiSSE(
        '/api/hellfire/message',
        {
          message,
          projectId: activeProjectId,
          chatId: activeChatId,
          history,
          context,
          targetSlot: target === 'all' ? null : target,
        },
        (event, data) => {
          if (event === 'meta') {
            if (typeof data.chatId === 'string' && data.chatId !== activeChatId) {
              setActiveChatId(data.chatId);
            }
            if (Array.isArray(data.pool)) {
              setPool(
                (data.pool as Array<{ slot: number; label: string; field: string; live: boolean }>).map((m) => ({
                  slot: m.slot,
                  label: m.label,
                  field: m.field,
                  online: m.live,
                })),
              );
            }
          } else if (event === 'ai' && data.status === 'start') {
            setMessages((prev) => [
              ...prev,
              {
                id: `ai-${data.slot}-${uid()}`,
                role: 'ai',
                slot: Number(data.slot),
                label: String(data.label ?? `AI ${data.slot}`),
                field: String(data.field ?? 'unassigned'),
                content: '',
                streaming: true,
              },
            ]);
          } else if (event === 'token') {
            const slot = Number(data.slot);
            setMessages((prev) => {
              const idx = [...prev].reverse().findIndex((m) => m.role === 'ai' && m.slot === slot && m.streaming);
              if (idx < 0) return prev;
              const targetIdx = prev.length - 1 - idx;
              return prev.map((m, i) => (i === targetIdx ? { ...m, content: m.content + String(data.text ?? '') } : m));
            });
          } else if (event === 'ai' && data.status === 'end') {
            const slot = Number(data.slot);
            setMessages((prev) => {
              const idx = [...prev].reverse().findIndex((m) => m.role === 'ai' && m.slot === slot && m.streaming);
              if (idx < 0) return prev;
              const targetIdx = prev.length - 1 - idx;
              const text = typeof data.text === 'string' ? data.text : '';
              return prev.map((m, i) =>
                i === targetIdx ? { ...m, streaming: false, content: m.content || text } : m,
              );
            });
          } else if (event === 'error') {
            setChatError(String(data.message ?? 'Hellfire failed'));
          } else if (event === 'saved') {
            void refreshChats();
          }
        },
      );
      setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
    } catch (err) {
      if (err instanceof ApiError && err.status === 423) {
        requestUnlock();
        setChatError('Chat history is locked — enter your PIN to continue.');
      } else {
        setChatError(err instanceof Error ? err.message : 'Request failed');
      }
      setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- File tree rendering ---------------- */
  const treePaths = useMemo(() => {
    const local = Object.keys(files).map((p) => ({ path: p, type: 'blob' as const }));
    const merged = new Map<string, { path: string; type: 'blob' | 'tree' }>();
    for (const entry of [...tree, ...local]) merged.set(entry.path, entry);
    return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
  }, [files, tree]);

  const nodes = useMemo(() => buildTree(treePaths), [treePaths]);

  const toggleFolder = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const allFiles = treePaths.filter((t) => t.type === 'blob');

  return (
    <div className="hellfire">
      {/* ---------------- File pane: tree + viewer ---------------- */}
      <section className="file-pane">
        <div className="file-pane-head">
          <strong>Files</strong>
          <div className="file-pane-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => void openDeviceFolder()} title="Link a device folder">
              📁 Folder
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => void newLocalFile()}>＋ New</button>
          </div>
        </div>

        <div className="gh-bar">
          {gh?.connected ? (
            <>
              <span className="gh-badge" title={`Connected as ${gh.login}`}>● {gh.login}</span>
              <input
                className="input gh-input"
                value={ghRepo}
                onChange={(e) => setGhRepo(e.target.value)}
                aria-label="Repository"
                spellCheck={false}
              />
              <input
                className="input gh-input gh-branch"
                value={ghBranch}
                onChange={(e) => setGhBranch(e.target.value)}
                aria-label="Branch"
                spellCheck={false}
              />
              <button className="btn btn-ghost btn-sm" onClick={() => void pullTree()} disabled={fileBusy}>
                ⬇ Pull
              </button>
              <button className="icon-btn" onClick={() => void disconnectGithub()} title="Disconnect">
                ⤬
              </button>
            </>
          ) : (
            <>
              <input
                className="input gh-input"
                type="password"
                placeholder="GitHub PAT (ghp_…)"
                value={ghToken}
                onChange={(e) => setGhToken(e.target.value)}
                aria-label="GitHub token"
              />
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void connectGithub()}
                disabled={fileBusy || !ghToken.trim()}
              >
                Connect
              </button>
            </>
          )}
        </div>

        <div className="file-tree" role="tree" aria-label="Project files">
          {nodes.length === 0 ? (
            <div className="empty-hint">
              No files yet — connect GitHub and pull, link a device folder, or create a file.
            </div>
          ) : (
            <FileTreeNodes
              nodes={nodes}
              collapsed={collapsed}
              openPath={openPath}
              onToggle={toggleFolder}
              onOpen={(p) => void openFile(p)}
            />
          )}
        </div>

        <div className="file-viewer">
          {openPath ? (
            <>
              <div className="file-viewer-head">
                <span className="file-path">
                  {openPath}
                  {dirty ? <span className="dirty-dot" title="Unsaved">●</span> : null}
                </span>
                <div className="file-viewer-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => void saveFile()} disabled={!dirty}>
                    Save
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void pushChanges()}
                    disabled={!gh?.connected || fileBusy}
                    title={gh?.connected ? 'Commit + push to GitHub' : 'Connect GitHub first'}
                  >
                    ⬆ Push
                  </button>
                  <button className="icon-btn" onClick={() => void deleteFile()} title="Delete file">
                    🗑
                  </button>
                </div>
              </div>
              <textarea
                className="file-editor"
                spellCheck={false}
                value={buffer}
                onChange={(e) => {
                  setBuffer(e.target.value);
                  setDirty(true);
                }}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                    e.preventDefault();
                    void saveFile();
                  }
                }}
              />
              <div className="file-viewer-foot">
                <label className="autopush">
                  <input
                    type="checkbox"
                    checked={autoPush}
                    onChange={(e) => {
                      setAutoPush(e.target.checked);
                      try {
                        localStorage.setItem(AUTOPUSH_KEY, e.target.checked ? '1' : '0');
                      } catch {
                        /* private mode */
                      }
                    }}
                  />
                  Auto-push on save
                </label>
                <input
                  className="input commit-input"
                  placeholder="Commit message…"
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                />
              </div>
            </>
          ) : (
            <div className="empty-hint center">Open a file from the tree to view or edit it.</div>
          )}
        </div>

        {fileNote ? <div className="inline-note">{fileNote}</div> : null}
        {allFiles.length ? (
          <div className="muted small file-count">{allFiles.length} files in view</div>
        ) : null}
      </section>

      {/* ---------------- Chat pane ---------------- */}
      <section className="hellfire-chat">
        <div className="roster">
          <span className="roster-title">
            {project ? project.name : 'No project'} · AI pool
          </span>
          {pool.length === 0 ? (
            <button className="link-btn" onClick={() => setActiveTab('projects')}>
              Assign AIs →
            </button>
          ) : (
            pool.map((m) => (
              <span
                key={m.slot}
                className={`roster-chip ${m.online ? 'online' : 'offline'}`}
                style={{ ['--slot' as string]: colorFor(m.slot) }}
                title={`${m.label} · ${m.field} · ${m.online ? 'key configured' : 'demo engine'}`}
              >
                {m.label} <em>{m.field}</em>
              </span>
            ))
          )}
          <button className="btn btn-ghost btn-sm roster-call" onClick={() => setVoiceRoom((v) => !v)}>
            {voiceRoom ? '✕ Voice room' : '🎙 Voice room'}
          </button>
        </div>

        {voiceRoom ? <Call /> : null}

        <div className="chat-scroll" ref={chatScrollRef}>
          <div className="msg-list">
            {messages.length === 0 ? (
              <div className="empty-state">
                <div className="empty-mark hellfire-mark">H</div>
                <h2>Hellfire is open</h2>
                <p className="muted">
                  The whole AI pool reads your message at once — AI 1, AI 2, AI 3 … each answering
                  from its own field. Open a file in the IDE to let them see your code.
                </p>
                <div className="empty-cta">Try: “AI 1, review this file for bugs”</div>
              </div>
            ) : (
              messages.map((m) =>
                m.role === 'user' ? (
                  <div key={m.id} className="msg user">
                    <div className="msg-body">{m.content}</div>
                  </div>
                ) : (
                  <div
                    key={m.id}
                    className="msg assistant ai-msg"
                    style={{ ['--turn' as string]: colorFor(m.slot ?? 1) }}
                  >
                    <div className="msg-avatar" style={{ background: `${colorFor(m.slot ?? 1)}22` }}>
                      {m.label?.slice(0, 3) ?? 'AI'}
                    </div>
                    <div className="msg-col">
                      <div className="msg-name">
                        {m.label}
                        <span className="mode-chip">{m.field}</span>
                      </div>
                      <div className="msg-body">
                        {m.content ? <Markdown text={m.content} /> : null}
                        {m.streaming && !m.content ? <span className="muted">thinking…</span> : null}
                        {m.streaming ? <span className="caret" /> : null}
                      </div>
                    </div>
                  </div>
                ),
              )
            )}
          </div>
        </div>

        {chatError ? <div className="inline-error">{chatError}</div> : null}

        <div className="composer">
          <div className="hellfire-controls">
            <select
              className="input select"
              value={target === 'all' ? 'all' : String(target)}
              onChange={(e) => setTarget(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              aria-label="Target AI"
            >
              <option value="all">All AIs</option>
              {pool.map((m) => (
                <option key={m.slot} value={m.slot}>
                  {m.label} only ({m.field})
                </option>
              ))}
            </select>
            <label className="ctx-toggle" title="Send the open file as context">
              <input type="checkbox" checked={withContext} onChange={(e) => setWithContext(e.target.checked)} />
              Open file as context
            </label>
          </div>
          <div className="composer-row">
            <textarea
              className="composer-input"
              rows={2}
              placeholder="Message the Hellfire pool…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button className="btn btn-primary send-btn" onClick={() => void send()} disabled={busy || !input.trim()}>
              {busy ? '…' : 'Send'}
            </button>
          </div>
          <div className="composer-hint">
            Enter to send · each AI replies on its own stream, tagged AI 1..AI N
          </div>
        </div>
      </section>
    </div>
  );
}

/* ---------------- File tree ---------------- */

type TreeNode = { name: string; path: string; type: 'blob' | 'tree'; children?: TreeNode[] };

function buildTree(entries: Array<{ path: string; type: 'blob' | 'tree' }>): TreeNode[] {
  const root: TreeNode[] = [];
  for (const entry of entries) {
    const parts = entry.path.split('/');
    let level = root;
    let acc = '';
    parts.forEach((part, idx) => {
      acc = acc ? `${acc}/${part}` : part;
      const isLeaf = idx === parts.length - 1;
      let node = level.find((n) => n.name === part && (isLeaf ? n.type === entry.type : n.type === 'tree'));
      if (!node) {
        node = { name: part, path: acc, type: isLeaf ? entry.type : 'tree', children: isLeaf ? undefined : [] };
        level.push(node);
      }
      if (!isLeaf) {
        node.children = node.children ?? [];
        level = node.children;
      }
    });
  }
  const sortLevel = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'tree' ? -1 : 1));
    nodes.forEach((n) => n.children && sortLevel(n.children));
    return nodes;
  };
  return sortLevel(root);
}

function FileTreeNodes({
  nodes,
  collapsed,
  openPath,
  onToggle,
  onOpen,
  depth = 0,
}: {
  nodes: TreeNode[];
  collapsed: Set<string>;
  openPath: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  depth?: number;
}) {
  return (
    <ul className="ft-list" style={{ ['--depth' as string]: depth }}>
      {nodes.map((node) =>
        node.type === 'tree' ? (
          <li key={node.path}>
            <button className="ft-folder" onClick={() => onToggle(node.path)} style={{ paddingLeft: 8 + depth * 14 }}>
              <span className="ft-caret">{collapsed.has(node.path) ? '▸' : '▾'}</span> 🗀 {node.name}
            </button>
            {!collapsed.has(node.path) && node.children?.length ? (
              <FileTreeNodes
                nodes={node.children}
                collapsed={collapsed}
                openPath={openPath}
                onToggle={onToggle}
                onOpen={onOpen}
                depth={depth + 1}
              />
            ) : null}
          </li>
        ) : (
          <li key={node.path}>
            <button
              className={`ft-file ${openPath === node.path ? 'active' : ''}`}
              onClick={() => onOpen(node.path)}
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              {node.name}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}
