import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setCsrf, type AppConfig } from '../lib/api';

export interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
}
interface Ctx {
  user: User | null;
  ready: boolean;
  config: AppConfig | null;
  allowRegistration: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshConfig: () => Promise<void>;
}

const AuthCtx = createContext<Ctx>(null!);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [allowRegistration, setAllowRegistration] = useState(true);

  const refreshConfig = useCallback(async () => {
    try {
      setConfig(await api<AppConfig>('/api/config'));
    } catch {
      /* surfaced by pages that need it */
    }
  }, []);

  useEffect(() => {
    (async () => {
      await Promise.all([
        refreshConfig(),
        api<{ user: User | null; csrfToken: string | null; allowRegistration: boolean }>('/api/auth/me')
          .then((r) => {
            setUser(r.user);
            setCsrf(r.csrfToken);
            setAllowRegistration(r.allowRegistration);
          })
          .catch(() => undefined),
      ]);
      setReady(true);
    })();
  }, [refreshConfig]);

  const value = useMemo<Ctx>(
    () => ({
      user,
      ready,
      config,
      allowRegistration,
      refreshConfig,
      async login(email, password) {
        const r = await api<{ user: User; csrfToken: string }>('/api/auth/login', { method: 'POST', json: { email, password } });
        setCsrf(r.csrfToken);
        setUser(r.user);
      },
      async register(email, password) {
        const r = await api<{ user: User; csrfToken: string }>('/api/auth/register', { method: 'POST', json: { email, password } });
        setCsrf(r.csrfToken);
        setUser(r.user);
      },
      async logout() {
        await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
        setCsrf(null);
        setUser(null);
      },
    }),
    [user, ready, config, allowRegistration, refreshConfig],
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
