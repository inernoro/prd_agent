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
const BAR_HEIGHT = 42;

export function ImageQuickEditInput({
  imageRect,
  zoom,
  camera,
  stageEl,
  onSubmit,
  running,
}: ImageQuickEditInputProps) {
  const [text, setText] = useState('');
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
    // 垂直不超出 stage 底部（如果超出就不显示）
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

  return (
    <div
      ref={containerRef}
      className="fixed z-[8000] flex items-center rounded-[10px] overflow-hidden"
      style={{
        left: pos.left,
        top: pos.top,
        width: BAR_WIDTH,
        height: BAR_HEIGHT,
        background: 'rgba(32, 32, 38, 0.95)',
        border: '1px solid rgba(255, 255, 255, 0.14)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06) inset',
        pointerEvents: 'auto',
      }}
    >
      {/* 快捷编辑标签 */}
      <div
        className="shrink-0 h-full flex items-center px-2.5 text-[11px] font-medium select-none"
        style={{
          color: 'rgba(255, 255, 255, 0.50)',
          borderRight: '1px solid rgba(255,255,255,0.10)',
        }}
      >
        快捷编辑
        <kbd
          className="ml-1.5 px-1 rounded text-[9px] font-mono"
          style={{
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'rgba(255,255,255,0.45)',
          }}
        >
          Tab
        </kbd>
      </div>

      {/* 输入框 */}
      <input
        ref={inputRef}
        type="text"
        className="flex-1 h-full bg-transparent px-2.5 text-[13px] outline-none placeholder:text-white/30"
        style={{ color: 'rgba(255, 255, 255, 0.88)' }}
        placeholder="Describe your edit here"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        disabled={running}
      />

      {/* 运行按钮 */}
      <button
        type="button"
        className="shrink-0 inline-flex items-center gap-1 px-3 h-[30px] mx-1 rounded-[7px] text-[12px] font-semibold transition-colors"
        style={{
          background: running ? 'rgba(99, 102, 241, 0.4)' : 'rgba(99, 102, 241, 0.85)',
          color: 'rgba(255, 255, 255, 0.95)',
          cursor: running || !text.trim() ? 'not-allowed' : 'pointer',
          opacity: running || !text.trim() ? 0.5 : 1,
        }}
        onClick={handleSubmit}
        disabled={running || !text.trim()}
      >
        运行
        <Play size={11} className="shrink-0" />
      </button>
    </div>
  );
}
