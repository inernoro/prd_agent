import { X } from 'lucide-react';
import { menuList, allPermissions, type PermissionDef } from '@/lib/authzMenuMapping';

interface MenuPermissionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  menuAppKey: string | null;
}

export function MenuPermissionDialog({ open, onOpenChange, menuAppKey }: MenuPermissionDialogProps) {
  if (!open || !menuAppKey) return null;

  const menu = menuList.find((m) => m.appKey === menuAppKey);
  if (!menu) return null;

  // 获取该菜单关联的权限定义
  const permDefs: PermissionDef[] = menu.permissions
    .map((key) => allPermissions.find((p) => p.key === key))
    .filter((p): p is PermissionDef => p !== undefined);

  // 权限分类颜色
  const categoryColors: Record<string, { bg: string; text: string }> = {
    access: { bg: 'rgba(59, 130, 246, 0.15)', text: 'rgba(147, 197, 253, 0.9)' },
    read: { bg: 'rgba(34, 197, 94, 0.15)', text: 'rgba(134, 239, 172, 0.9)' },
    write: { bg: 'rgba(249, 115, 22, 0.15)', text: 'rgba(253, 186, 116, 0.9)' },
    manage: { bg: 'rgba(168, 85, 247, 0.15)', text: 'rgba(216, 180, 254, 0.9)' },
    use: { bg: 'rgba(214, 178, 106, 0.15)', text: 'rgba(214, 178, 106, 0.9)' },
    super: { bg: 'rgba(239, 68, 68, 0.15)', text: 'rgba(252, 165, 165, 0.9)' },
  };

  const categoryLabels: Record<string, string> = {
    access: '基础访问',
    read: '读取',
    write: '写入',
    manage: '管理',
    use: '使用',
    super: '超级',
  };

  return (
    <>
      {/* 遮罩层 */}
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0, 0, 0, 0.4)' }}
        onClick={() => onOpenChange(false)}
      />

      {/* 弹窗内容 */}
      <div
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[420px] max-h-[70vh] overflow-hidden rounded-2xl"
        style={{
          background: 'linear-gradient(180deg, var(--glass-bg-start, rgba(255, 255, 255, 0.08)) 0%, var(--glass-bg-end, rgba(255, 255, 255, 0.03)) 100%)',
          backdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
          WebkitBackdropFilter: 'blur(40px) saturate(180%) brightness(1.1)',
          border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.14))',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}
        >
          <div>
            <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              {menu.label}
            </div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              关联权限节点
            </div>
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
        <div className="p-5 overflow-auto max-h-[calc(70vh-80px)]">
          {permDefs.length === 0 ? (
            <div className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
              该菜单无关联权限节点
            </div>
          ) : (
            <div className="space-y-3">
              {permDefs.map((perm) => {
                const colors = categoryColors[perm.category] || categoryColors.access;
                const categoryLabel = categoryLabels[perm.category] || perm.category;

                return (
                  <div
                    key={perm.key}
                    className="p-3 rounded-xl"
                    style={{ background: 'rgba(255, 255, 255, 0.03)' }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        {/* 权限中文名称 */}
                        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                          {perm.label}
                        </div>
                        {/* 权限 key (英文) */}
                        <div
                          className="text-xs mt-1 font-mono"
                          style={{ color: 'var(--text-muted)', opacity: 0.7 }}
                        >
                          {perm.key}
                        </div>
                        {/* 权限描述 */}
                        {perm.description && (
                          <div className="text-xs mt-1.5" style={{ color: 'var(--text-secondary)' }}>
                            {perm.description}
                          </div>
                        )}
                      </div>

                      {/* 分类标签 */}
                      <span
                        className="text-[10px] px-2 py-0.5 rounded-md font-medium shrink-0"
                        style={{ background: colors.bg, color: colors.text }}
                      >
                        {categoryLabel}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="px-5 py-3 text-xs"
          style={{
            borderTop: '1px solid rgba(255, 255, 255, 0.06)',
            color: 'var(--text-muted)',
          }}
        >
          共 {permDefs.length} 个权限节点
        </div>
      </div>
    </>
  );
}
