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
import type { Bootstrap, ChatSummary, Me } from './types';

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
  refreshChats: () => Promise<void>;
  signOut: () => void;
};

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}

const THEME_KEY = 'mindflayer_theme';

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
        const session = await api<{ user: Me }>('/api/me');
        if (cancelled) return;
        setMe(session.user);
        applyTheme(session.user.theme || 'mind-flayer-void');
        setThemeState(session.user.theme || 'mind-flayer-void');
        await refreshChats();
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status !== 401) {
          setBanner(err.message);
        }
        const saved = document.documentElement.dataset.theme;
        if (saved) applyTheme(saved);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshChats]);

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
    const provider = me?.provider;
    try {
      await api('/api/auth/google/signout', { method: 'POST', body: {} });
    } catch {
      /* no google session */
    }
    setPinToken(null);
    if (provider === 'google') {
      window.location.href = '/';
      return;
    }
    const form = document.createElement('form');
    form.method = 'post';
    form.action = '/auth/signout';
    document.body.appendChild(form);
    form.submit();
  }, [me]);

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
      refreshChats,
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
      refreshChats,
      signOut,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export { getPinToken };
