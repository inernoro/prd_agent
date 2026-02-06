import type { CSSProperties } from 'react';

/**
 * glassContainerStyle - 生成液态玻璃容器的基础 CSS 属性
 *
 * 将 backdrop-filter、background 与 GPU 合成层控制统一收敛到此处。
 * backdrop-filter 必须直接在创建合成层的容器元素上，不能下沉到子元素，
 * 否则浏览器合成层隔离会阻断模糊"穿透"到页面背景内容。
 *
 * 调用方只需 spread 到容器的 style 中：
 * ```tsx
 * <div style={{ ...glassContainerStyle(blur, bg), border: '...', boxShadow: '...' }}>
 * ```
 */
export function glassContainerStyle(blur: string, background: string): CSSProperties {
  return {
    backdropFilter: blur,
    WebkitBackdropFilter: blur,
    background,
    // 持久 GPU 合成层 — 避免状态变化时频繁创建/销毁导致闪烁
    transform: 'translateZ(0)',
    willChange: 'transform',
    // 独立堆叠上下文
    isolation: 'isolate',
    // 稳定合成层渲染，减少 repaint 闪烁
    backfaceVisibility: 'hidden',
  };
}
