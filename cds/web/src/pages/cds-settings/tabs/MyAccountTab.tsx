import { type FormEvent, useEffect, useState } from 'react';
import { Github, KeyRound, ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiRequest, apiUrl, changeMyPassword, listUsers, type CdsAuthPublicStatus, type CdsPublicUser } from '@/lib/api';
import { ErrorBlock, Field, LoadingBlock, Section } from '../components';
import { KeyNotifications } from '../components/KeyNotifications';
import { accountLoginMethods, actionLabels, availableAccountLogins, hasAccountLogin, type AccountAction } from '../accountAccess';

type LoginMethods = CdsAuthPublicStatus['loginMethods'];
type AccountProviders = CdsAuthPublicStatus['accountProviders'];
const providers = [['github', 'GitHub'], ['google', 'Google']] as const;

const inputClass = 'min-h-[3.25rem] w-full rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-0 lg:text-sm';

export function accountRoleLabel(user: CdsPublicUser): string {
  return user.isSystemOwner ? '系统所有者' : user.role === 'admin' ? '管理员' : '成员';
}

export function LoginMethodsTab({ loginMethods, accountProviders, canListAccounts }: {
  loginMethods: LoginMethods; accountProviders?: AccountProviders; canListAccounts: boolean;
}): JSX.Element {
  const [accounts, setAccounts] = useState<CdsPublicUser[] | null>(null);
  const [countFailed, setCountFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!canListAccounts) return;
    const controller = new AbortController();
    setCountFailed(false);
    listUsers(controller.signal).then(rows => {
      if (!controller.signal.aborted) setAccounts(rows);
    }).catch(() => {
      if (!controller.signal.aborted) setCountFailed(true);
    });
    return () => controller.abort();
  }, [attempt, canListAccounts]);
  const available = availableAccountLogins(loginMethods, accountProviders);
  const methods = {
    github: { detail: '个人登录使用本实例的 OAuth 应用，回调为 /api/auth/external/github/callback。项目仓库访问在 GitHub 集成中授权。', icon: Github },
    google: { detail: '个人登录使用本实例的 OAuth 应用，回调为 /api/auth/external/google/callback。', icon: ShieldCheck },
    sso: { detail: '使用本实例配置的上游身份提供方登录。', icon: ShieldCheck },
    local: { detail: '使用个人 CDS 用户名和口令登录。', icon: KeyRound },
  };
  return (
    <Section title="登录方式" description="账号数量按当前管理范围、实例开通状态和账号状态统计。">
      {countFailed ? <div className="mb-3 flex flex-wrap items-center gap-2">
        <ErrorBlock message="暂时无法读取账号数量" />
        <Button variant="outline" onClick={() => setAttempt(value => value + 1)}>重新读取</Button>
      </div> : null}
      <ul className="grid gap-3 lg:grid-cols-3">
        {accountLoginMethods.map(([id, name]) => {
          const { detail, icon: Icon } = methods[id];
          const enabled = available[id];
          const connected = accounts?.filter(user => hasAccountLogin(user, id)) ?? [];
          const ready = enabled ? connected.filter(user => user.status === 'active').length : 0;
          return <li key={id} className="min-w-0 rounded-lg border border-border bg-card p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Icon size={16} aria-hidden="true" />
              <strong>{name}</strong>
              <span className={enabled ? 'ml-auto text-ok' : 'ml-auto text-muted-foreground'}>{enabled ? '可用' : '未开通'}</span>
            </div>
            <p className="mt-2 break-words text-muted-foreground">{detail}</p>
            {canListAccounts && accounts && !countFailed ? <p className="mt-2 text-xs text-muted-foreground">
              {ready} 个可用账号 · {connected.length - ready} 个暂不可用
            </p> : null}
          </li>;
        })}
      </ul>
    </Section>
  );
}

