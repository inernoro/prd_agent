import { useEffect, useState } from 'react';
import { Bot, KeyRound, LogOut, ShieldCheck, ShieldOff } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  apiRequest,
  ApiError,
  fetchTicketSsoConfig,
  updateTicketSsoConfig,
  type TicketSsoConfig,
} from '@/lib/api';
import { requestAgentAccess } from '@/lib/agent-onboarding';
import { CodePill, ErrorBlock, Field, LoadingBlock, Section } from '../components';
import type { AuthStatusResponse, LoadState } from '../types';

function loginHref(mode?: string): string {
  const path = mode === 'github' ? '/api/auth/github/login' : '/login';
  if (window.location.port === '5173') {
    return `${window.location.protocol}//${window.location.hostname}:9900${path}`;
  }
  return path;
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
  const [sso, setSso] = useState<TicketSsoConfig | null>(null);
  const [ssoSecret, setSsoSecret] = useState('');
  const [ssoSaveState, setSsoSaveState] = useState<'idle' | 'running' | 'saved' | 'error'>('idle');
  const [ssoSaveError, setSsoSaveError] = useState('');

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

  useEffect(() => {
    let alive = true;
    fetchTicketSsoConfig()
      .then((config) => { if (alive) setSso(config); })
      .catch(() => { if (alive) setSso(null); });
    return () => { alive = false; };
  }, []);

  const saveSso = async (): Promise<void> => {
    if (!sso) return;
    setSsoSaveState('running');
    setSsoSaveError('');
    try {
      const saved = await updateTicketSsoConfig({
        enabled: sso.enabled,
        providerId: sso.providerId,
        label: sso.label,
        authorizationUrl: sso.authorizationUrl,
        tokenUrl: sso.tokenUrl,
        clientId: sso.clientId,
        clientSecret: ssoSecret || undefined,
        defaultRedirect: sso.defaultRedirect || '/project-list',
      });
      setSso(saved);
      setSsoSecret('');
      setSsoSaveState('saved');
    } catch (err) {
      setSsoSaveState('error');
      setSsoSaveError(err instanceof ApiError ? err.message : String(err));
    }
  };

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

        <div
          className="rounded-md border border-border bg-card px-4 py-4"
          data-agent-capability="auth.sso.configure"
          data-agent-secret-policy="protected-input-only"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="font-medium">单点登录提供方</div>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                CDS 使用通用一次性票据协议，不识别具体平台，可连接任意实现该协议的可信身份入口。
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={sso?.enabled === true}
                disabled={!sso}
                onChange={(event) => setSso((current) => current ? { ...current, enabled: event.target.checked } : current)}
              />
              允许 SSO 登录
            </label>
          </div>

          <div className="mt-4 flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <Bot className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div>
                <div className="text-sm font-medium text-foreground">不需要先学习 SSO 协议</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Agent 会读取脱敏状态、准备回调与票据配置并完成验证。客户端密钥只在受保护的输入框中填写。
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              className="shrink-0 border-primary/35 text-primary hover:text-foreground"
              onClick={() => requestAgentAccess('auth')}
            >
              <Bot />
              交给 Agent 配置
            </Button>
          </div>

          {sso ? (
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {([
                ['providerId', '提供方标识', 'corporate-sso'],
                ['label', '登录按钮名称', '使用公司账号登录'],
                ['authorizationUrl', '授权地址', 'https://portal.example.com/sso/authorize'],
                ['tokenUrl', '换票地址', 'https://portal.example.com/api/sso/token'],
                ['clientId', '客户端标识', 'cds-console'],
                ['defaultRedirect', '登录后默认页面', '/project-list'],
              ] as const).map(([key, label, placeholder]) => (
                <label key={key} className={key === 'authorizationUrl' || key === 'tokenUrl' ? 'md:col-span-2' : ''}>
                  <span className="mb-1.5 block text-sm text-muted-foreground">{label}</span>
                  <input
                    className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                    value={sso[key]}
                    placeholder={placeholder}
                    onChange={(event) => setSso((current) => current ? { ...current, [key]: event.target.value } : current)}
                  />
                </label>
              ))}
              <label className="md:col-span-2">
                <span className="mb-1.5 block text-sm text-muted-foreground">客户端密钥</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                  value={ssoSecret}
                  placeholder={sso.hasClientSecret ? '已安全保存，留空保持不变' : '输入客户端密钥'}
                  onChange={(event) => setSsoSecret(event.target.value)}
                />
              </label>
              <div className="flex items-center gap-3 md:col-span-2">
                <Button type="button" disabled={ssoSaveState === 'running'} onClick={() => void saveSso()}>
                  {ssoSaveState === 'running' ? '保存中' : '保存 SSO 配置'}
                </Button>
                {ssoSaveState === 'saved' ? <span className="text-sm text-emerald-500">配置已保存并立即生效</span> : null}
                {ssoSaveState === 'error' ? <span className="text-sm text-destructive">{ssoSaveError || '保存失败'}</span> : null}
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">当前会话无权读取 SSO 配置。</p>
          )}
        </div>
      </div>
    </Section>
  );
}
