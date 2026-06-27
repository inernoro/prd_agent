import { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, Download, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';

/**
 * 图片灯箱（lightbox）—— 点击图片放大、缩放（放大/缩小/拖拽平移）、左右切换、Esc/蒙版关闭。
 *
 * 用法：
 *   <ImageLightbox images={['/a.png','/b.png']} index={2} onClose={...} />
 *
 * 不渲染 trigger，由调用方在 img onClick 中触发；本组件只负责打开后的全屏展示。
 *
 * 缩放交互（任意比例尺都可预览）：
 *   - 右上角 + / - 按钮，以及百分比/复位按钮
 *   - 滚轮缩放（向光标方向），双击在 1x / 2x 间切换
 *   - 放大后可拖拽平移；缩放范围 0.2x ~ 8x，切换图片时自动复位
 *
 * 遵循 frontend-modal 规则：
 *   - createPortal 挂 document.body（escape 祖先 overflow:hidden 裁剪）
 *   - z-[10000]（盖在 modal/drawer 之上）
 *   - inline style 控制尺寸，不依赖 Tailwind arbitrary value
 *   - Esc 关 + 点蒙版关 + 阻止冒泡
 *   - 左右箭头键导航
 */
const MIN_SCALE = 0.2;
const MAX_SCALE = 8;

export function ImageLightbox({
  images,
  index: initialIndex,
  onClose,
  captions,
}: {
  /** 要在 lightbox 里轮播的图片 URL 列表（按页面阅读顺序） */
  images: string[];
  /** 初始展示哪一张 */
  index: number;
  onClose: () => void;
  /** 可选 caption（与 images 同序），鼠标悬停或始终显示在底部 */
  captions?: (string | undefined)[];
}) {
  const [idx, setIdx] = useState(initialIndex);
  const total = images.length;
  const hasPrev = idx > 0;
  const hasNext = idx < total - 1;

  // 缩放/平移状态
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ active: boolean; startX: number; startY: number; baseX: number; baseY: number; moved: boolean }>(
    { active: false, startX: 0, startY: 0, baseX: 0, baseY: 0, moved: false },
  );

  const resetView = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

  const zoomBy = useCallback((factor: number) => {
    setScale((s) => {
      const next = clampScale(s * factor);
      if (next <= 1) setOffset({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const prev = useCallback(() => {
    setIdx((i) => Math.max(0, i - 1));
    resetView();
  }, [resetView]);
  const next = useCallback(() => {
    setIdx((i) => Math.min(total - 1, i + 1));
    resetView();
  }, [total, resetView]);

  // 切换初始图片时复位
  useEffect(() => {
    setIdx(initialIndex);
    resetView();
  }, [initialIndex, resetView]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === '+' || e.key === '=') zoomBy(1.25);
      else if (e.key === '-' || e.key === '_') zoomBy(0.8);
      else if (e.key === '0') resetView();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, prev, next, zoomBy, resetView]);

  if (!images.length) return null;
  const src = images[idx];
  const caption = captions?.[idx];
  const isZoomed = scale !== 1 || offset.x !== 0 || offset.y !== 0;

  // 滚轮缩放（以光标位置为锚点做简单平移补偿）
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setScale((s) => {
      const nextScale = clampScale(s * factor);
      if (nextScale <= 1) {
        setOffset({ x: 0, y: 0 });
      } else {
        // 让缩放围绕图片中心附近，配合光标方向轻微补偿
        setOffset((o) => ({ x: o.x * (nextScale / s), y: o.y * (nextScale / s) }));
      }
      return nextScale;
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (scale <= 1) return;
    dragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      baseX: offset.x,
      baseY: offset.y,
      moved: false,
    };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.active) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
    setOffset({ x: d.baseX + dx, y: d.baseY + dy });
  };
  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current.active) {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    }
    dragRef.current.active = false;
  };

  const iconBtn =
    'rounded-lg p-1.5 transition-colors hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed';

  const lightbox = (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      {/* 计数 + 缩放控件 + 关闭按钮 */}
      <div
        className="absolute top-0 left-0 right-0 flex items-center justify-between px-6 py-4"
        style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 100%)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-sm tabular-nums" style={{ color: 'rgba(255,255,255,0.8)' }}>
          {idx + 1} / {total}
        </span>
        <div className="flex items-center gap-1.5" style={{ color: 'rgba(255,255,255,0.85)' }}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); zoomBy(0.8); }}
            disabled={scale <= MIN_SCALE}
            className={iconBtn}
            aria-label="缩小"
            title="缩小 (-)"
          >
            <ZoomOut size={18} />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); resetView(); }}
            className="rounded-lg px-2 py-1 text-xs tabular-nums transition-colors hover:bg-white/10"
            aria-label="复位"
            title="复位 (0)"
            style={{ minWidth: 48 }}
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); zoomBy(1.25); }}
            disabled={scale >= MAX_SCALE}
            className={iconBtn}
            aria-label="放大"
            title="放大 (+)"
          >
            <ZoomIn size={18} />
          </button>
          {isZoomed && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); resetView(); }}
              className={iconBtn}
              aria-label="还原"
              title="还原 (0)"
            >
              <RotateCcw size={16} />
            </button>
          )}
          <span className="mx-1 w-px self-stretch" style={{ background: 'rgba(255,255,255,0.2)' }} />
          <a
            href={src}
            download
            onClick={(e) => e.stopPropagation()}
            className={iconBtn}
            aria-label="下载"
            title="下载"
          >
            <Download size={18} />
          </a>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            className={iconBtn}
            aria-label="关闭"
            title="关闭 (Esc)"
          >
            <X size={20} />
          </button>
        </div>
      </div>

      {/* 左右导航 */}
      {hasPrev && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); prev(); }}
          className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full p-3 transition-all hover:bg-white/10"
          style={{ color: 'rgba(255,255,255,0.85)', background: 'rgba(0,0,0,0.4)' }}
          aria-label="上一张 (←)"
          title="上一张 (←)"
        >
          <ChevronLeft size={28} />
        </button>
      )}
      {hasNext && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); next(); }}
          className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-3 transition-all hover:bg-white/10"
          style={{ color: 'rgba(255,255,255,0.85)', background: 'rgba(0,0,0,0.4)' }}
          aria-label="下一张 (→)"
          title="下一张 (→)"
        >
          <ChevronRight size={28} />
        </button>
      )}

      {/* 图片本体 */}
      <img
        src={src}
        alt={caption ?? `图 ${idx + 1}`}
        draggable={false}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setScale((s) => {
            const next = s > 1 ? 1 : 2;
            if (next <= 1) setOffset({ x: 0, y: 0 });
            return next;
          });
        }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          maxWidth: '92vw',
          maxHeight: '88vh',
          objectFit: 'contain',
          boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transition: dragRef.current.active ? 'none' : 'transform 0.12s ease-out',
          cursor: scale > 1 ? (dragRef.current.active ? 'grabbing' : 'grab') : 'zoom-in',
          touchAction: 'none',
        }}
      />

      {/* caption */}
      {caption && (
        <div
          className="absolute bottom-0 left-0 right-0 flex justify-center px-6 py-4 pointer-events-none"
          style={{ background: 'linear-gradient(0deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 100%)' }}
        >
          <span
            className="text-sm max-w-[80vw] text-center"
            style={{ color: 'rgba(255,255,255,0.92)' }}
          >
            {caption}
          </span>
        </div>
      )}
    </div>
  );

  return createPortal(lightbox, document.body);
}
