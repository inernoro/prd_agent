import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/design/Badge';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { getUsers, createUser, bulkCreateUsers, generateInviteCodes, updateUserPassword, updateUserRole, updateUserStatus, unlockUser, forceExpireUser } from '@/services';
import { CheckCircle2, Circle, XCircle } from 'lucide-react';

type UserRow = {
  userId: string;
  username: string;
  displayName: string;
  role: 'PM' | 'DEV' | 'QA' | 'ADMIN';
  status: 'Active' | 'Disabled';
  createdAt: string;
  lastLoginAt?: string;
  isLocked?: boolean;
  lockoutRemainingSeconds?: number;
};

function fmtDateTime(v?: string | null) {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
}

function fmtRelative(v?: string | null) {
  if (!v) return '';
  const d = new Date(v);
  const t = d.getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const abs = Math.abs(diff);

  const sec = Math.floor(abs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  const suffix = diff >= 0 ? '前' : '后';
  if (sec < 60) return `${sec} 秒${suffix}`;
  if (min < 60) return `${min} 分钟${suffix}`;
  if (hr < 24) return `${hr} 小时${suffix}`;
  if (day < 30) return `${day} 天${suffix}`;
  return '';
}

const passwordRules: Array<{ key: string; label: string; test: (pwd: string) => boolean }> = [
  { key: 'len', label: '长度 8-128 位', test: (pwd) => pwd.length >= 8 && pwd.length <= 128 },
  { key: 'lower', label: '包含小写字母', test: (pwd) => /[a-z]/.test(pwd) },
  { key: 'upper', label: '包含大写字母', test: (pwd) => /[A-Z]/.test(pwd) },
  { key: 'digit', label: '包含数字', test: (pwd) => /\d/.test(pwd) },
  { key: 'special', label: '包含特殊字符（如 !@#$ 等）', test: (pwd) => /[!@#$%^&*(),.?":{}|<>]/.test(pwd) },
];

export default function UsersPage() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<UserRow['role'] | ''>('');
  const [status, setStatus] = useState<UserRow['status'] | ''>('');

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteCount, setInviteCount] = useState(1);
  const [inviteCodes, setInviteCodes] = useState<string[]>([]);

  const [createOpen, setCreateOpen] = useState(false);
  const [createUsername, setCreateUsername] = useState('');
  const [createDisplayName, setCreateDisplayName] = useState('');
  const [createRole, setCreateRole] = useState<UserRow['role']>('DEV');
  const [createPwd, setCreatePwd] = useState('');
  const [createPwd2, setCreatePwd2] = useState('');
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<{ userId: string; username: string } | null>(null);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkPrefix, setBulkPrefix] = useState('');
  const [bulkStart, setBulkStart] = useState(1);
  const [bulkCount, setBulkCount] = useState(5);
  const [bulkRole, setBulkRole] = useState<UserRow['role']>('DEV');
  const [bulkPwd, setBulkPwd] = useState('');
  const [bulkPwd2, setBulkPwd2] = useState('');
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<{
    requestedCount: number;
    createdCount: number;
    failedCount: number;
    createdItems: Array<{ userId: string; username: string }>;
    failedItems: Array<{ username: string; code: string; message: string }>;
  } | null>(null);

  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdUser, setPwdUser] = useState<UserRow | null>(null);
  const [pwd, setPwd] = useState('');
  const [pwd2, setPwd2] = useState('');
  const [pwdSubmitError, setPwdSubmitError] = useState<string | null>(null);
  const [pwdSubmitting, setPwdSubmitting] = useState(false);

  const [forceExpireOpen, setForceExpireOpen] = useState(false);
  const [forceExpireTargetUser, setForceExpireTargetUser] = useState<UserRow | null>(null);
  const [forceExpireSubmitting, setForceExpireSubmitting] = useState(false);
  const [forceExpireError, setForceExpireError] = useState<string | null>(null);
  const [forceTargets, setForceTargets] = useState<{ admin: boolean; desktop: boolean }>({ admin: true, desktop: true });

  const [unlockingUserId, setUnlockingUserId] = useState<string | null>(null);

  const pwdChecks = useMemo(() => {
    const v = pwd ?? '';
    const touched = v.length > 0;
    return passwordRules.map((r) => ({ ...r, ok: touched ? r.test(v) : false, touched }));
  }, [pwd]);

  const pwdAllOk = useMemo(() => {
    if (!pwd) return false;
    return passwordRules.every((r) => r.test(pwd));
  }, [pwd]);

  const pwdMatchOk = useMemo(() => {
    if (!pwd || !pwd2) return false;
    return pwd === pwd2;
  }, [pwd, pwd2]);

  const createUsernameOk = useMemo(() => {
    const u = (createUsername ?? '').trim();
    if (!u) return false;
    if (u.length < 4 || u.length > 32) return false;
    return /^[a-zA-Z0-9_]+$/.test(u);
  }, [createUsername]);

  const createPwdChecks = useMemo(() => {
    const v = createPwd ?? '';
    const touched = v.length > 0;
    return passwordRules.map((r) => ({ ...r, ok: touched ? r.test(v) : false, touched }));
  }, [createPwd]);

  const createPwdNonEmptyOk = useMemo(() => {
    return (createPwd ?? '').trim().length > 0;
  }, [createPwd]);

  const createPwdMatchOk = useMemo(() => {
    if (!createPwd || !createPwd2) return false;
    return createPwd === createPwd2;
  }, [createPwd, createPwd2]);

  const bulkPwdChecks = useMemo(() => {
    const v = bulkPwd ?? '';
    const touched = v.length > 0;
    return passwordRules.map((r) => ({ ...r, ok: touched ? r.test(v) : false, touched }));
  }, [bulkPwd]);

  const bulkPwdNonEmptyOk = useMemo(() => {
    return (bulkPwd ?? '').trim().length > 0;
  }, [bulkPwd]);

  const bulkPwdMatchOk = useMemo(() => {
    if (!bulkPwd || !bulkPwd2) return false;
    return bulkPwd === bulkPwd2;
  }, [bulkPwd, bulkPwd2]);

  const bulkUsernames = useMemo(() => {
    const prefix = (bulkPrefix ?? '').trim();
    const count = Math.max(1, Math.min(200, Math.floor(bulkCount || 1)));
    const start = Math.max(0, Math.floor(bulkStart || 0));
    if (!prefix) return [];
    const maxIndex = start + count - 1;
    const width = Math.max(2, String(maxIndex).length);
    const arr: string[] = [];
    for (let i = 0; i < count; i++) {
      arr.push(`${prefix}${String(start + i).padStart(width, '0')}`);
    }
    return arr;
  }, [bulkPrefix, bulkStart, bulkCount]);

  const bulkUsernamesOk = useMemo(() => {
    if (bulkUsernames.length === 0) return false;
    return bulkUsernames.every((u) => {
      if (u.length < 4 || u.length > 32) return false;
      return /^[a-zA-Z0-9_]+$/.test(u);
    });
  }, [bulkUsernames]);

  const query = useMemo(
    () => ({ page, pageSize: 20, search: search.trim() || undefined, role: role || undefined, status: status || undefined }),
    [page, search, role, status]
  );

  const load = async () => {
    setLoading(true);
    try {
      const res = await getUsers(query);
      if (res.success) {
        setItems(res.data.items);
        setTotal(res.data.total);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.page, query.search, query.role, query.status]);

  const onGenerate = async () => {
    const res = await generateInviteCodes(inviteCount);
    if (res.success) setInviteCodes(res.data.codes);
  };

  const onCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
  };

  const openCreateUser = () => {
    setCreateUsername('');
    setCreateDisplayName('');
    setCreateRole('DEV');
    setCreatePwd('');
    setCreatePwd2('');
    setCreateError(null);
    setCreateResult(null);
    setCreateSubmitting(false);
    setCreateOpen(true);
  };

  const submitCreateUser = async () => {
    if (!createUsernameOk) return;
    if (!createPwdNonEmptyOk) return;
    if (!createPwdMatchOk) return;

    setCreateSubmitting(true);
    setCreateError(null);
    try {
      const res = await createUser({
        username: createUsername.trim(),
        displayName: createDisplayName.trim() || undefined,
        role: createRole,
        password: createPwd,
      });
      if (!res.success) {
        setCreateError(res.error?.message || '创建失败');
        return;
      }
      setCreateResult({ userId: res.data.userId, username: res.data.username });
      await load();
    } finally {
      setCreateSubmitting(false);
    }
  };

  const openBulkCreate = () => {
    setBulkPrefix('');
    setBulkStart(1);
    setBulkCount(5);
    setBulkRole('DEV');
    setBulkPwd('');
    setBulkPwd2('');
    setBulkError(null);
    setBulkResult(null);
    setBulkSubmitting(false);
    setBulkOpen(true);
  };

  const submitBulkCreate = async () => {
    if (!bulkUsernamesOk) {
      setBulkError('生成的用户名不合法（需 4-32 位，仅字母/数字/下划线）');
      return;
    }
    if (!bulkPwdNonEmptyOk) return;
    if (!bulkPwdMatchOk) return;

    setBulkSubmitting(true);
    setBulkError(null);
    try {
      const items = bulkUsernames.map((u) => ({
        username: u,
        displayName: u,
        role: bulkRole,
        password: bulkPwd,
      }));
      const res = await bulkCreateUsers(items);
      if (!res.success) {
        setBulkError(res.error?.message || '批量创建失败');
        return;
      }
      setBulkResult(res.data);
      await load();
    } finally {
      setBulkSubmitting(false);
    }
  };

  const openChangePassword = (u: UserRow) => {
    setPwdUser(u);
    setPwd('');
    setPwd2('');
    setPwdSubmitError(null);
    setPwdOpen(true);
  };

  const isLockedUser = (u: UserRow) => {
    const remaining = typeof u.lockoutRemainingSeconds === 'number' ? u.lockoutRemainingSeconds : 0;
    if (remaining > 0) return true;
    return u.isLocked === true;
  };

  const onUnlock = async (u: UserRow) => {
    if (!u?.userId) return;
    setUnlockingUserId(u.userId);
    try {
      const res = await unlockUser(u.userId);
      if (!res.success) return;
      await load();
    } finally {
      setUnlockingUserId(null);
    }
  };

  const submitChangePassword = async () => {
    if (!pwdUser) return;
    if (!pwdAllOk) return;
    if (!pwdMatchOk) return;

    setPwdSubmitting(true);
    setPwdSubmitError(null);
    try {
      const res = await updateUserPassword(pwdUser.userId, pwd);
      if (!res.success) {
        setPwdSubmitError(res.error?.message || '修改失败');
        return;
      }
      setPwdOpen(false);
    } finally {
      setPwdSubmitting(false);
    }
  };

  const openForceExpire = (u: UserRow) => {
    setForceExpireTargetUser(u);
    setForceExpireError(null);
    setForceExpireSubmitting(false);
    setForceTargets({ admin: true, desktop: true });
    setForceExpireOpen(true);
  };

  const submitForceExpire = async () => {
    if (!forceExpireTargetUser) return;
    const targets: Array<'admin' | 'desktop'> = [];
    if (forceTargets.admin) targets.push('admin');
    if (forceTargets.desktop) targets.push('desktop');
    if (targets.length === 0) {
      setForceExpireError('请至少选择一个端（admin/desktop）');
      return;
    }

    setForceExpireSubmitting(true);
    setForceExpireError(null);
    try {
      const res = await forceExpireUser(forceExpireTargetUser.userId, targets);
      if (!res.success) {
        setForceExpireError(res.error?.message || '踢下线失败');
        return;
      }
      setForceExpireOpen(false);
    } finally {
      setForceExpireSubmitting(false);
    }
  };

  return (
    <div className="h-full flex flex-col gap-6">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>用户管理</div>
          <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>共 {total} 个用户</div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={openCreateUser}>
            创建用户
          </Button>
          <Button variant="secondary" size="sm" onClick={openBulkCreate}>
            批量创建
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setInviteOpen(true);
              setInviteCodes([]);
            }}
          >
            生成邀请码
          </Button>
        </div>
      </div>

      <Card className="flex-1 min-h-0 flex flex-col">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[220px]">
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="h-10 w-full rounded-[14px] px-4 text-sm outline-none"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              placeholder="搜索用户名或昵称"
            />
          </div>

          <select
            value={role}
            onChange={(e) => {
              setRole((e.target.value as UserRow['role'] | '') ?? '');
              setPage(1);
            }}
            className="h-10 rounded-[14px] px-3 text-sm"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
          >
            <option value="">角色</option>
            <option value="PM">PM</option>
            <option value="DEV">DEV</option>
            <option value="QA">QA</option>
            <option value="ADMIN">ADMIN</option>
          </select>

          <select
            value={status}
            onChange={(e) => {
              setStatus((e.target.value as UserRow['status'] | '') ?? '');
              setPage(1);
            }}
            className="h-10 rounded-[14px] px-3 text-sm"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
          >
            <option value="">状态</option>
            <option value="Active">正常</option>
            <option value="Disabled">禁用</option>
          </select>

          {null}
        </div>

        <div className="mt-5 flex-1 min-h-0 overflow-auto rounded-[16px]" style={{ border: '1px solid var(--border-subtle)' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'rgba(255,255,255,0.03)' }}>
              <tr>
                <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>用户</th>
                <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>角色</th>
                <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>状态</th>
                <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>最后登录时间</th>
                <th className="text-right px-4 py-3" style={{ color: 'var(--text-secondary)' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center" style={{ color: 'var(--text-muted)' }}>暂无数据</td>
                </tr>
              ) : (
                items.map((u) => (
                  <tr key={u.userId} className="hover:bg-white/2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td className="px-4 py-3">
                      <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>{u.username}</div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{u.displayName}</div>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={u.role}
                        onChange={async (e) => {
                          await updateUserRole(u.userId, e.target.value as UserRow['role']);
                          await load();
                        }}
                        className="h-9 rounded-[12px] px-3 text-sm"
                        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                      >
                        <option value="PM">PM</option>
                        <option value="DEV">DEV</option>
                        <option value="QA">QA</option>
                        <option value="ADMIN">ADMIN</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={u.status}
                        onChange={async (e) => {
                          await updateUserStatus(u.userId, e.target.value as UserRow['status']);
                          await load();
                        }}
                        className="h-9 rounded-[12px] px-3 text-sm"
                        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                      >
                        <option value="Active">正常</option>
                        <option value="Disabled">禁用</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      {!u.lastLoginAt ? (
                        <Badge variant="subtle">从未登录</Badge>
                      ) : (
                        <div className="flex flex-col">
                          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {fmtDateTime(u.lastLoginAt)}
                          </div>
                          <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                            {fmtRelative(u.lastLoginAt)}
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {isLockedUser(u) && (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={unlockingUserId === u.userId}
                            onClick={() => onUnlock(u)}
                            title={
                              typeof u.lockoutRemainingSeconds === 'number' && u.lockoutRemainingSeconds > 0
                                ? `当前锁定剩余 ${u.lockoutRemainingSeconds} 秒`
                                : '解除登录锁定'
                            }
                          >
                            {unlockingUserId === u.userId ? '解除中...' : '解除锁定'}
                          </Button>
                        )}
                        <Button variant="secondary" size="sm" onClick={() => openForceExpire(u)}>
                          一键过期
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => openChangePassword(u)}>
                          修改密码
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div className="text-sm" style={{ color: 'var(--text-muted)' }}>第 {page} 页 / 共 {Math.max(1, Math.ceil(total / 20))} 页</div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= Math.ceil(total / 20)}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      </Card>

      <Dialog
        open={createOpen}
        onOpenChange={(v) => {
          setCreateOpen(v);
          if (!v) {
            setCreateUsername('');
            setCreateDisplayName('');
            setCreateRole('DEV');
            setCreatePwd('');
            setCreatePwd2('');
            setCreateError(null);
            setCreateResult(null);
            setCreateSubmitting(false);
          }
        }}
        title="创建用户"
        description="创建账号（用户名）+ 密码 + 角色"
        content={
          <div className="space-y-4">
            <div className="grid gap-3">
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>用户名</div>
                <input
                  value={createUsername}
                  onChange={(e) => {
                    setCreateUsername(e.target.value);
                    setCreateError(null);
                    setCreateResult(null);
                  }}
                  className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  placeholder="4-32 位，仅字母/数字/下划线"
                  autoComplete="off"
                />
              </div>

              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>显示名称（可选）</div>
                <input
                  value={createDisplayName}
                  onChange={(e) => {
                    setCreateDisplayName(e.target.value);
                    setCreateError(null);
                    setCreateResult(null);
                  }}
                  className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  placeholder="默认同用户名（上限 50）"
                  autoComplete="off"
                />
              </div>

              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>角色</div>
                <select
                  value={createRole}
                  onChange={(e) => setCreateRole(e.target.value as UserRow['role'])}
                  className="mt-2 h-10 w-full rounded-[14px] px-3 text-sm"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                >
                  <option value="PM">PM</option>
                  <option value="DEV">DEV</option>
                  <option value="QA">QA</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
              </div>

              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>密码</div>
                <input
                  value={createPwd}
                  onChange={(e) => {
                    setCreatePwd(e.target.value);
                    setCreateError(null);
                    setCreateResult(null);
                  }}
                  type="password"
                  className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  placeholder="任意非空（强烈建议使用复杂密码）"
                  autoComplete="new-password"
                />
              </div>

              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>确认密码</div>
                <input
                  value={createPwd2}
                  onChange={(e) => {
                    setCreatePwd2(e.target.value);
                    setCreateError(null);
                    setCreateResult(null);
                  }}
                  type="password"
                  className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  placeholder="再次输入密码"
                  autoComplete="new-password"
                />
              </div>
            </div>

            <div
              className="rounded-[16px] px-4 py-3"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}
            >
              <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>密码建议（不影响创建）</div>
              <div className="mt-2 grid gap-1">
                {createPwdChecks.map((r) => {
                  const ok = r.touched ? r.ok : false;
                  const state: 'todo' | 'ok' | 'bad' = !r.touched ? 'todo' : ok ? 'ok' : 'bad';
                  const color = state === 'ok' ? 'rgba(34,197,94,0.95)' : state === 'bad' ? 'rgba(239,68,68,0.95)' : 'var(--text-muted)';
                  const Icon = state === 'ok' ? CheckCircle2 : state === 'bad' ? XCircle : Circle;
                  return (
                    <div key={r.key} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                      <Icon size={16} style={{ color }} />
                      <span style={{ color: 'var(--text-primary)' }}>{r.label}</span>
                    </div>
                  );
                })}
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                  {createPwd2.length === 0 ? (
                    <Circle size={16} style={{ color: 'var(--text-muted)' }} />
                  ) : createPwdMatchOk ? (
                    <CheckCircle2 size={16} style={{ color: 'rgba(34,197,94,0.95)' }} />
                  ) : (
                    <XCircle size={16} style={{ color: 'rgba(239,68,68,0.95)' }} />
                  )}
                  <span style={{ color: 'var(--text-primary)' }}>两次输入一致</span>
                </div>
              </div>
            </div>

            {!createUsernameOk && createUsername.trim().length > 0 && (
              <div className="text-sm" style={{ color: 'rgba(239,68,68,0.95)' }}>
                用户名不合法：4-32 位，仅字母/数字/下划线
              </div>
            )}

            {createResult && (
              <div
                className="rounded-[14px] px-4 py-3 text-sm"
                style={{ background: 'rgba(34,197,94,0.10)', border: '1px solid rgba(34,197,94,0.28)', color: 'rgba(34,197,94,0.95)' }}
              >
                已创建：{createResult.username}（{createResult.userId}）
              </div>
            )}

            {createError && (
              <div
                className="rounded-[14px] px-4 py-3 text-sm"
                style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.28)', color: 'rgba(239,68,68,0.95)' }}
              >
                {createError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)} disabled={createSubmitting}>
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={submitCreateUser}
                disabled={createSubmitting || !createUsernameOk || !createPwdNonEmptyOk || !createPwdMatchOk}
              >
                {createSubmitting ? '创建中...' : '确认创建'}
              </Button>
            </div>
          </div>
        }
      />

      <Dialog
        open={bulkOpen}
        onOpenChange={(v) => {
          setBulkOpen(v);
          if (!v) {
            setBulkPrefix('');
            setBulkStart(1);
            setBulkCount(5);
            setBulkRole('DEV');
            setBulkPwd('');
            setBulkPwd2('');
            setBulkError(null);
            setBulkResult(null);
            setBulkSubmitting(false);
          }
        }}
        title="批量创建用户"
        description="按前缀 + 数量生成用户名，统一密码与角色"
        maxWidth={900}
        content={
          <div className="space-y-4">
            <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 140px 140px 180px' }}>
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>用户名前缀</div>
                <input
                  value={bulkPrefix}
                  onChange={(e) => {
                    setBulkPrefix(e.target.value);
                    setBulkError(null);
                    setBulkResult(null);
                  }}
                  className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  placeholder="例如 dev_"
                  autoComplete="off"
                />
              </div>
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>起始编号</div>
                <input
                  type="number"
                  min={0}
                  value={bulkStart}
                  onChange={(e) => {
                    setBulkStart(Number(e.target.value || 0));
                    setBulkError(null);
                    setBulkResult(null);
                  }}
                  className="mt-2 h-10 w-full rounded-[14px] px-3 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                />
              </div>
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>数量</div>
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={bulkCount}
                  onChange={(e) => {
                    setBulkCount(Number(e.target.value || 1));
                    setBulkError(null);
                    setBulkResult(null);
                  }}
                  className="mt-2 h-10 w-full rounded-[14px] px-3 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                />
              </div>
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>角色</div>
                <select
                  value={bulkRole}
                  onChange={(e) => setBulkRole(e.target.value as UserRow['role'])}
                  className="mt-2 h-10 w-full rounded-[14px] px-3 text-sm"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                >
                  <option value="PM">PM</option>
                  <option value="DEV">DEV</option>
                  <option value="QA">QA</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
              </div>
            </div>

            <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>统一密码</div>
                <input
                  value={bulkPwd}
                  onChange={(e) => {
                    setBulkPwd(e.target.value);
                    setBulkError(null);
                    setBulkResult(null);
                  }}
                  type="password"
                  className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  placeholder="任意非空（强烈建议使用复杂密码）"
                  autoComplete="new-password"
                />
              </div>
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>确认密码</div>
                <input
                  value={bulkPwd2}
                  onChange={(e) => {
                    setBulkPwd2(e.target.value);
                    setBulkError(null);
                    setBulkResult(null);
                  }}
                  type="password"
                  className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  placeholder="再次输入密码"
                  autoComplete="new-password"
                />
              </div>
            </div>

            <div
              className="rounded-[16px] px-4 py-3"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}
            >
              <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>预览（最多显示前 30 条）</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {bulkUsernames.slice(0, 30).map((u) => (
                  <code
                    key={u}
                    className="rounded-[10px] px-2 py-1 text-[12px]"
                    style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-primary)' }}
                  >
                    {u}
                  </code>
                ))}
                {bulkUsernames.length > 30 && (
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>… 共 {bulkUsernames.length} 条</span>
                )}
              </div>
              {!bulkUsernamesOk && bulkUsernames.length > 0 && (
                <div className="mt-2 text-sm" style={{ color: 'rgba(239,68,68,0.95)' }}>
                  生成的用户名不合法：4-32 位，仅字母/数字/下划线（请检查前缀与长度）
                </div>
              )}
            </div>

            <div
              className="rounded-[16px] px-4 py-3"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}
            >
              <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>密码建议（不影响创建）</div>
              <div className="mt-2 grid gap-1">
                {bulkPwdChecks.map((r) => {
                  const ok2 = r.touched ? r.ok : false;
                  const state: 'todo' | 'ok' | 'bad' = !r.touched ? 'todo' : ok2 ? 'ok' : 'bad';
                  const color = state === 'ok' ? 'rgba(34,197,94,0.95)' : state === 'bad' ? 'rgba(239,68,68,0.95)' : 'var(--text-muted)';
                  const Icon = state === 'ok' ? CheckCircle2 : state === 'bad' ? XCircle : Circle;
                  return (
                    <div key={r.key} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                      <Icon size={16} style={{ color }} />
                      <span style={{ color: 'var(--text-primary)' }}>{r.label}</span>
                    </div>
                  );
                })}
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                  {bulkPwd2.length === 0 ? (
                    <Circle size={16} style={{ color: 'var(--text-muted)' }} />
                  ) : bulkPwdMatchOk ? (
                    <CheckCircle2 size={16} style={{ color: 'rgba(34,197,94,0.95)' }} />
                  ) : (
                    <XCircle size={16} style={{ color: 'rgba(239,68,68,0.95)' }} />
                  )}
                  <span style={{ color: 'var(--text-primary)' }}>两次输入一致</span>
                </div>
              </div>
            </div>

            {bulkResult && (
              <div
                className="rounded-[14px] px-4 py-3 text-sm"
                style={{ background: 'rgba(34,197,94,0.10)', border: '1px solid rgba(34,197,94,0.28)', color: 'rgba(34,197,94,0.95)' }}
              >
                批量创建完成：成功 {bulkResult.createdCount} 个，失败 {bulkResult.failedCount} 个（请求 {bulkResult.requestedCount} 个）
              </div>
            )}

            {bulkError && (
              <div
                className="rounded-[14px] px-4 py-3 text-sm"
                style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.28)', color: 'rgba(239,68,68,0.95)' }}
              >
                {bulkError}
              </div>
            )}

            {bulkResult?.failedItems?.length ? (
              <div
                className="rounded-[16px] px-4 py-3"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}
              >
                <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>失败明细（最多显示前 50 条）</div>
                <div className="mt-2 grid gap-1">
                  {bulkResult.failedItems.slice(0, 50).map((x) => (
                    <div key={`${x.username}:${x.code}:${x.message}`} className="text-sm" style={{ color: 'var(--text-primary)' }}>
                      <span style={{ color: 'rgba(239,68,68,0.95)' }}>{x.username || '(空)'}</span>
                      <span style={{ color: 'var(--text-muted)' }}> · {x.code}</span>
                      <span style={{ color: 'var(--text-muted)' }}> · {x.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={bulkUsernames.length === 0}
                  onClick={() => onCopy(bulkUsernames.join('\n'))}
                >
                  复制账号清单
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={bulkUsernames.length === 0 || !bulkPwd}
                  onClick={() => onCopy(bulkUsernames.map((u) => `${u}\t${bulkPwd}`).join('\n'))}
                >
                  复制账号+密码
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setBulkOpen(false)} disabled={bulkSubmitting}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={submitBulkCreate}
                  disabled={bulkSubmitting || !bulkUsernamesOk || !bulkPwdNonEmptyOk || !bulkPwdMatchOk}
                >
                  {bulkSubmitting ? '创建中...' : '确认创建'}
                </Button>
              </div>
            </div>
          </div>
        }
      />

      <Dialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        title="生成邀请码"
        description="生成后可复制分发"
        content={
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={1}
                max={50}
                value={inviteCount}
                onChange={(e) => setInviteCount(Number(e.target.value || 1))}
                className="h-10 w-[120px] rounded-[14px] px-3 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              />
              <Button variant="secondary" size="sm" onClick={onGenerate}>
                生成
              </Button>
            </div>

            {inviteCodes.length > 0 && (
              <div className="grid gap-2">
                {inviteCodes.map((code) => (
                  <div
                    key={code}
                    className="flex items-center justify-between rounded-[14px] px-4 py-3"
                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}
                  >
                    <code className="text-sm" style={{ color: 'var(--accent-green)' }}>{code}</code>
                    <Button variant="secondary" size="sm" onClick={() => onCopy(code)}>
                      复制
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        }
      />

      <Dialog
        open={pwdOpen}
        onOpenChange={(v) => {
          setPwdOpen(v);
          if (!v) {
            setPwdUser(null);
            setPwd('');
            setPwd2('');
            setPwdSubmitError(null);
            setPwdSubmitting(false);
          }
        }}
        title={pwdUser ? `修改密码：${pwdUser.username}` : '修改密码'}
        description={pwdUser ? `${pwdUser.displayName} · ${pwdUser.userId}` : undefined}
        content={
          <div className="space-y-4">
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>新密码</div>
              <input
                value={pwd}
                onChange={(e) => {
                  setPwd(e.target.value);
                  setPwdSubmitError(null);
                }}
                type="password"
                className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                placeholder="至少8位，含大小写、数字、特殊字符"
                autoComplete="new-password"
              />
            </div>

            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>确认新密码</div>
              <input
                value={pwd2}
                onChange={(e) => {
                  setPwd2(e.target.value);
                  setPwdSubmitError(null);
                }}
                type="password"
                className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                placeholder="再次输入新密码"
                autoComplete="new-password"
              />
            </div>

            <div
              className="rounded-[16px] px-4 py-3"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)' }}
            >
              <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>密码要求（实时校验）</div>
              <div className="mt-2 rounded-[14px]" style={{ background: 'rgba(0,0,0,0.10)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <ul className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
                  {pwdChecks.map((r) => {
                    const ok = r.touched ? r.ok : false;
                    const state: 'todo' | 'ok' | 'bad' = !r.touched ? 'todo' : ok ? 'ok' : 'bad';
                    const color = state === 'ok' ? 'rgba(34,197,94,0.95)' : state === 'bad' ? 'rgba(239,68,68,0.95)' : 'var(--text-muted)';
                    const Icon = state === 'ok' ? CheckCircle2 : state === 'bad' ? XCircle : Circle;
                    const statusText = state === 'ok' ? '通过' : state === 'bad' ? '未通过' : '待输入';
                    const statusBg =
                      state === 'ok'
                        ? 'rgba(34,197,94,0.10)'
                        : state === 'bad'
                          ? 'rgba(239,68,68,0.10)'
                          : 'rgba(255,255,255,0.03)';
                    const statusBorder =
                      state === 'ok'
                        ? 'rgba(34,197,94,0.28)'
                        : state === 'bad'
                          ? 'rgba(239,68,68,0.28)'
                          : 'rgba(255,255,255,0.10)';

                    return (
                      <li key={r.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <Icon size={16} style={{ color }} />
                          <div className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                            {r.label}
                          </div>
                        </div>
                        <span
                          className="shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold"
                          style={{ color, background: statusBg, border: `1px solid ${statusBorder}` }}
                        >
                          {statusText}
                        </span>
                      </li>
                    );
                  })}

                  {(() => {
                    const state: 'todo' | 'ok' | 'bad' = pwd2.length === 0 ? 'todo' : pwdMatchOk ? 'ok' : 'bad';
                    const color = state === 'ok' ? 'rgba(34,197,94,0.95)' : state === 'bad' ? 'rgba(239,68,68,0.95)' : 'var(--text-muted)';
                    const Icon = state === 'ok' ? CheckCircle2 : state === 'bad' ? XCircle : Circle;
                    const statusText = state === 'ok' ? '通过' : state === 'bad' ? '未通过' : '待输入';
                    const statusBg =
                      state === 'ok'
                        ? 'rgba(34,197,94,0.10)'
                        : state === 'bad'
                          ? 'rgba(239,68,68,0.10)'
                          : 'rgba(255,255,255,0.03)';
                    const statusBorder =
                      state === 'ok'
                        ? 'rgba(34,197,94,0.28)'
                        : state === 'bad'
                          ? 'rgba(239,68,68,0.28)'
                          : 'rgba(255,255,255,0.10)';

                    return (
                      <li className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <Icon size={16} style={{ color }} />
                          <div className="text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                            两次输入一致
                          </div>
                        </div>
                        <span
                          className="shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold"
                          style={{ color, background: statusBg, border: `1px solid ${statusBorder}` }}
                        >
                          {statusText}
                        </span>
                      </li>
                    );
                  })()}
                </ul>
              </div>
            </div>

            {pwdSubmitError && (
              <div
                className="rounded-[14px] px-4 py-3 text-sm"
                style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.28)', color: 'rgba(239,68,68,0.95)' }}
              >
                {pwdSubmitError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setPwdOpen(false)} disabled={pwdSubmitting}>
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={submitChangePassword}
                disabled={pwdSubmitting || !pwdAllOk || !pwdMatchOk}
              >
                {pwdSubmitting ? '保存中...' : '保存'}
              </Button>
            </div>
          </div>
        }
      />

      <Dialog
        open={forceExpireOpen}
        onOpenChange={(v) => {
          setForceExpireOpen(v);
          if (!v) {
            setForceExpireTargetUser(null);
            setForceExpireError(null);
            setForceExpireSubmitting(false);
            setForceTargets({ admin: true, desktop: true });
          }
        }}
        title={forceExpireTargetUser ? `一键过期：${forceExpireTargetUser.username}` : '一键过期'}
        description={forceExpireTargetUser ? `${forceExpireTargetUser.displayName} · ${forceExpireTargetUser.userId}` : undefined}
        content={
          <div className="space-y-4">
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
              说明：此操作会让所选端的登录态立刻失效（可用于测试过期/踢下线）。
            </div>

            <div className="grid gap-2">
              <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                <input
                  type="checkbox"
                  checked={forceTargets.admin}
                  onChange={(e) => setForceTargets((s) => ({ ...s, admin: e.target.checked }))}
                />
                踢 Admin（Web 管理端）
              </label>
              <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                <input
                  type="checkbox"
                  checked={forceTargets.desktop}
                  onChange={(e) => setForceTargets((s) => ({ ...s, desktop: e.target.checked }))}
                />
                踢 Desktop（桌面端）
              </label>
            </div>

            {forceExpireError && (
              <div
                className="rounded-[14px] px-4 py-3 text-sm"
                style={{ border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.08)', color: 'rgba(239,68,68,0.95)' }}
              >
                {forceExpireError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" disabled={forceExpireSubmitting} onClick={() => setForceExpireOpen(false)}>
                取消
              </Button>
              <Button variant="primary" size="sm" disabled={forceExpireSubmitting} onClick={submitForceExpire}>
                {forceExpireSubmitting ? '处理中...' : '确认踢下线'}
              </Button>
            </div>
          </div>
        }
      />
    </div>
  );
}
