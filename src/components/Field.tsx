import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { useApp } from '../state';
import type { FieldEntry } from '../types';

/**
 * Button 5 — The Field: the community marketplace. Publish custom apps with
 * their own Cerebro URL (custom handle like 1234.3456), browse and star what
 * others shipped, and fire entries straight into Cerebro Search.
 */
export function FieldShowcase() {
  const { setActiveTab } = useApp();
  const [entries, setEntries] = useState<FieldEntry[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /* Publish form */
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [appUrl, setAppUrl] = useState('');
  const [html, setHtml] = useState('');
  const [tags, setTags] = useState('');
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async (q?: string) => {
    try {
      const res = await api<{ entries: FieldEntry[] }>(
        `/api/field/list${q ? `?q=${encodeURIComponent(q)}` : ''}`,
      );
      setEntries(res.entries);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load The Field');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const publish = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ handle: string; updated?: boolean }>('/api/field/publish', {
        method: 'POST',
        body: {
          title: title.trim(),
          description: description.trim(),
          appUrl: appUrl.trim() || undefined,
          html: html.trim() || undefined,
          tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
          handle: handle.trim() || undefined,
        },
      });
      setNotice(
        res.updated
          ? `Updated — your Cerebro URL: https://cerebro.mindflayer.app/${res.handle}`
          : `Published — your Cerebro URL: https://cerebro.mindflayer.app/${res.handle}`,
      );
      setTitle('');
      setDescription('');
      setAppUrl('');
      setHtml('');
      setTags('');
      setHandle('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Publish failed');
    } finally {
      setBusy(false);
    }
  };

  const star = async (entry: FieldEntry) => {
    try {
      const res = await api<{ stars: number }>(`/api/field/${entry.handle}/star`, { method: 'POST', body: {} });
      setEntries((prev) => prev.map((e) => (e.handle === entry.handle ? { ...e, stars: res.stars } : e)));
    } catch {
      /* non-fatal */
    }
  };

  const unpublish = async (entry: FieldEntry) => {
    if (!window.confirm(`Unpublish "${entry.title}" from The Field?`)) return;
    try {
      await api(`/api/field/${entry.handle}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not unpublish');
    }
  };

  const copyCerebro = (entry: FieldEntry) => {
    void navigator.clipboard
      ?.writeText(entry.cerebroUrl)
      .then(() => {
        setCopied(entry.handle);
        window.setTimeout(() => setCopied(null), 1600);
      })
      .catch(() => setError('Clipboard unavailable'));
  };

  const openInCerebro = (entry: FieldEntry) => {
    try {
      sessionStorage.setItem('mindflayer_cerebro_handle', entry.handle);
    } catch {
      /* private mode */
    }
    setActiveTab('cerebro');
  };

  return (
    <div className="field-page">
      <header className="panel-head">
        <div>
          <h2>The Field</h2>
          <p className="muted">
            Publish your apps on the grid with custom Cerebro URLs — community handles in the
            classic format, e.g. 1234.3456.
          </p>
        </div>
        <input
          className="input field-search"
          placeholder="Search The Field…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            void load(e.target.value.trim() || undefined);
          }}
        />
      </header>

      {error ? <div className="inline-error">{error}</div> : null}
      {notice ? <div className="inline-note">{notice}</div> : null}

      <div className="field-grid">
        <section className="panel publish-panel">
          <h3>Publish an app</h3>
          <form className="publish-form" onSubmit={(e) => void publish(e)}>
            <input
              className="input"
              placeholder="App title"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              className="input publish-desc"
              rows={3}
              placeholder="What does it do?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <input
              className="input"
              placeholder="https://your-app.example (or embed HTML below)"
              value={appUrl}
              onChange={(e) => setAppUrl(e.target.value)}
              spellCheck={false}
            />
            <textarea
              className="input publish-html"
              rows={5}
              placeholder="<— or paste a self-contained HTML app for sandboxed Cerebro runs (max 300 KB)"
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              spellCheck={false}
            />
            <div className="publish-row">
              <input
                className="input"
                placeholder="tags: game, tool, dashboard"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
              <input
                className="input handle-input"
                placeholder="handle (auto) e.g. 1234.3456"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                pattern="\d{4}\.\d{4}"
                title="Four digits, a dot, four digits"
                spellCheck={false}
              />
            </div>
            <button className="btn btn-primary" type="submit" disabled={busy || !title.trim()}>
              {busy ? 'Publishing…' : 'Publish to The Field'}
            </button>
          </form>
        </section>

        <section className="panel browse-panel">
          <h3>On the grid · {entries.length}</h3>
          {entries.length === 0 ? (
            <div className="empty-hint">Nothing here yet — be the first to publish.</div>
          ) : (
            <div className="entry-list">
              {entries.map((entry) => (
                <article key={entry.handle} className="entry-card">
                  <header>
                    <strong>{entry.title}</strong>
                    <span className="handle-badge">{entry.handle}</span>
                  </header>
                  {entry.description ? <p className="entry-desc">{entry.description}</p> : null}
                  <div className="entry-tags">
                    <span className="author-chip">{entry.authorTag}</span>
                    {entry.tags.map((t) => (
                      <span key={t} className="mini-badge">
                        {t}
                      </span>
                    ))}
                  </div>
                  <footer className="entry-foot">
                    <button className="btn btn-ghost btn-sm" onClick={() => void star(entry)}>
                      ★ {entry.stars}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => copyCerebro(entry)}>
                      {copied === entry.handle ? '✓ Copied' : 'Copy Cerebro URL'}
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={() => openInCerebro(entry)}>
                      Run in Cerebro
                    </button>
                    {entry.owned ? (
                      <button className="btn btn-ghost btn-sm danger" onClick={() => void unpublish(entry)}>
                        Unpublish
                      </button>
                    ) : null}
                  </footer>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
