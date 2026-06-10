import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface ModelChipPopoverProps {
  /** 最近一次实际运行的模型（来自 SSE event:model），无则为 null */
  modelInfo: { model: string; platform: string } | null;
  /** 用户选择的模型（'' = 自动调度） */
  selectedModel: string;
  /** 可选模型列表（可能为空，等 onOpen 拉取后更新） */
  models: string[];
  /** 选中某个模型（'' 表示回到自动调度） */
  onSelect: (model: string) => void;
  /** popover 打开时调用（用于惰性拉取模型列表） */
  onOpen: () => void;
  disabled?: boolean;
}

const POPOVER_WIDTH = 240;

/** 取模型名最后一段做短名展示（如 anthropic/claude-x → claude-x） */
function shortName(model: string): string {
  return model.split('/').pop() || model;
}

/**
 * 预览工具栏的模型 chip + 点击弹出切换列表。
 * 借鉴 open-design InlineModelSwitcher：顶栏常驻、一行展示、紧凑 popover。
 */
export function ModelChipPopover(props: ModelChipPopoverProps): JSX.Element {
  const { modelInfo, selectedModel, models, onSelect, onOpen, disabled } = props;
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // chip 展示文案：用户选择 > 最近实际运行 > 自动
  const chipLabel = selectedModel
    ? shortName(selectedModel)
    : modelInfo
      ? shortName(modelInfo.model)
      : '自动';

  const openPopover = useCallback(() => {
    const el = chipRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // 定位在 chip 下方、右对齐；左侧不允许越出视口
    setPos({
      top: rect.bottom + 4,
      left: Math.max(8, rect.right - POPOVER_WIDTH),
    });
    setOpen(true);
    onOpen();
  }, [onOpen]);

  const close = useCallback(() => setOpen(false), []);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  const handlePick = (model: string) => {
    onSelect(model);
    close();
  };

  const popover = open
    ? createPortal(
        // 透明蒙层：点击关闭（frontend-modal 规则：蒙层关闭 + 子元素阻止冒泡）
        <div
          className="fixed inset-0"
          style={{ zIndex: 10000 }}
          onClick={close}
        >
          <div
            data-testid="model-popover"
            onClick={(e) => e.stopPropagation()}
            className="fixed rounded-lg border border-white/10 bg-[var(--bg-elevated)] shadow-xl py-1"
            style={{
              top: pos.top,
              left: pos.left,
              width: POPOVER_WIDTH,
              maxHeight: 320,
              minHeight: 0,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
            }}
          >
            {/* 第一项：自动调度（value = ''） */}
            <button
              type="button"
              onClick={() => handlePick('')}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-[var(--text-secondary)] hover:bg-purple-500/10 hover:text-[var(--text-primary)] transition-colors"
            >
              <span className="flex-1 truncate">自动（默认池调度）</span>
              {selectedModel === '' && <Check size={12} className="text-purple-400 shrink-0" />}
            </button>

            {models.length === 0 ? (
              // 列表尚未拉取到：显示加载行
              <div className="flex items-center gap-2 px-2.5 py-2 text-[11px] text-[var(--text-tertiary)]">
                <MapSpinner size={12} />
                加载模型列表...
              </div>
            ) : (
              models.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => handlePick(m)}
                  title={m}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11px] font-mono text-[var(--text-secondary)] hover:bg-purple-500/10 hover:text-[var(--text-primary)] transition-colors"
                >
                  <span className="flex-1 truncate">{m}</span>
                  {selectedModel === m && <Check size={12} className="text-purple-400 shrink-0" />}
                </button>
              ))
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        data-testid="model-chip"
        title="点击切换直出引擎模型"
        disabled={disabled}
        onClick={() => (open ? close() : openPopover())}
        className={`flex items-center gap-0.5 text-[9px] font-mono text-[var(--text-tertiary)] bg-white/4 border border-white/8 rounded px-1.5 py-0.5 transition-colors ${
          disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white/8 hover:text-[var(--text-secondary)]'
        }`}
      >
        <span className="truncate" style={{ maxWidth: 120 }}>{chipLabel}</span>
        <ChevronDown size={9} className="shrink-0" />
      </button>
      {popover}
    </>
  );
}
