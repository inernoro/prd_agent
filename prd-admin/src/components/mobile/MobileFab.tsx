import { Plus, type LucideIcon } from 'lucide-react';

/**
 * 移动端浮动操作按钮（FAB）—— 承载页面主操作（新建/提交）。
 *
 * 固定在右下、底部 Tab 栏之上，让主操作一眼可见、单手可达，
 * 把次要操作让给「⋯」Sheet（chief-designer-usability 第三原则：主操作明显）。
 */
export interface MobileFabProps {
  onClick: () => void;
  icon?: LucideIcon;
  label?: string;
  /** 渐变起止色 */
  accent?: { from: string; to: string };
}

export function MobileFab({ onClick, icon: Icon = Plus, label, accent }: MobileFabProps) {
  const from = accent?.from ?? '#5E5CE6';
  const to = accent?.to ?? '#0A84FF';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label ?? '新建'}
      className="fixed flex items-center justify-center active:scale-90"
      style={{
        right: 18,
        bottom: 'calc(var(--mobile-tab-height, 60px) + env(safe-area-inset-bottom, 0px) + 16px)',
        height: 56,
        paddingLeft: label ? 18 : 0,
        paddingRight: label ? 20 : 0,
        width: label ? undefined : 56,
        gap: label ? 8 : 0,
        borderRadius: label ? 20 : 19,
        border: 'none',
        background: `linear-gradient(135deg, ${from}, ${to})`,
        boxShadow: `0 12px 30px -8px ${from}99`,
        color: '#fff',
        zIndex: 120,
        transition: 'transform 0.15s ease',
      }}
    >
      <Icon size={26} strokeWidth={2.6} />
      {label && <span style={{ fontSize: 16, fontWeight: 700 }}>{label}</span>}
    </button>
  );
}