export function MyAccountTab({ loginMethods, accountProviders }: {
  loginMethods: LoginMethods; accountProviders?: AccountProviders;
}): JSX.Element {
  const [user, setUser] = useState<CdsPublicUser | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [unlinkError, setUnlinkError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setPending(true);
    setError('');
    apiRequest<{ user: CdsPublicUser }>('/api/me', { signal: controller.signal }).then(({ user: current }) => {
      if (!current?.id) throw new Error('当前登录方式由上游身份源管理。');
      if (!controller.signal.aborted) setUser(current);
    }).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!controller.signal.aborted) setPending(false);
    });
    return () => controller.abort();
  }, [attempt]);

  if (pending) return <LoadingBlock label="读取我的账号" />;
  if (error || !user) return (
    <Section title="我的账号">
      <ErrorBlock message={error || '当前账号身份读取失败'} />
      <Button className="mt-3" variant="outline" onClick={() => setAttempt(value => value + 1)}>重新读取</Button>
    </Section>
  );
  const handle = user.username || user.githubLogin;
  const result = new URLSearchParams(window.location.search);
  const bindingProvider = result.get('provider');
  const bindingLabel = providers.find(([provider]) => provider === bindingProvider)?.[1];
  const bindingError = result.get('external') === 'error';
  const errorCode = result.get('code');
  async function detach(provider: typeof providers[number][0]): Promise<void> {
    setUnlinkError('');
    try {
      await apiRequest(`/api/auth/external/${provider}/link`, { method: 'DELETE' });
      window.location.assign('/login?redirect=%2Fcds-settings%23my-account');
    } catch (error) { setUnlinkError(error instanceof Error ? error.message : String(error)); }
  }
  return (
    <div className="space-y-6">
      <Section title="我的账号">
        <div className="flex min-w-0 flex-wrap items-start gap-3 rounded-lg border border-border bg-card p-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-foreground" aria-hidden="true">{Array.from(user.name || handle)[0]}</span>
          <div className="min-w-0">
            <p className="break-words text-base font-semibold">{user.name || handle}</p>
            <p className="break-words text-sm text-muted-foreground">{handle} · {accountRoleLabel(user)}</p>
            <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{user.id}</p>
          </div>
        </div>
      </Section>

      <Section title="我的登录">
        {unlinkError ? <ErrorBlock message={unlinkError} /> : null}
        {bindingError && bindingLabel ? <ErrorBlock message={errorCode === 'identity_taken'
          ? `这个 ${bindingLabel} 身份已绑定到另一个 CDS 账号`
          : errorCode === 'provider_already_linked'
            ? `当前 CDS 账号已绑定另一个 ${bindingLabel} 身份`
            : `${bindingLabel} 绑定未完成，请核对当前登录账号后重试`} /> : null}
        {result.get('external') === 'bound' && providers.some(([provider]) => provider === bindingProvider && user.linkedLogins?.[provider])
          ? <p className="mb-3 text-sm text-ok" role="status">身份已绑定</p> : null}
        <div className="divide-y divide-border rounded-lg border border-border bg-card px-4">
          <div className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">账号口令</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {user.authProvider === 'legacy' ? '当前使用系统账号口令' : user.hasPassword ? '已设置个人口令' : '当前账号未设置个人口令'}
              </p>
            </div>
            {user.authProvider === 'local' && user.hasPassword ? (
              <Button variant="outline" onClick={() => setPasswordOpen(true)}>修改本人口令</Button>
            ) : null}
          </div>
          {providers.map(([provider, label]) => {
            const linked = user.linkedLogins?.[provider];
            const available = accountProviders?.[provider] === true;
            const providerOnline = available || (linked && provider === 'github' && loginMethods.github);
            const canBind = available && user.externalLoginAllowed && user.authProvider !== 'legacy' && !linked;
            const alternative = user.hasPassword || (provider === 'github'
              ? accountProviders?.google && user.linkedLogins?.google : loginMethods.github && user.linkedLogins?.github);
            return (
              <div key={provider} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{label}</p>
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {linked ? `已绑定 · ${linked}${providerOnline ? '' : ' · 当前登录方式未开通'}`
                      : !available ? `此实例尚未开通 ${label} 个人账号登录`
                        : user.authProvider === 'legacy' ? '请使用独立个人账号完成绑定'
                          : user.externalLoginAllowed ? '等待本人完成授权' : '请联系管理员开通绑定资格'}
                  </p>
                </div>
                {canBind ? <Button asChild variant="outline"><a href={apiUrl(`/api/auth/external/${provider}/start?purpose=bind`)}>绑定 {label}</a></Button> : null}
                {linked && alternative ? <ConfirmAction title={`解除 ${label} 绑定`}
                  description="完成后，现有会话会退出，请使用另一种登录方式重新进入。"
                  confirmLabel="解除绑定" onConfirm={() => detach(provider)}
                  trigger={<Button variant="outline">解除绑定</Button>} /> : null}
                {linked && !alternative ? <span className="text-xs text-muted-foreground">须保留此登录方式</span> : null}
              </div>
            );
          })}
        </div>
      </Section>
      {user.authProvider !== 'legacy' && user.authProvider !== 'sso' ? <PersonalSessions /> : null}
      <KeyNotifications owner={user.isSystemOwner} personal />
      {passwordOpen ? <PersonalPasswordDialog onClose={() => setPasswordOpen(false)} /> : null}
    </div>
  );
}

