import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, EyeOff, Layers, MessageSquare, ScanLine } from 'lucide-react';
import { AnchoredMenu } from '@/components/ui/AnchoredMenu';
import { ReviewVersionBar } from './ReviewVersionBar';
import type { HostedReview } from './useHostedReview';
import type { AnnotationDisplayMode } from './useHostedAnnotations';

const DISPLAY_MODES: { id: AnnotationDisplayMode; label: string; short: string; description: string; icon: typeof MessageSquare }[] = [
  { id: 'hidden', label: '隐藏批注', short: '隐藏', description: '专注浏览，收起页面上的所有标记', icon: EyeOff },
  { id: 'standard', label: '标准标记', short: '标准', description: '保留文字高亮与元素描边', icon: ScanLine },
  { id: 'bubble', label: '批注气泡', short: '气泡', description: '高亮与编号一起显示，快速定位讨论', icon: Layers },
];

export function ReviewToolbarControls({ review, canUpload, onOpen, expanded, count, showVersions = true }: {
  review: HostedReview; canUpload: boolean; onOpen: () => void; expanded: boolean; count?: number | null; showVersions?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open]);
  const active = DISPLAY_MODES.find(mode => mode.id === review.annotations.displayMode) ?? DISPLAY_MODES[2];
  return <div className="review-toolbar-controls" onKeyDownCapture={event => {
    if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button type="button" className={`review-tool review-annotate-trigger min-h-11${expanded ? ' is-selected' : ''}`} onClick={onOpen}
      aria-label="批注与讨论" aria-expanded={expanded} title="打开批注与讨论，选择页面位置留下意见">
      <MessageSquare size={15} /><span>批注</span>{!!count && <span className="review-count">{count}</span>}<i className="review-attention-dot" aria-hidden="true" />
    </button>
    <button ref={trigger} type="button" className="review-tool review-display-trigger min-h-11" aria-label="批注显示方式" title={`批注显示：${active.label}`}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <active.icon size={15} /><span className="review-control-label">{active.short}</span><ChevronDown size={12} />
    </button>
    <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={trigger} minWidth={270} className={`review-popover${trigger.current?.closest('.surface-tone-dark') ? ' surface-tone-dark' : ''}`} style={{ width: 292, maxWidth: 'calc(100vw - 16px)', zIndex: 2147483647 }}>
      <div className="review-popover-heading"><strong>批注显示方式</strong><p>只调整显示，所有讨论都会保留</p></div>
      <div ref={menu} role="menu" aria-label="批注显示方式" onKeyDown={event => {
        if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next]?.focus();
      }}>{DISPLAY_MODES.map(mode => <button type="button" key={mode.id} role="menuitemradio"
        aria-checked={review.annotations.displayMode === mode.id} className="review-display-option" onClick={() => { review.annotations.setDisplayMode(mode.id); setOpen(false); trigger.current?.focus(); }}>
        <mode.icon size={18} /><span><strong>{mode.label}</strong><small>{mode.description}</small></span>{review.annotations.displayMode === mode.id && <Check size={15} />}
      </button>)}</div>
    </AnchoredMenu>
    {showVersions && <ReviewVersionBar review={review} canUpload={canUpload} />}
  </div>;
}
