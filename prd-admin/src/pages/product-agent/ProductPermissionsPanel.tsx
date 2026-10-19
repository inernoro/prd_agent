import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, Save, Search, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import {
  createSystemRole, getAdminAuthzMe, getAdminPermissionCatalog, getSystemRoles,
  getUserAuthz, updateSystemRole, updateUserAuthz,
} from '@/services';
import type { AdminPermissionDef, AdminUserAuthzSnapshot, SystemRoleDto } from '@/services/contracts/authz';
import { hasEffectivePermission } from '@/lib/permissionAccess';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';
import { mergePermissionOverrides, mergeScopedRolePermissions, permissionOverride, type PermissionOverride } from './productPermissionEditing';

export type ProductPermissionTab = 'menu' | 'function' | 'role';
type PermissionEntry = { key: string; label: string; permissions: string[]; note?: string };

const SHARED_MENU_NOTE = '该菜单与产品、需求、功能等页面共用“进入产品管理”权限，调整会同时影响这些页面。现有系统尚未提供逐页独立授权。';
const MENU_ENTRIES: PermissionEntry[] = [
  ...[
    ['dashboard', '概览'], ['products', '产品'], ['requirements', '需求'], ['features', '功能'],
    ['defects', '缺陷'], ['customers', '客户'], ['knowledge', '知识库'], ['graph', '图谱'],
  ].map(([key, label]) => ({ key, label, permissions: ['product-agent.use'], note: SHARED_MENU_NOTE })),
  { key: 'review', label: '评审', permissions: ['product-agent.use', 'review-agent.use'], note: '进入评审菜单需要同时具备“进入产品管理”和“评审”权限。每项单独配置，不会自动补授。' },
  { key: 'versions', label: '版本', permissions: ['product-agent.use', 'product-agent.version-apply'], note: '完整产品管理用户可进入版本页；仅需申领的人可单独配置“版本号申领”，不会因此获得其他产品页面。' },
  { key: 'settings', label: '设置', permissions: [], note: '此菜单由既有产品应用管理员规则控制，并非独立菜单权限。当前面板不修改应用管理员名单。' },
];
const inputClass = 'w-full rounded-md border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary outline-none focus:border-[var(--accent-fg-blue)]';
const isProductPermission = (key: string) => key.startsWith('product-agent.') || key.startsWith('review-agent.');

export function ProductPermissionsPanel({ tab }: { tab: ProductPermissionTab }) {
  const permissions = useAuthStore((state) => state.permissions);
  const isRoot = useAuthStore((state) => state.isRoot);
  const canManage = hasEffectivePermission(permissions, 'authz.manage', isRoot);
  const [catalog, setCatalog] = useState<AdminPermissionDef[]>([]);
  const [roles, setRoles] = useState<SystemRoleDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!canManage) { setLoading(false); return; }
    setError('');
    try {
      const [catalogResult, rolesResult] = await Promise.all([getAdminPermissionCatalog(), getSystemRoles()]);
      if (!catalogResult.success) throw new Error(catalogResult.error.message);
      if (!rolesResult.success) throw new Error(rolesResult.error.message);
      setCatalog(catalogResult.data.items.filter((item) => isProductPermission(item.key)));
      setRoles(rolesResult.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '权限资料加载失败，请重试。');
    } finally { setLoading(false); }
  }, [canManage]);
  useEffect(() => { setLoading(true); void reload(); }, [reload]);

  if (!canManage) return <Notice title="当前账号不能管理授权" text="此处需要已有的权限管理权限。请联系权限管理员为你开通后再刷新页面；产品管理员身份不会自动获得系统授权能力。" />;
  if (loading) return <MapSectionLoader text="正在读取权限与角色…" />;
  if (error) return <div className="space-y-3"><Notice title="权限资料未能加载" text={error} /><Button size="sm" onClick={() => { setLoading(true); void reload(); }}>重新加载</Button></div>;
  if (catalog.length === 0) return <Notice title="没有读取到产品管理权限" text="服务端尚未返回可配置的产品或评审权限，请刷新重试或联系管理员检查权限目录。" />;

  return tab === 'role'
    ? <RolePermissions catalog={catalog} roles={roles} onChanged={reload} />
    : <PermissionAssignments key={tab} catalog={catalog} roles={roles} tab={tab} />;
}