function PersonalSessions(): JSX.Element {
  const [data, setData] = useState<{
    sessions: Array<{ device: string; current: boolean; createdAt: string; lastSeenAt: string }>;
    revocations: Array<{ action: AccountAction; at: string }>;
  } | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    setError('');
    apiRequest<NonNullable<typeof data>>('/api/auth/my-sessions', { signal: ctrl.signal })
      .then(result => { if (!ctrl.signal.aborted) setData(result); })
      .catch(error => { if (!ctrl.signal.aborted) setError(error instanceof Error ? error.message : String(error)); });
    return () => ctrl.abort();
  }, [attempt]);
  return (
    <Section title="我的会话" actions={<Button variant="outline" onClick={() => setAttempt(value => value + 1)}>刷新</Button>}>
      {error ? <ErrorBlock message={error} /> : !data ? <LoadingBlock label="读取登录会话" /> : (
        <div className="space-y-3 text-sm">
          {data.sessions.length ? <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {data.sessions.map((session, index) => <li key={`${session.createdAt}-${index}`} className="flex flex-wrap justify-between gap-2 p-3">
              <span>{session.device}{session.current ? ' · 当前会话' : ''}</span>
              <span className="text-xs text-muted-foreground">最近活动 {new Date(session.lastSeenAt).toLocaleString()}</span>
            </li>)}
          </ul> : <p className="text-muted-foreground">没有已登记的登录会话。</p>}
          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer font-medium">退出或权限变更记录</summary>
            {data.revocations.length ? <ul className="mt-2 space-y-2 text-muted-foreground">
              {data.revocations.map((event, index) => <li key={`${event.at}-${index}`}>{actionLabels[event.action]} · {new Date(event.at).toLocaleString()}</li>)}
            </ul> : <p className="mt-2 text-muted-foreground">近期没有会话变更记录。</p>}
          </details>
        </div>
      )}
    </Section>
  );
}

function PersonalPasswordDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await changeMyPassword({ oldPassword, newPassword });
      window.location.assign('/login?redirect=%2Fcds-settings%23my-account');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>修改本人口令</DialogTitle>
          <DialogDescription>保存后，使用新口令重新登录。此账号现有会话会退出。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <Field label="当前口令">
            <input className={inputClass} type="password" autoComplete="current-password"
              required value={oldPassword} disabled={busy} onChange={event => setOldPassword(event.target.value)} />
          </Field>
          <Field label="新口令（至少 8 位）">
            <input className={inputClass} type="password" autoComplete="new-password"
              required minLength={8} value={newPassword} disabled={busy} onChange={event => setNewPassword(event.target.value)} />
          </Field>
          {error ? <ErrorBlock message={error} /> : null}
          <Button type="submit" className="justify-self-start" disabled={busy}>{busy ? '正在保存' : '保存口令'}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
