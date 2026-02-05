/**
 * 通用模型列表项组件
 *
 * 用于展示模型信息，包含：
 * - 序号（多个模型时显示）
 * - 平台标签
 * - 模型名称（带图标）
 *
 * 支持三种尺寸：sm（小）、md（中）、lg（大）
 */

import { Box } from 'lucide-react';
import { PlatformLabel } from '@/components/design/PlatformLabel';

export interface ModelListItemData {
  platformId: string;
  platformName?: string;
  modelId: string;
  modelName?: string;
}

export interface ModelListItemProps {
  /** 模型数据 */
  model: ModelListItemData;
  /** 序号（从1开始），不传或为0则不显示 */
  index?: number;
  /** 总数，用于判断是否显示序号（总数为1时隐藏序号） */
  total?: number;
  /** 尺寸：sm 小 / md 中 / lg 大 */
  size?: 'sm' | 'md' | 'lg';
  /** 额外的 className */
  className?: string;
  /** 右侧插槽 */
  suffix?: React.ReactNode;
  /** 点击事件 */
  onClick?: () => void;
  /** 启用 hover 高亮效果 */
  hoverable?: boolean;
  /** hover 时的背景色 */
  hoverBg?: string;
}

const SIZE_CONFIG = {
  sm: {
    container: 'px-2 py-1.5 gap-2',
    index: 'text-[10px] w-4',
    platform: 'sm' as const,
    icon: 12,
    model: 'text-[12px]',
  },
  md: {
    container: 'px-3 py-2 gap-2.5',
    index: 'text-[11px] w-5',
    platform: 'sm' as const,
    icon: 14,
    model: 'text-[13px]',
  },
  lg: {
    container: 'px-4 py-2.5 gap-3',
    index: 'text-[12px] w-6',
    platform: 'md' as const,
    icon: 16,
    model: 'text-[14px]',
  },
};

export function ModelListItem({
  model,
  index,
  total,
  size = 'md',
  className = '',
  suffix,
  onClick,
  hoverable = false,
  hoverBg = 'rgba(251, 191, 36, 0.08)',
}: ModelListItemProps) {
  const config = SIZE_CONFIG[size];
  const showIndex = index !== undefined && index > 0 && (total === undefined || total > 1);
  const displayName = model.modelName || model.modelId;
  const platformDisplay = model.platformName || model.platformId;

  return (
    <div
      className={`flex items-center rounded-lg transition-colors ${hoverable ? 'group' : ''} ${config.container} ${className}`}
      style={{ background: 'rgba(255,255,255,0.03)' }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      onMouseEnter={hoverable ? (e) => { e.currentTarget.style.background = hoverBg; } : undefined}
      onMouseLeave={hoverable ? (e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; } : undefined}
    >
      {/* 序号 */}
      {showIndex && (
        <span
          className={`${config.index} shrink-0 text-center font-medium`}
          style={{ color: 'var(--text-muted)' }}
        >
          {index}
        </span>
      )}

      {/* 平台标签 */}
      <PlatformLabel name={platformDisplay} size={config.platform} />

      {/* 模型名称 */}
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        <Box size={config.icon} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
        <span
          className={`${config.model} truncate`}
          style={{ color: 'var(--text-primary)' }}
          title={displayName}
        >
          {displayName}
        </span>
      </div>

      {/* 右侧插槽 */}
      {suffix && <div className="shrink-0">{suffix}</div>}
    </div>
  );
}

/**
 * 模型列表组件
 * 自动处理序号显示逻辑
 */
export interface ModelListProps {
  /** 模型列表 */
  models: ModelListItemData[];
  /** 尺寸 */
  size?: 'sm' | 'md' | 'lg';
  /** 列表容器 className */
  className?: string;
  /** 单项 className */
  itemClassName?: string;
  /** 渲染右侧插槽 */
  renderSuffix?: (model: ModelListItemData, index: number) => React.ReactNode;
  /** 点击事件 */
  onItemClick?: (model: ModelListItemData, index: number) => void;
}

export function ModelList({
  models,
  size = 'md',
  className = '',
  itemClassName = '',
  renderSuffix,
  onItemClick,
}: ModelListProps) {
  if (!models || models.length === 0) {
    return null;
  }

  return (
    <div className={`space-y-1.5 ${className}`}>
      {models.map((model, idx) => (
        <ModelListItem
          key={`${model.platformId}:${model.modelId}`}
          model={model}
          index={idx + 1}
          total={models.length}
          size={size}
          className={itemClassName}
          suffix={renderSuffix?.(model, idx)}
          onClick={onItemClick ? () => onItemClick(model, idx) : undefined}
        />
      ))}
    </div>
  );
}
