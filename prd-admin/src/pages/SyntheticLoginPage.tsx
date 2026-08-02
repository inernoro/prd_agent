import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { MapSpinner } from '@/components/ui/VideoLoader';
import { getAdminAuthzMe, loginWithSyntheticTicket } from '@/services';
import { useAuthStore } from '@/stores/authStore';

const exchangeRequests = new Map<string, ReturnType<typeof loginWithSyntheticTicket>>();

function exchangeTicketOnce(ticket: string) {
  const existing = exchangeRequests.get(ticket);
  if (existing) return existing;
  const request = loginWithSyntheticTicket(ticket);
  exchangeRequests.set(ticket, request);
  return request;
}

function normalizeReturnUrl(value: string | null) {
  const path = (value || '/').trim();
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return '/';
  return path;
}

export default function SyntheticLoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const ticket = useMemo(() => searchParams.get('code') || '', [searchParams]);
  const returnUrl = useMemo(() => normalizeReturnUrl(searchParams.get('returnUrl')), [searchParams]);
  const [error, setError] = useState('');
  const setAuth = useAuthStore((state) => state.login);
  const setTokens = useAuthStore((state) => state.setTokens);
  const setPermissions = useAuthStore((state) => state.setPermissions);
  const setPermissionsLoaded = useAuthStore((state) => state.setPermissionsLoaded);
  const setIsRoot = useAuthStore((state) => state.setIsRoot);
  const setCdnBaseUrl = useAuthStore((state) => state.setCdnBaseUrl);
  const setPermFingerprint = useAuthStore((state) => state.setPermFingerprint);
  const logout = useAuthStore((state) => state.logout);

  useEffect(() => {
    let alive = true;
    setError('');
    window.history.replaceState({}, document.title, '/synthetic-login');
    if (!ticket) {
      setError('一次性登录入口已失效，请重新生成后再试。');
      return () => {
        alive = false;
      };
    }

    void exchangeTicketOnce(ticket)
      .then(async (response) => {
        if (!alive) return;
        if (!response.success) {
          setError(response.error?.message || '一次性登录入口已失效，请重新生成后再试。');
          return;
        }

        setAuth(response.data.user, response.data.accessToken);
        setTokens(response.data.accessToken, '', response.data.sessionKey);
        setPermissionsLoaded(false);
        const authz = await getAdminAuthzMe();
        if (!alive) return;
        if (!authz.success) {
          logout();
          setError('测试账号无权进入管理后台，请检查账号权限后重新生成入口。');
          return;
        }

        setPermissions(authz.data.effectivePermissions || []);
        setIsRoot(authz.data.isRoot ?? false);
        if (authz.data.cdnBaseUrl) setCdnBaseUrl(authz.data.cdnBaseUrl);
        if (authz.data.permissionFingerprint) setPermFingerprint(authz.data.permissionFingerprint);
        setPermissionsLoaded(true);
        navigate(returnUrl, { replace: true });
      })
      .catch(() => {
        if (alive) setError('合成测试登录服务暂时不可用，请稍后重新生成入口。');
      });

    return () => {
      alive = false;
    };
  }, [
    logout,
    navigate,
    returnUrl,
    setAuth,
    setCdnBaseUrl,
    setIsRoot,
    setPermFingerprint,
    setPermissions,
    setPermissionsLoaded,
    setTokens,
    ticket,
  ]);

  return (
    <main
      className="min-h-screen w-full flex items-center justify-center px-5"
      style={{ background: 'var(--bg-base)' }}
      data-testid="synthetic-login-page"
    >
      <section
        className="w-full max-w-md rounded-2xl p-7 text-center"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-default)',
          boxShadow: 'var(--shadow-raised)',
        }}
        role={error ? 'alert' : 'status'}
        aria-live="polite"
      >
        <div
          className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl"
          style={{
            background: 'rgba(var(--accent-primary-rgb), 0.14)',
            color: 'var(--accent-primary)',
          }}
        >
          {error ? <ShieldCheck size={22} /> : <MapSpinner size={22} />}
        </div>
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
          {error ? '合成测试登录未完成' : '正在建立测试会话'}
        </h1>
        <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-muted)' }}>
          {error || '正在校验一次性入口并加载账号权限，完成后会自动打开目标页面。'}
        </p>
        <p className="mt-3 text-xs leading-5" style={{ color: 'var(--text-subtle)' }}>
          测试会话最长保留 30 分钟，不能续期。
        </p>
      </section>
    </main>
  );
}
