import { colors } from '../Charts';

interface StatCardProps {
  title: string;
  value: number | string;
  icon?: React.ReactNode;
  iconColor?: string;
  suffix?: React.ReactNode;
  valueColor?: string;
}

/**
 * 统计卡片组件 - Linear 风格
 * 
 * 两种变体：
 * - 带图标：适用于仪表盘概览
 * - 简洁型：适用于数据统计页
 */
export function StatCard({ 
  title, 
  value, 
  icon,
  iconColor = colors.accent,
  suffix,
  valueColor,
}: StatCardProps) {
  const displayValue = typeof value === 'number' ? value.toLocaleString() : value;
  
  // 简洁型（无图标）
  if (!icon) {
    return (
      <div className="stat-card stat-card-simple">
        <div className="stat-card-label">{title}</div>
        <div className="stat-card-value">
          <span 
            className="stat-card-number" 
            style={valueColor ? { color: valueColor } : undefined}
          >
            {displayValue}
          </span>
          {suffix && <span className="stat-card-suffix">{suffix}</span>}
        </div>
      </div>
    );
  }
  
  // 带图标型
  return (
    <div className="stat-card">
      <div className="stat-card-content">
        <div className="stat-card-label">{title}</div>
        <div className="stat-card-value">
          <span 
            className="stat-card-number"
            style={valueColor ? { color: valueColor } : undefined}
          >
            {displayValue}
          </span>
          {suffix && <span className="stat-card-suffix">{suffix}</span>}
        </div>
      </div>
      <div 
        className="stat-card-icon"
        style={{ 
          background: `color-mix(in srgb, ${iconColor} 15%, transparent)`,
          color: iconColor,
        }}
      >
        {icon}
      </div>
    </div>
  );
}

export default StatCard;

