import { useEffect, useRef, useState } from 'react';
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
import { CodePill, ErrorBlock, LoadingBlock, Section } from '../components';
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
  if (mode === 'sso') return 'SSO';
  if (mode === 'disabled') return '未启用';
  return mode || 'unknown';
}

export function AuthTab(): JSX.Element {
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [state, setState] = useState<LoadState<AuthStatusResponse>>({ status: 'loading' });
  const [logoutState, setLogoutState] = useState<'idle' | 'running' | 'error'>('idle');
  const [logoutError, setLogoutError] = useState('');
  const [sso, setSso] = useState<TicketSsoConfig | null>(null);
  const [ssoSecret, setSsoSecret] = useState('');
  const [ssoSaveState, setSsoSaveState] = useState<'idle' | 'running' | 'saved' | 'error'>('idle');
  const [ssoSaveError, setSsoSaveError] = useState('');
  const [ssoReadError, setSsoReadError] = useState('');
  const [ssoDenied, setSsoDenied] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(true);
  const [ssoUnknown, setSsoUnknown] = useState(false);
  const [ssoAttempt, setSsoAttempt] = useState(0);
  const unconfirmedSso = useRef<{ config: TicketSsoConfig; secretChanged: boolean } | null>(null);
  const [ssoReadAfterUnknown, setSsoReadAfterUnknown] = useState(false);
  const savedSso = useRef<TicketSsoConfig | null>(null);
  const editableKeys = ['enabled', 'providerId', 'label', 'authorizationUrl', 'tokenUrl', 'clientId', 'defaultRedirect'] as const;

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: 'loading' });
    apiRequest<AuthStatusResponse>('/api/auth/status', { signal: ctrl.signal })
      .then((data) => { if (typeof data.enabled !== 'boolean' && !data.mode) throw new Error('未取得可确认的认证状态'); setState({ status: 'ok', data }); })
      .catch((err: unknown) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
      });
    return () => ctrl.abort();
  }, [statusAttempt]);

  useEffect(() => {
    let alive = true;
    setSsoLoading(true); setSsoReadError(''); setSsoDenied(false);
    fetchTicketSsoConfig()
      .then((config) => {
        if (!alive) return;
        const previous = savedSso.current;
        setSso(current => {
          if (!current || !previous || config.managedByEnvironment) return config;
          const next = { ...config };
          for (const key of editableKeys) if (current[key] !== previous[key]) Object.assign(next, { [key]: current[key] });
          return next;
        });
        savedSso.current = config;
        if (config.managedByEnvironment) setSsoSecret('');
        setSsoReadAfterUnknown(true);
        const pending = unconfirmedSso.current;
        if (!pending || !pending.secretChanged && editableKeys.every(key => config[key] === pending.config[key])) { unconfirmedSso.current = null; setSsoUnknown(false); if (pending) { setSsoSaveState('idle'); setSsoSaveError(''); } }
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setSsoDenied(err instanceof ApiError && err.status === 403);
        setSsoReadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (alive) setSsoLoading(false); });
    return () => { alive = false; };
  }, [ssoAttempt]);

  function updateSso(change: Partial<TicketSsoConfig>): void {
    setSso(current => current ? { ...current, ...change } : current);
    if (!ssoUnknown) { setSsoSaveState('idle'); setSsoSaveError(''); }
  }

  const saveSso = async (): Promise<void> => {
    if (!sso || ssoLoading || ssoReadError || ssoUnknown || ssoSaveState === 'running') return;
    const submitted = { ...sso };
    const changedSecret = Boolean(ssoSecret);
    setSsoReadAfterUnknown(false);
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
      setSso(saved); savedSso.current = saved;
      setSsoSecret('');
      setSsoSaveState('saved');
    } catch (err) {
      setSsoSaveState('error');
      const unknown = !(err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408);
      setSsoUnknown(unknown); unconfirmedSso.current = unknown ? { config: submitted, secretChanged: changedSecret } : null;
      setSsoSaveError(unknown ? '保存结果未确认，请先重新读取核对，勿重复提交。密钥不会回传，修改密钥后仍需通过正常 SSO 登录确认有效性。' : err instanceof ApiError ? err.message : String(err));
    }
  };

  const logout = async (): Promise<void> => {
    if (state.status !== 'ok' || !state.data.logoutEndpoint) return;
    setLogoutState('running');
    setLogoutError('');
    try {
      await apiRequest(state.data.logoutEndpoint, { method: 'POST' });
      window.location.href = state.data.postLogoutRedirect || loginHref(state.data.mode);
    } catch (err) {
      setLogoutState('error');
      setLogoutError(err instanceof ApiError ? err.message : String(err));
    }
  };

  if (state.status === 'loading') return <LoadingBlock />;
  if (state.status === 'error') return <div className="space-y-3"><ErrorBlock message={state.message} /><Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" onClick={() => setStatusAttempt(value => value + 1)}>重试读取认证状态</Button></div>;

  const auth = state.data;
  const enabled = auth.enabled !== false && auth.mode !== 'disabled';
  const userName = auth.user?.githubLogin || auth.user?.username || auth.user?.name || (enabled ? '已登录用户' : '本地匿名访问');

  return (
    <Section
      title="登录与认证"
      description={
        <>
          管理 Dashboard 登录方式与可信 SSO 入口。环境托管项修改后需重启；页面保存的 SSO 设置立即生效。
        </>
      }
    >
      <div className="space-y-5">
        <div
          className={
            enabled
              ? 'rounded-md border border-ok/30 bg-ok-soft px-4 py-4'
              : 'rounded-md border border-warn/40 bg-warn-soft px-4 py-4'
          }
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              {enabled ? (
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-ok" />
              ) : (
                <ShieldOff className="mt-0.5 h-5 w-5 shrink-0 text-warn" />
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
              <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs"
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
            {sso ? <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={sso?.enabled === true}
                disabled={!sso || sso.managedByEnvironment || ssoSaveState === 'running' || ssoLoading}
                onChange={(event) => updateSso({ enabled: event.target.checked })}
              />
              允许 SSO 登录
            </label> : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3"><Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" variant="outline" size="sm" disabled={ssoDenied} onClick={() => requestAgentAccess('auth')}><Bot />交给 Agent 配置</Button><span className="text-xs text-muted-foreground">客户端密钥仅在受保护输入框填写，不会回显。</span></div>
          {ssoLoading ? <p role="status" className="mt-3 text-sm text-muted-foreground">正在读取 SSO 配置…</p> : null}
          {ssoReadError ? <div role="alert" className="mt-3 space-y-2 text-sm text-destructive"><p>{ssoDenied ? '当前会话无权读取 SSO 配置，请联系系统所有者。' : `SSO 配置读取失败：${ssoReadError}。当前状态未确认，可重试。`}</p><Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" variant="outline" size="sm" disabled={ssoLoading || ssoSaveState === 'running'} onClick={() => setSsoAttempt(value => value + 1)}>重新读取 SSO 配置</Button></div> : null}
          {sso ? (
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {sso.managedByEnvironment ? (
                <div className="rounded-md border border-warn/35 bg-warn-soft px-3 py-2 text-sm leading-6 text-foreground md:col-span-2">
                  当前配置由 CDS_SSO_* 环境变量托管。页面仅展示生效值，请在部署环境中修改后重启 CDS。
                </div>
              ) : null}
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
                    disabled={sso.managedByEnvironment || ssoSaveState === 'running' || ssoLoading}
                    value={sso[key]}
                    placeholder={placeholder}
                    onChange={(event) => updateSso({ [key]: event.target.value })}
                  />
                </label>
              ))}
              <label className="md:col-span-2">
                <span className="mb-1.5 block text-sm text-muted-foreground">客户端密钥</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
                  disabled={sso.managedByEnvironment || ssoSaveState === 'running' || ssoLoading}
                  value={ssoSecret}
                  placeholder={sso.hasClientSecret ? '已安全保存，留空保持不变' : '输入客户端密钥'}
                  onChange={(event) => { setSsoSecret(event.target.value); if (!ssoUnknown) setSsoSaveState('idle'); }}
                />
              </label>
              <div className="flex flex-wrap items-center gap-3 md:col-span-2">
                <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs"
                  type="button"
                  disabled={sso.managedByEnvironment || ssoSaveState === 'running' || ssoLoading || Boolean(ssoReadError) || ssoUnknown}
                  onClick={() => void saveSso()}
                >
                  {ssoSaveState === 'running' ? '保存中' : '保存 SSO 配置'}
                </Button>
                <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" variant="outline" disabled={ssoLoading || ssoSaveState === 'running'} onClick={() => setSsoAttempt(value => value + 1)}>重新读取核对</Button>
                {ssoUnknown && ssoReadAfterUnknown && !ssoReadError ? <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" variant="outline" onClick={() => { setSsoUnknown(false); unconfirmedSso.current = null; setSsoSaveError('原保存结果仍未确认。你已选择在核对配置及正常登录后准备新的修改，不会自动重复提交。'); }}>已核对配置与登录，准备新修改</Button> : null}
                {ssoSaveState === 'saved' ? <span className="text-sm text-ok">配置已保存并立即生效</span> : null}
                {ssoSaveState === 'error' ? <span className="text-sm text-destructive">{ssoSaveError || '保存失败'}</span> : null}
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">{ssoReadError ? '尚未取得 SSO 配置，不能判断是否启用。' : '等待配置读取结果。'}</p>
          )}
        </div>
        <details className="border-t border-border pt-3"><summary className="cursor-pointer text-sm font-medium">账号密码与 GitHub OAuth 配置参考</summary><div className="mt-3">
          <div className="flex items-start gap-3 text-sm leading-6 text-muted-foreground">
            <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              账号密码模式保留 <code>CDS_USERNAME</code> / <code>CDS_PASSWORD</code> 作为原始管理员凭据，
              并可在「用户管理」中创建本地账号；生产环境需同时使用持久化认证存储。GitHub OAuth 使用{' '}
              <code>CDS_GITHUB_CLIENT_ID</code> / <code>CDS_GITHUB_CLIENT_SECRET</code> /{' '}
              <code>CDS_ALLOWED_ORGS</code>。这些变量由初始化流程或运维脚本写入环境文件，页面只负责查看状态和退出当前会话。
            </div>
          </div>
        </div></details>
      </div>
    </Section>
  );
}
