interface PanelCardProps {
  title: string;
  children: React.ReactNode;
  isEmpty?: boolean;
  emptyText?: string;
  extra?: React.ReactNode;
}

/**
 * 面板卡片组件 - Linear 风格
 * 
 * 用于包装图表、表格等内容区域
 */
export function PanelCard({ 
  title, 
  children, 
  isEmpty,
  emptyText = '暂无数据',
  extra,
}: PanelCardProps) {
  return (
    <div className="panel-card">
      <div className="panel-card-header">
        <span className="panel-card-title">{title}</span>
        {extra && <div className="panel-card-extra">{extra}</div>}
      </div>
      <div className="panel-card-body">
        {isEmpty ? (
          <div className="panel-card-empty">
            <svg className="panel-card-empty-icon" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="8" y="12" width="48" height="40" rx="4" />
              <path d="M8 20h48M20 12v40M44 12v40" />
              <circle cx="32" cy="32" r="6" fill="currentColor" opacity="0.2" />
            </svg>
            <span className="panel-card-empty-text">{emptyText}</span>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

export default PanelCard;

