import { useRef } from 'react';
import { Plus, History, RefreshCw } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import type { HostedReview } from './useHostedReview';

export function ReviewVersionBar({ review, canUpload }: { review: HostedReview; canUpload: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
    <label className="flex min-w-0 items-center gap-1.5 text-token-secondary">
      <History size={14} className="shrink-0" />
      <span className="sr-only">网页版本</span>
      <select aria-label="网页版本" value={review.selected?.id ?? ''} disabled={review.loading || review.uploading || !review.versions.length}
        onChange={event => void review.selectVersion(event.target.value)}
        className="min-h-9 min-w-0 max-w-52 rounded-lg border border-token-subtle bg-token-nested px-2 text-xs text-token-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50">
        {!review.versions.length && <option value="">{review.error ? '版本加载失败' : '正在读取版本…'}</option>}
        {review.versions.map(version => <option key={version.id} value={version.id} disabled={!version.canPreview && !version.isCurrent}>
          {version.versionLabel}{version.isCurrent ? ' · 当前发布' : ''}{!version.canPreview && !version.isCurrent ? ' · 历史文件不完整' : ''}
        </option>)}
      </select>
    </label>
    {canUpload && <>
      <input ref={input} type="file" accept=".html,.htm,.zip" className="hidden" aria-label="上传新版本文件" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (file) void review.upload(file);
      }} />
      <button type="button" onClick={() => input.current?.click()} disabled={review.uploading || review.loading}
        title="上传 HTML 或 ZIP，保存当前版本后创建并发布新版本" className="inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-token-subtle bg-token-nested px-2.5 text-xs text-token-primary hover-bg-soft disabled:opacity-40">
        {review.uploading ? <MapSpinner size={13} /> : <Plus size={14} />}{review.uploading ? '正在保存新版本…' : '新增版本'}
      </button>
    </>}
    {review.loading && <span className="inline-flex items-center gap-1.5 text-token-muted"><MapSpinner size={12} />正在打开版本…</span>}
    {review.historical && !review.loading && <span className="text-token-muted">正在查看历史版本，切换不影响线上网页</span>}
    {review.error && <div role="alert" className="flex basis-full items-center gap-2 text-xs text-red-500">
      <span className="min-w-0 flex-1 break-words">{review.error}</span>
      <button type="button" aria-label="重试加载版本" onClick={() => void review.refresh()} className="shrink-0 p-1"><RefreshCw size={13} /></button>
    </div>}
  </div>;
}
