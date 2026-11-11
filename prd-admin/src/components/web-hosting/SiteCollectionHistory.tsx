import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Copy, ExternalLink, FolderOpen } from 'lucide-react';
import { AnchoredMenu } from '@/components/ui/AnchoredMenu';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { getCollectionHistory, type CollectionHistoryItem } from '@/services/real/hostedCollections';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';

/** 按实际分享快照找回合集；展开才查询，不为每张卡片加载历史，也不创建或修改关联。 */
export function SiteCollectionHistory({ siteId, siteTitle }: { siteId: string; siteTitle: string }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const token = useAuthStore(state => state.token);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [loaded, setResult] = useState<{ token: string | null; siteId: string; page: number; items: CollectionHistoryItem[]; total: number; pageSize: number } | null>(null);
  const result = loaded?.token === token && loaded.siteId === siteId && loaded.page === page ? loaded : null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const close = useCallback(() => { setOpen(false); requestAnimationFrame(() => anchor.current?.focus()); }, []);
  useEffect(() => {
    if (!open) return;
    let alive = true; setLoading(true); setError(''); setResult(null);
    void getCollectionHistory(siteId, page).then(response => {
      if (!alive) return;
      if (response.success) setResult({ ...response.data, token, siteId });
      else setError(response.error?.message || '合集历史暂时无法读取，请重试。');
    }).catch(() => { if (alive) setError('合集历史暂时无法读取，请检查网络后重试。'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, siteId, page, reload, token]);
  useEffect(() => { if (open) { const frame = requestAnimationFrame(() => panel.current?.focus()); return () => cancelAnimationFrame(frame); } }, [open]);
  const copy = async (item: CollectionHistoryItem) => {
    try { await navigator.clipboard.writeText(new URL(item.shareUrl, window.location.origin).href); toast.success('原链接已复制'); }
    catch { toast.error('未能复制链接', '请重试，或在有效的合集名称上选择复制链接地址。'); }
  };
  const pageCount = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : page;
  return <>
    <button ref={anchor} type="button" data-no-drag data-site-collection-history
      aria-label={`查看「${siteTitle}」的合集历史`} aria-haspopup="dialog" aria-expanded={open} aria-controls={menuId}
      title="查看包含此文档的合集分享，直接打开原链接"
      className="inline-flex min-h-7 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] hover-bg-soft max-sm:min-h-9"
      style={{ color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}
      onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}
      onClick={event => { event.stopPropagation(); if (open) close(); else { setPage(1); setOpen(true); } }}>
      <FolderOpen size={12} aria-hidden />合集历史
    </button>
    <AnchoredMenu open={open} onClose={close} anchorRef={anchor} align="left" minWidth={280}
      style={{ width: 'min(380px, calc(100vw - 16px))', maxHeight: 'min(520px, calc(100dvh - 16px))', padding: 0 }}>
      <div ref={panel} id={menuId} role="dialog" aria-label="包含此文档的合集分享" tabIndex={-1}
        className="flex min-h-0 flex-col text-[12px]" style={{ maxHeight: 'inherit', color: 'var(--text-primary)' }} onPointerDown={event => event.stopPropagation()}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
        <div className="shrink-0 border-b p-3" style={{ borderColor: 'var(--border-subtle)' }}><strong>包含此文档的合集分享</strong>
          <p className="mt-1 text-[11px] text-token-muted">你创建的分享记录 · 点击名称打开原链接，访问权限和密码保持原样</p></div>
        <div className="min-h-0 overflow-y-auto p-3" style={{ overscrollBehavior: 'contain' }}>
          {loading ? <div role="status" className="flex items-center gap-2 py-4"><MapSpinner size={16} />正在读取合集历史…</div>
            : error ? <div role="alert"><p>{error}</p><button type="button" className="mt-2 underline" onClick={() => setReload(value => value + 1)}>重试</button></div>
              : result?.items.length ? result.items.map(item => <div key={item.id} className="flex items-start gap-2 border-b py-3 first:pt-0 last:border-0 last:pb-0" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="min-w-0 flex-1">
                  {item.isActive ? <a href={item.shareUrl} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 font-medium hover:underline" style={{ color: 'var(--accent-primary)' }}>
                    <span className="truncate">{item.title}</span><ExternalLink size={12} className="shrink-0" aria-hidden /></a> : <span className="block truncate font-medium">{item.title}</span>}
                  <p className="mt-1 text-[11px] text-token-muted">{item.statusLabel} · {item.memberCount} 份 · {new Date(item.createdAt).toLocaleDateString('zh-CN')}{item.accessLevel === 'password' && ' · 密码保护'}</p>
                </div>
                <button type="button" aria-label={`复制原链接：${item.title}`} title="复制原链接" className="shrink-0 rounded p-1.5 hover-bg-soft" onClick={() => void copy(item)}><Copy size={13} aria-hidden /></button>
              </div>) : <p className="py-3 text-token-muted">还没有包含此文档的合集分享。这里只展示分享记录，不代表当前合集归属。</p>}
        </div>
        {result && result.total > result.pageSize && <nav aria-label="合集历史分页" className="flex shrink-0 items-center justify-between border-t p-3" style={{ borderColor: 'var(--border-subtle)' }}>
          <button type="button" disabled={loading || page === 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>第 {page} / {pageCount} 页 · {result.total} 条</span><button type="button" disabled={loading || page >= pageCount} onClick={() => setPage(value => value + 1)}>下一页</button>
        </nav>}
      </div>
    </AnchoredMenu>
  </>;
}
