import { ShieldCheck, Users, Plus } from 'lucide-react';
import { Button } from '@/components/design/Button';
import type { SystemRoleDto } from '@/services/contracts/authz';

interface AuthzRoleColumnProps {
  roles: SystemRoleDto[];
  activeKey: string | null;
  onSelect: (key: string | null) => void;
  onCreateClick: () => void;
  onResetClick: () => void;
  loading?: boolean;
  resetSubmitting?: boolean;
}

export function AuthzRoleColumn({
  roles,
  activeKey,
  onSelect,
  onCreateClick,
  onResetClick,
  loading,
  resetSubmitting,
}: AuthzRoleColumnProps) {
  const isAllSelected = activeKey === null;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/5">
        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          角色
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onCreateClick} disabled={loading} title="新增角色">
            <Plus size={14} />
          </Button>
        </div>
      </div>

      {/* 全部按钮 */}
      <div className="px-2 py-2">
        <button
          type="button"
          className="w-full text-left rounded-xl px-3 py-2.5 transition-all duration-200"
          style={{
            background: isAllSelected
              ? 'linear-gradient(135deg, rgba(214, 178, 106, 0.15) 0%, rgba(214, 178, 106, 0.08) 100%)'
              : 'transparent',
            border: isAllSelected ? '1px solid rgba(214, 178, 106, 0.3)' : '1px solid transparent',
          }}
          onClick={() => onSelect(null)}
        >
          <div className="flex items-center gap-2">
            <span
              className="shrink-0 inline-flex items-center justify-center rounded-lg w-7 h-7"
              style={{
                background: isAllSelected ? 'var(--gold-gradient)' : 'rgba(255,255,255,0.06)',
                color: isAllSelected ? '#1a1206' : 'var(--text-secondary)',
              }}
            >
              <ShieldCheck size={14} />
            </span>
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              全部
            </span>
          </div>
        </button>
      </div>

      {/* 角色列表 */}
      <div className="flex-1 min-h-0 overflow-auto px-2 pb-2">
        <div className="flex flex-col gap-1">
          {roles.map((r) => {
            const isActive = r.key === activeKey;
            const isBuiltIn = !!r.isBuiltIn;
            return (
              <button
                key={r.key}
                type="button"
                className="w-full text-left rounded-xl px-3 py-2.5 transition-all duration-200 hover:bg-white/4"
                style={{
                  background: isActive
                    ? 'linear-gradient(135deg, rgba(214, 178, 106, 0.12) 0%, rgba(214, 178, 106, 0.06) 100%)'
                    : 'transparent',
                  border: isActive
                    ? '1px solid rgba(214, 178, 106, 0.25)'
                    : isBuiltIn
                      ? '1px solid rgba(214, 178, 106, 0.1)'
                      : '1px solid transparent',
                }}
                onClick={() => onSelect(r.key)}
                disabled={loading}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="shrink-0 inline-flex items-center justify-center rounded-lg w-7 h-7"
                    style={{
                      background: isBuiltIn ? 'var(--gold-gradient)' : 'rgba(255,255,255,0.06)',
                      color: isBuiltIn ? '#1a1206' : 'var(--text-secondary)',
                    }}
                  >
                    {isBuiltIn ? <ShieldCheck size={14} /> : <Users size={14} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                      {r.name}
                    </div>
                    <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                      {r.key} · {r.permissions?.length || 0} 权限
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Footer: 重置内置 */}
      <div className="px-2 py-2 border-t border-white/5">
        <Button
          variant="ghost"
          size="sm"
          className="w-full text-xs"
          onClick={onResetClick}
          disabled={loading || resetSubmitting}
          title="内置角色从代码加载，此按钮已废弃"
        >
          {resetSubmitting ? '重置中...' : '重置内置'}
        </Button>
      </div>
    </div>
  );
}
