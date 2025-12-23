import { Server } from 'lucide-react';
import { getPlatformTone, platformChipStyle } from '@/lib/platformColors';

export interface PlatformLabelProps {
  name: string | null | undefined;
  className?: string;
  showIcon?: boolean;
  size?: 'sm' | 'md';
}

/**
 * 平台标签组件
 * 根据平台名称自动匹配专属颜色
 */
export function PlatformLabel({ name, className, showIcon = true, size = 'sm' }: PlatformLabelProps) {
  const displayName = (name ?? '').trim();
  if (!displayName) return null;

  const tone = getPlatformTone(name);
  const style = platformChipStyle(tone);

  const sizeClasses = size === 'sm'
    ? 'px-2 h-5 text-[11px]'
    : 'px-2.5 h-6 text-xs';

  return (
    <label
      className={`inline-flex items-center gap-1 rounded-full font-semibold tracking-wide shrink-0 ${sizeClasses} ${className ?? ''}`}
      title={displayName}
      style={style}
    >
      {showIcon && <Server size={size === 'sm' ? 10 : 12} />}
      {displayName}
    </label>
  );
}

