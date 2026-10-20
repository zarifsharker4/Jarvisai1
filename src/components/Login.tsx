import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { useApp } from '../state';
import { VecnaLogo } from './VecnaLogo';

type Mode = 'login' | 'signup';

type CodeChallenge = {
  email: string;
  purpose: Mode;
  delivery: string;
  canDeliver: boolean;
  devCode?: string;
};

/** Mind Flayer archive-style landing + auth slide. */
export function Login() {
  const { bootstrap, refreshSession } = useApp();
  const sender = bootstrap?.auth?.senderName ?? 'Vecna from Mind Flayer';

  const [mode, setMode] = useState<Mode>('login');
  const [challenge, setChallenge] = useState<CodeChallenge | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => setCooldown((n) => (n <= 1 ? 0 : n - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const switchMode = (next: Mode) => {
    setMode(next);
    setChallenge(null);
    setCode('');
    setError(null);
    setNotice(null);
  };

  const startChallenge = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api<CodeChallenge>(`/api/auth/${mode}`, {
        method: 'POST',
        body: { email: email.trim(), password },
      });
      setChallenge(res);
      setCode('');
      setCooldown(60);
      setNotice(
        res.delivery === 'sent'
          ? `${sender} just sent your 6-digit code. It dies in 10 minutes.`
          : null,
      );
    } catch (err) {
      if (err instanceof ApiError && err.reason === 'exists') {
        setMode('login');
        setError('That email already has an account — enter your password to sign in.');
      } else if (err instanceof ApiError && err.status === 429) {
        setError(err.message);
        setCooldown(60);
      } else {
        setError(err instanceof ApiError ? err.message : 'Something went wrong');
      }
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/verify', {
        method: 'POST',
        body: { email: challenge.email, code, purpose: challenge.purpose },
      });
      await refreshSession();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify that code');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<CodeChallenge>('/api/auth/resend', {
        method: 'POST',
        body: { email: challenge.email, purpose: challenge.purpose },
      });
      setChallenge(res);
      setCooldown(60);
      setNotice(
        res.delivery === 'sent'
          ? 'New code sent. The old one is already dead.'
          : 'New code ready below — mail delivery is not configured yet.',
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not resend the code');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      {/* Animated HUD background */}
      <div className="landing-hud" aria-hidden>
        <div className="hud-grid" />
        <div className="hud-ring hud-ring-1" />
        <div className="hud-ring hud-ring-2" />
        <div className="hud-ring hud-ring-3" />
        <div className="vecna-hero">
          <VecnaLogo size={240} className="vecna-hero-sigil" />
        </div>
        <div className="hud-scan" />
        <div className="hud-corner top-left" aria-hidden />
        <div className="hud-corner top-right" aria-hidden />
        <div className="hud-corner bottom-left" aria-hidden />
        <div className="hud-corner bottom-right" aria-hidden />
        <div className="hud-tag" aria-hidden>MF · ARCHIVE</div>
      </div>

      {/* Foreground card */}
      <div className="landing-card">
        <div className="brand-block">
          <div className="brand-mark vecna-mark" aria-hidden>
            <VecnaLogo size={44} className="brand-icon" />
          </div>
          <div>
            <h1 className="brand-name">Mind Flayer</h1>
            <p className="brand-sub">3-agent collaborative coding workspace</p>
          </div>
        </div>

        {challenge ? (
          <>
            <button className="auth-back" type="button" onClick={() => setChallenge(null)}>
              ← Use a different email
            </button>

            <div className="auth-step">
              <div className="auth-step-head">
                <span className="auth-avatar" aria-hidden>
                  <VecnaLogo size={40} />
                </span>
                <div>
                  <div className="auth-sender">{sender}</div>
                  <div className="auth-sender-mail">vecna@mindflayer.ai</div>
                </div>
              </div>
              <h2 className="auth-title">Check your inbox</h2>
              <p className="auth-copy">
                I sent a 6-digit code to <strong>{challenge.email}</strong>. Type it below —
                it dies in 10 minutes, and the old one stops working the moment a new one is
                issued.
              </p>

              <form className="auth-form" onSubmit={verify}>
                <label className="field">
                  <span>6-digit code</span>
                  <input
                    className="input otp-input"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="\d{6}"
                    maxLength={6}
                    autoFocus
                    placeholder="000000"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  />
                </label>
                {error ? <div className="form-error">{error}</div> : null}
                {notice ? <div className="auth-notice">{notice}</div> : null}
                {challenge.devCode ? (
                  <div className="auth-devcode">
                    <strong>Mail delivery is not configured.</strong> Set{' '}
                    <code className="inline-code">KNOCK_API_KEY</code> to have Vecna actually send
                    this. Until then the code is{' '}
                    <span className="dev-code">{challenge.devCode}</span>
                  </div>
                ) : challenge.delivery !== 'sent' ? (
                  <div className="auth-devcode">
                    <strong>Vecna could not send the mail.</strong> Ask whoever runs this deployment
                    to set <code className="inline-code">KNOCK_API_KEY</code>; the message is waiting in
                    the server outbox.
                  </div>
                ) : null}
                <button
                  className="btn btn-primary btn-lg auth-submit"
                  type="submit"
                  disabled={busy || code.length !== 6}
                >
                  {busy ? 'Verifying…' : 'Verify & enter'}
                </button>
              </form>

              <div className="auth-links">
                <button
                  className="link-btn"
                  type="button"
                  onClick={() => void resend()}
                  disabled={busy || cooldown > 0}
                >
                  {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend the code'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="auth-switch" role="tablist" aria-label="Authentication">
              <button
                role="tab"
                aria-selected={mode === 'login'}
                className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
                onClick={() => switchMode('login')}
                type="button"
              >
                Sign in
              </button>
              <button
                role="tab"
                aria-selected={mode === 'signup'}
                className={`auth-tab ${mode === 'signup' ? 'active' : ''}`}
                onClick={() => switchMode('signup')}
                type="button"
              >
                Create account
              </button>
            </div>

            <p className="landing-copy">
              {mode === 'login'
                ? 'Email and password, then a 6-digit code from Vecna. No Google, no popups, no config screens.'
                : 'Pick an email and a password. Vecna mails you a 6-digit code to prove the address is yours.'}
            </p>

            <form className="auth-form" onSubmit={startChallenge}>
              <label className="field">
                <span>Email</span>
                <input
                  className="input"
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  className="input"
                  type="password"
                  name="password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required
                  minLength={mode === 'signup' ? 8 : undefined}
                  placeholder={mode === 'signup' ? 'at least 8 characters' : 'your password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              {error ? <div className="form-error">{error}</div> : null}
              <button className="btn btn-primary btn-lg auth-submit" type="submit" disabled={busy}>
                {busy ? 'One moment…' : mode === 'login' ? 'Send my code' : 'Create account & send code'}
              </button>
            </form>

            <ul className="landing-points">
              <li className="point">
                <span className="point-icon" aria-hidden>★</span>
                <span className="point-text">
                  Unique <strong>@mindflayer-…</strong> tag for every account
                </span>
              </li>
              <li className="point">
                <span className="point-icon" aria-hidden>◉</span>
                <span className="point-text">4-digit PIN lock on your chat history</span>
              </li>
              <li className="point">
                <span className="point-icon" aria-hidden>⌘</span>
                <span className="point-text">Encrypted connectors — bring your own API keys</span>
              </li>
            </ul>

            <p className="landing-foot">
              Codes come from <strong>{sender}</strong>
              {bootstrap?.auth?.mailConfigured ? '' : ' · mail delivery needs a provider key'}.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
