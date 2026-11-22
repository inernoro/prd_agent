import { type FormEvent, useContext, useEffect, useState } from 'react';
import { ArrowRight, CircleUser, Search, UserPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConsoleAuthContext } from '@/lib/consoleAuthContext';
import { consoleAccountIdentity } from '@/lib/consoleIdentity';
import { apiRequest, createLocalUser, inviteLocalUser, listUsers, updateUser, type CdsPublicUser } from '@/lib/api';
import {
  accountLoginMethods, accountViews, actionLabels, actionStateLabels, hasAccountLogin, listAccountActions,
  type AccountAction, type AccountActionEntry, type AccountView, type AvailableAccountLogins,
} from '../accountAccess';
import { EmptyBlock, ErrorBlock, Field, LoadingBlock, MetricTile, Section } from '../components';
import { AccountActionDialog, accountInputClass } from '../components/AccountActionDialog';
import { IdentityRecoveryPanel } from '../components/IdentityRecoveryPanel';
import { RecoveryRequestsPanel } from '../components/RecoveryRequestsPanel';
import { UserProjectAccessDialog } from '../components/UserProjectAccessDialog';
import { SystemPasswordDialog, SystemPasswordPanel } from '../components/SystemPasswordPanel';
import { KeyNotifications, type AccessRequestNotice } from '../components/KeyNotifications';
import { accountRoleLabel } from './MyAccountTab';

interface Props {
  onToast: (message: string) => void;
  durableUsers: boolean;
  availableLogins: AvailableAccountLogins;
  view: AccountView;
  changeView: (view: AccountView, selectedId?: string) => void;
  selectionId?: string;
}

function accountName(user: CdsPublicUser): string {
  return user.username || user.githubLogin || user.name;
}

function accountSource(user: CdsPublicUser, availableLogins: AvailableAccountLogins): string {
  if (user.invitationPending) return '等待激活';
  if (user.authProvider === 'legacy') return '系统账号';
  return accountLoginMethods.filter(([method]) => availableLogins[method] && hasAccountLogin(user, method))
    .map(([, label]) => label).join(' · ');
}

const memberStateLabels = { active: '正常', disabled: '已停用', invited: '等待激活', unavailable: '无可用登录方式' } as const;

function memberState(user: CdsPublicUser, signIn: string): keyof typeof memberStateLabels {
  if (user.status === 'disabled') return 'disabled';
  if (user.invitationPending) return 'invited';
  return signIn ? 'active' : 'unavailable';
}

export function UsersTab(props: Props): JSX.Element {
  const { status, retry } = useContext(ConsoleAuthContext);
  const identity = consoleAccountIdentity(status);
  if (!identity || !status?.user?.id) {
    return <div className="space-y-3"><ErrorBlock message="当前登录身份尚未确认" /><Button onClick={retry}>重新读取当前身份</Button></div>;
  }
  return <AccountManagement key={identity} viewerId={status.user.id}
    owner={status.user.isSystemOwner === true} {...props} />;
}

