import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, Download } from 'lucide-react';

/**
 * 图片灯箱（lightbox）—— 点击图片放大、左右切换、Esc/蒙版关闭。
 *
 * 用法：
 *   <ImageLightbox images={['/a.png','/b.png']} index={2} onClose={...} />
 *
 * 不渲染 trigger，由调用方在 img onClick 中触发；本组件只负责打开后的全屏展示。
 *
 * 遵循 frontend-modal 规则：
 *   - createPortal 挂 document.body（escape 祖先 overflow:hidden 裁剪）
 *   - z-[10000]（盖在 modal/drawer 之上）
 *   - inline style 控制尺寸，不依赖 Tailwind arbitrary value
 *   - Esc 关 + 点蒙版关 + 阻止冒泡
 *   - 左右箭头键导航
 */
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

  const prev = useCallback(() => setIdx((i) => Math.max(0, i - 1)), []);
  const next = useCallback(() => setIdx((i) => Math.min(total - 1, i + 1)), [total]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, prev, next]);

  if (!images.length) return null;
  const src = images[idx];
  const caption = captions?.[idx];

  const lightbox = (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      {/* 计数 + 关闭按钮 */}
      <div
        className="absolute top-0 left-0 right-0 flex items-center justify-between px-6 py-4"
        style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 100%)' }}
      >
        <span className="text-sm tabular-nums" style={{ color: 'rgba(255,255,255,0.8)' }}>
          {idx + 1} / {total}
        </span>
        <div className="flex items-center gap-2">
          <a
            href={src}
            download
            onClick={(e) => e.stopPropagation()}
            className="rounded-lg p-1.5 transition-colors hover:bg-white/10"
            style={{ color: 'rgba(255,255,255,0.8)' }}
            aria-label="下载"
            title="下载"
          >
            <Download size={18} />
          </a>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            className="rounded-lg p-1.5 transition-colors hover:bg-white/10"
            style={{ color: 'rgba(255,255,255,0.8)' }}
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
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '92vw',
          maxHeight: '88vh',
          objectFit: 'contain',
          boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
          cursor: 'default',
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
