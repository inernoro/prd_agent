import { useEffect, useState } from 'react';
import { KeyRound, LogOut, ShieldCheck, ShieldOff } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';
import { CodePill, ErrorBlock, Field, LoadingBlock, Section } from '../components';
import type { AuthStatusResponse, LoadState } from '../types';

function loginHref(mode?: string): string {
  const file = mode === 'github' ? 'login-gh.html' : 'login.html';
  if (window.location.port === '5173') {
    return `${window.location.protocol}//${window.location.hostname}:9900/${file}`;
  }
  return `/${file}`;
}

function authModeLabel(mode?: string): string {
  if (mode === 'github') return 'GitHub OAuth';
  if (mode === 'basic') return '账号密码';
  if (mode === 'disabled') return '未启用';
  return mode || 'unknown';
}

export function AuthTab(): JSX.Element {
  const [state, setState] = useState<LoadState<AuthStatusResponse>>({ status: 'loading' });
  const [logoutState, setLogoutState] = useState<'idle' | 'running' | 'error'>('idle');
  const [logoutError, setLogoutError] = useState('');

  useEffect(() => {
    const ctrl = new AbortController();
    apiRequest<AuthStatusResponse>('/api/auth/status', { signal: ctrl.signal })
      .then((data) => setState({ status: 'ok', data }))
      .catch((err: unknown) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
      });
    return () => ctrl.abort();
  }, []);

  const logout = async (): Promise<void> => {
    if (state.status !== 'ok' || !state.data.logoutEndpoint) return;
    setLogoutState('running');
    setLogoutError('');
    try {
      await apiRequest(state.data.logoutEndpoint, { method: 'POST' });
      window.location.href = loginHref(state.data.mode);
    } catch (err) {
      setLogoutState('error');
      setLogoutError(err instanceof ApiError ? err.message : String(err));
    }
  };

  if (state.status === 'loading') return <LoadingBlock />;
  if (state.status === 'error') return <ErrorBlock message={state.message} />;

  const auth = state.data;
  const enabled = auth.enabled !== false && auth.mode !== 'disabled';
  const userName = auth.user?.githubLogin || auth.user?.username || auth.user?.name || (enabled ? '已登录用户' : '本地匿名访问');

  return (
    <Section
      title="登录与认证"
      description={
        <>
          CDS Dashboard 自身的访问控制与退出入口。持久配置仍写入 <code>cds/.cds.env</code>，修改后执行{' '}
          <code>./exec_cds.sh restart</code> 生效。
        </>
      }
    >
      <div className="space-y-5">
        <div
          className={
            enabled
              ? 'rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-4'
              : 'rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-4'
          }
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              {enabled ? (
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
              ) : (
                <ShieldOff className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
              )}
              <div className="min-w-0">
                <div className="font-medium">{enabled ? '认证已启用' : '本地开发模式：认证未启用'}</div>
                <div className="mt-1 text-sm leading-6 text-muted-foreground">
                  当前模式 <CodePill>{authModeLabel(auth.mode)}</CodePill>
                  {enabled ? (
                    <>
                      ，当前用户 <CodePill>{userName}</CodePill>
                    </>
                  ) : (
                    '，适合本地预览和自动化验收。生产环境应启用 GitHub OAuth 或账号密码。'
                  )}
                </div>
              </div>
            </div>
            {auth.logoutEndpoint ? (
              <Button
                type="button"
                variant="outline"
                disabled={logoutState === 'running'}
                onClick={() => void logout()}
              >
                <LogOut />
                {logoutState === 'running' ? '退出中' : '退出登录'}
              </Button>
            ) : null}
          </div>
          {logoutState === 'error' ? (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {logoutError || '退出失败'}
            </div>
          ) : null}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="模式">
            <CodePill>{auth.mode || 'unknown'}</CodePill>
          </Field>
          <Field label="退出接口">
            <CodePill>{auth.logoutEndpoint || '无需退出'}</CodePill>
          </Field>
        </div>

        <div className="rounded-md border border-border bg-card px-4 py-4">
          <div className="flex items-start gap-3 text-sm leading-6 text-muted-foreground">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              账号密码模式使用 <code>CDS_USERNAME</code> / <code>CDS_PASSWORD</code>；GitHub OAuth 使用{' '}
              <code>CDS_GITHUB_CLIENT_ID</code> / <code>CDS_GITHUB_CLIENT_SECRET</code> /{' '}
              <code>CDS_ALLOWED_ORGS</code>。这些变量由初始化流程或运维脚本写入环境文件，页面只负责查看状态和退出当前会话。
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}
