import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Plus, RefreshCw, ChevronDown, User, X, UserCog, ShieldCheck } from 'lucide-react';
import { TabBar } from '@/components/design/TabBar';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import {
  createSystemRole,
  deleteSystemRole,
  getAdminAuthzMe,
  getSystemRoles,
  resetBuiltInSystemRoles,
  updateSystemRole,
  updateUserAuthz,
  getUsers,
} from '@/services';
import type { SystemRoleDto } from '@/services/contracts/authz';
import type { AdminUser } from '@/types/admin';
import { useAuthStore } from '@/stores/authStore';
import { PermissionMatrix } from './authz/PermissionMatrix';
import { MenuPermissionDialog } from './authz/MenuPermissionDialog';

export default function AuthzPage() {
  const navigate = useNavigate();
  const setPermissions = useAuthStore((s) => s.setPermissions);

  // 数据状态
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [roles, setRoles] = useState<SystemRoleDto[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);

  // 用户选择状态
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);

  // 菜单权限预览弹窗
  const [menuPreviewAppKey, setMenuPreviewAppKey] = useState<string | null>(null);

  // 对话框状态
  const [createOpen, setCreateOpen] = useState(false);
  const [createKey, setCreateKey] = useState('');
  const [createName, setCreateName] = useState('');
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [resetSubmitting, setResetSubmitting] = useState(false);

  // 用户赋权弹窗
  const [assignRoleOpen, setAssignRoleOpen] = useState(false);
  const [assignRoleSubmitting, setAssignRoleSubmitting] = useState(false);

  // 当前选中的用户
  const activeUser = useMemo(
    () => (selectedUserId ? users.find((u) => u.userId === selectedUserId) : null),
    [users, selectedUserId]
  );

  // 用户对应的角色 key
  const highlightRoleKey = useMemo(() => {
    if (!activeUser) return null;
    return activeUser.systemRoleKey || (activeUser.role === 'ADMIN' ? 'admin' : 'none');
  }, [activeUser]);

  // 加载数据
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const [rolesRes, usersRes] = await Promise.all([getSystemRoles(), getUsers({ page: 1, pageSize: 100 })]);

    if (!rolesRes.success) {
      toast.error('加载角色失败', rolesRes.error?.message);
      setLoading(false);
      return;
    }

    setRoles(Array.isArray(rolesRes.data) ? rolesRes.data : []);
    if (usersRes.success) {
      setUsers((usersRes.data?.items || []) as AdminUser[]);
    }
    setLoading(false);
  };

  // 更新角色权限
  const handleUpdateRole = async (roleKey: string, permissions: string[]) => {
    const role = roles.find((r) => r.key === roleKey);
    if (!role || role.isBuiltIn) return;

    setSaving(true);
    const res = await updateSystemRole(roleKey, {
      key: roleKey,
      name: role.name,
      permissions,
    });

    if (!res.success) {
      toast.error('保存失败', res.error?.message);
      setSaving(false);
      return;
    }

    setRoles((prev) => prev.map((r) => (r.key === roleKey ? res.data : r)));
    toast.success('已保存');
    setSaving(false);
  };

  // 删除角色
  const handleDeleteRole = async (roleKey: string) => {
    const role = roles.find((r) => r.key === roleKey);
    if (!role || role.isBuiltIn) return;

    const ok = await systemDialog.confirm({
      title: '删除系统角色',
      message: `将删除角色：${role.name}（${role.key}）\n\n注意：已绑定该角色的用户将退回到默认推断。`,
      tone: 'danger',
      confirmText: '确认删除',
      cancelText: '取消',
    });
    if (!ok) return;

    const res = await deleteSystemRole(roleKey);
    if (!res.success) {
      toast.error('删除失败', res.error?.message);
      return;
    }

    setRoles((prev) => prev.filter((r) => r.key !== roleKey));
    toast.success('已删除');
  };

  // 创建角色
  const submitCreate = async () => {
    if (createSubmitting) return;
    const key = String(createKey || '').trim().toLowerCase();
    const name = String(createName || '').trim();

    if (!key || !name) {
      toast.warning('请填写角色 key 与名称');
      return;
    }
    if (!/^[a-z][a-z0-9_-]{1,32}$/.test(key)) {
      toast.warning('key 不合法', '建议使用小写字母开头，长度 2-33，仅 a-z0-9_-');
      return;
    }
    if (key === 'root') {
      toast.warning('key 不合法');
      return;
    }
    if (roles.some((r) => r.key === key)) {
      toast.warning('该 key 已存在');
      return;
    }

    setCreateSubmitting(true);
    const res = await createSystemRole({ key, name, permissions: [] });

    if (!res.success) {
      toast.error('创建失败', res.error?.message);
      setCreateSubmitting(false);
      return;
    }

    // 排序：内置角色在前，自定义角色按字母排序在后
    setRoles((prev) =>
      prev.concat(res.data).sort((a, b) => {
        // 内置角色优先
        if (a.isBuiltIn && !b.isBuiltIn) return -1;
        if (!a.isBuiltIn && b.isBuiltIn) return 1;
        // 同类型按 key 排序
        return a.key.localeCompare(b.key);
      })
    );
    setCreateOpen(false);
    setCreateKey('');
    setCreateName('');
    toast.success('已创建');
    setCreateSubmitting(false);
  };

  // 重置内置
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
      toast.error('刷新失败', res.error?.message);
      setResetSubmitting(false);
      return;
    }

    setRoles(Array.isArray(res.data) ? res.data : []);

    // 刷新当前用户权限
    const me = await getAdminAuthzMe();
    if (me.success) {
      setPermissions(me.data.effectivePermissions || []);
    }

    toast.success('已刷新');
    setResetSubmitting(false);
  };

  // 用户选择按钮（点击打开弹窗）
  const UserSelectButton = (
    <button
      type="button"
      onClick={() => setUserDropdownOpen(true)}
      className="h-7 flex items-center gap-1.5 px-2.5 rounded-lg text-xs font-medium transition-colors"
      style={{
        background: activeUser ? 'rgba(214, 178, 106, 0.15)' : 'rgba(255, 255, 255, 0.06)',
        border: activeUser ? '1px solid rgba(214, 178, 106, 0.3)' : '1px solid rgba(255, 255, 255, 0.1)',
        color: activeUser ? 'rgba(214, 178, 106, 0.95)' : 'var(--text-secondary)',
      }}
    >
      <User size={12} />
      <span>{activeUser ? activeUser.displayName || activeUser.username : '选择用户'}</span>
      {activeUser ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setSelectedUserId(null);
          }}
          className="ml-0.5 p-0.5 rounded hover:bg-white/10"
        >
          <X size={10} />
        </button>
      ) : (
        <ChevronDown size={12} />
      )}
    </button>
  );

  // TabBar 右侧操作按钮
  const tabBarActions = (
    <div className="flex items-center gap-1.5">
      {UserSelectButton}

      {/* 新增角色 */}
      <button
        type="button"
        onClick={() => setCreateOpen(true)}
        className="h-7 flex items-center gap-1.5 px-2.5 rounded-lg text-xs font-medium transition-colors hover:bg-white/10"
        style={{
          background: 'rgba(255, 255, 255, 0.06)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          color: 'var(--text-secondary)',
        }}
      >
        <Plus size={12} />
        <span>新增角色</span>
      </button>

      {/* 用户赋权按钮 - 根据是否选中用户显示不同功能 */}
      <button
        type="button"
        onClick={() => {
          if (activeUser) {
            setAssignRoleOpen(true);
          } else {
            navigate('/users');
          }
        }}
        className="h-7 flex items-center gap-1.5 px-2.5 rounded-lg text-xs font-medium transition-colors hover:bg-white/10"
        style={{
          background: activeUser ? 'rgba(214, 178, 106, 0.12)' : 'rgba(255, 255, 255, 0.06)',
          border: activeUser ? '1px solid rgba(214, 178, 106, 0.25)' : '1px solid rgba(255, 255, 255, 0.1)',
          color: activeUser ? 'rgba(214, 178, 106, 0.95)' : 'var(--text-secondary)',
        }}
      >
        <UserCog size={12} />
        <span>{activeUser ? `给 ${activeUser.displayName || activeUser.username} 赋权` : '用户赋权'}</span>
      </button>

      {/* 刷新 */}
      <button
        type="button"
        onClick={resetBuiltIns}
        disabled={resetSubmitting}
        className="h-7 w-7 flex items-center justify-center rounded-lg transition-colors hover:bg-white/10 disabled:opacity-50"
        style={{
          background: 'rgba(255, 255, 255, 0.06)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          color: 'var(--text-secondary)',
        }}
      >
        <RefreshCw size={12} className={resetSubmitting ? 'animate-spin' : ''} />
      </button>
    </div>
  );

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 overflow-hidden">
      {/* 顶部工具栏 - TabBar 全宽，包含右侧按钮 */}
      <TabBar title="权限管理" icon={<Shield size={16} />} actions={tabBarActions} />

      {/* 权限矩阵 - 占满剩余高度 */}
      <Card className="flex-1 min-h-0 overflow-hidden">
        <PermissionMatrix
          roles={roles}
          highlightRoleKey={highlightRoleKey}
          onUpdateRole={handleUpdateRole}
          onDeleteRole={handleDeleteRole}
          onMenuClick={setMenuPreviewAppKey}
          loading={loading}
          saving={saving}
          readOnly={!!activeUser}
        />
      </Card>

      {/* 菜单权限预览弹窗 */}
      <MenuPermissionDialog
        open={!!menuPreviewAppKey}
        onOpenChange={(open) => {
          if (!open) setMenuPreviewAppKey(null);
        }}
        menuAppKey={menuPreviewAppKey}
      />

      {/* 创建角色对话框 */}
      <Dialog
        open={createOpen}
        onOpenChange={(v) => {
          setCreateOpen(v);
          if (!v) {
            setCreateKey('');
            setCreateName('');
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

      {/* 用户选择弹窗 */}
      {userDropdownOpen && (
        <>
          {/* 遮罩层 */}
          <div
            className="fixed inset-0 z-40"
            style={{ background: 'rgba(0, 0, 0, 0.4)' }}
            onClick={() => setUserDropdownOpen(false)}
          />

          {/* 弹窗内容 */}
          <div
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[360px] max-h-[70vh] overflow-hidden rounded-2xl"
            style={{
              background: 'rgba(24, 24, 28, 0.95)',
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
            }}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-5 py-4"
              style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}
            >
              <div>
                <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                  选择用户
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  查看用户对应角色的权限分布
                </div>
              </div>
              <button
                type="button"
                onClick={() => setUserDropdownOpen(false)}
                className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
              >
                <X size={16} style={{ color: 'var(--text-muted)' }} />
              </button>
            </div>

            {/* Content */}
            <div className="p-3 overflow-auto max-h-[calc(70vh-100px)]">
              {users.length === 0 ? (
                <div className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
                  暂无用户
                </div>
              ) : (
                <div className="space-y-1">
                  {users.map((user) => {
                    const userRoleKey = user.systemRoleKey || (user.role === 'ADMIN' ? 'admin' : 'none');
                    const userRole = roles.find((r) => r.key === userRoleKey);
                    const isSelected = selectedUserId === user.userId;

                    return (
                      <button
                        key={user.userId}
                        type="button"
                        onClick={() => {
                          setSelectedUserId(user.userId);
                          setUserDropdownOpen(false);
                        }}
                        className="w-full px-4 py-3 text-left rounded-xl transition-all duration-200"
                        style={{
                          background: isSelected ? 'rgba(214, 178, 106, 0.15)' : 'rgba(255, 255, 255, 0.02)',
                          border: isSelected ? '1px solid rgba(214, 178, 106, 0.3)' : '1px solid transparent',
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <div
                              className="text-sm font-medium"
                              style={{ color: isSelected ? 'rgba(214, 178, 106, 0.95)' : 'var(--text-primary)' }}
                            >
                              {user.displayName || user.username}
                            </div>
                            <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                              {user.username}
                            </div>
                          </div>
                          <span
                            className="text-[11px] px-2 py-0.5 rounded-md"
                            style={{
                              background: userRole?.isBuiltIn ? 'rgba(214, 178, 106, 0.1)' : 'rgba(255, 255, 255, 0.05)',
                              color: userRole?.isBuiltIn ? 'rgba(214, 178, 106, 0.8)' : 'var(--text-muted)',
                            }}
                          >
                            {userRole?.name || userRoleKey}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div
              className="px-5 py-3 text-xs flex items-center justify-between"
              style={{
                borderTop: '1px solid rgba(255, 255, 255, 0.06)',
                color: 'var(--text-muted)',
              }}
            >
              <span>共 {users.length} 个用户</span>
              {activeUser && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedUserId(null);
                    setUserDropdownOpen(false);
                  }}
                  className="text-xs px-2 py-1 rounded-md hover:bg-white/5 transition-colors"
                  style={{ color: 'rgba(214, 178, 106, 0.8)' }}
                >
                  清除选择
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* 用户赋权弹窗 */}
      {assignRoleOpen && activeUser && (
        <>
          {/* 遮罩层 */}
          <div
            className="fixed inset-0 z-40"
            style={{ background: 'rgba(0, 0, 0, 0.4)' }}
            onClick={() => !assignRoleSubmitting && setAssignRoleOpen(false)}
          />

          {/* 弹窗内容 */}
          <div
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[400px] max-h-[70vh] overflow-hidden rounded-2xl"
            style={{
              background: 'rgba(24, 24, 28, 0.95)',
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
            }}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-5 py-4"
              style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}
            >
              <div>
                <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                  用户角色赋权
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  为 {activeUser.displayName || activeUser.username} 分配系统角色
                </div>
              </div>
              <button
                type="button"
                onClick={() => !assignRoleSubmitting && setAssignRoleOpen(false)}
                className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
                disabled={assignRoleSubmitting}
              >
                <X size={16} style={{ color: 'var(--text-muted)' }} />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 overflow-auto max-h-[calc(70vh-140px)]">
              <div className="space-y-2">
                {roles.map((role) => {
                  const isCurrentRole = highlightRoleKey === role.key;

                  return (
                    <button
                      key={role.key}
                      type="button"
                      onClick={async () => {
                        if (assignRoleSubmitting) return;
                        if (isCurrentRole) return; // 已经是当前角色

                        setAssignRoleSubmitting(true);
                        const res = await updateUserAuthz(activeUser.userId, {
                          systemRoleKey: role.key === 'none' ? null : role.key,
                        });

                        if (!res.success) {
                          toast.error('赋权失败', res.error?.message);
                          setAssignRoleSubmitting(false);
                          return;
                        }

                        // 更新本地用户数据
                        setUsers((prev) =>
                          prev.map((u) =>
                            u.userId === activeUser.userId
                              ? { ...u, systemRoleKey: role.key === 'none' ? undefined : role.key }
                              : u
                          )
                        );

                        toast.success(`已将 ${activeUser.displayName || activeUser.username} 的角色设为 ${role.name}`);
                        setAssignRoleSubmitting(false);
                        setAssignRoleOpen(false);
                      }}
                      disabled={assignRoleSubmitting}
                      className="w-full px-4 py-3 text-left rounded-xl transition-all duration-200 disabled:opacity-50"
                      style={{
                        background: isCurrentRole ? 'rgba(214, 178, 106, 0.15)' : 'rgba(255, 255, 255, 0.02)',
                        border: isCurrentRole ? '1px solid rgba(214, 178, 106, 0.3)' : '1px solid rgba(255, 255, 255, 0.06)',
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-9 h-9 rounded-[10px] flex items-center justify-center"
                            style={{
                              background: role.isBuiltIn ? 'rgba(214, 178, 106, 0.12)' : 'rgba(255, 255, 255, 0.05)',
                            }}
                          >
                            {role.isBuiltIn ? (
                              <ShieldCheck size={16} style={{ color: 'rgba(214, 178, 106, 0.8)' }} />
                            ) : (
                              <User size={16} style={{ color: 'var(--text-muted)' }} />
                            )}
                          </div>
                          <div>
                            <div
                              className="text-sm font-medium"
                              style={{ color: isCurrentRole ? 'rgba(214, 178, 106, 0.95)' : 'var(--text-primary)' }}
                            >
                              {role.name}
                            </div>
                            <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                              {role.key} · {role.permissions?.length || 0} 项权限
                            </div>
                          </div>
                        </div>
                        {isCurrentRole && (
                          <span
                            className="text-[10px] px-2 py-0.5 rounded-md"
                            style={{
                              background: 'rgba(214, 178, 106, 0.2)',
                              color: 'rgba(214, 178, 106, 0.9)',
                            }}
                          >
                            当前
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Footer */}
            <div
              className="px-5 py-3 text-[11px]"
              style={{
                borderTop: '1px solid rgba(255, 255, 255, 0.06)',
                color: 'var(--text-muted)',
              }}
            >
              点击角色即可立即赋权，带盾牌图标为内置角色
            </div>
          </div>
        </>
      )}
    </div>
  );
}
