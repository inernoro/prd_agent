/**
 * GlassBackdrop - 玻璃效果隔离层
 *
 * 将 backdrop-filter 渲染在独立的 overflow:hidden 子层中，
 * 强制浏览器将模糊效果裁剪到父容器的圆角区域内，
 * 规避各主流浏览器 backdrop-filter + border-radius 合成时的边缘溢出与闪烁。
 *
 * 使用要求：
 * - 父容器需要 position: relative
 * - 父容器需要 isolation: isolate（确保 zIndex:-1 在局部堆叠上下文内生效）
 * - 父容器需要 transform: translateZ(0)（创建持久 GPU 合成层）
 *
 * @example
 * <div style={{ position: 'relative', isolation: 'isolate', transform: 'translateZ(0)' }}>
 *   <GlassBackdrop blur="blur(40px) saturate(180%)" background="linear-gradient(...)" />
 *   {children}
 * </div>
 */
export function GlassBackdrop({ blur, background }: { blur: string; background: string }) {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: 'inherit',
        overflow: 'hidden',
        backdropFilter: blur,
        WebkitBackdropFilter: blur,
        background,
        pointerEvents: 'none',
        backfaceVisibility: 'hidden',
        zIndex: -1,
      }}
    />
  );
}
