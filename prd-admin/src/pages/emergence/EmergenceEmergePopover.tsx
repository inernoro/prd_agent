import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkle, Star, ChevronDown } from 'lucide-react';
import { Button } from '@/components/design/Button';

interface Props {
  disabled?: boolean;
  onEmerge: (fantasy: boolean) => void;
}

/**
 * 涌现入口 Popover —— 把原本「二维涌现」「三维幻想」两颗按钮合并，
 * 并在展开面板里配上大白话解释，让用户「第一次见就知道选哪个」。
 * 满足 .claude/rules/guided-exploration.md 的 3 秒规则。
 */
export function EmergenceEmergePopover({ disabled, onEmerge }: Props) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number }>({ x: 0, y: 0, w: 0 });

  useEffect(() => {
    if (!open) return;
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ x: rect.left, y: rect.bottom + 6, w: rect.width });
    const onClick = (e: MouseEvent) => {
      if (!btnRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (fantasy: boolean) => {
    setOpen(false);
    onEmerge(fantasy);
  };

  return (
    <>
      <div ref={btnRef} className="inline-flex">
        <Button variant="ghost" size="xs" disabled={disabled} onClick={() => setOpen(v => !v)}>
          <Sparkle size={13} /> 涌现
          <ChevronDown size={11} style={{ opacity: 0.6, marginLeft: 2 }} />
        </Button>
      </div>

      {open &&
        createPortal(
          <div
            className="surface-popover fixed z-[90] overflow-hidden rounded-[14px]"
            style={{
              top: anchor.y,
              right: `calc(100vw - ${anchor.x + 340}px)`,
              width: 340,
              backdropFilter: 'blur(40px) saturate(180%)',
            }}
          >
            <div className="px-4 pt-3.5 pb-2">
              <p className="text-[11px] text-token-muted">
                AI 会组合当前树里的多个节点，发现新的可能性。选择发散方式：
              </p>
            </div>

            <button
              onClick={() => choose(false)}
              disabled={disabled}
              className="surface-panel-footer hover-bg-soft flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors duration-150 disabled:opacity-50"
            >
              <div className="surface-action-accent flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px]">
                <Sparkle size={14} />
              </div>
              <div className="min-w-0">
                <p className="mb-0.5 text-[12px] font-semibold text-token-primary">
                  二维涌现·跨系统组合
                </p>
                <p className="text-[11px] leading-[1.55] text-token-muted">
                  AI 把已有的 2+ 个节点"接上"，在当前技术边界内发现它们的组合产物。结果必须基于现实锚点，每条都能落地。
                </p>
              </div>
            </button>

            <button
              onClick={() => choose(true)}
              disabled={disabled}
              className="surface-panel-footer hover-bg-soft flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors duration-150 disabled:opacity-50"
            >
              <div className="surface-state-warning flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px]">
                <Star size={14} />
              </div>
              <div className="min-w-0">
                <p className="mb-0.5 text-[12px] font-semibold text-token-primary">
                  三维幻想·放飞想象
                </p>
                <p className="text-[11px] leading-[1.55] text-token-muted">
                  放宽技术约束，想 3-5 年后的可能性。每条幻想都会标注"需要假设什么"，帮你辨别哪些是火花、哪些需要等风。
                </p>
              </div>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
