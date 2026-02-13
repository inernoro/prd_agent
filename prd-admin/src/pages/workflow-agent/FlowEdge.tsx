import { memo } from 'react';
import { getBezierPath, type EdgeProps } from '@xyflow/react';

// ═══════════════════════════════════════════════════════════════
// FlowEdge — 有灵魂的连线
//
// 设计意图：
//   即使数据没有在流动，连线也应该像沉睡中的河流——
//   你能感受到它的方向、它的潜力、它随时可以苏醒。
//
// 视觉层级（从下到上）：
//   1. 辉光底层 (glow path)  — 柔和的色彩扩散，营造深度
//   2. 主线 (main path)      — 清晰的线条，承载状态信息
//   3. 粒子层 (particles)    — 传输态的能量粒子
//
// 状态：
//   idle         → 暖灰色虚线，缓慢流动，暗示数据方向
//   transferring → 蓝色辉光 + 多层粒子流
//   done         → 绿色实线 + 完成脉冲
//   error        → 红色虚线 + 微弱抖动
// ═══════════════════════════════════════════════════════════════

export interface FlowEdgeData {
  status?: string;
  /** 可选：源节点的 accentHue，让连线继承舱的色彩 */
  sourceHue?: number;
}

type FlowEdgeType = EdgeProps & { data?: FlowEdgeData };

// 状态色彩系统
function edgeColors(status: string, hue?: number) {
  switch (status) {
    case 'transferring':
      return {
        main: 'rgba(59,130,246,0.7)',
        glow: 'rgba(59,130,246,0.15)',
        width: 2.5,
        glowWidth: 10,
      };
    case 'done':
      return {
        main: 'rgba(34,197,94,0.6)',
        glow: 'rgba(34,197,94,0.1)',
        width: 2,
        glowWidth: 8,
      };
    case 'error':
      return {
        main: 'rgba(239,68,68,0.55)',
        glow: 'rgba(239,68,68,0.08)',
        width: 1.5,
        glowWidth: 6,
      };
    default: {
      // idle: 如果有源节点色相，用它的淡色版本；否则用暖灰
      const h = hue ?? 40;
      return {
        main: `hsla(${h}, 20%, 55%, 0.18)`,
        glow: `hsla(${h}, 20%, 55%, 0.04)`,
        width: 1.5,
        glowWidth: 6,
      };
    }
  }
}

function FlowEdgeInner(props: FlowEdgeType) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props;
  const status = data?.status || 'idle';
  const sourceHue = data?.sourceHue;

  const [edgePath] = getBezierPath({
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
  });

  const colors = edgeColors(status, sourceHue);
  const isIdle = status === 'idle';
  const isTransferring = status === 'transferring';
  const isDone = status === 'done';
  const isError = status === 'error';

  return (
    <g>
      {/* ── 第 1 层：辉光底层 ── */}
      <path
        d={edgePath}
        fill="none"
        stroke={colors.glow}
        strokeWidth={colors.glowWidth}
        strokeLinecap="round"
        style={{ filter: isTransferring ? 'blur(4px)' : 'blur(3px)' }}
      />

      {/* ── 第 2 层：主线 ── */}
      <path
        d={edgePath}
        fill="none"
        stroke={colors.main}
        strokeWidth={colors.width}
        strokeLinecap="round"
        strokeDasharray={isIdle ? '8 6' : isError ? '4 4' : '0'}
      >
        {/* 静态时：虚线沿路径缓缓流动，暗示数据流向 */}
        {isIdle && (
          <animate
            attributeName="stroke-dashoffset"
            from="0"
            to="-28"
            dur="3s"
            repeatCount="indefinite"
          />
        )}
        {/* 错误态：微弱抖动 */}
        {isError && (
          <animate
            attributeName="stroke-dashoffset"
            from="0"
            to="-8"
            dur="0.8s"
            repeatCount="indefinite"
          />
        )}
      </path>

      {/* ── 第 3 层：传输态粒子 ── */}
      {isTransferring && (
        <g>
          {/* 主粒子 — 明亮，领头 */}
          <circle r="3.5" fill="rgba(59,130,246,0.95)" filter="url(#particleGlow)">
            <animateMotion dur="1.8s" repeatCount="indefinite" path={edgePath} />
          </circle>
          {/* 次粒子 — 中等亮度，跟随 */}
          <circle r="2.5" fill="rgba(59,130,246,0.6)">
            <animateMotion dur="1.8s" repeatCount="indefinite" path={edgePath} begin="0.6s" />
          </circle>
          {/* 尾粒子 — 暗淡，拖尾 */}
          <circle r="2" fill="rgba(59,130,246,0.3)">
            <animateMotion dur="1.8s" repeatCount="indefinite" path={edgePath} begin="1.2s" />
          </circle>
          {/* 微粒子 — 星尘感 */}
          <circle r="1.5" fill="rgba(147,197,253,0.4)">
            <animateMotion dur="1.8s" repeatCount="indefinite" path={edgePath} begin="0.3s" />
          </circle>
          <circle r="1" fill="rgba(147,197,253,0.25)">
            <animateMotion dur="1.8s" repeatCount="indefinite" path={edgePath} begin="0.9s" />
          </circle>

          {/* 粒子发光滤镜 */}
          <defs>
            <filter id="particleGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>
        </g>
      )}

      {/* ── 完成态：一次性脉冲波 ── */}
      {isDone && (
        <g>
          {/* 绿色光球沿线走完 */}
          <circle r="4" fill="rgba(34,197,94,0.7)" opacity="0">
            <animateMotion dur="1s" repeatCount="1" fill="freeze" path={edgePath} />
            <animate attributeName="opacity" values="0;0.9;0.9;0" dur="1s" repeatCount="1" fill="freeze" />
            <animate attributeName="r" values="2;6;3" dur="1s" repeatCount="1" fill="freeze" />
          </circle>
          {/* 完成后沿线残留的微光 */}
          <path
            d={edgePath}
            fill="none"
            stroke="rgba(34,197,94,0.08)"
            strokeWidth="12"
            strokeLinecap="round"
            style={{ filter: 'blur(6px)' }}
            opacity="0"
          >
            <animate attributeName="opacity" values="0;0.6;0.3" dur="1.5s" repeatCount="1" fill="freeze" />
          </path>
        </g>
      )}
    </g>
  );
}

export const FlowEdge = memo(FlowEdgeInner);
