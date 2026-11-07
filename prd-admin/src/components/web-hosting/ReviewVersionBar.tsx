import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Files, Upload, RefreshCw } from 'lucide-react';
import { AnchoredMenu } from '@/components/ui/AnchoredMenu';
import { MapSpinner } from '@/components/ui/VideoLoader';
import type { HostedReview } from './useHostedReview';

export function ReviewVersionBar({ review, canUpload }: { review: HostedReview; canUpload: boolean }) {
  const input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const busy = review.loading || review.uploading;
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  }, [open]);
  return <div className="review-version-control" onKeyDownCapture={event => {
    if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} type="button" className="review-tool review-version-trigger max-sm:min-h-11" aria-label={`网页版本：${review.selected?.versionLabel ?? '加载中'}`}
      aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(value => !value)} title="切换网页版本，查看对应批注">
      {busy ? <MapSpinner size={15} /> : <Files size={15} />}
      <span>{review.selected?.versionLabel ?? '版本'}<span className="review-version-state">{review.historical ? '历史版' : '当前版'}</span></span>
      <ChevronDown size={12} className={open ? 'review-chevron-open' : ''} />
    </button>
    <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={trigger} minWidth={280} className={`review-popover${trigger.current?.closest('.surface-tone-dark') ? ' surface-tone-dark' : ''}`} style={{ width: 292, maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100dvh - 88px)', overflowY: 'auto', zIndex: 2147483647 }}>
      <div className="review-popover-heading"><strong>网页版本</strong><p>{review.versions.some(version => version.historyRestricted) ? '当前权限仅开放当前版本，历史需站点编辑权限' : '切换版本，查看对应的内容与批注'}</p></div>
      <div ref={list} role="listbox" aria-label="网页版本" className="review-version-list" onKeyDown={event => {
        if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next]?.focus();
      }}>
        {!review.versions.length && <p className="review-menu-empty">{review.error ? '暂时无法读取版本记录' : '正在读取版本记录…'}</p>}
        {review.versions.map(version => <button key={version.id} type="button" role="option" aria-selected={review.selected?.id === version.id}
          disabled={busy || (!version.canPreview && !version.isCurrent)} className="review-version-option" onClick={() => { void review.selectVersion(version.id); setOpen(false); trigger.current?.focus(); }}>
          <span className="review-timeline-dot" />
          <span className="review-version-copy"><span><strong>{version.versionLabel}</strong><span>{version.isCurrent ? '当前发布' : '历史版本'}</span></span>
            <time dateTime={version.publishedAt ?? undefined}>{version.publishedAt ? new Date(version.publishedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '已保存的网页快照'}</time>
            {!version.canPreview && !version.isCurrent && <small>历史文件不完整</small>}</span>
          {review.selected?.id === version.id && <Check size={15} />}
        </button>)}
      </div>
      {canUpload && <div className="review-menu-footer"><button type="button" className="review-upload-action" onClick={() => input.current?.click()} disabled={busy}>
        {review.uploading ? <MapSpinner size={15} /> : <Upload size={15} />}{review.uploading ? '正在保存新版本…' : '上传新版本'}
        <span>HTML / ZIP</span>
      </button><p>保留旧版内容与批注，上传后发布新版本。</p></div>}
      {review.error && <div role="alert" className="review-version-error"><span>{review.error}</span><button type="button" aria-label="重试加载版本" onClick={() => void review.refresh()}><RefreshCw size={14} /></button></div>}
    </AnchoredMenu>
    {canUpload && <input ref={input} type="file" accept=".html,.htm,.zip" className="hidden" aria-label="上传新版本文件" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (file) void review.upload(file);
    }} />}
  </div>;
}
