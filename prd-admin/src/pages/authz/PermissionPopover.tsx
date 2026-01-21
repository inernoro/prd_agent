import { useState, useEffect } from 'react';
import { X, Trash2 } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { allPermissions, type PermissionDef } from '@/lib/authzMenuMapping';

interface PermissionPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roleName: string;
  menuLabel: string;
  menuPermissions: string[];
  currentPermissions: string[];
  onSave: (permissions: string[]) => void;
  onDelete?: () => void;
  saving?: boolean;
  isBuiltIn?: boolean;
}

export function PermissionPopover({
  open,
  onOpenChange,
  roleName,
  menuLabel,
  menuPermissions,
  currentPermissions,
  onSave,
  onDelete,
  saving,
  isBuiltIn,
}: PermissionPopoverProps) {
  const [checkedPerms, setCheckedPerms] = useState<Set<string>>(new Set(currentPermissions));

  // 同步 currentPermissions
  useEffect(() => {
    setCheckedPerms(new Set(currentPermissions));
  }, [currentPermissions]);

  if (!open) return null;

  // 获取该菜单下的权限定义
  const permDefs: PermissionDef[] = menuPermissions
    .map((key) => allPermissions.find((p) => p.key === key))
    .filter((p): p is PermissionDef => p !== undefined);

  const handleToggle = (key: string) => {
    if (isBuiltIn) return;
    setCheckedPerms((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (isBuiltIn) return;
    setCheckedPerms(new Set(menuPermissions));
  };

  const handleClearAll = () => {
    if (isBuiltIn) return;
    setCheckedPerms(new Set());
  };

  const handleSave = () => {
    if (isBuiltIn) return;
    onSave(Array.from(checkedPerms));
  };

  const hasChanges = (() => {
    if (checkedPerms.size !== currentPermissions.length) return true;
    for (const p of currentPermissions) {
      if (!checkedPerms.has(p)) return true;
    }
    return false;
  })();

  return (
    <>
      {/* 遮罩层 */}
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0, 0, 0, 0.3)' }}
        onClick={() => onOpenChange(false)}
      />

      {/* Popover 内容 */}
      <div
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[360px] max-h-[80vh] overflow-hidden rounded-2xl"
        style={{
          background: 'rgba(24, 24, 28, 0.95)',
          backdropFilter: 'blur(20px)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}
        >
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {roleName} - {menuLabel}
            </div>
            {isBuiltIn && (
              <div className="text-xs mt-0.5" style={{ color: 'rgba(214, 178, 106, 0.8)' }}>
                内置角色不可修改
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="p-1.5 rounded-lg hover:bg-white/5 transition-colors"
          >
            <X size={16} style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-auto max-h-[50vh]">
          {permDefs.length === 0 ? (
            <div className="text-sm text-center py-4" style={{ color: 'var(--text-muted)' }}>
              该菜单无关联权限
            </div>
          ) : (
            <div className="space-y-2">
              {permDefs.map((perm) => (
                <label
                  key={perm.key}
                  className="flex items-start gap-3 p-2 rounded-xl cursor-pointer transition-colors hover:bg-white/4"
                  style={{
                    background: checkedPerms.has(perm.key) ? 'rgba(214, 178, 106, 0.08)' : 'transparent',
                    opacity: isBuiltIn ? 0.7 : 1,
                    cursor: isBuiltIn ? 'default' : 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded"
                    checked={checkedPerms.has(perm.key)}
                    onChange={() => handleToggle(perm.key)}
                    disabled={isBuiltIn}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
                      {perm.label}
                    </div>
                    {perm.description && (
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {perm.description}
                      </div>
                    )}
                    <div className="text-[10px] mt-0.5 opacity-50" style={{ color: 'var(--text-muted)' }}>
                      {perm.key}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderTop: '1px solid rgba(255, 255, 255, 0.06)' }}
        >
          <div className="flex items-center gap-2">
            {!isBuiltIn && permDefs.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={handleSelectAll}
                  className="text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  全选
                </button>
                <button
                  type="button"
                  onClick={handleClearAll}
                  className="text-xs px-2 py-1 rounded hover:bg-white/5 transition-colors"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  清空
                </button>
              </>
            )}
            {onDelete && !isBuiltIn && (
              <button
                type="button"
                onClick={onDelete}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-red-500/10 transition-colors"
                style={{ color: 'rgba(239, 68, 68, 0.8)' }}
              >
                <Trash2 size={12} />
                删除角色
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            {!isBuiltIn && (
              <Button variant="primary" size="sm" onClick={handleSave} disabled={saving || !hasChanges}>
                {saving ? '保存中...' : '保存'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
