import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, api, getPinToken, setPinToken } from './api';
import type { Bootstrap, ChatSummary, Me, Project, TabId } from './types';

type AppState = {
  ready: boolean;
  bootstrap: Bootstrap | null;
  me: Me | null;
  chats: ChatSummary[];
  activeChatId: string | null;
  setActiveChatId: (id: string | null) => void;
  chatsLocked: boolean;
  pinDialog: boolean;
  requestUnlock: () => void;
  closePin: () => void;
  unlock: (pin: string) => Promise<void>;
  banner: string | null;
  setBanner: (value: string | null) => void;
  theme: string;
  setTheme: (theme: string) => void;
  patchMe: (patch: Partial<Me>) => void;
  projects: Project[];
  activeProjectId: string | null;
  setActiveProjectId: (id: string | null) => void;
  refreshProjects: () => Promise<void>;
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  refreshChats: () => Promise<void>;
  refreshSession: () => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}

const THEME_KEY = 'mindflayer_theme';
const PROJECT_KEY = 'mindflayer_project';

function loadActiveProject(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatsLocked, setChatsLocked] = useState(false);
  const [pinDialog, setPinDialog] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(() => loadActiveProject());
  const [activeTab, setActiveTab] = useState<TabId>('vecna');
  const [theme, setThemeState] = useState(() => {
    try {
      return localStorage.getItem(THEME_KEY) ?? 'classic';
    } catch {
      return 'classic';
    }
  });

  const refreshChats = useCallback(async () => {
    try {
      const res = await api<{ chats: ChatSummary[] }>('/api/chats');
      setChats(res.chats);
      setChatsLocked(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 423) {
        setChatsLocked(true);
        setChats([]);
      }
    }
  }, []);

  /** Load every isolated workspace; keeps the remembered selection valid. */
  const refreshProjects = useCallback(async () => {
    try {
      const res = await api<{ projects: Project[] }>('/api/projects');
      setProjects(res.projects);
      setActiveProjectIdState((current) => {
        if (current && res.projects.some((p) => p.id === current)) return current;
        return res.projects[0]?.id ?? null;
      });
    } catch {
      /* signed out or locked — the switcher renders its own empty state */
    }
  }, []);

  const setActiveProjectId = useCallback((id: string | null) => {
    setActiveProjectIdState(id);
    try {
      if (id) localStorage.setItem(PROJECT_KEY, id);
      else localStorage.removeItem(PROJECT_KEY);
    } catch {
      /* private mode */
    }
  }, []);

  /** Pull the account behind the current session cookie (also used after OTP verify). */
  const refreshSession = useCallback(async () => {
    try {
      const session = await api<{ user: Me }>('/api/me');
      setMe(session.user);
      const nextTheme = session.user.theme || 'mind-flayer-void';
      applyTheme(nextTheme);
      setThemeState(nextTheme);
      await refreshChats();
      void refreshProjects();
      return;
    } catch (err) {
      setMe(null);
      if (err instanceof ApiError && err.status !== 401) setBanner(err.message);
      throw err;
    }
  }, [refreshChats, refreshProjects]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const boot = await api<Bootstrap>('/api/bootstrap');
        if (cancelled) return;
        setBootstrap(boot);
      } catch {
        /* bootstrap is best-effort */
      }
      try {
        await refreshSession();
      } catch {
        const saved = document.documentElement.dataset.theme;
        if (saved) applyTheme(saved);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshSession]);

  const setTheme = useCallback(
    (next: string) => {
      setThemeState(next);
      applyTheme(next);
      if (me) {
        void api('/api/me', { method: 'PATCH', body: { theme: next } }).catch(() => undefined);
        setMe((prev) => (prev ? { ...prev, theme: next } : prev));
      }
    },
    [me],
  );

  const patchMe = useCallback((patch: Partial<Me>) => {
    setMe((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const unlock = useCallback(
    async (pin: string) => {
      const res = await api<{ token: string }>('/api/pin/verify', { body: { pin } });
      setPinToken(res.token);
      setPinDialog(false);
      await refreshChats();
    },
    [refreshChats],
  );

  const requestUnlock = useCallback(() => setPinDialog(true), []);
  const closePin = useCallback(() => setPinDialog(false), []);

  const signOut = useCallback(async () => {
    try {
      await api('/api/auth/signout', { method: 'POST', body: {} });
    } catch {
      /* the cookie may already be gone */
    }
    setPinToken(null);
    setMe(null);
    setChats([]);
    setActiveChatId(null);
    setProjects([]);
    setActiveProjectIdState(null);
  }, []);

  const value = useMemo<AppState>(
    () => ({
      ready,
      bootstrap,
      me,
      chats,
      activeChatId,
      setActiveChatId,
      chatsLocked,
      pinDialog,
      requestUnlock,
      closePin,
      unlock,
      banner,
      setBanner,
      theme,
      setTheme,
      patchMe,
      projects,
      activeProjectId,
      setActiveProjectId,
      refreshProjects,
      activeTab,
      setActiveTab,
      refreshChats,
      refreshSession,
      signOut,
    }),
    [
      ready,
      bootstrap,
      me,
      chats,
      activeChatId,
      chatsLocked,
      pinDialog,
      requestUnlock,
      closePin,
      unlock,
      banner,
      theme,
      setTheme,
      patchMe,
      projects,
      activeProjectId,
      setActiveProjectId,
      refreshProjects,
      activeTab,
      setActiveTab,
      refreshChats,
      refreshSession,
      signOut,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export { getPinToken };
