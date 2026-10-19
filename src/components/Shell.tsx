import { useState } from 'react';
import { useApp } from '../state';
import { Chat } from './Chat';
import { Call } from './Call';
import { Settings } from './Settings';
import { PinGate } from './PinGate';

type View = 'chat' | 'call' | 'settings';

export const THEMES = [
  { id: 'classic-dark', label: 'Classic Dark', swatch: '#5b8cff' },
  { id: 'stranger-things', label: 'Stranger Things', swatch: '#ff2d55' },
  { id: 'from-series', label: 'From Series', swatch: '#c9a227' },
  { id: 'arc-reactor', label: 'Arc Reactor', swatch: '#17d4ff' },
  { id: 'cyberpunk', label: 'Cyberpunk', swatch: '#ff009d' },
  { id: 'dracula', label: 'Dracula', swatch: '#bd93f9' },
  { id: 'monokai', label: 'Monokai', swatch: '#f92672' },
  { id: 'nord', label: 'Nord', swatch: '#88c0d0' },
  { id: 'gruvbox', label: 'Gruvbox', swatch: '#fabd2f' },
  { id: 'tokyo-night', label: 'Tokyo Night', swatch: '#70a5ff' },
  { id: 'one-dark-pro', label: 'One Dark Pro', swatch: '#a9b1d6' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha', swatch: '#f2cdcd' },
  { id: 'synthwave-84', label: 'Synthwave 84', swatch: '#f72585' },
  { id: 'matrix-green', label: 'Matrix Green', swatch: '#00ff41' },
  { id: 'solarized-dark', label: 'Solarized Dark', swatch: '#268bd2' },
  { id: 'github-dark', label: 'GitHub Dark', swatch: '#58a6ff' },
  { id: 'midnight-blue', label: 'Midnight Blue', swatch: '#4c7dff' },
  { id: 'emerald-abyss', label: 'Emerald Abyss', swatch: '#50c878' },
  { id: 'sunset-vibes', label: 'Sunset Vibes', swatch: '#ff6b6b' },
  { id: 'rose-pine', label: 'Rose Pine', swatch: '#f07178' },
  { id: 'palenight', label: 'Palenight', swatch: '#80aaff' },
  { id: 'mind-flayer-void', label: 'Mind Flayer Void', swatch: '#ff3b5c' },
  { id: 'vecna-curse', label: 'Vecna Curse', swatch: '#9d0208' },
  { id: 'obsidian-gold', label: 'Obsidian Gold', swatch: '#d4af37' },
  { id: 'titanium-glass', label: 'Titanium Glass', swatch: '#7f8c8d' },
] as const;

export function Shell() {
  const { me, chats, activeChatId, setActiveChatId, theme, setTheme, signOut, requestUnlock, refreshChats } =
    useApp();
  const [view, setView] = useState<View>('chat');

  const openChat = (id: string) => {
    setActiveChatId(id);
    setView('chat');
  };

  const newChat = async () => {
    setActiveChatId(null);
    setView('chat');
    await refreshChats().catch(() => undefined);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand-mark small">
            <svg viewBox="0 0 48 48" aria-hidden="true" className="brand-icon-small">
              <circle cx="24" cy="22" r="12" fill="currentColor" />
              <path d="M24 8 a16 16 0 0 1 16 16 v4 a10 10 0 0 0 -10 -10 z" fill="color-mix(in srgb, currentColor 60%, transparent)" />
              <circle cx="24" cy="22" r="5" fill="color-mix(in srgb, white 80%, transparent)" />
              <circle cx="24" cy="22" r="2.6" fill="color-mix(in srgb, black 70%, transparent)" />
            </svg>
          </div>
          <div>
            <div className="brand-name small">Mind Flayer</div>
            <div className="brand-sub">Collaborator</div>
          </div>
        </div>

        <button className="btn btn-primary new-chat" onClick={newChat}>
          + New session
        </button>

        <div className="sidebar-section-label">
          <span>History</span>
          <button className="icon-btn" onClick={requestUnlock} title="Unlock history" aria-label="Unlock history">
            🔒
          </button>
        </div>

        <nav className="chat-list" aria-label="Chat history">
          {chats.length === 0 ? (
            <div className="empty-hint">
              {me?.pinEnabled ? 'History locked — tap 🔒 to unlock.' : 'No sessions yet. Start one above.'}
            </div>
          ) : (
            chats.map((chat) => (
              <button
                key={chat.id}
                className={`chat-item ${activeChatId === chat.id ? 'active' : ''}`}
                onClick={() => openChat(chat.id)}
              >
                <span className="chat-title">{chat.title || 'Untitled'}</span>
                <span className="chat-meta">
                  <span className={`mode-chip mode-${chat.mode}`}>{chat.mode}</span>
                  {chat.locked ? <span title="PIN-protected">🔒</span> : null}
                </span>
              </button>
            ))
          )}
        </nav>

        <div className="sidebar-section-label">
          <span>Theme</span>
        </div>
        <div className="theme-list" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={theme === t.id}
              className={`theme-item ${theme === t.id ? 'active' : ''}`}
              onClick={() => setTheme(t.id)}
            >
              <span className="theme-dot" style={{ background: t.swatch }} />
              <span className="theme-label">{t.label}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-foot">
          <div className="user-chip">
            <div className="avatar">{(me?.tag ?? 'MF').slice(-2).toUpperCase()}</div>
            <div className="user-lines">
              <div className="user-tag">{me?.tag}</div>
              <div className="user-mail">{me?.email ?? me?.provider}</div>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <nav className="tabs" aria-label="Primary">
            <button className={`tab ${view === 'chat' ? 'active' : ''}`} onClick={() => setView('chat')}>
              Chat
            </button>
            <button className={`tab ${view === 'call' ? 'active' : ''}`} onClick={() => setView('call')}>
              📞 Call Mind Flayer
            </button>
            <button className={`tab ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}>
              ⚙ Settings
            </button>
          </nav>
          <div className="topbar-right">
            <span className="tag-badge">{me?.tag}</span>
          </div>
        </header>

        <div className="content">
          {view === 'chat' ? <Chat /> : null}
          {view === 'call' ? <Call /> : null}
          {view === 'settings' ? <Settings /> : null}
        </div>
      </main>

      <PinGate />
    </div>
  );
}
