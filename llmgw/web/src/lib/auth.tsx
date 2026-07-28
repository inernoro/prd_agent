// 极简鉴权上下文：JWT 存 sessionStorage，未登录跳登录页；首登强制改密门。
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  applyChangePasswordResult,
  changePassword as apiChangePassword,
  clearSession,
  expireSession,
  exportSessionSnapshot,
  getSessionExpiresAt,
  getStoredUser,
  getStoredTenant,
  importSessionSnapshot,
  isAuthed,
  login as apiLogin,
  exchangeMapSso,
  mustChangePassword as readMustChangePassword,
  onSessionExpired,
  setSession,
} from './api';
import type { SessionExpiredReason } from './api';
import type { ApiResponse, ChangePasswordResult, LoginResult, TenantSession } from './types';

type AuthState = {
  authed: boolean;
  initializing: boolean;
  user: { username?: string; displayName?: string; identityProvider?: string } | null;
  tenant: TenantSession | null;
  /** 首登强制改密：为 true 时守卫强制跳 /change-password，改密成功前不放行日志页。 */
  mustChangePassword: boolean;
  /** 上一次会话是被动失效（过期/吊销）而非主动退出；登录页据此提示原因。 */
  sessionExpiredReason: SessionExpiredReason | null;
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
  const [expiredReason, setExpiredReason] = useState<SessionExpiredReason | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  // 会话失效的唯一落地点：翻 authed → 路由守卫立刻把用户送回登录页。
  // 以前这里没有订阅，api 层清了 sessionStorage 但 React 状态还停在「已登录」，
  // 于是页面永远卡在「登录已失效，请重新登录」而不跳转。
  const applyExpired = useCallback((reason: SessionExpiredReason) => {
    setAuthed(false);
    setUser(null);
    setTenant(null);
    setMustChange(false);
    setInitializing(false);
    setExpiredReason(reason);
  }, []);

  useEffect(() => onSessionExpired((reason) => {
    applyExpired(reason);
    // 同一浏览器的其他标签页共享同一份会话，必须一起下线。
    channelRef.current?.postMessage({ type: 'expired', reason });
  }), [applyExpired]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') {
      setInitializing(false);
      return undefined;
    }

    const channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
    channelRef.current = channel;
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => setInitializing(false), 700);
    channel.onmessage = (event: MessageEvent<{
      type?: string;
      reason?: SessionExpiredReason;
      requestId?: string;
      snapshot?: ReturnType<typeof exportSessionSnapshot>;
    }>) => {
      if (event.data?.type === 'request') {
        const snapshot = exportSessionSnapshot();
        if (snapshot) channel.postMessage({ type: 'response', requestId: event.data.requestId, snapshot });
        return;
      }

      // 其他标签页已失效：本页同步下线，但不再回广播，避免标签页之间来回弹。
      if (event.data?.type === 'expired') {
        clearSession();
        applyExpired(event.data.reason || 'expired');
        return;
      }

      if (event.data?.type !== 'response'
        || event.data.requestId !== requestId
        || !event.data.snapshot
        || isAuthed())
        return;

      if (!importSessionSnapshot(event.data.snapshot)) return;
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
      channelRef.current = null;
    };
  }, [applyExpired]);

  // 主动过期：到点就下线，不必等用户点一下、撞一次 401 才知道自己已经登出。
  // 定时器在系统休眠时可能延迟，故补一条「标签页重新可见时复查」。
  useEffect(() => {
    if (!authed) return undefined;
    const expiresAt = getSessionExpiresAt();
    if (expiresAt === null) return undefined;

    const fire = () => expireSession('expired');
    const delay = expiresAt - Date.now();
    if (delay <= 0) {
      fire();
      return undefined;
    }

    const timer = window.setTimeout(fire, Math.min(delay, 2 ** 31 - 1));
    const recheck = () => {
      if (document.visibilityState === 'visible' && Date.now() >= expiresAt) fire();
    };
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('focus', recheck);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('focus', recheck);
    };
  }, [authed]);

  const value = useMemo<AuthState>(
    () => ({
      authed,
      initializing,
      user,
      tenant,
      mustChangePassword: mustChange,
      sessionExpiredReason: expiredReason,
      async login(username: string, password: string) {
        const res = await apiLogin({ username, password });
        if (res.success && res.data?.token) {
          setSession(res.data);
          setUser(getStoredUser());
          setTenant(getStoredTenant());
          setMustChange(readMustChangePassword());
          setAuthed(true);
          setInitializing(false);
          setExpiredReason(null);
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
          setExpiredReason(null);
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
        // 主动退出不是「过期」，登录页不该弹过期提示。
        setExpiredReason(null);
      },
    }),
    [authed, initializing, user, tenant, mustChange, expiredReason],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}
