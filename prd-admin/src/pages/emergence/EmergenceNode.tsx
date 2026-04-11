import { memo, useMemo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Sparkle, Zap, Star, Search, CheckCircle2, Pencil, Clock, Lightbulb, AlertTriangle } from 'lucide-react';

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
  missingCapabilities: string[];
  tags: string[];
  onExplore?: () => void;
  onStatusChange?: (newStatus: string) => void;
}

type EmergenceNodeType = NodeProps & { data: EmergenceNodeData };

// ── 维度视觉配置（使用项目色彩规范 rgba 格式）──
const dimensionConfig: Record<number, {
  accent: string; accentBg: string; accentBorder: string;
  label: string; Icon: typeof Zap;
}> = {
  1: {
    accent: 'rgba(59,130,246,0.85)', accentBg: 'rgba(59,130,246,0.08)', accentBorder: 'rgba(59,130,246,0.15)',
    label: '系统内', Icon: Zap,
  },
  2: {
    accent: 'rgba(147,51,234,0.85)', accentBg: 'rgba(147,51,234,0.08)', accentBorder: 'rgba(147,51,234,0.15)',
    label: '跨系统', Icon: Sparkle,
  },
  3: {
    accent: 'rgba(234,179,8,0.85)', accentBg: 'rgba(234,179,8,0.08)', accentBorder: 'rgba(234,179,8,0.15)',
    label: '幻想', Icon: Star,
  },
};

const statusConfig: Record<string, { icon: typeof CheckCircle2; label: string; color: string; bg: string; next: string }> = {
  idea: { icon: Lightbulb, label: '想法', color: 'rgba(255,255,255,0.5)', bg: 'rgba(255,255,255,0.04)', next: 'planned' },
  planned: { icon: Clock, label: '计划中', color: 'rgba(59,130,246,0.85)', bg: 'rgba(59,130,246,0.08)', next: 'building' },
  building: { icon: Pencil, label: '开发中', color: 'rgba(234,179,8,0.85)', bg: 'rgba(234,179,8,0.08)', next: 'done' },
  done: { icon: CheckCircle2, label: '已完成', color: 'rgba(34,197,94,0.85)', bg: 'rgba(34,197,94,0.08)', next: 'idea' },
};

function StarRating({ score, max = 5 }: { score: number; max?: number }) {
  return (
    <span className="inline-flex gap-px">
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className="text-[10px]" style={{ opacity: i < score ? 1 : 0.2 }}>★</span>
      ))}
    </span>
  );
}

function EmergenceNodeInner({ data, selected }: EmergenceNodeType) {
  const dim = dimensionConfig[data.dimension] ?? dimensionConfig[1];
  const sc = statusConfig[data.status] ?? statusConfig.idea;
  const isSeed = data.nodeType === 'seed';

  const cardStyle = useMemo((): React.CSSProperties => ({
    background: `linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)`,
    border: `1px ${data.dimension === 2 ? 'dashed' : 'solid'} ${dim.accentBorder.replace('0.15', selected ? '0.4' : '0.18')}`,
    borderRadius: 16,
    boxShadow: [
      selected ? `0 0 0 2px ${dim.accent.replace('0.85', '0.3')}` : '',
      '0 8px 16px -4px rgba(0, 0, 0, 0.3)',
      'inset 0 1px 1px rgba(255, 255, 255, 0.08)',
      data.dimension === 3 ? `0 0 24px -4px rgba(234,179,8,0.12)` : '',
    ].filter(Boolean).join(', '),
    backdropFilter: 'blur(40px) saturate(180%)',
    WebkitBackdropFilter: 'blur(40px) saturate(180%)',
    minWidth: 220,
    maxWidth: 300,
  }), [dim, selected, data.dimension]);

  return (
    <div style={cardStyle} className="p-3">
      {/* 入口 Handle */}
      {!isSeed && (
        <Handle type="target" position={Position.Top}
          style={{ background: dim.accent, width: 8, height: 8, border: 'none' }} />
      )}

      {/* 标题行 */}
      <div className="flex items-center gap-2 mb-2">
        <div className="w-7 h-7 rounded-[8px] flex items-center justify-center flex-shrink-0"
          style={{ background: dim.accentBg, border: `1px solid ${dim.accentBorder}` }}>
          <dim.Icon size={13} style={{ color: dim.accent }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {data.label}
          </div>
        </div>
        {/* 可点击状态徽章 */}
        <button
          onClick={(e) => { e.stopPropagation(); data.onStatusChange?.(sc.next); }}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-[6px] cursor-pointer transition-all duration-200 flex-shrink-0 hover:brightness-125"
          style={{ background: sc.bg, border: `1px solid ${sc.color.replace('0.85', '0.2')}` }}
          title={`点击切换状态 → ${statusConfig[sc.next]?.label}`}
        >
          <sc.icon size={10} style={{ color: sc.color }} />
          <span className="text-[9px] font-semibold" style={{ color: sc.color }}>{sc.label}</span>
        </button>
      </div>

      {/* 描述 */}
      <p className="text-[11px] leading-[1.5] mb-2"
        style={{ color: 'var(--text-muted)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {data.description}
      </p>

      {/* 评分行 */}
      <div className="flex items-center gap-3 text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
        <span>价值 <StarRating score={data.valueScore} /></span>
        <span>难度 <StarRating score={data.difficultyScore} /></span>
      </div>

      {/* 假设条件（二维/三维） */}
      {data.bridgeAssumptions?.length > 0 && (
        <p className="text-[10px] italic mb-2" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
          假设：{data.bridgeAssumptions.slice(0, 2).join('；')}
        </p>
      )}

      {/* 缺失能力警告 */}
      {data.missingCapabilities?.length > 0 && (
        <div className="mb-2 p-1.5 rounded-[6px]"
          style={{ background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.15)' }}>
          <div className="flex items-start gap-1.5">
            <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" style={{ color: 'rgba(234,179,8,0.8)' }} />
            <div>
              <p className="text-[9px] font-semibold mb-0.5" style={{ color: 'rgba(234,179,8,0.8)' }}>需外部支持</p>
              {data.missingCapabilities.slice(0, 2).map((mc, i) => (
                <p key={i} className="text-[9px] leading-[1.4]" style={{ color: 'var(--text-muted)' }}>{mc}</p>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 标签 */}
      {data.tags?.length > 0 && (
        <div className="flex gap-1 flex-wrap mb-2">
          {data.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="surface-row text-[10px] px-1.5 py-0.5 rounded-[6px]">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* 操作按钮 */}
      {data.onExplore && (
        <div className="pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <button
            onClick={(e) => { e.stopPropagation(); data.onExplore?.(); }}
            className="h-7 w-full rounded-[8px] text-[11px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-colors duration-200"
            style={{ background: dim.accentBg, border: `1px solid ${dim.accentBorder}`, color: dim.accent }}
          >
            <Search size={11} /> 探索
          </button>
        </div>
      )}

      {/* 出口 Handle */}
      <Handle type="source" position={Position.Bottom}
        style={{ background: dim.accent, width: 8, height: 8, border: 'none' }} />
    </div>
  );
}

export const EmergenceFlowNode = memo(EmergenceNodeInner);
