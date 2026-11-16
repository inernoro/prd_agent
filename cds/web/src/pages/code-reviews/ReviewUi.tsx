import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ReviewButton({ tone = 'default', className = '', ...props }: ComponentProps<typeof Button> & { tone?: 'default' | 'primary' | 'ghost' | 'danger' }): JSX.Element {
  return <Button {...props} variant={tone === 'primary' ? 'default' : tone === 'ghost' ? 'ghost' : 'outline'} className={`cr-button cr-button-${tone} ${className}`} />;
}
export function ReviewBack({ onBack }: { onBack: () => void }): JSX.Element {
  return <button type="button" className="cr-back" onClick={onBack}><ChevronLeft aria-hidden="true" />返回审查列表</button>;
}
export function ReviewCopy({ text, label = '复制', compact = false }: { text: string; label?: string; compact?: boolean }): JSX.Element {
  const [status, setStatus] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return <span className="cr-copy"><ReviewButton tone="ghost" className={compact ? 'cr-icon-button' : ''} title={label} aria-label={label} onClick={() => {
    void navigator.clipboard.writeText(text).then(() => { if (alive.current) setStatus('已复制'); }).catch(() => { if (alive.current) setStatus('复制未完成，请手动选择文本。'); });
  }}><Copy aria-hidden="true" />{compact ? null : label}</ReviewButton><span role="status" className={compact ? 'sr-only' : 'cr-muted'}>{status}</span></span>;
}
export function ReviewPagination({ offset, limit, total, disabled, onOffset, noun = '条' }: {
  offset: number; limit: number; total: number; disabled?: boolean; onOffset: (offset: number) => void; noun?: string;
}): JSX.Element {
  const page = Math.floor(offset / limit), pages = Math.max(1, Math.ceil(total / limit));
  const visible = [...new Set([0, 1, 2, page - 1, page, page + 1, pages - 1].filter(n => n >= 0 && n < pages))].sort((a, b) => a - b);
  return <div className="cr-pagination"><span>第 {total ? offset + 1 : 0}–{Math.min(offset + limit, total)} {noun}，共 {total.toLocaleString()} {noun}</span>
    <nav aria-label={`${noun === '项问题' ? '问题' : '任务'}分页`}><ReviewButton tone="ghost" className="cr-icon-button" aria-label={noun === '项问题' ? '上一页问题' : '上一页任务'} disabled={disabled || !page} onClick={() => onOffset(Math.max(0, offset - limit))}><ChevronLeft /></ReviewButton>
      {visible.map((n, index) => <span key={n} className="cr-page-slot">{index > 0 && n > visible[index - 1] + 1 ? <span className="cr-muted">…</span> : null}<button type="button" className="cr-page-number" aria-label={`第 ${n + 1} 页`} aria-current={n === page ? 'page' : undefined} disabled={disabled} onClick={() => onOffset(n * limit)}>{n + 1}</button></span>)}
      <ReviewButton tone="ghost" className="cr-icon-button" aria-label={noun === '项问题' ? '下一页问题' : '下一页任务'} disabled={disabled || page + 1 >= pages} onClick={() => onOffset(offset + limit)}><ChevronRight /></ReviewButton></nav></div>;
}
export function ReviewEmpty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }): JSX.Element {
  return <div className="cr-empty"><h2>{title}</h2>{children ? <p>{children}</p> : null}{action}</div>;
}
