import { Tags, FolderInput, Share2, Trash2, X } from 'lucide-react';

// 批量操作条：多选条目后浮在列表底部的纯展示组件。
// 组件本身只渲染这一条水平 bar，定位（fixed / sticky / absolute）交由父级处理。

export interface BulkActionBarProps {
  count: number;          // 已选数量
  onTag?: () => void;
  onMove?: () => void;
  onShare?: () => void;
  onDelete?: () => void;
  onCancel: () => void;   // 必有
}

// 次级操作按钮的通用样式（打标签 / 移动到 / 分享 / 取消共用）
const baseBtnStyle: React.CSSProperties = {
  fontSize: 10,
  borderRadius: 7,
  padding: '4px 7px',
  background: 'var(--bg-card)',
  border: '1px solid var(--border-faint)',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
};

export function BulkActionBar(props: BulkActionBarProps) {
  const { count, onTag, onMove, onShare, onDelete, onCancel } = props;

  return (
    <div
      className="flex items-center gap-2"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-faint)',
        borderRadius: 12,
        padding: '7px 10px',
        boxShadow: '0 8px 22px rgba(0,0,0,0.3)',
      }}
    >
      {/* 左侧：已选数量提示 */}
      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>
        已选 {count} 项
      </span>

      {/* 右侧：操作按钮组，仅渲染传入了回调的按钮 */}
      <div className="flex gap-1.5" style={{ marginLeft: 'auto' }}>
        {onTag && (
          <button type="button" className="inline-flex items-center gap-1" style={baseBtnStyle} onClick={onTag}>
            <Tags size={10} />
            打标签
          </button>
        )}
        {onMove && (
          <button type="button" className="inline-flex items-center gap-1" style={baseBtnStyle} onClick={onMove}>
            <FolderInput size={10} />
            移动到
          </button>
        )}
        {onShare && (
          <button type="button" className="inline-flex items-center gap-1" style={baseBtnStyle} onClick={onShare}>
            <Share2 size={10} />
            分享
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            className="inline-flex items-center gap-1"
            // 删除走品牌语义红色，可硬编码
            style={{ ...baseBtnStyle, color: 'rgba(248,113,113,0.9)', borderColor: 'rgba(248,113,113,0.3)' }}
            onClick={onDelete}
          >
            <Trash2 size={10} />
            删除
          </button>
        )}
        {/* 取消始终渲染，放最后 */}
        <button type="button" className="inline-flex items-center gap-1" style={baseBtnStyle} onClick={onCancel}>
          <X size={10} />
          取消
        </button>
      </div>
    </div>
  );
}