function AccountManagement({ owner, viewerId, onToast, durableUsers, availableLogins, view, changeView, selectionId }: Props & {
  owner: boolean; viewerId: string;
}): JSX.Element {
  const [users, setUsers] = useState<CdsPublicUser[] | null>(null);
  const [requests, setRequests] = useState<AccountActionEntry[] | null>(null);
  const [readError, setReadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [systemSessions, setSystemSessions] = useState<number | null>(null);
  const [keyHandoffs, setKeyHandoffs] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<CdsPublicUser | null>(null);
  const [grantUser, setGrantUser] = useState<CdsPublicUser | null>(null);
  const [subject, setSubject] = useState<React.ComponentProps<typeof AccountActionDialog>['subject'] | null>(null);
  const [editError, setEditError] = useState('');

  const refresh = () => setAttempt(value => value + 1);
  useEffect(() => { setSubject(null); setSelected(null); setEditError(''); }, [view]);
  useEffect(() => {
    if (view === 'members' && users) setSelected(selectionId ? users.find(user => user.id === selectionId) ?? null : null);
    if (view === 'approvals' && requests) {
      const entry = requests.find(item => item.id === selectionId);
      setSubject(entry ? { entry } : null);
    }
  }, [view, selectionId, users, requests]);
  useEffect(() => {
    const controller = new AbortController();
    const onError = (error: unknown) => {
      if (!controller.signal.aborted) setReadError(error instanceof Error ? error.message : String(error));
    };
    setReadError('');
    if (view === 'members') {
      listUsers(controller.signal).then(result => { if (!controller.signal.aborted) setUsers(result); }).catch(onError);
      listAccountActions(controller.signal).then(result => { if (!controller.signal.aborted) setRequests(result); }).catch(() => {});
      if (owner) {
        apiRequest<{ sessions: unknown[] }>('/api/auth/system-password', { signal: controller.signal })
          .then(result => { if (!controller.signal.aborted) setSystemSessions(result.sessions.length); }).catch(() => {});
        apiRequest<{ requests: AccessRequestNotice[] }>('/api/access-requests?queue=all', { signal: controller.signal })
          .then(result => { if (!controller.signal.aborted) setKeyHandoffs(result.requests.filter(item => item.status === 'pending' && item.notificationAccountId === null).length); }).catch(() => {});
      }
    }
    if (view === 'approvals') {
      listAccountActions(controller.signal).then(result => { if (!controller.signal.aborted) setRequests(result); }).catch(onError);
    }
    return () => controller.abort();
  }, [attempt, view, owner]);

  async function update(user: CdsPublicUser, patch: Parameters<typeof updateUser>[1]): Promise<void> {
    setEditError('');
    try {
      const current = await updateUser(user.id, patch);
      if (current) setSelected(current);
      onToast(patch.role ? '已授予管理员' : patch.externalLoginAllowed !== undefined ? '绑定资格已更新' : '账号已启用');
      refresh();
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    }
  }

  const needle = query.trim().toLocaleLowerCase();
  const visibleUsers = users?.map(user => {
    const signIn = accountSource(user, availableLogins);
    return { user, signIn, state: memberState(user, signIn) };
  }).filter(({ user, state }) =>
    (!roleFilter || user.role === roleFilter) &&
    (!stateFilter || state === stateFilter) &&
    (!needle || [user.username, user.githubLogin, user.name, user.id].some(value => value?.toLocaleLowerCase().includes(needle)))) ?? [];
  const isTarget = selected && selected.id !== viewerId && !selected.isSystemOwner;
  const canChange = isTarget && selected.status === 'active';
  const selectedSource = selected ? accountSource(selected, availableLogins) : '';
  const approvals = requests?.filter(entry => entry.status !== 'completed' || entry.requestedVia === 'agent' ||
    entry.requestedByAccountId !== entry.approvedByAccountId || entry.approvedByAccountId === undefined);
  const title = accountViews.find(([value]) => value === view)?.[1];

  return (
    <div className="min-w-0 space-y-5">
      <div className="account-access-view-select">
        <label className="sr-only" htmlFor="account-view">账号与登录视图</label>
        <select id="account-view" className={accountInputClass} value={view} onChange={event => changeView(event.target.value as AccountView)}>
          {accountViews.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      {readError ? (
        <Section title={title ?? '账号与登录'}>
          <ErrorBlock message={readError} /><Button className="mt-3" variant="outline" onClick={refresh}>重新读取</Button>
        </Section>
      ) : null}
      {view === 'members' && !selected && !readError ? (
        <Section title="账号与登录" description="每人一个 CDS 账号，登录方式、项目权限、会话、审计和 Key 通知归到同一个身份。"
          actions={<Button onClick={() => setCreateOpen(true)}><UserPlus />邀请成员</Button>}>
          {users ? (
            <>
              <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
                <MetricTile label="个人账号" value={users.length} detail={`${users.filter(user => user.role === 'admin' || user.role === 'owner').length} 位管理者`} />
                <MetricTile label="待批申请" value={requests ? requests.filter(item => item.status === 'pending').length : '—'} />
                <MetricTile label="待激活" value={users.filter(user => user.invitationPending).length} />
                <MetricTile label="共用系统账号" value={owner && systemSessions !== null ? `${systemSessions} 个会话` : '—'} />
                <MetricTile label="待交接 Key 通知" value={keyHandoffs ?? '—'} />
              </div>
              <div className="rounded-lg border border-border bg-card p-3 sm:p-4">
                <div className="account-member-filter mb-3 flex flex-wrap items-center gap-2">
                  <label className="relative block w-full sm:w-64">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                    <input aria-label="搜索成员" className={`${accountInputClass} pl-9`} placeholder="搜索账号、姓名或编号"
                      value={query} onChange={event => setQuery(event.target.value)} />
                  </label>
                  <select aria-label="角色筛选" className={`${accountInputClass} w-auto`} value={roleFilter} onChange={event => setRoleFilter(event.target.value)}>
                    <option value="">全部角色</option><option value="owner">系统所有者</option><option value="admin">管理员</option><option value="member">成员</option>
                  </select>
                  <select aria-label="状态筛选" className={`${accountInputClass} w-auto`} value={stateFilter} onChange={event => setStateFilter(event.target.value)}>
                    <option value="">全部状态</option>
                    {Object.entries(memberStateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <span className="ml-auto text-xs text-muted-foreground">{visibleUsers.length} / {users.length} 个账号</span>
                </div>
                {visibleUsers.length ? (
                <div className="overflow-hidden rounded-lg border border-border">
                  <div className="account-members-grid account-members-head bg-muted/45 px-3 py-2 text-xs text-muted-foreground" aria-hidden="true">
                    <span>账号</span><span>角色</span><span>登录方式</span><span>状态</span><span>最近登录</span><span />
                  </div>
                  <ul className="divide-y divide-border">
                  {visibleUsers.map(({ user, signIn, state }) => (
                    <li key={user.id}>
                      <button type="button" data-user-card={user.id}
                        className="account-members-grid w-full items-center px-3 py-3 text-left text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        aria-label={`查看 ${accountName(user)} 的账号详情`}
                        onClick={() => { setSelected(user); setEditError(''); changeView('members', user.id); }}>
                        <span className="flex min-w-0 items-center gap-3">
                          <CircleUser className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                          <span className="min-w-0"><strong className="block break-words">{user.name || accountName(user)}</strong>
                            <small className="block break-all text-muted-foreground">{accountName(user)}<span className="account-member-mobile"> · {accountRoleLabel(user)}</span></small></span>
                        </span>
                        <span className="account-member-desktop text-muted-foreground">{accountRoleLabel(user)}</span>
                        <span className="account-member-desktop min-w-0 break-words text-muted-foreground">{signIn || '—'}</span>
                        <span className={state === 'active' ? 'text-ok-ink' : 'text-warn-ink'}>
                          {memberStateLabels[state]}
                        </span>
                        <span className="account-member-desktop text-xs text-muted-foreground">{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : '尚未登录'}</span>
                        <ArrowRight size={15} className="account-member-desktop text-muted-foreground" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                  </ul>
                </div>
              ) : <EmptyBlock title={users.length ? '没有匹配成员' : '还没有成员'} description={users.length ? '调整搜索和筛选条件。' : '邀请成员自行激活一个独立账号。'} />}
              </div>
            </>
          ) : <LoadingBlock label="读取成员" />}
        </Section>
      ) : null}
      {view === 'approvals' && !subject && !readError ? (
        <Section title="待批申请" description={owner ? '逐项核对账号、实际影响及变更原因。执行结果留在原申请。' : '查看你提交的申请及其处理结果。'}
          actions={<Button variant="outline" onClick={refresh}>刷新申请</Button>}>
          {!approvals ? <LoadingBlock label="读取申请" /> : !approvals.length ? (
            <EmptyBlock title="没有账号操作申请" description="管理员和智能体提交的申请会出现在这里。所有者本人确认的结果可在账号审计查看。" />
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {approvals.map(entry => (
                <li key={entry.id}>
                  <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left text-sm hover:bg-muted/50"
                    onClick={() => { setSubject({ entry }); changeView('approvals', entry.id); }}>
                    <span className="break-words"><strong>{actionLabels[entry.action]}</strong> · {entry.targetName}</span>
                    <span className={entry.status === 'pending' ? 'text-warn-ink' : 'text-muted-foreground'}>{actionStateLabels[entry.status]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}
      {view === 'recovery' ? (
        <>
          <RecoveryRequestsPanel owner={owner} viewerId={viewerId} selectionId={selectionId} onSelect={id => changeView('recovery', id)} />
          {owner ? <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">设备接入与项目凭据恢复</summary>
            <IdentityRecoveryPanel onToast={onToast} /></details> : null}
        </>
      ) : null}
      {view === 'system' ? <SystemPasswordPanel owner={owner} /> : null}
      {view === 'keys' ? <KeyNotifications owner={owner} /> : null}
      {view === 'matrix' ? <AccountPermissionMatrix /> : null}

      {createOpen ? (
        <CreateMemberDialog owner={owner} durable={durableUsers} onClose={() => setCreateOpen(false)} onCreated={user => {
          onToast(`已创建 ${accountName(user)}`);
          refresh();
        }} />
      ) : null}
      {view === 'members' && selected ? (
        <Section title={selected.name || accountName(selected)}
          description={`${accountName(selected)} · ${accountRoleLabel(selected)} · ${memberStateLabels[memberState(selected, selectedSource)]}`}
          actions={<Button variant="outline" onClick={() => changeView('members')}>返回成员</Button>}>
          <div className="grid gap-4 lg:grid-cols-2">
            <dl className="grid gap-3 rounded-lg border border-border p-4 text-sm">
              <div><dt className="text-muted-foreground">账号编号</dt><dd className="break-all font-mono">{selected.id}</dd></div>
              <div><dt className="text-muted-foreground">可用登录方式</dt><dd>{selectedSource || '无可用登录方式'}</dd></div>
              <div><dt className="text-muted-foreground">新增身份绑定资格</dt><dd>{selected.externalLoginAllowed ? '已开通' : '未开通'}</dd></div>
              <div><dt className="text-muted-foreground">最近登录</dt><dd>{selected.lastLoginAt ? new Date(selected.lastLoginAt).toLocaleString() : '尚未登录'}</dd></div>
            </dl>
            <section className="space-y-3 rounded-lg border border-border p-4">
            <h3 className="font-semibold">账号操作</h3>
            {!selectedSource && selected.status === 'active' ? (
              <p className="text-sm text-muted-foreground">这个成员需要申请身份恢复。<Button variant="link" onClick={() => changeView('recovery')}>查看身份恢复</Button></p>
            ) : null}
            {editError ? <ErrorBlock message={editError} /> : null}
            <div className="flex flex-wrap gap-2">
              {canChange ? <Button variant="outline"
                onClick={() => void update(selected, { externalLoginAllowed: !selected.externalLoginAllowed })}>
                {selected.externalLoginAllowed ? '暂停新增绑定' : '开通绑定资格'}
              </Button> : null}
              {owner && isTarget ? <Button variant="outline" onClick={() => setGrantUser(selected)}>项目授权</Button> : null}
              {owner && canChange && selected.role === 'member' ? (
                <ConfirmAction scopeKey={selected.id} title="授予管理员"
                  description={`${accountName(selected)} 可管理普通成员和提交账号操作申请。`}
                  confirmLabel="授予管理员" onConfirm={() => update(selected, { role: 'admin' })}
                  trigger={<Button variant="outline">授予管理员</Button>} />
              ) : null}
              {owner && isTarget && selected.status === 'disabled' ? (
                <ConfirmAction scopeKey={selected.id} title="启用账号" description={`恢复 ${accountName(selected)} 的原项目权限。`}
                  confirmLabel="启用账号" onConfirm={() => update(selected, { status: 'active' })}
                  trigger={<Button variant="outline">启用账号</Button>} />
              ) : null}
              {canChange ? ([
                ...(selected.authProvider === 'local' && selected.hasPassword !== false ? ['reset-password'] : []),
                'revoke-sessions', 'disable-user',
                ...(selected.linkedLogins?.github ? ['unlink-github'] : []),
                ...(selected.linkedLogins?.google ? ['unlink-google'] : []),
                ...(owner && selected.role === 'admin' ? ['revoke-admin'] : []),
              ] as AccountAction[]).map(action => (
                <Button key={action} variant="outline" onClick={() => setSubject({ user: selected, action })}>{actionLabels[action]}</Button>
              )) : null}
            </div>
            </section>
          </div>
        </Section>
      ) : null}
      {subject && 'entry' in subject && subject.entry.action === 'rotate-system-password' ? (
        <SystemPasswordDialog key={subject.entry.id} accountName={subject.entry.targetName} initial={subject.entry}
          onClose={() => { setSubject(null); changeView('approvals'); }} onChange={refresh} />
      ) : subject ? <AccountActionDialog key={'entry' in subject ? subject.entry.id : subject.user.id + subject.action}
        subject={subject} owner={owner} viewerId={viewerId}
        inline={view === 'approvals' && 'entry' in subject}
        onClose={() => { setSubject(null); if (view === 'approvals' || !selected) changeView(view); }}
        onChange={entry => {
          if (entry.status === 'completed') {
            onToast('已执行，回执已保存');
          } else if (!owner) onToast('已登记，可在待批申请中回读');
          refresh();
        }} /> : null}
      <UserProjectAccessDialog user={grantUser} onClose={() => setGrantUser(null)} onToast={onToast} />
    </div>
  );
}

function CreateMemberDialog({ owner, durable, onClose, onCreated }: {
  owner: boolean; durable: boolean; onClose: () => void; onCreated: (user: CdsPublicUser) => void;
}): JSX.Element {
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [method, setMethod] = useState<'invite' | 'password'>('invite');
  const [invitation, setInvitation] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError('');
    const input = { username, name: name || undefined, role, externalLoginAllowed: true };
    try {
      if (method === 'invite') {
        const { user, invitation: issued } = await inviteLocalUser(input);
        setInvitation({ url: new URL(issued.path, window.location.origin).href, expiresAt: issued.expiresAt });
        onCreated(user);
      } else {
        onCreated(await createLocalUser({ ...input, password }));
        onClose();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-auto">
        <DialogHeader><DialogTitle>{invitation ? '账号已创建' : '创建账号'}</DialogTitle>
          <DialogDescription>{durable ? '成员可以自行选择可用的登录方式。' : '当前实例使用内存存储，重启后新账号会丢失。'}</DialogDescription>
        </DialogHeader>
        {invitation ? (
          <div className="grid gap-3">
            <Field label="一次性激活链接">
              <input aria-label="一次性激活链接" className={accountInputClass} readOnly value={invitation.url}
                onFocus={event => event.target.select()} />
            </Field>
            <p className="text-sm text-muted-foreground">仅发给此成员。链接有效至 {new Date(invitation.expiresAt).toLocaleString()}。</p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => { void navigator.clipboard.writeText(invitation.url).then(() => setCopied(true)).catch(() => setError('请选中链接并手动复制')); }}>
                {copied ? '已复制' : '复制激活链接'}
              </Button>
              <Button variant="outline" onClick={onClose}>完成</Button>
            </div>
            {error ? <ErrorBlock message={error} /> : null}
          </div>
        ) : <form onSubmit={submit} className="grid gap-3">
          <Field label="用户名"><input aria-label="用户名" className={accountInputClass} required minLength={3} maxLength={32}
            value={username} onChange={event => setUsername(event.target.value)} disabled={busy} autoComplete="off" /></Field>
          <Field label="显示名"><input aria-label="显示名" className={accountInputClass} maxLength={100}
            value={name} onChange={event => setName(event.target.value)} disabled={busy} autoComplete="off" /></Field>
          {owner ? <Field label="角色"><select aria-label="角色" className={accountInputClass} value={role} disabled={busy}
            onChange={event => setRole(event.target.value === 'admin' ? 'admin' : 'member')}>
            <option value="member">成员</option><option value="admin">管理员</option>
          </select></Field> : null}
          <Field label="首次登录">
            <select aria-label="首次登录" className={accountInputClass} value={method} disabled={busy}
              onChange={event => setMethod(event.target.value === 'password' ? 'password' : 'invite')}>
              <option value="invite">一次性邀请，成员自行激活</option>
              <option value="password">设置初始口令</option>
            </select>
          </Field>
          {method === 'password' ? <Field label="初始口令（至少 8 位）"><input aria-label="初始口令" className={accountInputClass} type="password" required minLength={8} maxLength={512}
            value={password} onChange={event => setPassword(event.target.value)} disabled={busy} autoComplete="new-password" /></Field> : null}
          {error ? <ErrorBlock message={error} /> : null}
          <Button type="submit" className="justify-self-start" disabled={busy}>{busy ? '正在创建' : '创建账号'}</Button>
        </form>}
      </DialogContent>
    </Dialog>
  );
}

const permissionRows = [
  ['创建普通成员', '可执行', '可执行', '—', '—'],
  ['授予管理员', '可执行', '—', '—', '—'],
  ['重置他人口令、停用、退出会话', '逐次确认', '对成员提交申请', '—', '授权设备仅在项目内提案'],
  ['撤销管理员', '逐次确认', '—', '—', '—'],
  ['修改本人口令', '个人账号可用', '可执行', '可执行', '—'],
  ['账号审计', '全部', '本人及发起的申请', '本人', '仅回读本设备提案'],
] as const;

function AccountPermissionMatrix(): JSX.Element {
  const columns = ['系统所有者', '管理员', '成员', '智能体'];
  return <Section title="权限矩阵" description="管理员管理普通成员。系统设置与高风险批准由系统所有者负责。">
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {columns.map((column, index) => <li className="min-w-0 rounded-lg border border-border bg-card p-4" key={column}>
        <h3 className="mb-2 font-semibold">{column}</h3>
        <dl className="divide-y divide-border text-sm">{permissionRows.map(([action, ...scope]) => <div className="py-2" key={action}>
          <dt className="text-muted-foreground">{action}</dt><dd className="font-medium">{scope[index]}</dd>
        </div>)}</dl>
      </li>)}
    </ul>
  </Section>;
}
