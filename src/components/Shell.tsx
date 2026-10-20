import { useState } from 'react';
import { useApp } from '../state';
import type { TabId } from '../types';
import { VecnaChat } from './VecnaChat';
import { Hellfire } from './Hellfire';
import { ApiManager } from './ApiManager';
import { Projects } from './Projects';
import { FieldShowcase } from './Field';
import { Cerebro } from './Cerebro';
import { Settings } from './Settings';
import { PinGate } from './PinGate';
import { Onboarding } from './Onboarding';
import { VecnaLogo } from './VecnaLogo';

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

/** The six navigation destinations — sidebar rail on desktop, bottom bar on phones. */
export const NAV_ITEMS: Array<{ id: TabId; icon: string; label: string; short: string }> = [
  { id: 'vecna', icon: '◉', label: 'Vecna Chat', short: 'Vecna' },
  { id: 'hellfire', icon: '🔥', label: 'Hellfire · File IDE', short: 'Hellfire' },
  { id: 'manager', icon: '⌘', label: 'API & Field Manager', short: 'APIs' },
  { id: 'projects', icon: '🗂', label: 'Project Switcher', short: 'Projects' },
  { id: 'field', icon: '✦', label: 'The Field', short: 'Field' },
  { id: 'cerebro', icon: '☰', label: 'Cerebro Search', short: 'Cerebro' },
];

const TAB_TITLES: Record<TabId, string> = {
  vecna: 'Vecna · Supreme Guide',
  hellfire: 'Hellfire · Group Chat & Mobile IDE',
  manager: 'API & Field Manager',
  projects: 'Project Switcher',
  field: 'The Field · Showcase',
  cerebro: 'Cerebro · Custom App Browser',
};

export function Shell() {
  const {
    me,
    chats,
    activeChatId,
    setActiveChatId,
    theme,
    setTheme,
    signOut,
    requestUnlock,
    refreshChats,
    activeTab,
    setActiveTab,
    activeProjectId,
    projects,
  } = useApp();
  const [showSettings, setShowSettings] = useState(false);

  const openChat = (id: string, mode: string) => {
    setActiveChatId(id);
    setActiveTab(mode === 'hellfire' ? 'hellfire' : 'vecna');
  };

  const newChat = async () => {
    setActiveChatId(null);
    setActiveTab('vecna');
    await refreshChats().catch(() => undefined);
  };

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand-mark small vecna-mark">
            <VecnaLogo size={30} className="brand-icon-small" />
          </div>
          <div>
            <div className="brand-name small">Mind Flayer</div>
            <div className="brand-sub">{project ? project.name : 'Workspace'}</div>
          </div>
        </div>

        {/* Six-button sidebar navigation */}
        <nav className="nav-rail" aria-label="Main sections">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`nav-rail-btn ${activeTab === item.id ? 'active' : ''}`}
              onClick={() => setActiveTab(item.id)}
              title={item.label}
            >
              <span className="nav-rail-icon" aria-hidden>
                {item.icon}
              </span>
              <span className="nav-rail-label">{item.label}</span>
            </button>
          ))}
        </nav>

        <button className="btn btn-primary new-chat" onClick={() => void newChat()}>
          + New Vecna session
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
                onClick={() => openChat(chat.id, chat.mode)}
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
              <div className="user-mail">{me?.email ?? 'email account'}</div>
            </div>
          </div>
          <div className="sidebar-foot-actions">
            <button className="btn btn-ghost btn-sm" onClick={() => setShowSettings(true)}>
              ⚙ Settings
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <span className="topbar-tab-icon" aria-hidden>
              {NAV_ITEMS.find((n) => n.id === activeTab)?.icon}
            </span>
            <strong>{TAB_TITLES[activeTab]}</strong>
            {project ? <span className="proj-chip">{project.name}</span> : null}
          </div>
          <div className="topbar-right">
            <span className="tag-badge">{me?.tag}</span>
          </div>
        </header>

        <div className="content">
          {activeTab === 'vecna' ? <VecnaChat /> : null}
          {activeTab === 'hellfire' ? <Hellfire /> : null}
          {activeTab === 'manager' ? <ApiManager /> : null}
          {activeTab === 'projects' ? <Projects /> : null}
          {activeTab === 'field' ? <FieldShowcase /> : null}
          {activeTab === 'cerebro' ? <Cerebro /> : null}
        </div>
      </main>

      {/* Bottom navigation for phones / narrow screens */}
      <nav className="bottom-nav" aria-label="Main sections">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            className={`bottom-nav-btn ${activeTab === item.id ? 'active' : ''}`}
            onClick={() => setActiveTab(item.id)}
          >
            <span className="bottom-nav-icon" aria-hidden>
              {item.icon}
            </span>
            <span className="bottom-nav-label">{item.short}</span>
          </button>
        ))}
      </nav>

      {showSettings ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Settings">
          <div className="modal settings-modal">
            <button className="modal-close" onClick={() => setShowSettings(false)} aria-label="Close settings">
              ×
            </button>
            <Settings />
          </div>
        </div>
      ) : null}

      <Onboarding />
      <PinGate />
    </div>
  );
}
