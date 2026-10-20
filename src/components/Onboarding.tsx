import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { useApp } from '../state';
import type { VecnaStatus } from '../types';
import { playConfigAlert } from '../ringtone';
import { VecnaLogo } from './VecnaLogo';

const DISMISS_KEY = 'mindflayer_vecna_onboard';

/**
 * First-login prompt: initialize Vecna (the Supreme Guide) with a Gemini API
 * key. Shown while no LLM key exists at all; dismissible, and re-openable
 * later from the API & Field Manager. The key is stored server-side,
 * AES-GCM encrypted, on a connector flagged as Vecna's own.
 */
export function Onboarding() {
  const { me, refreshChats } = useApp();
  const [status, setStatus] = useState<VecnaStatus | null>(null);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!me) return;
    api<VecnaStatus>('/api/vecna/status')
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [me, done]);

  const visible = Boolean(
    me && status && !status.configured && !status.hasAnyKey && !dismissed,
  );

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode */
    }
    setDismissed(true);
  };

  const initialize = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/connectors', {
        method: 'POST',
        body: {
          provider: 'google-ai-studio',
          name: 'Vecna',
          apiKey: trimmed,
          isVecna: true,
          isDefault: true,
        },
      });
      setDone(true);
      void refreshChats();
      window.setTimeout(() => {
        setDismissed(true);
      }, 2200);
    } catch (err) {
      playConfigAlert();
      setError(err instanceof ApiError ? err.message : 'Could not store that key');
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Initialize Vecna">
      <div className="modal onboard-modal">
        <div className="onboard-sigil" aria-hidden>
          <VecnaLogo size={72} />
        </div>
        {done ? (
          <>
            <h2>Vecna is awake.</h2>
            <p className="muted">
              Supreme Guide initialized on your Gemini key. The worker AIs stay separate — you
              assign those in the Project Switcher.
            </p>
            <button className="btn btn-primary" onClick={dismiss}>
              Enter the workspace
            </button>
          </>
        ) : (
          <>
            <h2>Initialize Vecna</h2>
            <p className="muted">
              First things first: Vecna, your Supreme Guide, runs on its own Gemini key — always
              active, never mixed up with the worker AIs. Paste a Google AI Studio key to wake it.
            </p>
            <form className="auth-form" onSubmit={(e) => void initialize(e)}>
              <label className="field">
                <span>Gemini API key</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  placeholder="AIza..."
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
              </label>
              {error ? <div className="form-error">{error}</div> : null}
              <button className="btn btn-primary btn-lg" type="submit" disabled={busy || !key.trim()}>
                {busy ? 'Waking Vecna…' : 'Wake Vecna'}
              </button>
            </form>
            <div className="onboard-links">
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer noopener">
                Get a free Gemini key →
              </a>
              <button className="link-btn" type="button" onClick={dismiss}>
                Skip — I'll add keys later
              </button>
            </div>
            <p className="muted small">
              Stored encrypted, server-side. You can add unlimited keys from any provider later in
              the API & Field Manager.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
