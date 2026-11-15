import { useEffect, useState } from 'react';
import { KeyRound, ShieldCheck, UserPlus, Users } from 'lucide-react';

import { ConfirmAction } from '@/components/ui/confirm-action';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  apiRequest,
  ApiError,
  listUsers,
  createLocalUser,
  updateUser,
  changeMyPassword,
  type CdsPublicUser,
} from '@/lib/api';
import { Section, Field, LoadingBlock, ErrorBlock, CodePill, EmptyBlock } from '../components';
import { IdentityRecoveryPanel } from '../components/IdentityRecoveryPanel';
import { UserProjectAccessDialog } from '../components/UserProjectAccessDialog';

interface MeUser {
  id: string;
  username: string | null;
  authProvider?: 'github' | 'local' | 'legacy' | 'sso';
  isSystemOwner: boolean;
  name: string;
}

const touchActionClass = 'min-h-[3.25rem] text-base [&_svg]:size-[1.875rem] lg:min-h-0 lg:text-xs lg:[&_svg]:size-4';
const inputCls =
  'min-h-[3.25rem] text-base lg:min-h-0 lg:text-sm w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';

export function UsersTab({
  onToast,
  durableUsers,
}: {
  onToast: (msg: string) => void;
  durableUsers: boolean;
}): JSX.Element {
  const [me, setMe] = useState<MeUser | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  const [meError, setMeError] = useState('');
  const [meAttempt, setMeAttempt] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busyUser, setBusyUser] = useState('');
  const [resetUser, setResetUser] = useState<CdsPublicUser | null>(null);
  const [resetValue, setResetValue] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetUnknown, setResetUnknown] = useState(false);

  // ── My password ──
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState('');

  // ── User list (owner) ──
  const [users, setUsers] = useState<CdsPublicUser[] | null>(null);
  const [usersError, setUsersError] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState('');
  const [grantUser, setGrantUser] = useState<CdsPublicUser | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setMeLoaded(false); setMeError('');
    apiRequest<{ user: MeUser }>('/api/me', { signal: ctrl.signal })
      .then((data) => { if (!data.user) throw new Error('未能确认当前用户身份'); setMe(data.user); })
      .catch((err: unknown) => { if (!ctrl.signal.aborted) setMeError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!ctrl.signal.aborted) setMeLoaded(true); });
    return () => ctrl.abort();
  }, [meAttempt]);

  const isOwner = me?.isSystemOwner === true;
  const isLocal = me?.authProvider === 'local';
  const isLegacy = me?.authProvider === 'legacy';

  const refreshUsers = async (): Promise<void> => {
    setUsersError('');
    try {
      setUsers(await listUsers());
    } catch (err) {
      setUsersError(err instanceof ApiError ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (isOwner) void refreshUsers();
  }, [isOwner]);

  const submitPassword = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setPwError('');
    if (newPw.length < 8) {
      setPwError('新密码长度至少 8 位');
      return;
    }
    setPwBusy(true);
    try {
      await changeMyPassword({ oldPassword: oldPw, newPassword: newPw });
      onToast('密码已修改，请使用新密码重新登录');
      setOldPw('');
      setNewPw('');
    } catch (err) {
      setPwError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setPwBusy(false);
    }
  };

  const submitCreate = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setCreateError('');
    setCreateBusy(true);
    try {
      await createLocalUser({ username: newUsername, password: newPassword, name: newName || undefined });
      onToast(`已创建本地账号 ${newUsername}`);
      setNewUsername('');
      setNewName('');
      setNewPassword('');
      setCreateOpen(false);
      await refreshUsers();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setCreateBusy(false);
    }
  };

  const toggleStatus = async (user: CdsPublicUser): Promise<void> => {
    const next = user.status === 'active' ? 'disabled' : 'active';
    setBusyUser(user.id);
    try {
      await updateUser(user.id, { status: next });
      onToast(`已${next === 'disabled' ? '禁用' : '启用'} ${user.username || user.githubLogin}`);
      await refreshUsers();
    } catch (err) { onToast(err instanceof ApiError ? err.message : String(err)); }
    finally { setBusyUser(''); }
  };

  const resetPassword = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!resetUser || resetUnknown) return;
    if (resetValue.length < 8) { setResetError('新密码长度至少 8 位'); return; }
    setBusyUser(resetUser.id); setResetError('');
    try {
      await updateUser(resetUser.id, { newPassword: resetValue });
      onToast(`已重置 ${resetUser.username || resetUser.githubLogin} 的密码`);
      setResetValue(''); setResetUser(null);
    } catch (err) {
      const unknown = !(err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408);
      setResetUnknown(unknown);
      setResetError(unknown ? '密码重置结果未确认，请先让该成员验证新密码，勿重复提交。' : err instanceof Error ? err.message : String(err));
    } finally { setBusyUser(''); }
  };
  const needle = query.trim().toLocaleLowerCase();
  const visibleUsers = users?.filter(user => !needle || [user.username, user.githubLogin, user.name, user.id].some(value => value?.toLocaleLowerCase().includes(needle))) || [];
  function userActions(user: CdsPublicUser): JSX.Element {
    return <div className="flex flex-wrap gap-2">
      {!user.isSystemOwner ? <Button type="button" variant="outline" size="sm" className={touchActionClass} disabled={busyUser === user.id} onClick={() => setGrantUser(user)}>项目授权</Button> : null}
      {user.authProvider === 'local' ? <Button type="button" variant="outline" size="sm" className={touchActionClass} disabled={busyUser === user.id} onClick={() => { setResetUser(user); setResetValue(''); setResetError(''); setResetUnknown(false); }}>重置密码</Button> : null}
      {user.id !== me?.id ? <ConfirmAction scopeKey={user.id} title={`${user.status === 'active' ? '禁用' : '启用'}账号：${user.username || user.githubLogin}`} description={`账号编号：${user.id}。${user.status === 'active' ? '禁用后不能继续访问 CDS，账号和项目授权记录保留。' : '启用后按已有项目授权访问，不会新增项目权限。'}`} confirmLabel={user.status === 'active' ? '禁用账号' : '启用账号'} onConfirm={() => toggleStatus(user)} pending={busyUser === user.id} trigger={<Button type="button" variant="outline" size="sm" className={touchActionClass} disabled={busyUser === user.id}>{busyUser === user.id ? '正在更新' : user.status === 'active' ? '禁用' : '启用'}</Button>} /> : null}
    </div>;
  }

  if (!meLoaded) return <LoadingBlock label="加载用户信息" />;
  if (meError) return <Section title="用户管理"><ErrorBlock message={`当前身份读取失败：${meError}`} /><Button className="mt-3" variant="outline" onClick={() => setMeAttempt(value => value + 1)}>重试读取身份</Button></Section>;

  return (
    <div className="space-y-8">
      {!durableUsers ? (
        <div className="rounded-md border border-border bg-[hsl(var(--surface-sunken))] px-4 py-3 text-sm leading-6 text-muted-foreground">
          当前认证存储为内存模式，新建账号会在 CDS 重启后丢失。生产环境请配置持久化认证存储后再创建用户。
        </div>
      ) : null}


      {isOwner ? (
        <>


          <Section
            title="用户列表"
            actions={<Button type="button" className={touchActionClass} onClick={() => setCreateOpen(true)}><UserPlus />创建账号</Button>}
            description={
              isLegacy
                ? '持久化用户库中的账号。当前原始管理员由环境变量管理，因此不重复出现在本列表中。'
                : '系统内所有持久化账号，可管理项目授权、禁用 / 启用账号或重置本地账号密码。'
            }
          >
            {users && (users.length > 5 || query) ? <label className="mb-3 block sm:max-w-sm"><span className="sr-only">搜索用户</span><input aria-label="搜索用户" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索账号、姓名或编号" className={inputCls} /></label> : null}
            {usersError ? (
              <div className="space-y-2"><ErrorBlock message={usersError} /><Button variant="outline" onClick={() => void refreshUsers()}>重新读取用户</Button></div>
            ) : users === null ? (
              <LoadingBlock label="加载用户列表" />
            ) : users.length === 0 ? (
              <EmptyBlock title="还没有用户" description="创建第一个本地账号，或邀请成员通过 GitHub 登录。" />
            ) : (
              <div className="hidden overflow-x-auto rounded-md border border-border lg:block">
                <table className="w-full min-w-[42rem] text-sm">
                  <thead className="bg-muted/40 text-left text-xs uppercase tracking-normal text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-semibold">账号</th>
                      <th className="px-3 py-2 font-semibold">来源</th>
                      <th className="px-3 py-2 font-semibold">状态</th>
                      <th className="px-3 py-2 font-semibold">最近登录</th>
                      <th className="px-3 py-2 text-right font-semibold">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleUsers.map((u) => (
                      <tr key={u.id} className="border-t border-border">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2 font-medium text-foreground">
                            {u.username || u.githubLogin}
                            {u.isSystemOwner ? (
                              <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-primary">
                                <ShieldCheck className="h-3 w-3" />
                                所有者
                              </span>
                            ) : null}
                          </div>
                          {u.name && u.name !== (u.username || u.githubLogin) ? (
                            <div className="text-xs text-muted-foreground">{u.name}</div>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {u.authProvider === 'local'
                            ? '本地账号'
                            : u.authProvider === 'legacy'
                              ? '原始账号'
                              : u.authProvider === 'sso'
                                ? 'SSO'
                                : 'GitHub'}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={
                              u.status === 'active'
                                ? 'inline-flex rounded bg-ok-soft px-1.5 py-0.5 text-[0.6875rem] font-semibold text-ok'
                                : 'inline-flex rounded bg-warn-soft px-1.5 py-0.5 text-[0.6875rem] font-semibold text-warn'
                            }
                          >
                            {u.status === 'active' ? '正常' : '已禁用'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '从未登录'}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex justify-end">{userActions(u)}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {users && !usersError && users.length > 0 && visibleUsers.length === 0 ? <p className="py-4 text-sm text-muted-foreground">没有匹配的账号，请调整搜索条件。</p> : null}
            {users && !usersError ? <ul className="grid gap-3 sm:grid-cols-2 lg:hidden">{visibleUsers.map(user => <li key={user.id} data-user-card={user.id} className="min-w-0 space-y-3 rounded-md border border-border p-3 text-sm">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words font-semibold">{user.username || user.githubLogin || user.name || user.id}</h3>{user.name && user.name !== (user.username || user.githubLogin) ? <p className="mt-1 break-words text-muted-foreground">{user.name}</p> : null}{user.isSystemOwner ? <p className="mt-1 text-xs text-primary">系统所有者</p> : null}</div><span className={user.status === 'active' ? 'shrink-0 text-ok' : 'shrink-0 text-warn'}>{user.status === 'active' ? '正常' : '已禁用'}</span></div>
              <p className="text-xs text-muted-foreground">{user.authProvider === 'local' ? '本地账号' : user.authProvider === 'github' ? 'GitHub' : user.authProvider === 'sso' ? 'SSO' : '原始账号'} · {user.lastLoginAt ? `最近登录 ${new Date(user.lastLoginAt).toLocaleString()}` : '从未登录'}</p>
              {userActions(user)}
            </li>)}</ul> : null}
          </Section>
        </>
      ) : (
        <Section title="用户管理" description="仅系统所有者可创建账号、禁用账号或重置密码。">
          <div className="flex items-start gap-3 rounded-md border border-border bg-card px-4 py-4 text-sm leading-6 text-muted-foreground">
            <Users className="mt-0.5 h-4 w-4 shrink-0" />
            <div>你当前不是系统所有者，无法管理其他用户。如需账号变更请联系系统所有者。</div>
          </div>
        </Section>
      )}
      <details className="pt-3"><summary className="cursor-pointer text-sm font-medium">我的登录密码</summary><div className="mt-3">      <Section
        title="修改密码"
        description={
          isLocal
            ? '修改当前本地账号的登录密码。修改后所有会话失效，需要用新密码重新登录。'
            : isLegacy
              ? '当前使用原始环境变量账号登录，密码继续由 CDS_USERNAME / CDS_PASSWORD 管理。'
              : '当前账号通过外部身份提供方登录，密码由身份提供方管理，无需在此修改。'
        }
      >
        {isLocal ? (
          <form onSubmit={submitPassword} className="max-w-md space-y-3">
            <Field label="原密码">
              <input
                type="password"
                disabled={pwBusy}
                value={oldPw}
                onChange={(e) => setOldPw(e.target.value)}
                autoComplete="current-password"
                required
                className={inputCls}
                placeholder="原密码"
              />
            </Field>
            <Field label="新密码（至少 8 位）">
              <input
                type="password"
                disabled={pwBusy}
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                autoComplete="new-password"
                required
                minLength={8}
                className={inputCls}
                placeholder="新密码"
              />
            </Field>
            {pwError ? <ErrorBlock message={pwError} /> : null}
            <Button type="submit" disabled={pwBusy}>
              <KeyRound />
              {pwBusy ? '修改中' : '修改密码'}
            </Button>
          </form>
        ) : (
          <div className="rounded-md border border-border bg-card px-4 py-4 text-sm leading-6 text-muted-foreground">
            {isLegacy ? '原始管理员账号' : '外部身份账号'}{' '}
            <CodePill>{me?.username || me?.name || '当前用户'}</CodePill>{' '}
            的凭据不在持久化用户库中修改。
          </div>
        )}
      </Section></div></details>
      {isOwner ? <Dialog open={createOpen} onOpenChange={open => { if (!createBusy) setCreateOpen(open); }}><DialogContent className="[&>button]:min-h-[3.25rem] [&>button]:min-w-[3.25rem] [&>button>svg]:size-[1.875rem]"><DialogHeader className="pr-10"><DialogTitle>创建本地账号</DialogTitle><DialogDescription>新账号默认为普通成员，与 GitHub OAuth 用户共存。{!durableUsers ? '当前认证为内存模式，账号会在 CDS 重启后丢失。' : ''}</DialogDescription></DialogHeader>            <form onSubmit={submitCreate} className="grid gap-3">
              <Field label="用户名">
                <input
                  aria-label="用户名"
                  disabled={createBusy}
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  required
                  className={inputCls}
                  placeholder="如 alice"
                  autoComplete="off"
                />
              </Field>
              <Field label="显示名（可选）">
                <input
                  aria-label="显示名（可选）"
                  disabled={createBusy}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className={inputCls}
                  placeholder="如 Alice"
                  autoComplete="off"
                />
              </Field>
              <Field label="初始密码（至少 8 位）">
                <input
                  type="password"
                  aria-label="初始密码（至少8位）"
                  disabled={createBusy}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  className={inputCls}
                  placeholder="初始密码"
                  autoComplete="new-password"
                />
              </Field>
              <div className="space-y-2">
                {createError ? <p role="alert" className="text-sm text-destructive">{createError}</p> : null}
                <Button type="submit" disabled={createBusy} className={`mt-1 ${touchActionClass}`}>
                  <UserPlus />
                  {createBusy ? '创建中' : '创建账号'}
                </Button>
              </div>
            </form></DialogContent></Dialog> : null}
      <Dialog open={Boolean(resetUser)} onOpenChange={open => { if (!open && !busyUser) { setResetUser(null); setResetValue(''); } }}><DialogContent className="[&>button]:min-h-[3.25rem] [&>button]:min-w-[3.25rem] [&>button>svg]:size-[1.875rem]"><DialogHeader className="pr-10"><DialogTitle>重置账号密码</DialogTitle><DialogDescription>账号：{resetUser?.username || resetUser?.githubLogin}。保存后成员需使用新密码登录，账号的项目授权保持不变。</DialogDescription></DialogHeader><form onSubmit={resetPassword} className="space-y-3"><label className="block space-y-2 text-sm">新密码（至少 8 位）<input aria-label="重置后的新密码" type="password" autoComplete="new-password" required minLength={8} className={inputCls} value={resetValue} disabled={Boolean(busyUser)} onChange={event => setResetValue(event.target.value)} /></label>{resetError ? <p role="alert" className="text-sm text-destructive">{resetError}</p> : null}<Button type="submit" className={touchActionClass} disabled={Boolean(busyUser) || resetUnknown}>{busyUser ? '正在重置' : '保存新密码'}</Button></form></DialogContent></Dialog>
      {isOwner ? <IdentityRecoveryPanel onToast={onToast} /> : null}
      <UserProjectAccessDialog user={grantUser} onClose={() => setGrantUser(null)} onToast={onToast} />
    </div>
  );
}
