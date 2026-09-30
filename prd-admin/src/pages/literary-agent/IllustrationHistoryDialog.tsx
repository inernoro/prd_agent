import { useEffect, useState } from 'react';
import { Download, History, RefreshCw } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { ImageLightbox } from '@/components/ui/ImageLightbox';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  getLiteraryIllustrationHistoryReal,
  type LiteraryIllustrationHistory,
  type LiteraryIllustrationHistoryItem,
} from '@/services/real/literaryAgentConfig';

/**
 * 这篇文章生成过的全部配图。
 *
 * 改稿、重新规划标记、同一位置重新生成都不再删除旧图——它们只是不再挂在正文上。
 * 这里按配图方案版本分组列出，当前挂在正文里的标「正在使用」；智能体（MCP）生成的图同样在内。
 */
export function IllustrationHistoryDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
}) {
  const [data, setData] = useState<LiteraryIllustrationHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [lightbox, setLightbox] = useState<{ images: string[]; captions: string[]; index: number } | null>(null);

  useEffect(() => {
    if (!open || !workspaceId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getLiteraryIllustrationHistoryReal({ id: workspaceId }).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.success && res.data) setData(res.data);
      else setError(res.error?.message || '历史配图读取失败');
    });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, reloadKey]);

  const allItems = data?.groups.flatMap((g) => g.items) ?? [];
  const captionOf = (item: LiteraryIllustrationHistoryItem) =>
    [item.markerIndex != null ? `配图 ${item.markerIndex + 1}` : '未挂位置', item.markerText || item.prompt || '']
      .filter(Boolean)
      .join(' · ');

  const openLightbox = (item: LiteraryIllustrationHistoryItem) => {
    const index = allItems.findIndex((x) => x.id === item.id);
    setLightbox({ images: allItems.map((x) => x.url), captions: allItems.map(captionOf), index: Math.max(0, index) });
  };

  const headline = data
    ? data.total === 0
      ? '这篇文章还没有生成过配图'
      : `共 ${data.total} 张，正文当前使用 ${data.currentCount} 张，其余 ${data.total - data.currentCount} 张是改稿或重新生成前的版本`
    : null;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        maxWidth={960}
        title={
          <span className="inline-flex items-center gap-2">
            <History size={16} />
            历史配图
          </span>
        }
        titleAction={
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="h-7 px-2 inline-flex items-center gap-1 rounded-md hover-bg-soft text-xs"
            style={{ color: 'var(--text-muted)' }}
            title="重新读取"
          >
            <RefreshCw size={13} />
            刷新
          </button>
        }
        content={
          <div className="flex flex-col gap-4" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
            {headline && (
              <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {headline}。旧图不会被删除，改稿、重新规划标记后都能在这里找回。
              </div>
            )}
            {loading && !data && (
              <div className="flex items-center gap-2 py-10 justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
                <MapSpinner size={16} />
                正在读取这篇文章的全部配图…
              </div>
            )}
            {error && (
              <div className="text-sm py-6 text-center" style={{ color: 'var(--accent-fg-danger)' }}>
                {error}
              </div>
            )}
            {data?.groups.map((group) => (
              <section key={`${group.workflowVersion ?? 'legacy'}`} className="flex flex-col gap-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {group.isCurrentVersion
                      ? '当前版本'
                      : group.workflowVersion != null
                        ? `第 ${group.workflowVersion} 版配图方案`
                        : '早期配图'}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {group.items.length} 张
                  </span>
                </div>
                <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
                  {group.items.map((item) => (
                    <figure
                      key={item.id}
                      className="flex flex-col rounded-lg overflow-hidden"
                      style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)' }}
                    >
                      <button
                        type="button"
                        onClick={() => openLightbox(item)}
                        className="relative block w-full"
                        style={{ aspectRatio: '3 / 4', background: 'var(--bg-sunken)' }}
                        title="点击放大"
                      >
                        <img
                          src={item.url}
                          alt={captionOf(item)}
                          loading="lazy"
                          className="absolute inset-0 w-full h-full object-cover"
                        />
                        {item.isCurrent && (
                          <span
                            className="absolute left-2 top-2 px-1.5 py-0.5 rounded text-[11px] font-medium"
                            style={{ background: 'var(--bg-elevated)', color: 'var(--accent-fg-success)' }}
                          >
                            正在使用
                          </span>
                        )}
                      </button>
                      <figcaption className="px-2 py-1.5 flex items-start gap-1.5">
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                            {item.markerIndex != null ? `配图 ${item.markerIndex + 1}` : '未挂位置'}
                          </div>
                          <div
                            className="text-[11px] line-clamp-2"
                            style={{ color: 'var(--text-muted)' }}
                            title={item.markerText || item.prompt || ''}
                          >
                            {item.markerText || item.prompt || '（无描述）'}
                          </div>
                          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            {new Date(item.createdAt).toLocaleString()}
                          </div>
                        </div>
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          download
                          className="shrink-0 p-1 rounded hover-bg-soft"
                          style={{ color: 'var(--text-muted)' }}
                          title="打开原图 / 下载"
                        >
                          <Download size={13} />
                        </a>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </section>
            ))}
          </div>
        }
      />
      {lightbox && (
        <ImageLightbox
          images={lightbox.images}
          captions={lightbox.captions}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}
    </>
  );
}
