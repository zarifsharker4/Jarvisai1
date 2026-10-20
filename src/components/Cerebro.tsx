import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import type { FieldEntry } from '../types';

const RECENT_KEY = 'mindflayer_cerebro_recent';
const HANDOFF_KEY = 'mindflayer_cerebro_handle';
const HANDLE_RE = /^\d{4}\.\d{4}$/;

type Mode = 'readonly' | 'interactive';

/**
 * Button 6 — Cerebro Search: the in-app browser for community apps. Enter a
 * Stranger-Things-style handle (e.g. 1234.3456) and the app runs inside a
 * sandboxed iframe — read-only by default, interactive on demand. The sandbox
 * never grants same-origin access, so community code cannot touch sessions,
 * keys or backend code.
 */
export function Cerebro() {
  const [handle, setHandle] = useState('');
  const [entry, setEntry] = useState<FieldEntry | null>(null);
  const [mode, setMode] = useState<Mode>('readonly');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  const loadedRef = useRef(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (raw) setRecent(JSON.parse(raw) as string[]);
    } catch {
      /* ignore */
    }
  }, []);

  const remember = (value: string) => {
    setRecent((prev) => {
      const next = [value, ...prev.filter((h) => h !== value)].slice(0, 8);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  };

  const resolveHandle = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!HANDLE_RE.test(value)) {
      setError('Handles look like 1234.3456 — four digits, a dot, four digits.');
      return;
    }
    setBusy(true);
    setError(null);
    setEntry(null);
    try {
      const res = await api<{ entry: FieldEntry }>(`/api/field/${value}`);
      setEntry(res.entry);
      setHandle(value);
      remember(value);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 404
            ? `No app on the grid with handle ${value}.`
            : err.message
          : 'Lookup failed',
      );
    } finally {
      setBusy(false);
    }
  }, []);

  /* Handoff from The Field's "Run in Cerebro" button. */
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    try {
      const handoff = sessionStorage.getItem(HANDOFF_KEY);
      if (handoff) {
        sessionStorage.removeItem(HANDOFF_KEY);
        void resolveHandle(handoff);
      }
    } catch {
      /* ignore */
    }
  }, [resolveHandle]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void resolveHandle(handle);
  };

  const sandbox =
    mode === 'interactive' ? 'allow-scripts allow-forms allow-modals' : '';
  const sandboxExternal =
    mode === 'interactive' ? 'allow-scripts allow-forms allow-modals' : 'allow-scripts';
  const hasHtml = Boolean(entry?.html);
  const src = !hasHtml && entry?.appUrl ? entry.appUrl : undefined;

  return (
    <div className="cerebro">
      <header className="panel-head">
        <div>
          <h2>Cerebro · Custom App Browser</h2>
          <p className="muted">
            Enter a project handle to run a community app in the sandbox — read-only unless you
            flip it to interactive.
          </p>
        </div>
      </header>

      <form className="cerebro-bar" onSubmit={submit}>
        <span className="cerebro-prefix">cerebro://</span>
        <input
          className="input cerebro-input"
          placeholder="1234.3456"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          inputMode="numeric"
          spellCheck={false}
          aria-label="App handle"
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !handle.trim()}>
          {busy ? 'Resolving…' : 'Open'}
        </button>
        <div className="mode-switch" role="tablist" aria-label="Sandbox mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'readonly'}
            className={`mode-btn ${mode === 'readonly' ? 'active' : ''}`}
            onClick={() => setMode('readonly')}
            title="Scripts disabled — pure inspection"
          >
            🔒 Read-only
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'interactive'}
            className={`mode-btn ${mode === 'interactive' ? 'active' : ''}`}
            onClick={() => setMode('interactive')}
            title="Scripts allowed inside an isolated sandbox"
          >
            ⚡ Interactive
          </button>
        </div>
      </form>

      {recent.length ? (
        <div className="recent-handles">
          <span className="muted small">Recent:</span>
          {recent.map((h) => (
            <button key={h} className="handle-badge clickable" onClick={() => void resolveHandle(h)}>
              {h}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <div className="inline-error">{error}</div> : null}

      <div className="sandbox-note">
        <strong>Sandbox:</strong> {mode === 'readonly'
          ? 'read-only — embedded scripts are disabled, the app renders as inert content.'
          : 'interactive — scripts run with an opaque origin: no cookies, no storage, no path to your backend, sessions or keys.'}
      </div>

      {entry ? (
        <>
          <div className="cerebro-detail">
            <div>
              <strong>{entry.title}</strong> <span className="handle-badge">{entry.handle}</span>
              <div className="muted small">
                by {entry.authorTag} · ★ {entry.stars}
                {entry.tags.length ? ` · ${entry.tags.join(', ')}` : ''}
              </div>
            </div>
            <div className="cerebro-detail-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setReloadKey((k) => k + 1)}>
                ↻ Reload
              </button>
              {entry.appUrl ? (
                <a className="btn btn-ghost btn-sm" href={entry.appUrl} target="_blank" rel="noreferrer noopener">
                  Open externally ↗
                </a>
              ) : null}
            </div>
          </div>
          {entry.description ? <p className="entry-desc">{entry.description}</p> : null}

          {src || entry.html ? (
            <div className="cerebro-frame-wrap" key={`${reloadKey}-${mode}`}>
              <iframe
                className="cerebro-frame"
                title={`${entry.title} · ${entry.handle}`}
                src={src}
                srcDoc={src ? undefined : entry.html ?? undefined}
                sandbox={src ? sandboxExternal : sandbox}
                referrerPolicy="no-referrer"
              />
            </div>
          ) : (
            <div className="empty-hint center">
              This listing has no embedded app — nothing safe to run here.
            </div>
          )}
        </>
      ) : (
        !error && (
          <div className="empty-state compact">
            <div className="empty-mark">☰</div>
            <h3>Enter a handle</h3>
            <p className="muted">
              Handles look like <code className="inline-code">1234.3456</code>. Publish apps with
              custom handles from The Field tab.
            </p>
          </div>
        )
      )}
    </div>
  );
}
