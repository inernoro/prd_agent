import { memo, useMemo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Loader2, AlertCircle, CheckCircle2, FlaskConical } from 'lucide-react';
import { getIconForCapsule, getEmojiForCapsule } from './capsuleRegistry';
import type { ArtifactSlot } from '@/services/contracts/workflowAgent';

// ═══════════════════════════════════════════════════════════════
// CapsuleNode — React Flow 自定义节点
//
// 每个舱在画布上渲染为一个带有输入/输出端口 (Handle) 的卡片。
// 顶部输入端口，底部输出端口，中间显示图标 + 名称 + 状态。
// ═══════════════════════════════════════════════════════════════

export interface CapsuleNodeData {
  [key: string]: unknown;
  label: string;
  capsuleType: string;
  icon: string;
  accentHue: number;
  inputSlots: ArtifactSlot[];
  outputSlots: ArtifactSlot[];
  /** pending | running | completed | failed | idle */
  execStatus?: string;
  durationMs?: number;
  testable?: boolean;
  onTestRun?: (typeKey: string) => void;
  /** 选中态 */
  selected?: boolean;
}

type CapsuleNodeType = NodeProps & { data: CapsuleNodeData };

// 状态色
function statusColor(status?: string) {
  switch (status) {
    case 'running': return { bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.35)', glow: 'rgba(59,130,246,0.2)' };
    case 'completed': return { bg: 'rgba(34,197,94,0.1)', border: 'rgba(34,197,94,0.3)', glow: 'rgba(34,197,94,0.15)' };
    case 'failed': return { bg: 'rgba(239,68,68,0.1)', border: 'rgba(239,68,68,0.3)', glow: 'rgba(239,68,68,0.15)' };
    default: return { bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.12)', glow: 'transparent' };
  }
}

