import { Shield, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { allPermissions, getPermissionsByMenu, type PermissionDef } from '@/lib/authzMenuMapping';

interface AuthzPermissionColumnProps {
  selectedMenuAppKey: string | null;
  checkedPermissions: Set<string>;
  onToggle: (key: string, checked: boolean) => void;
  onSave: () => void;
  onDelete?: () => void;
  canDelete?: boolean;
  saving?: boolean;
  loading?: boolean;
  roleName?: string;
  isBuiltIn?: boolean;
}

export function AuthzPermissionColumn({
  selectedMenuAppKey,
  checkedPermissions,
  onToggle,
  onSave,
  onDelete,
  canDelete,
  saving,
  loading,
  roleName,
  isBuiltIn,
}: AuthzPermissionColumnProps) {
  // 根据菜单过滤权限列表
  const permissions: PermissionDef[] = selectedMenuAppKey ? getPermissionsByMenu(selectedMenuAppKey) : allPermissions;

  // 分组：基础 / 读 / 写 / 管理 / 使用 / 超级
  const accessPerms = permissions.filter((p) => p.category === 'access');
  const readPerms = permissions.filter((p) => p.category === 'read');
  const writePerms = permissions.filter((p) => p.category === 'write');
  const managePerms = permissions.filter((p) => p.category === 'manage');
  const usePerms = permissions.filter((p) => p.category === 'use');
  const superPerms = permissions.filter((p) => p.category === 'super');

  const renderPermGroup = (title: string, perms: PermissionDef[]) => {
    if (perms.length === 0) return null;
    return (
      <div className="mb-4">
        <div className="text-xs font-medium mb-2 px-1" style={{ color: 'var(--text-muted)' }}>
          {title}
        </div>
        <div className="flex flex-col gap-1">
          {perms.map((p) => (
            <label
              key={p.key}
              className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-white/4 cursor-pointer transition-colors"
              style={{ background: checkedPermissions.has(p.key) ? 'rgba(214, 178, 106, 0.08)' : 'transparent' }}
            >
              <input
                type="checkbox"
                className="h-4 w-4 rounded"
                checked={checkedPermissions.has(p.key)}
                onChange={(e) => onToggle(p.key, e.target.checked)}
                disabled={loading || isBuiltIn}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
                  {p.label}
                </div>
                {p.description && (
                  <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    <span className="opacity-60">{p.key}</span>
                    {p.description && <span> · {p.description}</span>}
                  </div>
                )}
              </div>
            </label>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/5">
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--text-secondary)' }}>
            {isBuiltIn ? <ShieldCheck size={14} /> : <Shield size={14} />}
          </span>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            {roleName ? `${roleName} 的权限` : '权限列表'}
          </div>
          {isBuiltIn && (
            <span
              className="text-xs px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(214, 178, 106, 0.15)', color: 'rgba(214, 178, 106, 0.9)' }}
            >
              内置
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canDelete && !isBuiltIn && (
            <Button variant="ghost" size="sm" onClick={onDelete} disabled={loading || saving}>
              删除
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={onSave} disabled={loading || saving || isBuiltIn}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </div>

      {isBuiltIn && (
        <div
          className="mx-3 mt-3 px-3 py-2 rounded-lg text-xs"
          style={{ background: 'rgba(214, 178, 106, 0.1)', color: 'rgba(214, 178, 106, 0.8)' }}
        >
          内置角色的权限由代码定义，不可修改
        </div>
      )}

      {/* 权限列表 */}
      <div className="flex-1 min-h-0 overflow-auto p-3">
        {renderPermGroup('基础访问', accessPerms)}
        {renderPermGroup('读取权限', readPerms)}
        {renderPermGroup('写入权限', writePerms)}
        {renderPermGroup('管理权限', managePerms)}
        {renderPermGroup('使用权限', usePerms)}
        {renderPermGroup('超级权限', superPerms)}

        {permissions.length === 0 && (
          <div className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
            该菜单无关联权限
          </div>
        )}
      </div>
    </div>
  );
}
