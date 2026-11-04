import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Save, Search } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { getUsers, getUserAuthz, updateUserAuthz } from '@/services';
import type { AdminUser } from '@/types/admin';
import type { AdminPermissionDef, AdminUserAuthzSnapshot, SystemRoleDto } from '@/services/contracts/authz';
import { hasEffectivePermission } from '@/lib/permissionAccess';
import { useAuthStore } from '@/stores/authStore';
import { mergePermissionOverrides, type PermissionOverride } from './productPermissionEditing';
import { hasPermissionEditConflict, hasUnrestrictedPermissions, loadAllPermissionUsers, permissionCheckboxValue } from './productPermissionBatch';

type Changes = Record<string, Record<string, PermissionOverride>>;

export function ProductPermissionPeople({ permissionKeys, catalog, roles, onBusyChange, onSaved }: {
  permissionKeys: string[];
  catalog: AdminPermissionDef[];
  roles: SystemRoleDto[];
  onBusyChange: (busy: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const permissions = useAuthStore((state) => state.permissions);
  const isRoot = useAuthStore((state) => state.isRoot);
  const canReadUsers = hasEffectivePermission(permissions, 'users.read', isRoot);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, AdminUserAuthzSnapshot>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [changes, setChanges] = useState<Changes>({});
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [result, setResult] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const current = useRef(0);
  const saveLock = useRef(false);
  const retryLock = useRef(false);
  const definitions = permissionKeys.map((key) => catalog.find((item) => item.key === key));
  const missingDefinition = definitions.some((definition) => !definition);

  useEffect(() => {
    const sequence = ++current.current;
    const alive = () => current.current === sequence;
    if (!canReadUsers) { setLoading(false); return; }
    setLoading(true); setError(''); setUsers([]); setSnapshots({}); setRowErrors({});
    setChanges({}); setResult(''); setProgress('正在读取人员目录…');
    void (async () => {
      try {
        const directory = await loadAllPermissionUsers(async (page, pageSize) => {
          const response = await getUsers({ page, pageSize });
          if (!response.success) throw new Error(response.error.message);
          return response.data;
        }, alive, (loaded, total) => setProgress(`正在读取人员目录：${loaded} / ${total}`));
        if (!alive()) return;
        setUsers(directory);
        let cursor = 0;
        let completed = 0;
        const readWorker = async () => {
          while (alive() && cursor < directory.length) {
            const user = directory[cursor++];
            try {
              const response = await getUserAuthz(user.userId);
              if (!alive()) return;
              if (!response.success) throw new Error(response.error.message);
              setSnapshots((previous) => ({ ...previous, [user.userId]: response.data }));
            } catch (cause) {
              if (!alive()) return;
              setRowErrors((previous) => ({ ...previous, [user.userId]: cause instanceof Error ? cause.message : '读取失败，请重试。' }));
            }
            completed += 1;
            setProgress(`正在读取人员权限：${completed} / ${directory.length}`);
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, directory.length) }, readWorker));
      } catch (cause) {
        if (alive()) setError(cause instanceof Error ? cause.message : '人员目录加载失败，请重新加载。');
      } finally { if (alive()) setLoading(false); }
    })();
    return () => { current.current += 1; };
  }, [canReadUsers, reloadKey]);

  const visible = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return users.filter((user) => `${user.displayName} ${user.username}`.toLocaleLowerCase().includes(keyword));
  }, [users, query]);
  const rolePermissionsFor = (snapshot: AdminUserAuthzSnapshot) => roles.find((role) => role.key === snapshot.effectiveSystemRoleKey)?.permissions ?? [];
  const editableIds = visible.filter((user) => {
    const snapshot = snapshots[user.userId];
    return snapshot && !rowErrors[user.userId] && !hasUnrestrictedPermissions(snapshot, rolePermissionsFor(snapshot));
  }).map((user) => user.userId);
  const checkedFor = (id: string, key: string) => {
    const snapshot = snapshots[id];
    if (!snapshot) return false;
    const pending = changes[id]?.[key];
    return pending ? pending === 'allow' : permissionCheckboxValue(snapshot, rolePermissionsFor(snapshot), key);
  };
  const dirtyIds = Object.keys(changes).filter((id) => Object.keys(changes[id]).length > 0);

  const stage = useCallback((ids: string[], key: string, checked: boolean) => {
    setResult('');
    setChanges((previous) => {
      const next = { ...previous };
      ids.forEach((id) => {
        const snapshot = snapshots[id];
        if (!snapshot) return;
        const rolePermissions = roles.find((role) => role.key === snapshot.effectiveSystemRoleKey)?.permissions ?? [];
        if (hasUnrestrictedPermissions(snapshot, rolePermissions)) return;
        const edits = { ...next[id] };
        if (checked === permissionCheckboxValue(snapshot, rolePermissions, key)) delete edits[key];
        else edits[key] = checked ? 'allow' : 'deny';
        if (Object.keys(edits).length === 0) delete next[id];
        else next[id] = edits;
      });
      return next;
    });
  }, [snapshots, roles]);

  const save = async () => {
    if (saveLock.current || retryLock.current || dirtyIds.length === 0 || missingDefinition) return;
    saveLock.current = true; setSaving(true); onBusyChange(true); setResult('');
    const sequence = current.current;
    const alive = () => sequence === current.current;
    let succeeded = 0;
    let failed = 0;
    try {
      for (const id of dirtyIds) {
        if (!alive()) break;
        setProgress(`正在保存：${succeeded + failed + 1} / ${dirtyIds.length}`);
        try {
          const latest = await getUserAuthz(id);
          if (!alive()) break;
          if (!latest.success) throw new Error(latest.error.message);
          if (hasPermissionEditConflict(snapshots[id], latest.data, Object.keys(changes[id]))) {
            throw new Error('权限已被其他管理员更新，请重新读取此人权限后再配置。');
          }
          const response = await updateUserAuthz(id, mergePermissionOverrides(latest.data, changes[id]));
          if (!alive()) break;
          if (!response.success) throw new Error(response.error.message);
          succeeded += 1;
          setSnapshots((previous) => ({ ...previous, [id]: response.data }));
          setChanges((previous) => { const next = { ...previous }; delete next[id]; return next; });
          setRowErrors((previous) => { const next = { ...previous }; delete next[id]; return next; });
        } catch (cause) {
          if (!alive()) break;
          failed += 1;
          setRowErrors((previous) => ({ ...previous, [id]: cause instanceof Error ? cause.message : '保存失败，请重试。' }));
        }
      }
      if (alive()) {
        setResult(`已保存 ${succeeded} 人${failed ? `，失败 ${failed} 人。失败项仍保留待修改状态，可核对后重试。` : '，全部完成。'}`);
        if (succeeded > 0) {
          try { await onSaved(); }
          catch { if (alive()) setError('人员权限已保存，但当前账号状态刷新失败，请刷新页面。'); }
        }
      }
    } finally {
      saveLock.current = false;
      onBusyChange(false);
      if (alive()) setSaving(false);
    }
  };

  const retryPerson = async (id: string) => {
    if (retryLock.current || saveLock.current) return;
    retryLock.current = true; setRetrying(true); onBusyChange(true);
    const sequence = current.current;
    try {
      const response = await getUserAuthz(id);
      if (current.current !== sequence) return;
      if (!response.success) throw new Error(response.error.message);
      setSnapshots((previous) => ({ ...previous, [id]: response.data }));
      // 重新读取意味着重新核对，不能把冲突前的草稿静默套在新快照上。
      setChanges((previous) => { const next = { ...previous }; delete next[id]; return next; });
      setRowErrors((previous) => { const next = { ...previous }; delete next[id]; return next; });
    } catch (cause) {
      if (current.current === sequence) setRowErrors((previous) => ({ ...previous, [id]: cause instanceof Error ? cause.message : '读取失败，请重试。' }));
    } finally {
      retryLock.current = false; onBusyChange(false);
      if (current.current === sequence) setRetrying(false);
    }
  };

  if (!canReadUsers) return <p role="status" className="text-sm text-token-secondary">完整人员列表需要已有的“用户读取”权限，请联系权限管理员配置。此页面不会自动开通该权限。</p>;
  if (missingDefinition) return <p role="alert" className="text-sm text-token-secondary">服务端未返回此项权限目录，请刷新页面或检查部署版本后再配置。</p>;

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex min-w-48 flex-1 items-center gap-2 rounded-md border border-token-subtle bg-token-nested px-3">
        <Search size={14} className="text-token-muted" />
        <input aria-label="搜索配置人员" placeholder="搜索姓名或账号" value={query} disabled={saving} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-sm text-token-primary outline-none" />
      </label>
      <span className="text-xs text-token-muted">共 {users.length} 人，待保存 {dirtyIds.length} 人</span>
      <Button size="sm" disabled={saving || loading || retrying} onClick={() => { if (dirtyIds.length === 0 || window.confirm('重新加载会丢弃未保存的权限调整，是否继续？')) setReloadKey((value) => value + 1); }}><RefreshCw size={14} />重新加载</Button>
      <Button size="sm" variant="primary" disabled={saving || loading || retrying || dirtyIds.length === 0} onClick={() => void save()}>{saving ? <MapSpinner size={14} /> : <Save size={14} />}保存 {dirtyIds.length} 人</Button>
    </div>
    {(loading || saving) && <p role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-token-secondary"><MapSpinner size={14} />{progress}</p>}
    {error && <p role="alert" className="text-sm text-[color:var(--accent-fg-danger)]">{error}</p>}
    {result && <p role="status" className="text-sm text-token-secondary">{result}</p>}
    <p className="text-xs leading-5 text-token-muted">勾选表示有权限，点击保存后生效。表头全选只修改当前搜索结果。超级权限由系统维护，不能在此取消。</p>
    {loading && users.length === 0 ? <MapSectionLoader text="正在读取完整人员列表…" /> : <div className="max-h-[560px] overflow-auto rounded-md border border-token-subtle">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 bg-token-nested text-xs text-token-secondary"><tr><th scope="col" className="px-3 py-3">人员</th><th scope="col" className="px-3 py-3">角色</th>{definitions.map((definition) => {
          if (!definition) return null;
          const checkedCount = editableIds.filter((id) => checkedFor(id, definition.key)).length;
          return <th scope="col" key={definition.key} className="px-3 py-3"><label className="inline-flex items-center gap-2"><input type="checkbox" aria-label={`全选当前搜索结果的${definition.name}`} ref={(element) => { if (element) element.indeterminate = checkedCount > 0 && checkedCount < editableIds.length; }} checked={editableIds.length > 0 && checkedCount === editableIds.length} disabled={loading || saving || retrying || editableIds.length === 0} onChange={(event) => stage(editableIds, definition.key, event.target.checked)} className="h-4 w-4" />{definition.name} · 全选</label></th>;
        })}<th scope="col" className="px-3 py-3">状态</th></tr></thead>
        <tbody className="divide-y divide-token-subtle">{visible.map((user) => {
          const snapshot = snapshots[user.userId];
          const rowError = rowErrors[user.userId];
          const role = roles.find((item) => item.key === snapshot?.effectiveSystemRoleKey);
          return <tr key={user.userId} className="hover-bg-soft">
            <td className="px-3 py-3 text-token-primary"><span className="block">{user.displayName || user.username}</span><span className="text-xs text-token-muted">{user.username}{user.status === 'Disabled' ? ' · 已禁用' : ''}</span></td>
            <td className="px-3 py-3 text-xs text-token-secondary">{snapshot ? role?.name ?? snapshot.effectiveSystemRoleKey : '待读取'}</td>
            {definitions.map((definition) => definition && <td key={definition.key} className="px-3 py-3">{snapshot ? <input type="checkbox" aria-label={`${user.displayName || user.username}的${definition.name}`} disabled={loading || saving || retrying || Boolean(rowError) || hasUnrestrictedPermissions(snapshot, role?.permissions ?? [])} checked={checkedFor(user.userId, definition.key)} onChange={(event) => stage([user.userId], definition.key, event.target.checked)} className="h-4 w-4" /> : <span className="text-xs text-token-muted">待读取</span>}</td>)}
            <td className="max-w-64 px-3 py-3 text-xs text-token-secondary">{rowError ? <><p role="alert">{rowError}</p><button type="button" disabled={saving || loading || retrying} onClick={() => void retryPerson(user.userId)} className="mt-1 hover:underline">重新读取此人权限（清除此人草稿）</button></> : changes[user.userId] ? '待保存' : snapshot ? hasUnrestrictedPermissions(snapshot, role?.permissions ?? []) ? '超级权限由系统维护' : '已读取' : '待读取'}</td>
          </tr>;
        })}</tbody>
      </table>
      {!loading && visible.length === 0 && <p className="py-10 text-center text-sm text-token-muted">{users.length === 0 ? '没有可配置人员。' : '没有匹配人员，请调整搜索条件。'}</p>}
    </div>}
  </div>;
}
