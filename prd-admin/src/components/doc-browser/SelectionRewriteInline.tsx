import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, ArrowUp, X, Check, Undo2, RotateCcw, Square } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useScrollFollowTransform, usePaneRect } from './useOverlayFollow';
import { useSelectionRewriteActions } from './useSelectionRewriteActions';
import {
  SELECTION_OVERLAY_CHIP,
  SELECTION_OVERLAY_FIELD,
  SELECTION_OVERLAY_LABEL,
  SELECTION_OVERLAY_PANEL,
  SELECTION_OVERLAY_PRIMARY,
} from './selectionOverlayStyle';
import { toFriendlyRewriteError } from './selectionRewriteError';

// 知识库「逐句修改」的两个就地条：
//   1. SelectionRewritePrompt —— 划词后原地问「想怎么改」（图 1/2）
//   2. InlineDiffReviewBar   —— 改动直接长在正文里之后的「撤销 / 采纳」（图 4）
// 两者都不承载结果内容：结果就是文章本身的变化（artifact-is-experience.md）。
// 布局遵 frontend-modal.md：createPortal 到 body + inline style 定位。

export interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** 手机窄屏下按视口收宽，不许横向溢出（mobile-first-density.md） */
function clampWidth(preferred: number): number {
  if (typeof window === 'undefined') return preferred;
  return Math.min(preferred, window.innerWidth - 16);
}

/** 把浮层夹在视口内：优先贴选区下方，放不下就翻到上方 */
function placeNearSelection(rect: AnchorRect, width: number, height: number) {
  const below = rect.top + rect.height + 8;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 8) : below;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left));
  return { top, left };
}

/**
 * 划词后的「想怎么改」输入条。
 * 快捷动作来自后端 SSOT，输入框只是兜底——不给用户一个空白框发呆（zero-friction-input.md）。
 */