function CapsuleNodeInner({ data, selected }: CapsuleNodeType) {
  const Icon = useMemo(() => getIconForCapsule(data.icon), [data.icon]);
  const emoji = useMemo(() => getEmojiForCapsule(data.capsuleType), [data.capsuleType]);
  const sc = statusColor(data.execStatus);

  return (
    <div
      className="relative group transition-all duration-200"
      style={{
        minWidth: 180,
        maxWidth: 240,
      }}
    >
      {/* 输入端口 (顶部) */}
      {data.inputSlots.map((slot, i) => (
        <Handle
          key={slot.slotId}
          type="target"
          position={Position.Top}
          id={slot.slotId}
          style={{
            left: data.inputSlots.length === 1
              ? '50%'
              : `${((i + 1) / (data.inputSlots.length + 1)) * 100}%`,
            width: 10,
            height: 10,
            background: 'rgba(255,255,255,0.15)',
            border: '2px solid rgba(255,255,255,0.3)',
            borderRadius: '50%',
            transition: 'all 0.2s',
          }}
          title={`${slot.name} (${slot.dataType})`}
        />
      ))}
      {/* 没有输入插槽也要有一个默认的 target handle 允许连线 */}
      {data.inputSlots.length === 0 && (
        <Handle
          type="target"
          position={Position.Top}
          id="default-in"
          style={{
            width: 10, height: 10,
            background: 'rgba(255,255,255,0.08)',
            border: '2px solid rgba(255,255,255,0.15)',
            borderRadius: '50%',
          }}
        />
      )}

      {/* 节点主体 */}
      <div
        className="rounded-[14px] px-4 py-3 backdrop-blur-xl transition-all duration-200"
        style={{
          background: sc.bg,
          border: `1.5px solid ${selected ? `hsla(${data.accentHue}, 70%, 60%, 0.6)` : sc.border}`,
          boxShadow: `0 0 ${selected ? '20px' : '12px'} ${selected ? `hsla(${data.accentHue}, 70%, 60%, 0.2)` : sc.glow}, 0 4px 16px rgba(0,0,0,0.3)`,
        }}
      >
        {/* 头部：图标 + 名称 */}
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-[10px] flex items-center justify-center flex-shrink-0"
            style={{
              background: `hsla(${data.accentHue}, 60%, 55%, 0.15)`,
              color: `hsla(${data.accentHue}, 60%, 65%, 0.95)`,
            }}
          >
            <Icon className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1">
              <span className="text-sm">{emoji}</span>
              <span
                className="text-[12px] font-semibold truncate"
                style={{ color: 'var(--text-primary, #e8e6e3)' }}
              >
                {data.label}
              </span>
            </div>
          </div>
        </div>

        {/* 状态指示 */}
        <div className="mt-2 flex items-center gap-2">
          {data.execStatus === 'running' && (
            <div className="flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" style={{ color: 'rgba(59,130,246,0.9)' }} />
              <span className="text-[10px]" style={{ color: 'rgba(59,130,246,0.9)' }}>运行中...</span>
            </div>
          )}
          {data.execStatus === 'completed' && (
            <div className="flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" style={{ color: 'rgba(34,197,94,0.85)' }} />
              <span className="text-[10px]" style={{ color: 'rgba(34,197,94,0.85)' }}>
                完成{data.durationMs != null ? ` · ${(data.durationMs / 1000).toFixed(1)}s` : ''}
              </span>
            </div>
          )}
          {data.execStatus === 'failed' && (
            <div className="flex items-center gap-1">
              <AlertCircle className="w-3 h-3" style={{ color: 'rgba(239,68,68,0.85)' }} />
              <span className="text-[10px]" style={{ color: 'rgba(239,68,68,0.85)' }}>失败</span>
            </div>
          )}
          {!data.execStatus || data.execStatus === 'idle' || data.execStatus === 'pending' ? (
            <div className="flex items-center gap-1.5">
              {/* 插槽预览 */}
              {data.inputSlots.length > 0 && (
                <span className="text-[9px] px-1.5 py-0.5 rounded" style={{
                  background: 'rgba(255,255,255,0.05)',
                  color: 'var(--text-muted, #888)',
                }}>
                  {data.inputSlots.length} 入
                </span>
              )}
              {data.outputSlots.length > 0 && (
                <span className="text-[9px] px-1.5 py-0.5 rounded" style={{
                  background: 'rgba(34,197,94,0.08)',
                  color: 'rgba(34,197,94,0.7)',
                }}>
                  {data.outputSlots.length} 出
                </span>
              )}
              {data.testable && data.onTestRun && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    data.onTestRun!(data.capsuleType);
                  }}
                  className="text-[9px] px-1.5 py-0.5 rounded flex items-center gap-0.5 transition-colors"
                  style={{
                    background: `hsla(${data.accentHue}, 60%, 55%, 0.1)`,
                    color: `hsla(${data.accentHue}, 60%, 65%, 0.85)`,
                    border: `1px solid hsla(${data.accentHue}, 60%, 55%, 0.15)`,
                  }}
                >
                  <FlaskConical className="w-2.5 h-2.5" />
                  测试
                </button>
              )}
            </div>
          ) : null}
        </div>

        {/* 运行态脉冲条 */}
        {data.execStatus === 'running' && (
          <div className="mt-2 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
            <div
              className="h-full rounded-full animate-pulse"
              style={{ width: '60%', background: 'rgba(59,130,246,0.5)' }}
            />
          </div>
        )}
      </div>

      {/* 输出端口 (底部) */}
      {data.outputSlots.map((slot, i) => (
        <Handle
          key={slot.slotId}
          type="source"
          position={Position.Bottom}
          id={slot.slotId}
          style={{
            left: data.outputSlots.length === 1
              ? '50%'
              : `${((i + 1) / (data.outputSlots.length + 1)) * 100}%`,
            width: 10,
            height: 10,
            background: `hsla(${data.accentHue}, 60%, 55%, 0.3)`,
            border: `2px solid hsla(${data.accentHue}, 60%, 55%, 0.5)`,
            borderRadius: '50%',
            transition: 'all 0.2s',
          }}
          title={`${slot.name} (${slot.dataType})`}
        />
      ))}
      {data.outputSlots.length === 0 && (
        <Handle
          type="source"
          position={Position.Bottom}
          id="default-out"
          style={{
            width: 10, height: 10,
            background: 'rgba(255,255,255,0.08)',
            border: '2px solid rgba(255,255,255,0.15)',
            borderRadius: '50%',
          }}
        />
      )}
    </div>
  );
}

export const CapsuleNode = memo(CapsuleNodeInner);
