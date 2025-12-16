import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/design/Badge';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { getUsers, generateInviteCodes, updateUserPassword, updateUserRole, updateUserStatus, isMockMode } from '@/services';
import { CheckCircle2, Circle, XCircle } from 'lucide-react';

type UserRow = {
  userId: string;
  username: string;
  displayName: string;
  role: 'PM' | 'DEV' | 'QA' | 'ADMIN';
  status: 'Active' | 'Disabled';
  createdAt: string;
  lastLoginAt?: string;
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

  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdUser, setPwdUser] = useState<UserRow | null>(null);
  const [pwd, setPwd] = useState('');
  const [pwd2, setPwd2] = useState('');
  const [pwdSubmitError, setPwdSubmitError] = useState<string | null>(null);
  const [pwdSubmitting, setPwdSubmitting] = useState(false);

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

  const openChangePassword = (u: UserRow) => {
    setPwdUser(u);
    setPwd('');
    setPwd2('');
    setPwdSubmitError(null);
    setPwdOpen(true);
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

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <div className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>用户管理</div>
          <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>共 {total} 个用户</div>
        </div>
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

      <Card>
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
              setRole(e.target.value as any);
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
              setStatus(e.target.value as any);
              setPage(1);
            }}
            className="h-10 rounded-[14px] px-3 text-sm"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
          >
            <option value="">状态</option>
            <option value="Active">正常</option>
            <option value="Disabled">禁用</option>
          </select>

          {isMockMode ? <Badge variant="subtle">mock</Badge> : null}
        </div>

        <div className="mt-5 overflow-hidden rounded-[16px]" style={{ border: '1px solid var(--border-subtle)' }}>
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
                          await updateUserRole(u.userId, e.target.value as any);
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
                          await updateUserStatus(u.userId, e.target.value as any);
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
                      <Button variant="secondary" size="sm" onClick={() => openChangePassword(u)}>
                        修改密码
                      </Button>
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
    </div>
  );
}
