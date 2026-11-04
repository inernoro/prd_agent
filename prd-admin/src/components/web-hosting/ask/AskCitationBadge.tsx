import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, X } from 'lucide-react';
import { AnchoredMenu } from '@/components/ui/AnchoredMenu';
import { compactExcerpt } from './citationNodes';

export function AskCitationBadge({ references, notes, sourceTitle }: {
  references: { id: string; href: string; label: string }[];
  notes: Map<string, string>;
  sourceTitle: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLAnchorElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const sources = [...new Map(references.map((ref) => [ref.href, { ...ref, text: notes.get(ref.href.slice(1)) ?? '' }])).values()];
  const label = sourceTitle.trim() || '本页原文';
  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    window.addEventListener('blur', close);
    return () => window.removeEventListener('blur', close);
  }, [open, close]);
  const dismiss = () => { close(); anchor.current?.focus(); };
  return <span className="ask-citation-inline" data-citation-badge>
    <a ref={anchor} id={references[0].id} href={references[0].href} className="ask-citation-badge"
      aria-label={`查看「${label}」的 ${sources.length} 处引用`} aria-haspopup="dialog" aria-expanded={open}
      title={`来自当前网页：${label}`} onClick={(event) => { event.preventDefault(); setOpen((value) => !value); }}>
      <FileText size={11} aria-hidden="true" /><span className="ask-citation-badge-label">{label}</span>
      {sources.length > 1 && <span className="ask-citation-badge-count">+{sources.length - 1}</span>}
    </a>
    {references.slice(1).map((ref) => <span key={ref.id} id={ref.id} hidden />)}
    <AnchoredMenu open={open} onClose={close} anchorRef={anchor} align="right" minWidth={240}
      className="ask-md ask-citation-popover" style={{ width: 'min(320px, calc(100vw - 24px))', maxWidth: 'calc(100vw - 24px)', maxHeight: 'min(260px, 32dvh)', display: 'flex', padding: 0 }}>
      <div role="dialog" aria-label="引用原文" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, width: '100%' }} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); dismiss(); }
      }}>
        <div className="ask-citation-popover-header">
          <FileText size={13} aria-hidden="true" /><span title={label}>{label}</span>
          <button ref={closeButton} type="button" aria-label="关闭引用" onClick={dismiss}><X size={13} /></button>
        </div>
        <div className="ask-citation-popover-list" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {sources.map((source) => <CitationCard key={source.href} text={source.text} label={source.label} />)}
        </div>
      </div>
    </AnchoredMenu>
  </span>;
}

function CitationCard({ text, label }: { text: string; label: string }) {
  const [expanded, setExpanded] = useState(false);
  return <div className="ask-citation-card">
    <div className="ask-citation-card-label">原文片段 {label}</div>
    <p className={expanded ? 'ask-citation-card-full' : 'ask-citation-preview'}>{expanded ? text : compactExcerpt(text)}</p>
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? '收起片段' : '展开片段'}</button>
  </div>;
}
