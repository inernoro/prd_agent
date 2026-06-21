import { useEffect, useState } from 'react';
import { KeyRound, ShieldCheck, UserPlus, Users } from 'lucide-react';

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

interface MeUser {
  id: string;
  username: string | null;
  authProvider?: 'github' | 'local';
  isSystemOwner: boolean;
  name: string;
}

const inputCls =
  'w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';

export function UsersTab({ onToast }: { onToast: (msg: string) => void }): JSX.Element {
  const [me, setMe] = useState<MeUser | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);

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

  useEffect(() => {
    const ctrl = new AbortController();
    apiRequest<{ user: MeUser }>('/api/me', { signal: ctrl.signal })
      .then((data) => setMe(data.user))
      .catch(() => setMe(null))
      .finally(() => setMeLoaded(true));
    return () => ctrl.abort();
  }, []);

  const isOwner = me?.isSystemOwner === true;
  const isLocal = (me?.authProvider ?? 'github') === 'local';

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
      await refreshUsers();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setCreateBusy(false);
    }
  };

  const toggleStatus = async (user: CdsPublicUser): Promise<void> => {
    const next = user.status === 'active' ? 'disabled' : 'active';
    try {
      await updateUser(user.id, { status: next });
      onToast(`已${next === 'disabled' ? '禁用' : '启用'} ${user.username || user.githubLogin}`);
      await refreshUsers();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    }
  };

  const resetPassword = async (user: CdsPublicUser): Promise<void> => {
    const pw = window.prompt(`为 ${user.username || user.githubLogin} 设置新密码（至少 8 位）`);
    if (pw === null) return;
    if (pw.length < 8) {
      onToast('密码长度至少 8 位');
      return;
    }
    try {
      await updateUser(user.id, { newPassword: pw });
      onToast(`已重置 ${user.username || user.githubLogin} 的密码`);
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    }
  };

  if (!meLoaded) return <LoadingBlock label="加载用户信息" />;

  return (
    <div className="space-y-8">
      <Section
        title="修改密码"
        description={
          isLocal
            ? '修改当前本地账号的登录密码。修改后所有会话失效，需要用新密码重新登录。'
            : '当前账号通过 GitHub OAuth 登录，密码由 GitHub 管理，无需在此修改。'
        }
      >
        {isLocal ? (
          <form onSubmit={submitPassword} className="max-w-md space-y-3">
            <Field label="原密码">
              <input
                type="password"
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
            GitHub 账号 <CodePill>{me?.username || me?.name || '当前用户'}</CodePill> 的凭据由 GitHub 托管。
          </div>
        )}
      </Section>

      {isOwner ? (
        <>
          <Section
            title="创建本地账号"
            description="为团队成员开设用户名 + 密码账号，与 GitHub OAuth 用户共存。新账号默认为普通成员。"
          >
            <form onSubmit={submitCreate} className="grid max-w-3xl gap-3 md:grid-cols-3">
              <Field label="用户名">
                <input
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
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  className={inputCls}
                  placeholder="初始密码"
                  autoComplete="new-password"
                />
              </Field>
              <div className="md:col-span-3">
                {createError ? <ErrorBlock message={createError} /> : null}
                <Button type="submit" disabled={createBusy} className="mt-1">
                  <UserPlus />
                  {createBusy ? '创建中' : '创建账号'}
                </Button>
              </div>
            </form>
          </Section>

          <Section title="用户列表" description="系统内所有账号（GitHub 与本地账号），可禁用 / 启用账号或重置本地账号密码。">
            {usersError ? (
              <ErrorBlock message={usersError} />
            ) : users === null ? (
              <LoadingBlock label="加载用户列表" />
            ) : users.length === 0 ? (
              <EmptyBlock title="还没有用户" description="创建第一个本地账号，或邀请成员通过 GitHub 登录。" />
            ) : (
              <div className="overflow-hidden rounded-md border border-border">
                <table className="w-full text-sm">
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
                    {users.map((u) => (
                      <tr key={u.id} className="border-t border-border">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2 font-medium text-foreground">
                            {u.username || u.githubLogin}
                            {u.isSystemOwner ? (
                              <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
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
                          {u.authProvider === 'local' ? '本地账号' : 'GitHub'}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={
                              u.status === 'active'
                                ? 'inline-flex rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-500'
                                : 'inline-flex rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-amber-500'
                            }
                          >
                            {u.status === 'active' ? '正常' : '已禁用'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '从未登录'}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-2">
                            {u.authProvider === 'local' ? (
                              <Button type="button" variant="outline" size="sm" onClick={() => void resetPassword(u)}>
                                重置密码
                              </Button>
                            ) : null}
                            {u.id !== me?.id ? (
                              <Button type="button" variant="outline" size="sm" onClick={() => void toggleStatus(u)}>
                                {u.status === 'active' ? '禁用' : '启用'}
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
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
    </div>
  );
}