function Notice({ title, text }: { title: string; text: string }) {
  return <div role="status" className="rounded-lg border border-token-subtle bg-token-nested p-4">
    <p className="text-sm font-medium text-token-primary">{title}</p>
    <p className="mt-2 text-xs leading-6 text-token-secondary">{text}</p>
  </div>;
}

async function refreshMyPermissions() {
  const me = await getAdminAuthzMe();
  if (!me.success) { toast.warning('权限已保存，请刷新页面以更新当前账号状态'); return; }
  useAuthStore.getState().setPermissions(me.data.effectivePermissions);
  useAuthStore.getState().setPermFingerprint(me.data.permissionFingerprint ?? '');
}

function PermissionAssignments({ tab, catalog, roles }: { tab: 'menu' | 'function'; catalog: AdminPermissionDef[]; roles: SystemRoleDto[] }) {
  const entries = useMemo<PermissionEntry[]>(() => tab === 'menu' ? MENU_ENTRIES : catalog
    .filter((item) => item.key !== 'product-agent.use' && item.key !== 'review-agent.use')
    .map((item) => ({ key: item.key, label: item.name, permissions: [item.key], note: item.description ?? undefined })), [catalog, tab]);
  const [selected, setSelected] = useState(entries[0]?.key ?? '');
  const [query, setQuery] = useState('');
  const [userId, setUserId] = useState('');
  const [snapshot, setSnapshot] = useState<AdminUserAuthzSnapshot | null>(null);
  const [userLoading, setUserLoading] = useState(false);
  const [userError, setUserError] = useState('');
  const [changes, setChanges] = useState<Record<string, PermissionOverride>>({});
  const [saving, setSaving] = useState(false);
  const entry = entries.find((item) => item.key === selected);
  const userRole = roles.find((role) => role.key === snapshot?.effectiveSystemRoleKey);
  const visible = entries.filter((item) => `${item.label} ${item.note ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null); setChanges({}); setUserError('');
    if (!userId) { setUserLoading(false); return; }
    setUserLoading(true);
    void getUserAuthz(userId).then((result) => {
      if (cancelled) return;
      if (result.success) setSnapshot(result.data);
      else setUserError(result.error.message);
    }).catch(() => { if (!cancelled) setUserError('人员权限读取失败，请重新选择或重试。'); })
      .finally(() => { if (!cancelled) setUserLoading(false); });
    return () => { cancelled = true; };
  }, [userId]);

  const save = async () => {
    if (!snapshot || saving || Object.keys(changes).length === 0) return;
    setSaving(true); setUserError('');
    try {
      const latest = await getUserAuthz(snapshot.userId);
      if (!latest.success) throw new Error(latest.error.message);
      if (Object.keys(changes).some((key) => permissionOverride(latest.data, key) !== permissionOverride(snapshot, key))) {
        setSnapshot(latest.data); setChanges({});
        throw new Error('该人员的权限已被其他管理员更新，已重新读取。请核对后再配置。');
      }
      const result = await updateUserAuthz(snapshot.userId, mergePermissionOverrides(latest.data, changes));
      if (!result.success) throw new Error(result.error.message);
      setSnapshot(result.data); setChanges({}); toast.success('人员权限已保存');
      await refreshMyPermissions();
    } catch (cause) { setUserError(cause instanceof Error ? cause.message : '保存失败，请重试。'); }
    finally { setSaving(false); }
  };

  return <div className="grid min-h-0 gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
    <div>
      <label className="mb-3 flex items-center gap-2 rounded-md border border-token-subtle bg-token-nested px-3">
        <Search size={14} className="shrink-0 text-token-muted" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === 'menu' ? '搜索菜单' : '搜索功能'} aria-label={tab === 'menu' ? '搜索菜单' : '搜索功能'} className="min-w-0 flex-1 bg-transparent py-2 text-sm text-token-primary outline-none" />
      </label>
      <nav aria-label={tab === 'menu' ? '菜单列表' : '功能列表'} className="space-y-1">
        {visible.map((item) => <button key={item.key} type="button" aria-pressed={selected === item.key} disabled={saving} onClick={() => { setSelected(item.key); setChanges({}); }} className={`w-full rounded-md px-3 py-2.5 text-left text-sm transition-colors ${selected === item.key ? 'surface-action text-token-primary' : 'text-token-secondary hover-bg-soft'}`}>{item.label}</button>)}
        {visible.length === 0 && <p className="p-3 text-xs text-token-muted">没有匹配的项目，请调整关键词。</p>}
      </nav>
    </div>
    <section className="min-w-0 rounded-lg border border-token-subtle p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div><h3 className="text-sm font-semibold text-token-primary">{entry?.label}</h3><p className="mt-1 text-xs leading-6 text-token-secondary">{entry?.note ?? '先选择人员，再配置此功能的现有权限。'}</p></div>
        <Button size="sm" variant="primary" onClick={() => void save()} disabled={!snapshot || saving || Object.keys(changes).length === 0}>{saving ? <MapSpinner size={14} /> : <Save size={14} />}保存</Button>
      </div>
      {entry && entry.permissions.length === 0 ? <Notice title="当前没有独立授权项" text={entry.note ?? '该页面沿用已有的访问规则。'} /> : <>
        <div><label className="mb-2 block text-xs text-token-secondary">配置人员</label>{saving ? <p className="py-2 text-sm text-token-secondary">{snapshot?.displayName || snapshot?.username} · 正在保存</p> : <UserSearchSelect value={userId} onChange={(value) => { setChanges({}); setUserId(value); }} placeholder="搜索并选择要配置的人员" />}</div>
        {userLoading ? <MapSectionLoader text="正在读取人员权限…" /> : snapshot ? <div className="mt-5 space-y-3">
          <p className="text-xs text-token-muted">{snapshot.displayName || snapshot.username} · 当前角色：{userRole?.name ?? snapshot.effectiveSystemRoleKey}</p>
          {entry?.permissions.map((key) => {
            const definition = catalog.find((item) => item.key === key);
            if (!definition) return <Notice key={key} title="该权限暂不可配置" text="服务端权限目录未返回此项，请检查部署版本。" />;
            const mode = changes[key] ?? permissionOverride(snapshot, key);
            return <div key={key} className="flex flex-wrap items-center justify-between gap-3 border-b border-token-subtle py-3 last:border-b-0">
              <div className="min-w-0 flex-1"><p className="text-sm text-token-primary">{definition.name}</p><p className="mt-1 text-xs leading-5 text-token-muted">{definition.description}</p></div>
              <select aria-label={`${definition.name}的人员授权`} className={`${inputClass} sm:w-44`} value={mode} onChange={(event) => {
                const value = event.target.value as PermissionOverride;
                setChanges((previous) => { const next = { ...previous }; if (value === permissionOverride(snapshot, key)) delete next[key]; else next[key] = value; return next; });
              }} disabled={saving}>
                <option value="inherit">继承角色</option><option value="allow">额外允许</option><option value="deny">明确禁止</option>
              </select>
            </div>;
          })}
          <p className="text-xs leading-5 text-token-muted">“继承角色”清除该项人员例外；保存只修改你调整的权限。超级管理员的访问由既有超级权限控制。</p>
        </div> : !userError && <div className="py-10 text-center text-sm text-token-muted">选择人员后显示其现有授权，可按角色继承或单独调整。</div>}
      </>}
      {userError && <p role="alert" className="mt-4 text-sm text-[color:var(--accent-fg-danger)]">{userError}</p>}
    </section>
  </div>;
}

function RolePermissions({ catalog, roles, onChanged }: { catalog: AdminPermissionDef[]; roles: SystemRoleDto[]; onChanged: () => Promise<void> }) {
  const [selectedKey, setSelectedKey] = useState(roles[0]?.key ?? '');
  const role = roles.find((item) => item.key === selectedKey);
  const [checked, setChecked] = useState<string[]>(role?.permissions ?? []);
  const [roleKey, setRoleKey] = useState('');
  const [roleName, setRoleName] = useState('');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const scope = catalog.map((item) => item.key);
  const readOnly = !role || role.isBuiltIn || role.permissions.includes('super');
  useEffect(() => { setChecked(role?.permissions ?? []); setError(''); }, [role]);
  const dirty = role && scope.some((key) => checked.includes(key) !== role.permissions.includes(key));

  const save = async () => {
    if (!role || readOnly || saving || !dirty) return;
    setSaving(true); setError('');
    try {
      const latest = await getSystemRoles();
      if (!latest.success) throw new Error(latest.error.message);
      const current = latest.data.find((item) => item.key === role.key);
      if (!current || current.isBuiltIn || current.permissions.includes('super')) throw new Error('角色状态已变化，请刷新后重新配置。');
      if (scope.some((key) => current.permissions.includes(key) !== role.permissions.includes(key))) throw new Error('该角色已被其他管理员更新，请刷新后核对。');
      const result = await updateSystemRole(role.key, { key: role.key, name: current.name, permissions: mergeScopedRolePermissions(current.permissions, scope, checked) });
      if (!result.success) throw new Error(result.error.message);
      toast.success('角色权限已保存'); await onChanged(); await refreshMyPermissions();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '角色保存失败，请重试。'); }
    finally { setSaving(false); }
  };
  const create = async () => {
    if (!roleKey.trim() || !roleName.trim() || creating) return;
    setCreating(true); setError('');
    try {
      const result = await createSystemRole({ key: roleKey.trim(), name: roleName.trim(), permissions: [] });
      if (!result.success) throw new Error(result.error.message);
      setSelectedKey(result.data.key); setRoleKey(''); setRoleName(''); toast.success('角色已创建，请勾选需要的权限后保存'); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '角色创建失败，请重试。'); }
    finally { setCreating(false); }
  };

  return <div className="space-y-5">
    <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
      <nav aria-label="角色列表" className="space-y-1">
        {roles.map((item) => <button type="button" key={item.key} aria-pressed={selectedKey === item.key} disabled={saving || creating} onClick={() => setSelectedKey(item.key)} className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2.5 text-left text-sm ${selectedKey === item.key ? 'surface-action text-token-primary' : 'text-token-secondary hover-bg-soft'}`}><span>{item.name}</span>{item.isBuiltIn && <span className="text-xs text-token-muted">内置</span>}</button>)}
        {roles.length === 0 && <p className="p-3 text-xs text-token-muted">还没有可用角色，可在下方创建。</p>}
      </nav>
      <section className="rounded-lg border border-token-subtle p-4">
        <div className="mb-4 flex items-start justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-semibold text-token-primary"><ShieldCheck size={16} />{role?.name ?? '选择角色'}</h3><p className="mt-2 text-xs leading-5 text-token-secondary">显示该系统角色的产品管理及评审权限；其他应用的权限保存时保留。修改会影响绑定此角色的所有人员。</p></div><Button size="sm" variant="primary" disabled={readOnly || !dirty || saving} onClick={() => void save()}>{saving ? <MapSpinner size={14} /> : <Save size={14} />}保存角色</Button></div>
        {role?.isBuiltIn && <p className="mb-3 text-xs text-token-muted">内置角色由系统维护，不能修改。可创建自定义角色后配置权限。</p>}
        {role?.permissions.includes('super') && <p className="mb-3 text-xs text-token-muted">此角色已有超级权限，单独调整产品权限无法限制其访问。</p>}
        {role && <div className="divide-y divide-token-subtle">{catalog.map((item) => <label key={item.key} className="flex items-start gap-3 py-3"><input type="checkbox" aria-label={`${role.name}：${item.name}`} className="mt-1 h-4 w-4 shrink-0" checked={checked.includes(item.key) || role.permissions.includes('super')} disabled={readOnly || saving} onChange={(event) => setChecked((previous) => event.target.checked ? [...new Set([...previous, item.key])] : previous.filter((key) => key !== item.key))} /><span><span className="block text-sm text-token-primary">{item.name}</span><span className="mt-1 block text-xs leading-5 text-token-muted">{item.description}</span></span></label>)}</div>}
      </section>
    </div>
    <div className="flex flex-wrap items-end gap-3 border-t border-token-subtle pt-4">
      <label className="min-w-40 flex-1 text-xs text-token-secondary">角色名称<input className={`mt-2 ${inputClass}`} value={roleName} onChange={(event) => setRoleName(event.target.value)} placeholder="例如：产品评审成员" /></label>
      <label className="min-w-40 flex-1 text-xs text-token-secondary">角色标识<input className={`mt-2 ${inputClass}`} value={roleKey} onChange={(event) => setRoleKey(event.target.value)} placeholder="例如：product-reviewer" /></label>
      <Button size="sm" onClick={() => void create()} disabled={!roleName.trim() || !roleKey.trim() || creating || saving}>{creating ? <MapSpinner size={14} /> : <Plus size={14} />}创建角色</Button>
      <Button size="sm" disabled={saving || creating} onClick={() => void onChanged()}><RefreshCw size={14} />刷新</Button>
    </div>
    {error && <p role="alert" className="text-sm text-[color:var(--accent-fg-danger)]">{error}</p>}
  </div>;
}
