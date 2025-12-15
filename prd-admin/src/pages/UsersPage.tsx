import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/design/Badge';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { getUsers, generateInviteCodes, updateUserRole, updateUserStatus } from '@/services';

type UserRow = {
  userId: string;
  username: string;
  displayName: string;
  role: 'PM' | 'DEV' | 'QA' | 'ADMIN';
  status: 'Active' | 'Disabled';
  createdAt: string;
  lastLoginAt?: string;
};

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

          <Badge variant="subtle">mock</Badge>
        </div>

        <div className="mt-5 overflow-hidden rounded-[16px]" style={{ border: '1px solid var(--border-subtle)' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'rgba(255,255,255,0.03)' }}>
              <tr>
                <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>用户</th>
                <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>角色</th>
                <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>状态</th>
                <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>注册时间</th>
                <th className="text-left px-4 py-3" style={{ color: 'var(--text-secondary)' }}>最后登录</th>
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
                    <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>{u.createdAt}</td>
                    <td className="px-4 py-3" style={{ color: 'var(--text-muted)' }}>{u.lastLoginAt || '-'}</td>
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
    </div>
  );
}
