import { useEffect } from 'react';
import { useApp } from './state';
import { Login } from './components/Login';
import { Shell } from './components/Shell';

export default function App() {
  const { ready, me, banner, setBanner } = useApp();

  const authError = new URLSearchParams(window.location.search).get('auth_error');
  useEffect(() => {
    if (authError) {
      const clean = window.location.pathname + window.location.hash;
      window.history.replaceState({}, '', clean);
    }
  }, [authError]);

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-mark">J</div>
        <div className="boot-text">Mind Flayer is coming online…</div>
      </div>
    );
  }

  const notice = authError ? describeAuthError(authError) : banner;

  return (
    <>
      {notice ? (
        <div className="top-banner" role="status">
          <span>{notice}</span>
          <button className="banner-close" onClick={() => setBanner(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}
      {me ? <Shell /> : <Login />}
    </>
  );
}

function describeAuthError(code: string): string {
  switch (code) {
    case 'not_configured':
      return 'Google sign-in is not configured yet — add your Google OAuth client ID in Settings → Authentication.';
    case 'state':
      return 'Google sign-in could not be verified (expired or reused link). Please try again.';
    case 'denied':
      return 'Google sign-in was cancelled or denied.';
    case 'unavailable':
      return 'Authentication service is temporarily unavailable.';
    default:
      return `Sign-in failed: ${decodeURIComponent(code)}`;
  }
}
