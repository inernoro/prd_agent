import { useCallback, useEffect, useRef, useState } from 'react';

// ─── 类型 ────────────────────────────────────────────────────────────────────

/** 相对遮罩区域的百分比矩形（0-100） */
export interface SelectionRectPct {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

export interface SelectionFeedbackOverlayProps {
  /** false 时不渲染 */
  active: boolean;
  /** ESC / 点取消 */
  onCancel: () => void;
  /** 提交框选区域 + 备注，由父组件组装精修指令 */
  onSubmit: (payload: { rect: SelectionRectPct; note: string }) => void;
}

/** 像素矩形（相对遮罩左上角） */
interface RectPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

const NOTE_CARD_WIDTH = 300;
const NOTE_CARD_HEIGHT = 44;
/** 宽或高小于该百分比视为误触 */
const MIN_RECT_PCT = 2;

/**
 * 圈选反馈遮罩（借鉴 open-design PreviewDrawOverlay 的极简版）。
 * 在 iframe 包裹层（position:relative）内铺满，拖拽画框 + 备注，
 * 提交时把框换算成百分比交给父组件组装精修指令。
 * 注意：遮罩盖在 iframe 之上，拖拽期间 iframe 收不到事件，这是预期行为。
 */
export function SelectionFeedbackOverlay(props: SelectionFeedbackOverlayProps): JSX.Element | null {
  const { active, onCancel, onSubmit } = props;
  const overlayRef = useRef<HTMLDivElement | null>(null);
  /** 拖拽起点（px，相对遮罩） */
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  /** 当前/定格的框（px） */
  const [rect, setRect] = useState<RectPx | null>(null);
  /** 框是否已定格（mouseup 后进入备注阶段） */
  const [frozen, setFrozen] = useState(false);
  const [note, setNote] = useState('');

  const reset = useCallback(() => {
    setDragStart(null);
    setRect(null);
    setFrozen(false);
    setNote('');
  }, []);

  // 关闭/重新激活时清空状态
  useEffect(() => {
    if (!active) reset();
  }, [active, reset]);

  // ESC 任何时刻退出
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onCancel]);

  /** 把鼠标事件换算成相对遮罩的坐标（并 clamp 到遮罩范围内） */
  const toLocal = (e: React.MouseEvent): { x: number; y: number } | null => {
    const el = overlayRef.current;
    if (!el) return null;
    const bounds = el.getBoundingClientRect();
    return {
      x: Math.min(Math.max(e.clientX - bounds.left, 0), bounds.width),
      y: Math.min(Math.max(e.clientY - bounds.top, 0), bounds.height),
    };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (frozen) return; // 备注阶段不再画框，由「重画」按钮重置
    const p = toLocal(e);
    if (!p) return;
    e.preventDefault();
    setDragStart(p);
    setRect({ x: p.x, y: p.y, w: 0, h: 0 });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragStart || frozen) return;
    const p = toLocal(e);
    if (!p) return;
    setRect({
      x: Math.min(dragStart.x, p.x),
      y: Math.min(dragStart.y, p.y),
      w: Math.abs(p.x - dragStart.x),
      h: Math.abs(p.y - dragStart.y),
    });
  };

  const handleMouseUp = () => {
    if (!dragStart || frozen || !rect) return;
    setDragStart(null);
    const el = overlayRef.current;
    if (!el) {
      reset();
      return;
    }
    const wPct = (rect.w / el.clientWidth) * 100;
    const hPct = (rect.h / el.clientHeight) * 100;
    // 框太小视为误触，忽略并允许重画
    if (wPct < MIN_RECT_PCT || hPct < MIN_RECT_PCT) {
      setRect(null);
      return;
    }
    setFrozen(true);
  };

  const handleSubmit = () => {
    const el = overlayRef.current;
    if (!el || !rect) return;
    const payload: SelectionRectPct = {
      xPct: (rect.x / el.clientWidth) * 100,
      yPct: (rect.y / el.clientHeight) * 100,
      wPct: (rect.w / el.clientWidth) * 100,
      hPct: (rect.h / el.clientHeight) * 100,
    };
    onSubmit({ rect: payload, note: note.trim() });
  };

  if (!active) return null;

  // 备注卡定位：默认框下方，下方放不下则放框上方；水平方向 clamp 不越界
  let cardTop = 0;
  let cardLeft = 0;
  if (rect && frozen && overlayRef.current) {
    const el = overlayRef.current;
    const below = rect.y + rect.h + 8;
    cardTop = below + NOTE_CARD_HEIGHT > el.clientHeight
      ? Math.max(rect.y - NOTE_CARD_HEIGHT - 8, 4)
      : below;
    cardLeft = Math.min(Math.max(rect.x, 4), Math.max(el.clientWidth - NOTE_CARD_WIDTH - 4, 4));
  }

  return (
    <div
      ref={overlayRef}
      data-testid="selection-overlay"
      className="absolute inset-0 select-none"
      style={{ zIndex: 30, background: 'rgba(0,0,0,0.18)', cursor: 'crosshair' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* 顶部提示 pill */}
      <div
        className="absolute left-1/2 flex items-center gap-2 rounded-full border border-white/10 bg-[var(--bg-elevated)] px-3 py-1 text-[10px] text-[var(--text-secondary)] shadow-lg"
        style={{ top: 8, transform: 'translateX(-50%)', pointerEvents: 'none' }}
      >
        拖动框选要修改的区域 · Esc 退出
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onCancel}
          className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
          style={{ pointerEvents: 'auto' }}
        >
          取消
        </button>
      </div>

      {/* 框选矩形（拖拽中实时绘制 / 松手后定格） */}
      {rect && rect.w > 0 && rect.h > 0 && (
        <div
          className="absolute rounded-sm"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            border: '2px dashed #c084fc',
            background: 'rgba(192,132,252,0.12)',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* 备注输入卡：框定格后出现 */}
      {rect && frozen && (
        <div
          className="absolute flex items-center gap-1.5 rounded-lg border border-white/10 bg-[var(--bg-elevated)] p-1.5 shadow-xl"
          style={{ top: cardTop, left: cardLeft, width: NOTE_CARD_WIDTH }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <input
            data-testid="selection-note-input"
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmit();
            }}
            placeholder="想怎么改这块？例：换成图表"
            className="flex-1 min-w-0 bg-white/4 border border-white/8 rounded-md px-2 py-1 text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-purple-500/40"
          />
          <button
            type="button"
            onClick={handleSubmit}
            className="shrink-0 rounded-md bg-purple-500 px-2 py-1 text-[10px] text-white hover:bg-purple-600 transition-colors"
          >
            提交
          </button>
          <button
            type="button"
            onClick={reset}
            className="shrink-0 rounded-md bg-white/5 border border-white/8 px-2 py-1 text-[10px] text-[var(--text-secondary)] hover:bg-white/10 transition-colors"
          >
            重画
          </button>
        </div>
      )}
    </div>
  );
}
