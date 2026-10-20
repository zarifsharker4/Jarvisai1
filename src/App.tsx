import { useEffect } from 'react';
import { useApp } from './state';
import { Login } from './components/Login';
import { Shell } from './components/Shell';
import { VecnaLogo } from './components/VecnaLogo';

export default function App() {
  const { ready, me, banner, setBanner } = useApp();

  // Drop stale query strings from old links rather than showing them.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.search) {
      url.search = '';
      window.history.replaceState({}, '', url.pathname + url.hash);
    }
  }, []);

  if (!ready) {
    return (
      <div className="boot">
        <div className="boot-mark vecna-boot">
          <VecnaLogo size={64} />
        </div>
        <div className="boot-text">Mind Flayer is coming online…</div>
      </div>
    );
  }

  return (
    <>
      {banner ? (
        <div className="top-banner" role="status">
          <span>{banner}</span>
          <button className="banner-close" onClick={() => setBanner(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}
      {me ? <Shell /> : <Login />}
    </>
  );
}
