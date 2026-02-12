import { memo } from 'react';
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';

// ═══════════════════════════════════════════════════════════════
// FlowEdge — 自定义连线，带粒子流动动效
//
// 状态：
//   idle        → 灰色虚线
//   transferring → 蓝色 + 粒子沿贝塞尔曲线流动
//   done        → 绿色实线 + 脉冲
//   error       → 红色虚线
// ═══════════════════════════════════════════════════════════════

export interface FlowEdgeData {
  /** idle | transferring | done | error */
  status?: string;
}

type FlowEdgeType = EdgeProps & { data?: FlowEdgeData };

const EDGE_COLORS: Record<string, string> = {
  idle: 'rgba(255,255,255,0.12)',
  transferring: 'rgba(59,130,246,0.6)',
  done: 'rgba(34,197,94,0.5)',
  error: 'rgba(239,68,68,0.5)',
};

function FlowEdgeInner(props: FlowEdgeType) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd } = props;
  const status = data?.status || 'idle';

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const strokeColor = EDGE_COLORS[status] || EDGE_COLORS.idle;
  const isIdle = status === 'idle';
  const isTransferring = status === 'transferring';

  return (
    <>
      {/* 底层阴影 */}
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: strokeColor,
          strokeWidth: isTransferring ? 2.5 : 1.5,
          strokeDasharray: isIdle ? '6 4' : status === 'error' ? '4 4' : '0',
          filter: isTransferring ? 'drop-shadow(0 0 4px rgba(59,130,246,0.3))' : undefined,
          transition: 'stroke 0.3s, stroke-width 0.3s',
        }}
      />

      {/* 传输态：粒子流动 */}
      {isTransferring && (
        <g>
          <circle r="3" fill="rgba(59,130,246,0.9)">
            <animateMotion dur="2s" repeatCount="indefinite" path={edgePath} />
          </circle>
          <circle r="3" fill="rgba(59,130,246,0.5)">
            <animateMotion dur="2s" repeatCount="indefinite" path={edgePath} begin="0.7s" />
          </circle>
          <circle r="2" fill="rgba(59,130,246,0.3)">
            <animateMotion dur="2s" repeatCount="indefinite" path={edgePath} begin="1.4s" />
          </circle>
        </g>
      )}

      {/* 完成态：脉冲粒子 */}
      {status === 'done' && (
        <circle r="4" fill="rgba(34,197,94,0.6)" opacity="0">
          <animateMotion dur="1.2s" repeatCount="1" fill="freeze" path={edgePath} />
          <animate attributeName="opacity" values="0;0.8;0.8;0" dur="1.2s" repeatCount="1" fill="freeze" />
          <animate attributeName="r" values="2;5;2" dur="1.2s" repeatCount="1" fill="freeze" />
        </circle>
      )}
    </>
  );
}

export const FlowEdge = memo(FlowEdgeInner);
