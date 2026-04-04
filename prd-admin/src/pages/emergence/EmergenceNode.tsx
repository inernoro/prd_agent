import { memo, useMemo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Sparkle, Zap, Star, Search, CheckCircle2, Pencil, Clock, Lightbulb } from 'lucide-react';

// ── 节点数据类型 ──
export interface EmergenceNodeData {
  [key: string]: unknown;
  label: string;
  description: string;
  dimension: 1 | 2 | 3;
  nodeType: 'seed' | 'capability' | 'combination' | 'fantasy';
  valueScore: number;
  difficultyScore: number;
  status: 'idea' | 'planned' | 'building' | 'done';
  groundingContent: string;
  bridgeAssumptions: string[];
  tags: string[];
  onExplore?: () => void;
  onEmerge?: () => void;
}

type EmergenceNodeType = NodeProps & { data: EmergenceNodeData };

// 维度样式配置
const dimensionStyles: Record<number, { bg: string; border: string; glow: string; label: string; icon: typeof Zap }> = {
  1: { bg: 'rgba(59,130,246,0.08)', border: 'rgba(59,130,246,0.4)', glow: '', label: '一维·系统内', icon: Zap },
  2: { bg: 'rgba(147,51,234,0.08)', border: 'rgba(147,51,234,0.4)', glow: '', label: '二维·跨系统', icon: Sparkle },
  3: { bg: 'rgba(234,179,8,0.06)', border: 'rgba(234,179,8,0.4)', glow: '0 0 20px rgba(234,179,8,0.15)', label: '三维·幻想', icon: Star },
};

const statusIcons: Record<string, typeof CheckCircle2> = {
  idea: Lightbulb,
  planned: Clock,
  building: Pencil,
  done: CheckCircle2,
};

function StarRating({ score, max = 5 }: { score: number; max?: number }) {
  return (
    <span style={{ display: 'inline-flex', gap: 1 }}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} style={{ opacity: i < score ? 1 : 0.2, fontSize: 10 }}>★</span>
      ))}
    </span>
  );
}

function EmergenceNodeInner({ data, selected }: EmergenceNodeType) {
  const dim = dimensionStyles[data.dimension] ?? dimensionStyles[1];
  const DimIcon = dim.icon;
  const StatusIcon = statusIcons[data.status] ?? Lightbulb;
  const isSeed = data.nodeType === 'seed';

  const nodeStyle = useMemo(() => ({
    background: dim.bg,
    border: `1.5px ${data.dimension === 2 ? 'dashed' : 'solid'} ${dim.border}`,
    borderRadius: 12,
    padding: '12px 14px',
    minWidth: 220,
    maxWidth: 300,
    boxShadow: selected
      ? `0 0 0 2px ${dim.border}, ${dim.glow}`
      : dim.glow || 'none',
    transition: 'box-shadow 0.2s, border-color 0.2s',
    cursor: 'default',
  }), [dim, selected, data.dimension]);

  return (
    <div style={nodeStyle}>
      {/* 顶部入口 Handle */}
      {!isSeed && (
        <Handle type="target" position={Position.Top} style={{ background: dim.border, width: 8, height: 8 }} />
      )}

      {/* 标题行 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <DimIcon size={14} style={{ color: dim.border, flexShrink: 0 }} />
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {data.label}
        </span>
        <StatusIcon size={12} style={{ opacity: 0.6, flexShrink: 0 }} />
      </div>

      {/* 描述 */}
      <div style={{ fontSize: 11, opacity: 0.7, lineHeight: 1.4, marginBottom: 8, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {data.description}
      </div>

      {/* 评分 */}
      <div style={{ display: 'flex', gap: 12, fontSize: 10, opacity: 0.6, marginBottom: 6 }}>
        <span>价值 <StarRating score={data.valueScore} /></span>
        <span>难度 <StarRating score={data.difficultyScore} /></span>
      </div>

      {/* 假设条件（二维/三维节点） */}
      {data.bridgeAssumptions?.length > 0 && (
        <div style={{ fontSize: 10, opacity: 0.55, marginBottom: 6, fontStyle: 'italic' }}>
          假设：{data.bridgeAssumptions.slice(0, 2).join('；')}
        </div>
      )}

      {/* 标签 */}
      {data.tags?.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
          {data.tags.slice(0, 3).map((tag) => (
            <span key={tag} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}>
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* 操作按钮 */}
      <div style={{ display: 'flex', gap: 6 }}>
        {data.onExplore && (
          <button
            onClick={(e) => { e.stopPropagation(); data.onExplore?.(); }}
            style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: `1px solid ${dim.border}`, background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, color: 'inherit' }}
          >
            <Search size={11} /> 探索
          </button>
        )}
      </div>

      {/* 底部出口 Handle */}
      <Handle type="source" position={Position.Bottom} style={{ background: dim.border, width: 8, height: 8 }} />
    </div>
  );
}

export const EmergenceFlowNode = memo(EmergenceNodeInner);
