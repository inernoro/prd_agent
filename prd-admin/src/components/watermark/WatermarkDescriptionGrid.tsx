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
 * 水印描述数据
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
  positionMode?: 'pixel' | 'ratio'; // 定位模式，用于格式化偏移值
  iconEnabled?: boolean;
  borderEnabled?: boolean;
  backgroundEnabled?: boolean;
  roundedBackgroundEnabled?: boolean;
}

interface WatermarkDescriptionGridProps {
  data: WatermarkDescriptionData;
  className?: string;
}

/**
 * 水印配置描述网格组件
 *
 * 统一"我的"视图和海鲜市场的水印描述展示。
 * 双列布局，显示所有10个配置字段。
 */
export const WatermarkDescriptionGrid: React.FC<WatermarkDescriptionGridProps> = ({
  data,
  className = '',
}) => {
  const fontDisplay = data.fontLabel || data.fontKey || 'Default';

  // 格式化偏移值：pixel 模式显示整数，ratio 模式显示 2 位小数
  const formatOffset = (x?: number | null, y?: number | null, mode?: 'pixel' | 'ratio' | null) => {
    if (x == null || y == null) return '-';
    if (mode === 'ratio') {
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }
    // pixel 模式或未指定模式，显示整数
    return `${Math.round(x)},${Math.round(y)}`;
  };

  return (
    <div
      className={`surface-inset overflow-auto rounded-[6px] ${className}`}
    >
      <div className="grid grid-cols-2 gap-x-2 gap-y-0 p-1.5 text-[10px] text-token-muted">
        <InfoRow label="文本" value={data.text || '无'} />
        <InfoRow label="字体" value={fontDisplay} />
        <InfoRow label="大小" value={data.fontSizePx != null ? `${data.fontSizePx}px` : '-'} />
        <InfoRow label="透明度" value={data.opacity != null ? `${Math.round(data.opacity * 100)}%` : '-'} />
        <InfoRow label="位置" value={data.anchor ? (anchorLabelMap[data.anchor] || data.anchor) : '-'} />
        <InfoRow label="偏移" value={formatOffset(data.offsetX, data.offsetY, data.positionMode)} />
        <InfoRow label="图标" value={data.iconEnabled != null ? (data.iconEnabled ? '启用' : '禁用') : '-'} />
        <InfoRow label="边框" value={data.borderEnabled != null ? (data.borderEnabled ? '启用' : '禁用') : '-'} />
        <InfoRow label="背景" value={data.backgroundEnabled != null ? (data.backgroundEnabled ? '启用' : '禁用') : '-'} />
        <InfoRow label="圆角" value={data.roundedBackgroundEnabled != null ? (data.roundedBackgroundEnabled ? '启用' : '禁用') : '-'} />
      </div>
    </div>
  );
};

/**
 * 信息行组件
 */
const InfoRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center gap-1">
    <span>{label}</span>
    <span className="truncate text-token-primary">{value}</span>
  </div>
);

export default WatermarkDescriptionGrid;
