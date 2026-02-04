import React from 'react';

/**
 * 水印锚点位置标签映射
 */
export const anchorLabelMap: Record<string, string> = {
  'top-left': '左上',
  'top-right': '右上',
  'bottom-left': '左下',
  'bottom-right': '右下',
};

/**
 * 水印描述数据（支持部分字段）
 */
export interface WatermarkDescriptionData {
  text?: string;
  fontKey?: string;
  fontLabel?: string; // 已解析的字体显示名
  fontSizePx?: number;
  opacity?: number;
  anchor?: string;
  offsetX?: number;
  offsetY?: number;
  iconEnabled?: boolean;
  borderEnabled?: boolean;
  backgroundEnabled?: boolean;
  roundedBackgroundEnabled?: boolean;
}

interface WatermarkDescriptionGridProps {
  data: WatermarkDescriptionData;
  /**
   * 布局模式：
   * - 'full': 双列布局，显示所有10个字段（用于"我的"视图）
   * - 'compact': 单列布局，显示核心字段（用于海鲜市场预览）
   */
  mode?: 'full' | 'compact';
  className?: string;
}

/**
 * 水印配置描述网格组件
 *
 * 统一"我的"视图和海鲜市场的水印描述展示，避免样式重复定义。
 */
export const WatermarkDescriptionGrid: React.FC<WatermarkDescriptionGridProps> = ({
  data,
  mode = 'full',
  className = '',
}) => {
  const fontDisplay = data.fontLabel || data.fontKey || 'Default';

  if (mode === 'compact') {
    // 海鲜市场紧凑模式：单列，显示核心字段
    return (
      <div
        className={`overflow-auto border rounded-[6px] ${className}`}
        style={{
          borderColor: 'var(--border-subtle)',
          background: 'rgba(255,255,255,0.02)',
        }}
      >
        <div className="text-[11px] grid gap-1 grid-cols-1 p-2" style={{ color: 'var(--text-muted)' }}>
          <InfoRow label="文字" value={data.text || '（空）'} labelWidth={36} />
          <InfoRow label="字体" value={fontDisplay} labelWidth={36} />
          {data.fontSizePx !== undefined && (
            <InfoRow label="大小" value={`${data.fontSizePx}px`} labelWidth={36} />
          )}
          {data.opacity !== undefined && (
            <InfoRow label="透明度" value={`${Math.round(data.opacity * 100)}%`} labelWidth={36} />
          )}
          {data.anchor && (
            <InfoRow label="位置" value={anchorLabelMap[data.anchor] || data.anchor} labelWidth={36} />
          )}
        </div>
      </div>
    );
  }

  // 完整模式：双列布局，显示所有字段
  return (
    <div
      className={`overflow-auto border rounded-[6px] ${className}`}
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      <div className="text-[10px] grid grid-cols-2 gap-x-2 gap-y-0 p-1.5" style={{ color: 'var(--text-muted)' }}>
        <InfoRowCompact label="文本" value={data.text || '无'} />
        <InfoRowCompact label="字体" value={fontDisplay} />
        <InfoRowCompact label="大小" value={data.fontSizePx !== undefined ? `${data.fontSizePx}px` : '-'} />
        <InfoRowCompact label="透明度" value={data.opacity !== undefined ? `${Math.round(data.opacity * 100)}%` : '-'} />
        <InfoRowCompact label="位置" value={data.anchor ? (anchorLabelMap[data.anchor] || data.anchor) : '-'} />
        <InfoRowCompact label="偏移" value={data.offsetX !== undefined && data.offsetY !== undefined ? `${data.offsetX},${data.offsetY}` : '-'} />
        <InfoRowCompact label="图标" value={data.iconEnabled !== undefined ? (data.iconEnabled ? '启用' : '禁用') : '-'} />
        <InfoRowCompact label="边框" value={data.borderEnabled !== undefined ? (data.borderEnabled ? '启用' : '禁用') : '-'} />
        <InfoRowCompact label="背景" value={data.backgroundEnabled !== undefined ? (data.backgroundEnabled ? '启用' : '禁用') : '-'} />
        <InfoRowCompact label="圆角" value={data.roundedBackgroundEnabled !== undefined ? (data.roundedBackgroundEnabled ? '启用' : '禁用') : '-'} />
      </div>
    </div>
  );
};

/**
 * 信息行组件（紧凑模式用）
 */
const InfoRow: React.FC<{ label: string; value: string; labelWidth?: number }> = ({
  label,
  value,
  labelWidth = 36,
}) => (
  <div className="grid items-center gap-2" style={{ gridTemplateColumns: `${labelWidth}px auto` }}>
    <span>{label}</span>
    <span className="truncate" style={{ color: 'var(--text-primary)' }}>{value}</span>
  </div>
);

/**
 * 信息行组件（完整模式用，更紧凑）
 */
const InfoRowCompact: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center gap-1">
    <span>{label}</span>
    <span className="truncate" style={{ color: 'var(--text-primary)' }}>{value}</span>
  </div>
);

export default WatermarkDescriptionGrid;
