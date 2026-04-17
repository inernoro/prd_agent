import { memo, useMemo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Sparkle, Zap, Star, CheckCircle2, Pencil, Clock, Lightbulb, AlertTriangle } from 'lucide-react';

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
  onInspire?: () => void;
  onStatusChange?: (newStatus: string) => void;
  /** 占位骨架节点：展示 shimmer 动效，不响应交互 */
  isPlaceholder?: boolean;
  /** 占位序号：用于错开 shimmer 动画起始点 */
  placeholderIndex?: number;
  /** 新节点刚到达的标记：触发入场动画（0.5s 后由画布清除） */
  isJustArrived?: boolean;
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

// ── 骨架占位节点（正在生成中的 shimmer 卡片）──
function PlaceholderNode({ data }: EmergenceNodeType) {
  const dim = dimensionConfig[data.dimension] ?? dimensionConfig[1];
  const idx = data.placeholderIndex ?? 0;
  // 错开每个占位卡片的动画，制造"波纹"感
  const delay = `${idx * 0.18}s`;

  return (
    <div
      className="emergence-placeholder emergence-node-enter p-3"
      style={{
        background: `linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)`,
        border: `1px dashed ${dim.accentBorder}`,
        borderRadius: 16,
        boxShadow: '0 8px 16px -4px rgba(0, 0, 0, 0.3), inset 0 1px 1px rgba(255, 255, 255, 0.06)',
        backdropFilter: 'blur(40px) saturate(180%)',
        WebkitBackdropFilter: 'blur(40px) saturate(180%)',
        minWidth: 220,
        maxWidth: 300,
        width: 240,
        animationDelay: delay,
      }}
    >
      <Handle type="target" position={Position.Top}
        style={{ background: dim.accent, width: 8, height: 8, border: 'none', opacity: 0.4 }} />

      {/* 标题行骨架 */}
      <div className="flex items-center gap-2 mb-2">
        <div className="w-7 h-7 rounded-[8px] flex items-center justify-center flex-shrink-0"
          style={{ background: dim.accentBg, border: `1px solid ${dim.accentBorder}` }}>
          <dim.Icon size={13} style={{ color: dim.accent, opacity: 0.5 }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="shimmer-line" style={{ height: 10, width: '70%', borderRadius: 4, animationDelay: delay }} />
        </div>
      </div>

      {/* 描述骨架 */}
      <div className="space-y-1.5 mb-2">
        <div className="shimmer-line" style={{ height: 8, width: '95%', borderRadius: 4, animationDelay: delay }} />
        <div className="shimmer-line" style={{ height: 8, width: '60%', borderRadius: 4, animationDelay: `calc(${delay} + 0.08s)` }} />
      </div>

      {/* 评分骨架 */}
      <div className="flex items-center gap-2 mb-2">
        <div className="shimmer-line" style={{ height: 8, width: 60, borderRadius: 4, animationDelay: delay }} />
        <div className="shimmer-line" style={{ height: 8, width: 60, borderRadius: 4, animationDelay: `calc(${delay} + 0.1s)` }} />
      </div>

      {/* 底部"闪烁的期待感"文案 */}
      <div className="pt-2 flex items-center justify-center gap-1.5"
        style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <Sparkle size={11} className="emergence-twinkle" style={{ color: dim.accent, animationDelay: delay }} />
        <span className="text-[10px] emergence-pulse" style={{ color: 'var(--text-muted)', animationDelay: delay }}>
          即将涌现…
        </span>
      </div>

      <Handle type="source" position={Position.Bottom}
        style={{ background: dim.accent, width: 8, height: 8, border: 'none', opacity: 0.4 }} />
    </div>
  );
}

function EmergenceNodeInner(props: EmergenceNodeType) {
  const { data, selected } = props;

  const dim = dimensionConfig[data.dimension] ?? dimensionConfig[1];
  const sc = statusConfig[data.status] ?? statusConfig.idea;
  const isSeed = data.nodeType === 'seed';

  // 样式 memo 必须在任何条件 return 之前,以遵守 rules-of-hooks
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

  // 占位骨架节点走独立渲染路径(hooks 已全部执行完毕)
  if (data.isPlaceholder) return <PlaceholderNode {...props} />;

  return (
    <div
      style={cardStyle}
      className={`p-3 ${data.isJustArrived ? 'emergence-node-enter' : ''}`}
    >
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

      {/* 操作按钮：左=增加灵感（带提示词） 右=探索（不带提示词） */}
      {(data.onExplore || data.onInspire) && (
        <div className="pt-2 flex items-stretch gap-1.5" style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          {data.onInspire && (
            <button
              onClick={(e) => { e.stopPropagation(); data.onInspire?.(); }}
              className="flex-1 h-7 rounded-[8px] text-[11px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-all duration-150 hover:brightness-125 active:scale-[0.97]"
              style={{
                background: 'rgba(234,179,8,0.08)',
                border: '1px solid rgba(234,179,8,0.2)',
                color: 'rgba(234,179,8,0.9)',
              }}
              title="写一句想法，让 AI 按你的方向探索"
            >
              <Lightbulb size={11} /> 增加灵感
            </button>
          )}
          {data.onExplore && (
            <button
              onClick={(e) => { e.stopPropagation(); data.onExplore?.(); }}
              className="flex-1 h-7 rounded-[8px] text-[11px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-all duration-150 hover:brightness-125 active:scale-[0.97]"
              style={{ background: dim.accentBg, border: `1px solid ${dim.accentBorder}`, color: dim.accent }}
              title="直接探索，AI 自由发散子能力"
            >
              <Star size={11} /> 探索
            </button>
          )}
        </div>
      )}

      {/* 出口 Handle */}
      <Handle type="source" position={Position.Bottom}
        style={{ background: dim.accent, width: 8, height: 8, border: 'none' }} />
    </div>
  );
}

export const EmergenceFlowNode = memo(EmergenceNodeInner);