export function SelectionRewritePrompt({
  anchorRect,
  scrollRef,
  selectedText,
  onSubmit,
  onClose,
}: {
  anchorRect: AnchorRect;
  scrollRef?: RefObject<HTMLElement>;
  selectedText: string;
  /** actionKey='custom' 时 instruction 必填 */
  onSubmit: (actionKey: string, instruction?: string) => void;
  onClose: () => void;
}) {
  const actions = useSelectionRewriteActions();
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // 跟随滚动走直写 DOM，不走 state（见 useOverlayFollow：走 state 会慢内容一帧，跟不上手）
  useScrollFollowTransform(panelRef, scrollRef);

  useEffect(() => {
    // 选中即就绪：打开就能直接打字（chief-designer-usability.md 第一原则）
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const width = clampWidth(400);
  const { top, left } = placeNearSelection(anchorRect, width, 116);
  const send = () => {
    const t = text.trim();
    if (t) onSubmit('custom', t);
  };

  return createPortal(
    <div
      ref={panelRef}
      className="fixed z-[120] flex flex-col"
      style={{ top, left, width, padding: 10, ...SELECTION_OVERLAY_PANEL }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold flex items-center gap-1.5" style={{ color: SELECTION_OVERLAY_LABEL }}>
          <Sparkles size={11} />
          让 AI 修改选中的 {selectedText.length} 个字
        </span>
        <button
          onClick={onClose}
          className="w-5 h-5 rounded-[6px] flex items-center justify-center cursor-pointer hover-bg-soft transition-colors"
          style={{ color: 'var(--text-muted)' }}
          title="关闭（Esc）"
        >
          <X size={13} />
        </button>
      </div>

      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="想怎么改？例：能否细化一些？"
          className="flex-1 h-8 px-2.5 rounded-[10px] text-[12px] outline-none"
          style={SELECTION_OVERLAY_FIELD}
        />
        <button
          onClick={send}
          disabled={!text.trim()}
          className="h-8 w-8 rounded-full flex items-center justify-center cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          style={SELECTION_OVERLAY_PRIMARY}
          title="发送（Enter）"
        >
          <ArrowUp size={14} />
        </button>
      </div>

      {actions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {actions.map((a) => (
            <button
              key={a.key}
              onClick={() => onSubmit(a.key)}
              title={a.description}
              className="h-6 px-2.5 rounded-full text-[11px] font-semibold cursor-pointer transition-colors"
              style={SELECTION_OVERLAY_CHIP}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

export type InlineRewritePhase = 'streaming' | 'review' | 'error';

/**
 * 改动已经就地长在正文里之后的操作条：撤销 / 采纳。
 * 流式期间同一条位置显示「正在改写 + 模型 + 已等待」并给中止（expectation-management.md：
 * 用户任何时刻都知道在做什么、还要多久）。
 */
export function InlineDiffReviewBar({
  scrollRef,
  phase,
  model,
  added,
  removed,
  codeChangeUnmarked,
  startedAt,
  errorMsg,
  applying,
  onAccept,
  onDiscard,
  onRetry,
  onStop,
}: {
  scrollRef?: RefObject<HTMLElement>;
  phase: InlineRewritePhase;
  model?: string;
  added: number;
  removed: number;
  codeChangeUnmarked: boolean;
  startedAt: number;
  errorMsg?: string;
  applying: boolean;
  onAccept: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  onStop: () => void;
}) {
  const paneRect = usePaneRect(scrollRef);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (phase !== 'streaming') return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [phase]);
  const waited = useMemo(() => Math.max(0, Math.round((now - startedAt) / 1000)), [now, startedAt]);
  const friendlyError = useMemo(() => toFriendlyRewriteError(errorMsg), [errorMsg]);

  const width = clampWidth(phase === 'streaming' ? 320 : 300);
  /*
   * 条子钉在正文区的右上角，不追着选区跑。
   *
   * 上一版是「压在选区正上方」，结果选区靠近正文顶部时它就砸在标题和正文上
   * （2026-08-25 用户指着截图问「这是什么雷霆布局」）。追随选区还有两个躲不掉的坏处：
   * 选区一长，条子必然盖住它自己要展示的那段改动；正文一滚，条子跟着乱飘。
   * 正文里的改动才是主角，条子只是遥控器（content-fills-canvas.md），
   * 所以按 ChatGPT canvas 的做法固定在右上角——永远不压字，位置也永远可预期。
   */
  const pane = paneRect;
  const top = (pane?.top ?? 8) + 12;
  const left = pane
    ? Math.max(8, pane.right - width - 16)
    : Math.max(8, window.innerWidth - width - 16);

  return createPortal(
    <div
      className="fixed z-[120] flex flex-col gap-1"
      style={{ top, left, width, padding: 8, ...SELECTION_OVERLAY_PANEL }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {phase === 'streaming' && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold flex items-center gap-1.5 flex-1 min-w-0" style={{ color: SELECTION_OVERLAY_LABEL }}>
            <MapSpinner size={11} />
            <span className="truncate">
              正在改写 · 已等待 {waited}s
              {model && <span className="font-mono font-normal" style={{ color: 'var(--text-muted)' }}> · {model}</span>}
            </span>
          </span>
          <button
            onClick={onStop}
            className="h-6.5 px-2 rounded-[8px] text-[11px] font-semibold flex items-center gap-1 cursor-pointer bg-token-nested border border-token-subtle shrink-0"
            style={{ color: 'var(--text-secondary)' }}
            title="停止生成，保留已改好的部分"
          >
            <Square size={9} /> 停止
          </button>
        </div>
      )}

      {phase === 'error' && (
        <div className="flex items-center gap-2">
          {/* 上游原文只进 title（排查用），面上给用户能照着做的一句话 */}
          <span className="flex-1 min-w-0" title={friendlyError.raw || undefined}>
            <span className="text-[11px] block truncate" style={{ color: 'var(--accent-fg-danger)' }}>
              {friendlyError.message}
            </span>
            {friendlyError.hint && (
              <span className="text-[10px] block truncate" style={{ color: 'var(--text-muted)' }}>
                {friendlyError.hint}
              </span>
            )}
          </span>
          <button
            onClick={onRetry}
            className="h-6.5 px-2 rounded-[8px] text-[11px] font-semibold flex items-center gap-1 cursor-pointer shrink-0"
            style={SELECTION_OVERLAY_CHIP}
          >
            <RotateCcw size={10} /> 重试
          </button>
          <button
            onClick={onDiscard}
            className="h-6.5 px-2 rounded-[8px] text-[11px] font-semibold flex items-center gap-1 cursor-pointer shrink-0"
            style={SELECTION_OVERLAY_CHIP}
          >
            <Undo2 size={10} /> 撤销
          </button>
        </div>
      )}

      {phase === 'review' && (
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-mono flex-1 min-w-0 truncate" style={{ color: 'var(--text-muted)' }}>
            <span style={{ color: 'var(--accent-fg-info)' }}>+{added}</span>
            {' / '}
            <span style={{ color: 'var(--accent-fg-danger)' }}>-{removed}</span>
            {model && <span> · {model}</span>}
          </span>
          <button
            onClick={onRetry}
            className="h-7 w-7 rounded-[8px] flex items-center justify-center cursor-pointer shrink-0"
            style={SELECTION_OVERLAY_CHIP}
            title="换个说法重新改"
          >
            <RotateCcw size={11} />
          </button>
          <button
            onClick={onDiscard}
            disabled={applying}
            className="h-7 px-2.5 rounded-[8px] text-[11px] font-semibold flex items-center gap-1 cursor-pointer shrink-0 disabled:opacity-40"
            style={SELECTION_OVERLAY_CHIP}
            title="丢弃这次改动，恢复原文"
          >
            <Undo2 size={11} /> 撤销
          </button>
          <button
            onClick={onAccept}
            disabled={applying}
            className="h-7 px-3 rounded-[8px] text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer shrink-0 disabled:opacity-40"
            style={SELECTION_OVERLAY_PRIMARY}
            title="把改动保存进文档"
          >
            {applying ? <MapSpinner size={11} /> : <Check size={11} />}
            采纳
          </button>
        </div>
      )}

      {codeChangeUnmarked && phase !== 'error' && (
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          代码块内的改动无法标色，上面展示的已是改后的代码
        </span>
      )}
    </div>,
    document.body,
  );
}
