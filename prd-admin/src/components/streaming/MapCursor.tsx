import { memo } from 'react';

/**
 * 流式输出场景下的 MAP 品牌 cursor — 系统统一的"AI 正在写"标识
 *
 * 用法:
 * ```tsx
 * <StreamingText text={accumulated} streaming cursorContent={<MapCursor />} />
 * ```
 *
 * 默认渲染一个发光的 M (与首页 MAP loader 字母同源, 26 字号 → 等比缩小)
 * 父级 streaming-text-caret--custom 提供 blink 动画 + opacity 节奏。
 */
interface Props {
  /** 字号 (px), 默认跟随 currentColor 与父级 line-height */
  size?: number;
  /** 颜色, 默认 currentColor 让其跟随文本色 */
  color?: string;
}

export const MapCursor = memo(function MapCursor({ size, color }: Props) {
  return (
    <span
      style={{
        fontFamily: "'Inter', 'SF Pro Display', -apple-system, system-ui, sans-serif",
        fontWeight: 700,
        fontSize: size != null ? size : '0.95em',
        lineHeight: 1,
        letterSpacing: '0.02em',
        color: color ?? 'currentColor',
        // 微微发光, 与 MAP loader 一致
        textShadow: '0 0 6px currentColor',
        verticalAlign: 'baseline',
      }}
      aria-hidden
    >
      M
    </span>
  );
});
