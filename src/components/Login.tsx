import { useApp } from '../state';

/** Mind Flayer archive-style landing + auth slide.
 *
 * Full-screen animated arc-reactor / HUD background. Google is the only
 * sign-in surface shown on the primary view. Freebuff sign-in references are
 * intentionally excluded from this screen.
 */
export function Login() {
  const { bootstrap } = useApp();
  const configured = bootstrap?.google?.configured ?? false;

  return (
    <div className="landing">
      {/* Animated HUD background */}
      <div className="landing-hud" aria-hidden>
        <div className="hud-grid" />
        <div className="hud-ring hud-ring-1" />
        <div className="hud-ring hud-ring-2" />
        <div className="hud-ring hud-ring-3" />
        <div className="arc-reactor">
          <div className="core-pulse" />
          <div className="core" />
          <div className="core-ring" />
          <div className="core-ring-2" />
          <div className="core-glow" />
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
          <div className="brand-mark" aria-hidden>
            <svg viewBox="0 0 48 48" className="brand-icon" aria-hidden="true">
              <defs>
                <radialGradient id="mfCoreSmall" cx="50%" cy="44%" r="60%">
                  <stop offset="0%" stopColor="#ff5c72" />
                  <stop offset="55%" stopColor="#c81d4a" />
                  <stop offset="100%" stopColor="#5a0018" />
                </radialGradient>
              </defs>
              <circle cx="24" cy="22" r="12" fill="url(#mfCoreSmall)" />
              <path d="M24 8 a16 16 0 0 1 16 16 v4 a10 10 0 0 0 -10 -10 z" fill="#ff9460" opacity="0.9" />
              <circle cx="24" cy="22" r="5" fill="#fff2f0" />
              <circle cx="24" cy="22" r="2.6" fill="#1b0308" />
            </svg>
          </div>
          <div>
            <h1 className="brand-name">Mind Flayer</h1>
            <p className="brand-sub">3-agent collaborative coding workspace</p>
          </div>
        </div>

        <p className="landing-copy">
          Orchestrator plans, Coder builds, Reviewer audits — together in chat, in the live
          AI-to-AI discussion space, and on a group voice call. Your history is protected by a
          PIN and your API keys stay encrypted on your own account.
        </p>

        <div className="landing-actions">
          <a className="btn btn-google btn-lg" href="/auth/google/start">
            <GoogleGlyph />
            <span>Sign in with Google</span>
          </a>
          <a className="btn btn-google-outline btn-lg" href="/auth/google/start">
            <GoogleGlyph />
            <span>Create Account with Google</span>
          </a>
        </div>

        <ul className="landing-points">
          <li className="point">
            <span className="point-icon" aria-hidden>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 7a4 4 0 1 1 8 0 4 4 0 0 1-8 0zm14 0a4 4 0 1 0 8 0 4 4 0 0 0-8 0zm-1 9a4 4 0 1 0 8 0v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a4 4 0 0 0-8 0v2a6 6 0 0 0 12 0v-2h2a2 2 0 0 0 2-2V16z" />
              </svg>
            </span>
            <span className="point-text">
              Unique <strong>@mindflayer-…</strong> tag for every account
            </span>
          </li>
          <li className="point">
            <span className="point-icon" aria-hidden>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2a7 7 0 0 0-7 7c0 2.1.9 4.1 2.5 5.5L7 22h10l-2.5-7.5A7 7 0 0 0 12 9a7 7 0 0 0 7-7zM9.5 14a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm4 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm.5 4a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" />
              </svg>
            </span>
            <span className="point-text">PIN-locked chat history</span>
          </li>
          <li className="point">
            <span className="point-icon" aria-hidden>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 3h9l4 4v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm10 2a2 2 0 1 1 4 0 2 2 0 0 1-4 0zm-2 7a2 2 0 1 1 4 0v3a6 6 0 0 1-12 0V12zm0 4a2 2 0 1 0 4 0 2 2 0 0 0-4 0z" />
              </svg>
            </span>
            <span className="point-text">Encrypted connectors — bring your own API keys</span>
          </li>
          <li className="point">
            <span className="point-icon" aria-hidden>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M20 6h-4V4a2 2 0 0 0-4 0v2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-6 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM4 8h8v9H4V8zm2 0v9h4V8H6zm8-3a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
              </svg>
            </span>
            <span className="point-text">Branded mail record for your account</span>
          </li>
        </ul>

        {configured ? null : (
          <div className="landing-note">
            <strong>Configure Google OAuth</strong>
            <p className="muted">
              Add your Google OAuth client ID and secret in Settings → Authentication to enable the
              Google sign-in flow.
            </p>
          </div>
        )}

        <p className="landing-foot">
          New here? Signing in creates your account automatically and mails you your tag.
        </p>
      </div>
    </div>
  );
}

/** Official Google "Sign in with Google" glyph: standard color G on white. */
function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.2 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"
      />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.2 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.2 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.6l6.2 5.2C36.9 40.2 44 35 44 24c0-1.3-.1-2.6-.4-3.9z" />
    </svg>
  );
}
