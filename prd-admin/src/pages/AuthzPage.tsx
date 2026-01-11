import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu, Database, Image, Plug, ScrollText, Settings2, Shield, ShieldCheck, Users, Users2, Wand2 } from 'lucide-react';
import { PageHeader } from '@/components/design/PageHeader';
import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { systemDialog } from '@/lib/systemDialog';
import { createSystemRole, deleteSystemRole, getAdminAuthzMe, getAdminPermissionCatalog, getSystemRoles, resetBuiltInSystemRoles, updateSystemRole } from '@/services';
import type { AdminPermissionDef, SystemRoleDto } from '@/services/contracts/authz';
import { useAuthStore } from '@/stores/authStore';

function normKey(x: string): string {
  return String(x || '').trim();
}

export default function AuthzPage() {
  const navigate = useNavigate();
  const setPermissions = useAuthStore((s) => s.setPermissions);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [catalog, setCatalog] = useState<AdminPermissionDef[]>([]);
  const [roles, setRoles] = useState<SystemRoleDto[]>([]);
  const [activeKey, setActiveKey] = useState<string>('admin');
  const [dirtyPerms, setDirtyPerms] = useState<Set<string> | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createKey, setCreateKey] = useState('');
  const [createName, setCreateName] = useState('');
  const [createClonePerms, setCreateClonePerms] = useState(true);
  const [createSubmitting, setCreateSubmitting] = useState(false);

  const [resetSubmitting, setResetSubmitting] = useState(false);

  const activeRole = useMemo(() => roles.find((r) => r.key === activeKey) || null, [roles, activeKey]);
  const catalogByKey = useMemo(() => {
    const m = new Map<string, AdminPermissionDef>();
    for (const it of catalog) {
      const k = normKey(it.key);
      if (k) m.set(k, it);
    }
    return m;
  }, [catalog]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [cRes, rRes] = await Promise.all([getAdminPermissionCatalog(), getSystemRoles()]);
      if (!cRes.success) {
        setLoading(false);
        systemDialog.error(cRes.error?.message || '加载权限清单失败');
        return;
      }
      if (!rRes.success) {
        setLoading(false);
        systemDialog.error(rRes.error?.message || '加载系统角色失败');
        return;
      }
      setCatalog(Array.isArray(cRes.data.items) ? cRes.data.items : []);
      setRoles(Array.isArray(rRes.data) ? rRes.data : []);
      setDirtyPerms(null);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    // 切换角色时重置编辑态
    if (!activeRole) {
      setDirtyPerms(null);
      return;
    }
    setDirtyPerms(new Set((activeRole.permissions || []).map(normKey).filter(Boolean)));
  }, [activeRole]);

  const setChecked = (key: string, checked: boolean) => {
    const k = normKey(key);
    if (!k) return;
    setDirtyPerms((prev) => {
      const set = prev ? new Set(prev) : new Set<string>();
      if (checked) set.add(k);
      else set.delete(k);
      return set;
    });
  };

  type PermRow = {
    id: string;
    title: string;
    hint?: string;
    readKey?: string;
    writeKey?: string;
    writeLabel?: string; // 默认“写”，可覆盖为“管”
    icon: React.ReactNode;
  };

  const permRows: PermRow[] = useMemo(
    () => [
      { id: 'users', title: '用户管理', hint: '账号、角色与权限', readKey: 'admin.users.read', writeKey: 'admin.users.write', icon: <Users size={16} /> },
      { id: 'groups', title: '群组管理', hint: '协作群组与成员', readKey: 'admin.groups.read', writeKey: 'admin.groups.write', icon: <Users2 size={16} /> },
      { id: 'models', title: '模型管理', hint: '平台/模型/配置/调度', readKey: 'admin.models.read', writeKey: 'admin.models.write', icon: <Cpu size={16} /> },
      { id: 'logs', title: '日志', hint: '系统/LLM/API 请求日志', readKey: 'admin.logs.read', icon: <ScrollText size={16} /> },
      { id: 'open', title: '开放平台', hint: 'App/调用方/日志', writeKey: 'admin.openPlatform.manage', writeLabel: '管', icon: <Plug size={16} /> },
      { id: 'data', title: '数据管理', hint: '导入导出/清理', readKey: 'admin.data.read', writeKey: 'admin.data.write', icon: <Database size={16} /> },
      { id: 'assets', title: '资源管理', hint: '桌面资源/头像等', readKey: 'admin.assets.read', writeKey: 'admin.assets.write', icon: <Image size={16} /> },
      { id: 'settings', title: '系统设置/提示词', hint: 'settings/prompts', readKey: 'admin.settings.read', writeKey: 'admin.settings.write', icon: <Settings2 size={16} /> },
      { id: 'authz', title: '权限管理', hint: 'system roles / user authz', writeKey: 'admin.authz.manage', writeLabel: '管', icon: <Shield size={16} /> },
      { id: 'agent', title: 'Agent 体验', hint: 'PRD/视觉/文学 Agent', writeKey: 'admin.agent.use', writeLabel: '用', icon: <Wand2 size={16} /> },
    ],
    []
  );

  const save = async () => {
    if (!activeRole || !dirtyPerms) return;
    if (saving) return;
    setSaving(true);
    const perms = Array.from(dirtyPerms).sort();
    const res = await updateSystemRole(activeRole.key, { key: activeRole.key, name: activeRole.name, permissions: perms });
    if (!res.success) {
      systemDialog.error(res.error?.message || '保存失败');
      setSaving(false);
      return;
    }
    // 更新本地 roles
    setRoles((prev) => prev.map((r) => (r.key === activeRole.key ? res.data : r)));
    systemDialog.success('已保存');
    setSaving(false);
  };

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
    const basePerms = createClonePerms ? Array.from(dirtyPerms || new Set<string>()).sort() : [];
    const res = await createSystemRole({ key, name, permissions: basePerms });
    if (!res.success) {
      systemDialog.error(res.error?.message || '创建失败');
      setCreateSubmitting(false);
      return;
    }
    setRoles((prev) => prev.concat(res.data).sort((a, b) => a.key.localeCompare(b.key)));
    setActiveKey(res.data.key);
    setCreateOpen(false);
    setCreateKey('');
    setCreateName('');
    setCreateClonePerms(true);
    systemDialog.success('已创建');
    setCreateSubmitting(false);
  };

  const resetBuiltIns = async () => {
    if (resetSubmitting) return;
    const ok1 = await systemDialog.confirm({
      title: '重置内置角色',
      message: '将把所有“内置角色”的名称与权限恢复为默认定义（不会删除自定义角色）。是否继续？',
      tone: 'neutral',
      confirmText: '继续',
      cancelText: '取消',
    });
    if (!ok1) return;
    const ok2 = await systemDialog.confirm({
      title: '再次确认',
      message: '此操作会覆盖内置角色权限配置。建议仅在误操作后使用。',
      tone: 'danger',
      confirmText: '确认重置',
      cancelText: '取消',
    });
    if (!ok2) return;

    setResetSubmitting(true);
    const res = await resetBuiltInSystemRoles();
    if (!res.success) {
      systemDialog.error(res.error?.message || '重置失败');
      setResetSubmitting(false);
      return;
    }
    setRoles(Array.isArray(res.data) ? res.data : []);
    setActiveKey('admin');
    // 同步刷新当前登录用户的 effectivePermissions，避免“重置了但菜单没变化”的错觉
    const me = await getAdminAuthzMe();
    if (me.success) {
      setPermissions(me.data.effectivePermissions || []);
    }
    systemDialog.success('已重置内置角色');
    setResetSubmitting(false);
  };

  const removeActiveRole = async () => {
    if (!activeRole) return;
    if (activeRole.isBuiltIn) {
      systemDialog.error('内置角色不可删除');
      return;
    }
    const ok = await systemDialog.confirm({
      title: '删除系统角色',
      message: `将删除角色：${activeRole.name}（${activeRole.key}）\n\n注意：已绑定该角色的用户将退回到默认推断（ADMIN->admin，其它->none）。`,
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
    setActiveKey('admin');
    systemDialog.success('已删除');
  };

  return (
    <div className="h-full w-full p-6 flex flex-col min-h-0">
      <PageHeader title="权限管理" subtitle="系统角色（RBAC-lite）+ 权限点（permission strings）" />

      {/* 固定为当前视口高度：左右两栏内部滚动，避免卡片撑出屏幕 */}
      <div className="mt-4 grid grid-cols-12 gap-4 flex-1 min-h-0">
        <div className="col-span-4">
          <Card className="p-4 h-full min-h-0 flex flex-col">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>系统角色</div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)} disabled={loading}>
                  新增角色
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void resetBuiltIns()}
                  disabled={loading || resetSubmitting}
                  title="恢复内置角色到默认权限（不删除自定义角色）"
                >
                  {resetSubmitting ? '重置中...' : '重置内置'}
                </Button>
              </div>
            </div>
            {/* 用 flex 列表避免 grid 默认的 stretch 把每个 role 拉成“大卡片” */}
            <div className="mt-3 flex flex-col gap-1.5 flex-1 min-h-0 overflow-auto pr-1">
              {roles.map((r) => {
                const isActive = r.key === activeKey;
                return (
                  <button
                    key={r.key}
                    type="button"
                    // 关键：父容器不变，但 role node 本身更“紧凑”，并限制最大宽度居中，避免整列看起来像大块卡片
                    className="w-full max-w-[320px] mx-auto text-left rounded-[12px] px-2 py-1.5 transition-colors hover:bg-white/3"
                    style={{
                      background: isActive ? 'color-mix(in srgb, var(--accent-gold) 12%, transparent)' : 'transparent',
                      border: `1px solid ${isActive ? 'color-mix(in srgb, var(--accent-gold) 35%, var(--border-subtle))' : 'var(--border-subtle)'}`,
                      color: 'var(--text-primary)',
                    }}
                    onClick={() => setActiveKey(r.key)}
                    disabled={loading}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex items-center gap-2">
                        <div className="text-[13px] font-medium truncate leading-tight">{r.name}</div>
                        {r.isBuiltIn ? (
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 leading-none"
                            style={{ border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.03)' }}
                          >
                            内置
                          </span>
                        ) : null}
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 leading-none"
                          style={{ border: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.02)' }}
                          title="权限点数量"
                        >
                          {Array.isArray(r.permissions) ? r.permissions.length : 0}
                        </span>
                      </div>
                      <div className="text-[11px] opacity-70 shrink-0 leading-tight">{r.key}</div>
                    </div>
                  </button>
                );
              })}
              {roles.length === 0 && !loading ? (
                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>暂无角色</div>
              ) : null}
            </div>
          </Card>
        </div>

        <div className="col-span-8">
          <Card className="p-4 h-full min-h-0 flex flex-col">
            {/* Header：按钮固定右上角，说明单独一行，避免挤压按钮文字 */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                  {activeRole ? `编辑：${activeRole.name}` : '请选择角色'}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button variant="secondary" onClick={() => navigate('/users')} disabled={loading}>
                  去用户管理赋权
                </Button>
                {!activeRole?.isBuiltIn ? (
                  <Button variant="secondary" onClick={removeActiveRole} disabled={loading || saving || !activeRole}>
                    删除角色
                  </Button>
                ) : null}
                <Button onClick={save} disabled={loading || saving || !activeRole || !dirtyPerms} variant="primary">
                  {saving ? '保存中...' : '保存'}
                </Button>
              </div>
            </div>
            <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              菜单/路由/接口都应绑定同一 permission key。用户赋权在“用户管理 → 更多操作 → 后台菜单权限”。
            </div>

            {/* 内容区滚动：不撑高页面 */}
            <div className="mt-4 flex-1 min-h-0 overflow-auto pr-1">
              {/* 基础：后台访问 */}
              <div
                className="rounded-[14px] px-3 py-3"
                style={{ border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.015)' }}
              >
                <label className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex items-center gap-2">
                    <span className="opacity-70" style={{ color: 'var(--text-secondary)' }}><ShieldCheck size={16} /></span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>后台访问</div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        <span className="opacity-80">admin.access</span> · {catalogByKey.get('admin.access')?.description || '允许进入管理后台'}
                      </div>
                    </div>
                  </div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    </div>
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    disabled={loading || !dirtyPerms}
                    checked={!!dirtyPerms?.has('admin.access')}
                    onChange={(e) => setChecked('admin.access', e.target.checked)}
                  />
                </label>
              </div>

              {/* 模块权限：读/写（或管） */}
              <div className="mt-3 rounded-[14px] overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.045)' }}>
                <div className="px-3 py-2 text-xs flex items-center justify-between" style={{ background: 'rgba(255,255,255,0.015)', color: 'var(--text-muted)' }}>
                  <div>模块权限</div>
                  <div className="flex items-center gap-8">
                    <div className="w-[40px] text-center">读</div>
                    <div className="w-[40px] text-center">写/管</div>
                  </div>
                </div>
                {/* 取消横向分割线：用间距 + hover 层次区分，避免白线晃眼 */}
                <div className="p-1.5 flex flex-col gap-1.5" style={{ background: 'rgba(255,255,255,0.004)' }}>
                  {permRows.map((r) => {
                    const readKey = r.readKey ? normKey(r.readKey) : '';
                    const writeKey = r.writeKey ? normKey(r.writeKey) : '';
                    const readChecked = !!readKey && !!dirtyPerms?.has(readKey);
                    const writeChecked = !!writeKey && !!dirtyPerms?.has(writeKey);
                    const writeLabel = r.writeLabel || '写';
                    return (
                      <div
                        key={r.id}
                        className="px-3 py-2 flex items-center justify-between gap-3 rounded-[12px] hover:bg-white/4 transition-colors"
                        style={{ background: 'rgba(255,255,255,0.006)' }}
                      >
                        <div className="min-w-0 flex items-start gap-2">
                          <span className="mt-[2px] opacity-70" style={{ color: 'var(--text-secondary)' }}>{r.icon}</span>
                          <div className="min-w-0">
                            <div className="text-sm" style={{ color: 'var(--text-primary)' }}>{r.title}</div>
                            <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                              {r.hint || ''}
                              {readKey ? <span className="opacity-70">{` · ${readKey}`}</span> : null}
                              {writeKey ? <span className="opacity-70">{` · ${writeKey}`}</span> : null}
                            </div>
                          </div>
                        </div>
                          <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                          </div>

                        <div className="flex items-center gap-8">
                          <div className="w-[40px] flex items-center justify-center">
                            {readKey ? (
                              <input
                                type="checkbox"
                                aria-label={`${r.title}-读`}
                                disabled={loading || !dirtyPerms}
                                checked={readChecked}
                                onChange={(e) => setChecked(readKey, e.target.checked)}
                              />
                            ) : (
                              <span className="text-xs opacity-35 select-none" style={{ color: 'var(--text-muted)' }}>—</span>
                            )}
                          </div>
                          <div className="w-[40px] flex items-center justify-center">
                            {writeKey ? (
                              <input
                                type="checkbox"
                                aria-label={`${r.title}-${writeLabel}`}
                                disabled={loading || !dirtyPerms}
                                checked={writeChecked}
                                onChange={(e) => setChecked(writeKey, e.target.checked)}
                              />
                            ) : (
                              <span className="text-xs opacity-35 select-none" style={{ color: 'var(--text-muted)' }}>—</span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 高级：兜底超级权限 */}
              <div
                className="mt-3 rounded-[14px] px-3 py-3"
                style={{ border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.012)' }}
              >
                <label className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex items-center gap-2">
                    <span className="opacity-70" style={{ color: 'var(--text-secondary)' }}><Shield size={16} /></span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>超级权限（兜底）</div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        <span className="opacity-80">admin.super</span> · 仅建议给 root/破窗或极少数超级管理员
                      </div>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    disabled={loading || !dirtyPerms}
                    checked={!!dirtyPerms?.has('admin.super')}
                    onChange={(e) => setChecked('admin.super', e.target.checked)}
                  />
                </label>
              </div>
            </div>
          </Card>
        </div>
      </div>

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
        description="创建一个可编辑的 systemRoleKey，用于给用户分配后台菜单/页面/接口权限"
        content={
          <div className="space-y-4">
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>key（唯一）</div>
              <input
                value={createKey}
                onChange={(e) => setCreateKey(e.target.value)}
                className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                placeholder="例如：ops 或 content_viewer"
              />
            </div>
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>名称</div>
              <input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                className="mt-2 h-10 w-full rounded-[14px] px-4 text-sm outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
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

