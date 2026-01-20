import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield } from 'lucide-react';
import { TabBar } from '@/components/design/TabBar';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { systemDialog } from '@/lib/systemDialog';
import {
  createSystemRole,
  deleteSystemRole,
  getAdminAuthzMe,
  getSystemRoles,
  resetBuiltInSystemRoles,
  updateSystemRole,
  getUsers,
} from '@/services';
import type { SystemRoleDto } from '@/services/contracts/authz';
import type { AdminUser } from '@/types/admin';
import { useAuthStore } from '@/stores/authStore';
import { AuthzRoleColumn } from './authz/AuthzRoleColumn';
import { AuthzMenuColumn } from './authz/AuthzMenuColumn';
import { AuthzPermissionColumn } from './authz/AuthzPermissionColumn';
import { AuthzUserBar } from './authz/AuthzUserBar';

function normKey(x: string): string {
  return String(x || '').trim();
}

export default function AuthzPage() {
  const navigate = useNavigate();
  const setPermissions = useAuthStore((s) => s.setPermissions);

  // 数据状态
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [roles, setRoles] = useState<SystemRoleDto[]>([]);

  // 选择状态
  const [selectedRoleKey, setSelectedRoleKey] = useState<string | null>(null); // null = 全部
  const [selectedMenuAppKey, setSelectedMenuAppKey] = useState<string | null>(null); // null = 全部
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  // 编辑状态
  const [dirtyPerms, setDirtyPerms] = useState<Set<string>>(new Set());

  // 对话框状态
  const [createOpen, setCreateOpen] = useState(false);
  const [createKey, setCreateKey] = useState('');
  const [createName, setCreateName] = useState('');
  const [createClonePerms, setCreateClonePerms] = useState(true);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [resetSubmitting, setResetSubmitting] = useState(false);

  // 用户数据（用于查看用户权限）
  const [users, setUsers] = useState<AdminUser[]>([]);

  // 当前选中的角色
  const activeRole = useMemo(
    () => (selectedRoleKey ? roles.find((r) => r.key === selectedRoleKey) : null),
    [roles, selectedRoleKey]
  );

  // 当前选中的用户
  const activeUser = useMemo(
    () => (selectedUserId ? users.find((u) => u.userId === selectedUserId) : null),
    [users, selectedUserId]
  );

  // 当前显示的权限（角色权限或用户权限）
  const displayPermissions = useMemo(() => {
    if (activeUser) {
      // 显示用户的角色权限
      const userRoleKey = activeUser.systemRoleKey || (activeUser.role === 'ADMIN' ? 'admin' : 'none');
      const userRole = roles.find((r) => r.key === userRoleKey);
      return new Set(userRole?.permissions || []);
    }
    if (activeRole) {
      return new Set(activeRole.permissions || []);
    }
    // 全部：显示所有权限的并集
    const allPerms = new Set<string>();
    for (const r of roles) {
      for (const p of r.permissions || []) {
        allPerms.add(p);
      }
    }
    return allPerms;
  }, [activeRole, activeUser, roles]);

  // 加载数据
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const [rolesRes, usersRes] = await Promise.all([getSystemRoles(), getUsers({ page: 1, pageSize: 100 })]);

    if (!rolesRes.success) {
      systemDialog.error(rolesRes.error?.message || '加载角色失败');
      setLoading(false);
      return;
    }

    setRoles(Array.isArray(rolesRes.data) ? rolesRes.data : []);
    if (usersRes.success) {
      setUsers((usersRes.data?.items || []) as AdminUser[]);
    }
    setLoading(false);
  };

  // 切换角色时重置编辑态
  useEffect(() => {
    if (activeRole) {
      setDirtyPerms(new Set((activeRole.permissions || []).map(normKey).filter(Boolean)));
    } else {
      setDirtyPerms(new Set());
    }
  }, [activeRole]);

  // 选择角色
  const handleSelectRole = (key: string | null) => {
    setSelectedRoleKey(key);
    setSelectedUserId(null); // 清除用户选择
    setSelectedMenuAppKey(null); // 重置菜单选择
  };

  // 选择用户
  const handleSelectUser = (userId: string | null) => {
    setSelectedUserId(userId);
    if (userId) {
      // 选择用户时，自动选择该用户的角色
      const user = users.find((u) => u.userId === userId);
      if (user) {
        const userRoleKey = user.systemRoleKey || (user.role === 'ADMIN' ? 'admin' : 'none');
        setSelectedRoleKey(userRoleKey);
      }
    }
  };

  // 权限切换
  const setChecked = (key: string, checked: boolean) => {
    const k = normKey(key);
    if (!k) return;
    setDirtyPerms((prev) => {
      const set = new Set(prev);
      if (checked) set.add(k);
      else set.delete(k);
      return set;
    });
  };

  // 保存
  const save = async () => {
    if (!activeRole || saving) return;
    if (activeRole.isBuiltIn) {
      systemDialog.error('内置角色不可修改');
      return;
    }

    setSaving(true);
    const perms = Array.from(dirtyPerms).sort();
    const res = await updateSystemRole(activeRole.key, {
      key: activeRole.key,
      name: activeRole.name,
      permissions: perms,
    });

    if (!res.success) {
      systemDialog.error(res.error?.message || '保存失败');
      setSaving(false);
      return;
    }

    setRoles((prev) => prev.map((r) => (r.key === activeRole.key ? res.data : r)));
    systemDialog.success('已保存');
    setSaving(false);
  };

  // 创建角色
  const submitCreate = async () => {
    if (createSubmitting) return;
    const key = String(createKey || '').trim().toLowerCase();
    const name = String(createName || '').trim();

    if (!key || !name) {
      systemDialog.error('请填写角色 key 与名称');
      return;
    }
    if (!/^[a-z][a-z0-9_-]{1,32}$/.test(key)) {
      systemDialog.error('key 不合法：建议使用小写字母开头，长度 2-33，仅 a-z0-9_-');
      return;
    }
    if (key === 'root') {
      systemDialog.error('key 不合法');
      return;
    }
    if (roles.some((r) => r.key === key)) {
      systemDialog.error('该 key 已存在');
      return;
    }

    setCreateSubmitting(true);
    const basePerms = createClonePerms ? Array.from(dirtyPerms).sort() : [];
    const res = await createSystemRole({ key, name, permissions: basePerms });

    if (!res.success) {
      systemDialog.error(res.error?.message || '创建失败');
      setCreateSubmitting(false);
      return;
    }

    setRoles((prev) => prev.concat(res.data).sort((a, b) => a.key.localeCompare(b.key)));
    setSelectedRoleKey(res.data.key);
    setCreateOpen(false);
    setCreateKey('');
    setCreateName('');
    setCreateClonePerms(true);
    systemDialog.success('已创建');
    setCreateSubmitting(false);
  };

  // 重置内置（现已废弃，内置角色从代码加载）
  const resetBuiltIns = async () => {
    if (resetSubmitting) return;
    const ok = await systemDialog.confirm({
      title: '提示',
      message: '内置角色现已从代码加载，此操作仅刷新角色列表。',
      tone: 'neutral',
      confirmText: '确定',
      cancelText: '取消',
    });
    if (!ok) return;

    setResetSubmitting(true);
    const res = await resetBuiltInSystemRoles();

    if (!res.success) {
      systemDialog.error(res.error?.message || '刷新失败');
      setResetSubmitting(false);
      return;
    }

    setRoles(Array.isArray(res.data) ? res.data : []);
    setSelectedRoleKey(null);

    // 刷新当前用户权限
    const me = await getAdminAuthzMe();
    if (me.success) {
      setPermissions(me.data.effectivePermissions || []);
    }

    systemDialog.success('已刷新');
    setResetSubmitting(false);
  };

  // 删除角色
  const removeActiveRole = async () => {
    if (!activeRole) return;
    if (activeRole.isBuiltIn) {
      systemDialog.error('内置角色不可删除');
      return;
    }

    const ok = await systemDialog.confirm({
      title: '删除系统角色',
      message: `将删除角色：${activeRole.name}（${activeRole.key}）\n\n注意：已绑定该角色的用户将退回到默认推断。`,
      tone: 'danger',
      confirmText: '确认删除',
      cancelText: '取消',
    });
    if (!ok) return;

    const res = await deleteSystemRole(activeRole.key);
    if (!res.success) {
      systemDialog.error(res.error?.message || '删除失败');
      return;
    }

    setRoles((prev) => prev.filter((r) => r.key !== activeRole.key));
    setSelectedRoleKey(null);
    systemDialog.success('已删除');
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 overflow-hidden">
      <TabBar title="权限管理" icon={<Shield size={16} />} />

      {/* 用户水平条 */}
      <AuthzUserBar selectedUserId={selectedUserId} onSelectUser={handleSelectUser} />

      {/* 三栏布局 */}
      <div
        className="grid gap-4 flex-1 min-h-0 overflow-hidden"
        style={{ gridTemplateColumns: '240px 240px minmax(0, 1fr)' }}
      >
        {/* 角色栏 */}
        <Card className="min-h-0 overflow-hidden">
          <AuthzRoleColumn
            roles={roles}
            activeKey={selectedRoleKey}
            onSelect={handleSelectRole}
            onCreateClick={() => setCreateOpen(true)}
            onResetClick={resetBuiltIns}
            loading={loading}
            resetSubmitting={resetSubmitting}
          />
        </Card>

        {/* 菜单栏 */}
        <Card className="min-h-0 overflow-hidden">
          <AuthzMenuColumn
            activeAppKey={selectedMenuAppKey}
            onSelect={setSelectedMenuAppKey}
            rolePermissions={Array.from(displayPermissions)}
            loading={loading}
          />
        </Card>

        {/* 权限栏 */}
        <Card className="min-h-0 overflow-hidden">
          <AuthzPermissionColumn
            selectedMenuAppKey={selectedMenuAppKey}
            checkedPermissions={activeUser ? displayPermissions : dirtyPerms}
            onToggle={setChecked}
            onSave={save}
            onDelete={removeActiveRole}
            canDelete={!!activeRole && !activeRole.isBuiltIn}
            saving={saving}
            loading={loading}
            roleName={activeUser ? `${activeUser.displayName || activeUser.username} (${activeRole?.name || '无角色'})` : activeRole?.name}
            isBuiltIn={activeRole?.isBuiltIn || !!activeUser}
          />
        </Card>
      </div>

      {/* 底部操作栏 */}
      <div className="flex items-center justify-end gap-3 py-2">
        <Button variant="secondary" onClick={() => navigate('/users')}>
          去用户管理赋权
        </Button>
      </div>

      {/* 创建角色对话框 */}
      <Dialog
        open={createOpen}
        onOpenChange={(v) => {
          setCreateOpen(v);
          if (!v) {
            setCreateKey('');
            setCreateName('');
            setCreateClonePerms(true);
            setCreateSubmitting(false);
          }
        }}
        title="新增系统角色"
        description="创建一个可编辑的 systemRoleKey，用于给用户分配权限"
        content={
          <div className="space-y-4">
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
                key（唯一）
              </div>
              <input
                value={createKey}
                onChange={(e) => setCreateKey(e.target.value)}
                className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: 'var(--text-primary)',
                }}
                placeholder="例如：ops 或 content_viewer"
              />
            </div>
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
                名称
              </div>
              <input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: 'var(--text-primary)',
                }}
                placeholder="例如：内容只读"
              />
            </div>
            <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
              <input
                type="checkbox"
                checked={createClonePerms}
                onChange={(e) => setCreateClonePerms(e.target.checked)}
                disabled={createSubmitting}
              />
              复制当前选中角色的权限点作为初始值
            </label>
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="secondary" size="sm" onClick={() => setCreateOpen(false)} disabled={createSubmitting}>
                取消
              </Button>
              <Button variant="primary" size="sm" onClick={submitCreate} disabled={createSubmitting}>
                {createSubmitting ? '创建中...' : '创建'}
              </Button>
            </div>
          </div>
        }
      />
    </div>
  );
}
