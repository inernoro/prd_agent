// 极简鉴权上下文：JWT 存 sessionStorage，未登录跳登录页；首登强制改密门。
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  applyChangePasswordResult,
  changePassword as apiChangePassword,
  clearSession,
  exportSessionSnapshot,
  getStoredUser,
  getStoredTenant,
  importSessionSnapshot,
  isAuthed,
  login as apiLogin,
  exchangeMapSso,
  mustChangePassword as readMustChangePassword,
  setSession,
} from './api';
import type { ApiResponse, ChangePasswordResult, LoginResult, TenantSession } from './types';

type AuthState = {
  authed: boolean;
  initializing: boolean;
  user: { username?: string; displayName?: string; identityProvider?: string } | null;
  tenant: TenantSession | null;
  /** 首登强制改密：为 true 时守卫强制跳 /change-password，改密成功前不放行日志页。 */
  mustChangePassword: boolean;
  login: (username: string, password: string) => Promise<ApiResponse<LoginResult>>;
  loginWithMapCode: (code: string) => Promise<ApiResponse<LoginResult>>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<ApiResponse<ChangePasswordResult>>;
  logout: () => void;
};

const AuthContext = createContext<AuthState | null>(null);
const AUTH_CHANNEL_NAME = 'llmgw.auth.session.v1';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState<boolean>(() => isAuthed());
  const [initializing, setInitializing] = useState<boolean>(() => (
    !isAuthed() && typeof BroadcastChannel !== 'undefined'
  ));
  const [user, setUser] = useState(() => getStoredUser());
  const [tenant, setTenant] = useState(() => getStoredTenant());
  const [mustChange, setMustChange] = useState<boolean>(() => readMustChangePassword());

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') {
      setInitializing(false);
      return undefined;
    }

    const channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => setInitializing(false), 700);
    channel.onmessage = (event: MessageEvent<{
      type?: string;
      requestId?: string;
      snapshot?: ReturnType<typeof exportSessionSnapshot>;
    }>) => {
      if (event.data?.type === 'request') {
        const snapshot = exportSessionSnapshot();
        if (snapshot) channel.postMessage({ type: 'response', requestId: event.data.requestId, snapshot });
        return;
      }

      if (event.data?.type !== 'response'
        || event.data.requestId !== requestId
        || !event.data.snapshot
        || isAuthed())
        return;

      importSessionSnapshot(event.data.snapshot);
      setUser(getStoredUser());
      setTenant(getStoredTenant());
      setMustChange(readMustChangePassword());
      setAuthed(true);
      setInitializing(false);
      window.clearTimeout(timer);
    };

    if (!isAuthed()) channel.postMessage({ type: 'request', requestId });
    else setInitializing(false);

    return () => {
      window.clearTimeout(timer);
      channel.close();
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      authed,
      initializing,
      user,
      tenant,
      mustChangePassword: mustChange,
      async login(username: string, password: string) {
        const res = await apiLogin({ username, password });
        if (res.success && res.data?.token) {
          setSession(res.data);
          setUser(getStoredUser());
          setTenant(getStoredTenant());
          setMustChange(readMustChangePassword());
          setAuthed(true);
          setInitializing(false);
        }
        return res;
      },
      async loginWithMapCode(code: string) {
        const res = await exchangeMapSso({ code });
        if (res.success && res.data?.token) {
          setSession(res.data);
          setUser(getStoredUser());
          setTenant(getStoredTenant());
          setMustChange(readMustChangePassword());
          setAuthed(true);
          setInitializing(false);
        }
        return res;
      },
      async changePassword(oldPassword: string, newPassword: string) {
        const res = await apiChangePassword({ oldPassword, newPassword });
        if (res.success && res.data?.token) {
          applyChangePasswordResult(res.data);
          setUser(getStoredUser());
          setTenant(getStoredTenant());
          setMustChange(false);
        }
        return res;
      },
      logout() {
        clearSession();
        setAuthed(false);
        setUser(null);
        setTenant(null);
        setMustChange(false);
      },
    }),
    [authed, initializing, user, tenant, mustChange],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}
