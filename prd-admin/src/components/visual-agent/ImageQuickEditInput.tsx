import { Play } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

export type ImageQuickEditInputProps = {
  /** 选中的图片在画布中的世界坐标 */
  imageRect: { x: number; y: number; w: number; h: number };
  /** 当前缩放比 */
  zoom: number;
  /** 摄像机偏移 */
  camera: { x: number; y: number };
  /** 舞台容器的 DOM 引用 */
  stageEl: HTMLElement | null;
  /** 提交快捷编辑 */
  onSubmit: (text: string) => void;
  /** 是否正在执行 */
  running?: boolean;
};

/** 快捷编辑输入框的固定宽度 */
const BAR_WIDTH = 320;
const BAR_HEIGHT = 38;

export function ImageQuickEditInput({
  imageRect,
  zoom,
  camera,
  stageEl,
  onSubmit,
  running,
}: ImageQuickEditInputProps) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const recalcPosition = useCallback(() => {
    if (!stageEl) return;
    const sr = stageEl.getBoundingClientRect();
    // 图片底部中心的屏幕坐标
    const imgScreenX = imageRect.x * zoom + camera.x + sr.left;
    const imgScreenY = imageRect.y * zoom + camera.y + sr.top;
    const imgScreenW = imageRect.w * zoom;
    const imgScreenH = imageRect.h * zoom;

    let left = imgScreenX + imgScreenW / 2 - BAR_WIDTH / 2;
    const top = imgScreenY + imgScreenH + 8;

    // 水平 clamp
    left = Math.max(sr.left + 4, Math.min(left, sr.right - BAR_WIDTH - 4));
    // 垂直不超出 stage 底部
    if (top + BAR_HEIGHT > sr.bottom - 4) {
      setPos(null);
      return;
    }

    setPos({ left, top: Math.max(sr.top + 4, top) });
  }, [imageRect, zoom, camera, stageEl]);

  useEffect(() => {
    recalcPosition();
  }, [recalcPosition]);

  useEffect(() => {
    const handler = () => recalcPosition();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [recalcPosition]);

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || running) return;
    onSubmit(trimmed);
    setText('');
  }, [text, running, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
      // 阻止事件冒泡到画布快捷键
      e.stopPropagation();
    },
    [handleSubmit],
  );

  if (!pos) return null;

  const hasText = text.trim().length > 0;

  return (
    <div
      ref={containerRef}
      className="fixed z-[8000] flex items-center gap-1.5 rounded-[10px] px-2"
      style={{
        left: pos.left,
        top: pos.top,
        width: BAR_WIDTH,
        height: BAR_HEIGHT,
        background: focused
          ? 'rgba(32, 32, 38, 0.98)'
          : 'rgba(32, 32, 38, 0.92)',
        border: focused
          ? '1px solid rgba(99, 102, 241, 0.50)'
          : '1px solid rgba(255, 255, 255, 0.14)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        boxShadow: focused
          ? '0 8px 32px rgba(0,0,0,0.45), 0 0 0 2px rgba(99, 102, 241, 0.18)'
          : '0 8px 32px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06) inset',
        pointerEvents: 'auto',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
    >
      {/* 快捷编辑标签 */}
      <span
        className="shrink-0 text-[11px] font-medium select-none whitespace-nowrap"
        style={{ color: 'rgba(255, 255, 255, 0.40)' }}
      >
        快捷编辑
      </span>

      {/* 输入框 */}
      <input
        ref={inputRef}
        type="text"
        className="flex-1 min-w-0 h-full bg-transparent text-[13px] outline-none placeholder:text-white/25"
        style={{ color: 'rgba(255, 255, 255, 0.88)' }}
        placeholder="Describe your edit here"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        disabled={running}
      />

      {/* 运行按钮 */}
      <button
        type="button"
        className="shrink-0 inline-flex items-center gap-1 px-2.5 h-[26px] rounded-[6px] text-[11px] font-semibold transition-all"
        style={{
          background: hasText && !running ? 'rgba(99, 102, 241, 0.85)' : 'rgba(99, 102, 241, 0.25)',
          color: hasText && !running ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 255, 255, 0.40)',
          cursor: running || !hasText ? 'not-allowed' : 'pointer',
        }}
        onClick={handleSubmit}
        disabled={running || !hasText}
      >
        运行
        <Play size={10} className="shrink-0" />
      </button>
    </div>
  );
}
