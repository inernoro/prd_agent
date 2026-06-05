import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ChevronRight, ChevronDown, Sparkles, Plus, Pencil, Compass, Lock } from 'lucide-react';
import { GOAL_STATUS_REGISTRY } from '../pmConstants';
import type { GoalNodeData } from './goalCanvasLayout';

const SCOPE_ACCENT: Record<string, string> = { team: '#3B82F6', personal: '#A855F7' };
const ROOT_ACCENT: Record<string, string> = { team: '#F59E0B', personal: '#A855F7' };

/** 进度环（小尺寸 SVG，走状态色） */
function ProgressRing({ value, color }: { value: number; color: string }) {
  const r = 13;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, value)) / 100);
  return (
    <svg width={32} height={32} viewBox="0 0 32 32" className="shrink-0">
      <circle cx={16} cy={16} r={r} fill="none" stroke="var(--bg-base)" strokeWidth={3} />
      <circle cx={16} cy={16} r={r} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={off} transform="rotate(-90 16 16)" />
      <text x={16} y={16} textAnchor="middle" dominantBaseline="central" style={{ fontSize: 9, fill: 'var(--text-secondary)' }}>{value}</text>
    </svg>
  );
}

function GoalNodeInner({ data, selected }: NodeProps & { data: GoalNodeData }) {
  const g = data.goal!;
  const st = GOAL_STATUS_REGISTRY[g.status];
  const accent = SCOPE_ACCENT[g.scope] ?? SCOPE_ACCENT.team;
  const depth = g.depth ?? 0;
  return (
    <div
      onClick={() => data.onOpen?.(g)}
      className="group rounded-xl border overflow-hidden cursor-pointer transition-shadow"
      style={{
        width: 248,
        background: 'var(--bg-card)',
        borderColor: selected ? accent : 'var(--border-subtle)',
        boxShadow: selected ? `0 0 0 2px ${accent}44` : '0 4px 12px -6px rgba(0,0,0,0.35)',
        borderLeft: `3px solid ${accent}`,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: accent, width: 7, height: 7, border: 'none' }} />
      <div className="px-3 py-2.5 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          {data.hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); data.onToggle?.(g.id); }}
              className="shrink-0" style={{ color: 'var(--text-muted)' }}
              title={data.collapsed ? '展开子目标' : '折叠子目标'}
            >
              {data.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
          )}
          {depth > 0 && (
            <span className="text-[9px] px-1 py-0.5 rounded shrink-0 tabular-nums" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>L{depth + 1}</span>
          )}
          <span className="text-[12.5px] font-medium truncate flex-1" style={{ color: 'var(--text-primary)' }} title={g.title}>{g.title}</span>
          <span className="text-[9px] px-1.5 py-0.5 rounded shrink-0" style={{ background: `${st.color}22`, color: st.color }}>{st.label}</span>
        </div>
        <div className="flex items-center gap-2">
          <ProgressRing value={g.progress} color={st.color} />
          <div className="flex-1 min-w-0 text-[10px] flex flex-col gap-0.5" style={{ color: 'var(--text-muted)' }}>
            {g.metric && <span className="truncate" title={g.metric}>指标：{g.metric}</span>}
            <span className="flex items-center gap-2">
              {g.period && <span>周期：{g.period}</span>}
              {data.hasChildren && data.collapsed && <span style={{ color: accent }}>{g.childCount ?? ''} 个子目标</span>}
            </span>
          </div>
        </div>
        {data.canWrite && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={(e) => { e.stopPropagation(); data.onDecompose?.(g); }} disabled={!data.canHaveChildren}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded disabled:opacity-30"
              style={{ color: '#F59E0B', background: 'rgba(245,158,11,0.10)' }}
              title={data.canHaveChildren ? 'AI 拆细为子目标' : '已达最大层级'}><Sparkles size={11} />拆细</button>
            <button onClick={(e) => { e.stopPropagation(); data.onAddChild?.(g); }} disabled={!data.canHaveChildren}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded disabled:opacity-30"
              style={{ color: 'var(--text-muted)', background: 'var(--bg-base)' }}
              title={data.canHaveChildren ? '加子目标' : '已达最大层级'}><Plus size={11} />子目标</button>
            <button onClick={(e) => { e.stopPropagation(); data.onOpen?.(g); }}
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ml-auto"
              style={{ color: 'var(--text-muted)', background: 'var(--bg-base)' }}
              title="编辑详情"><Pencil size={11} />编辑</button>
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: accent, width: 7, height: 7, border: 'none' }} />
    </div>
  );
}

function GoalRootInner({ data }: NodeProps & { data: GoalNodeData }) {
  const accent = ROOT_ACCENT[data.rootScope ?? 'team'];
  const Icon = data.rootScope === 'personal' ? Lock : Compass;
  return (
    <div className="rounded-xl border px-3.5 py-2.5 flex flex-col gap-1" style={{ width: 220, background: `${accent}14`, borderColor: `${accent}66` }}>
      <div className="flex items-center gap-1.5">
        <Icon size={14} style={{ color: accent }} />
        <span className="text-[12px] font-semibold" style={{ color: accent }}>{data.rootLabel}</span>
      </div>
      <div className="text-[11px] line-clamp-2" style={{ color: 'var(--text-primary)' }}>{data.rootSubtitle}</div>
      <Handle type="source" position={Position.Right} style={{ background: accent, width: 7, height: 7, border: 'none' }} />
    </div>
  );
}

export const GoalFlowNode = memo(GoalNodeInner);
export const GoalRootNode = memo(GoalRootInner);
