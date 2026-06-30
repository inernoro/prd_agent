// 极简鉴权上下文：JWT 存 sessionStorage，未登录跳登录页。
import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { clearSession, getStoredUser, isAuthed, login as apiLogin, setSession } from './api';
import type { ApiResponse, LoginResult } from './types';

type AuthState = {
  authed: boolean;
  user: { username?: string; displayName?: string } | null;
  login: (username: string, password: string) => Promise<ApiResponse<LoginResult>>;
  logout: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState<boolean>(() => isAuthed());
  const [user, setUser] = useState(() => getStoredUser());

  const value = useMemo<AuthState>(
    () => ({
      authed,
      user,
      async login(username: string, password: string) {
        const res = await apiLogin({ username, password });
        if (res.success && res.data?.token) {
          setSession(res.data);
          setUser(getStoredUser());
          setAuthed(true);
        }
        return res;
      },
      logout() {
        clearSession();
        setAuthed(false);
        setUser(null);
      },
    }),
    [authed, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}
