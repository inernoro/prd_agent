// 极简鉴权上下文：JWT 存 sessionStorage，未登录跳登录页；首登强制改密门。
import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  applyChangePasswordResult,
  changePassword as apiChangePassword,
  clearSession,
  getStoredUser,
  isAuthed,
  login as apiLogin,
  mustChangePassword as readMustChangePassword,
  setSession,
} from './api';
import type { ApiResponse, ChangePasswordResult, LoginResult } from './types';

type AuthState = {
  authed: boolean;
  user: { username?: string; displayName?: string } | null;
  /** 首登强制改密：为 true 时守卫强制跳 /change-password，改密成功前不放行日志页。 */
  mustChangePassword: boolean;
  login: (username: string, password: string) => Promise<ApiResponse<LoginResult>>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<ApiResponse<ChangePasswordResult>>;
  logout: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState<boolean>(() => isAuthed());
  const [user, setUser] = useState(() => getStoredUser());
  const [mustChange, setMustChange] = useState<boolean>(() => readMustChangePassword());

  const value = useMemo<AuthState>(
    () => ({
      authed,
      user,
      mustChangePassword: mustChange,
      async login(username: string, password: string) {
        const res = await apiLogin({ username, password });
        if (res.success && res.data?.token) {
          setSession(res.data);
          setUser(getStoredUser());
          setMustChange(readMustChangePassword());
          setAuthed(true);
        }
        return res;
      },
      async changePassword(oldPassword: string, newPassword: string) {
        const res = await apiChangePassword({ oldPassword, newPassword });
        if (res.success && res.data?.token) {
          applyChangePasswordResult(res.data);
          setUser(getStoredUser());
          setMustChange(false);
        }
        return res;
      },
      logout() {
        clearSession();
        setAuthed(false);
        setUser(null);
        setMustChange(false);
      },
    }),
    [authed, user, mustChange],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}
