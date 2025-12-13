import { Empty } from '@arco-design/web-react';

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
            <Empty description={emptyText} />
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

export default PanelCard;

