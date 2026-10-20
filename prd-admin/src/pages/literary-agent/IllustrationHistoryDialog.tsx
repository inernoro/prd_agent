import { useEffect, useState } from 'react';
import { Download, History, ImageOff, RefreshCw, RotateCcw } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { ImageLightbox } from '@/components/ui/ImageLightbox';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  getLiteraryIllustrationHistoryReal,
  restoreLiteraryIllustrationReal,
  type LiteraryIllustrationHistory,
  type LiteraryIllustrationHistoryItem,
} from '@/services/real/literaryAgentConfig';
import { planRestore } from './illustrationRestoreTarget';

/**
 * 这篇文章生成过的全部配图。
 *
 * 改稿、重新规划标记、同一位置重新生成都不再删除旧图——它们只是不再挂在正文上。
 * 这里按配图方案版本分组列出，当前挂在正文里的标「正在使用」；智能体（MCP）生成的图同样在内。
 * 没在用的旧图可以「放回」当前方案里的任意位置，原位置还在时默认放回原位
 * （智能体用 map_literary_restore_image 走的是同一处）。
 */
export function IllustrationHistoryDialog({
  open,
  onOpenChange,
  workspaceId,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** 放回成功后让编辑页重读，正文与配图卡片跟着换 */
  onRestored?: () => void;
}) {
  const [data, setData] = useState<LiteraryIllustrationHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [lightbox, setLightbox] = useState<{ images: string[]; captions: string[]; index: number } | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  /** 用户在下拉里为某张图选的目标位置；没选就用 planRestore 给的默认 */
  const [pickedTarget, setPickedTarget] = useState<Record<string, number>>({});

  const targetOf = (item: LiteraryIllustrationHistoryItem) =>
    pickedTarget[item.id] ?? planRestore(data, item).defaultTarget;

  const restore = async (item: LiteraryIllustrationHistoryItem) => {
    const target = targetOf(item);
    if (target == null || restoringId || !data) return;
    setRestoringId(item.id);
    // 带上打开时看到的方案版本：期间文章被改稿或重新规划过，服务端会拒绝，而不是挂到同序号的新标记上
    const res = await restoreLiteraryIllustrationReal({
      id: workspaceId, assetId: item.id, markerIndex: target, workflowVersion: data.currentVersion,
    });
    setRestoringId(null);
    if (!res.success) {
      toast.error(res.error?.message || '放回失败');
      // 方案已更新：重新拉一遍，按新方案展示可放回的位置
      if (res.error?.code === 'WORKSPACE_CONTENT_CHANGED') setReloadKey((k) => k + 1);
      return;
    }
    toast.success(res.data?.note || `已把这张放回配图 ${target + 1}，换下的那张也留在这里`);
    setReloadKey((k) => k + 1);
    onRestored?.();
  };

  useEffect(() => {
    if (!open || !workspaceId) return;
    let cancelled = false;
    // 换了文章：上一篇的历史不能留在屏幕上（还能点「放回」），等这一篇读回来再显示
    setData((prev) => (prev && prev.workspaceId === workspaceId ? prev : null));
    setLoading(true);
    setError(null);
    void getLiteraryIllustrationHistoryReal({ id: workspaceId }).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.success && res.data) {
        setData(res.data);
        // 方案可能变了（位置增减、重排），上一次选的目标位置不再可信
        setPickedTarget({});
      }
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
  const lastSet = data?.previousSets?.[0];

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
            {lastSet && (
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {lastSet.archivedAt ? `${new Date(lastSet.archivedAt).toLocaleString()} ` : ''}
                {lastSet.reason}之前，正文挂着的是标「换稿前在用」的 {lastSet.images.length} 张。
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
                        <HistoryThumb url={item.url} label={item.markerIndex != null ? `配图 ${item.markerIndex + 1}` : '配图'} />
                        {item.isCurrent ? (
                          <span
                            className="absolute left-2 top-2 px-1.5 py-0.5 rounded text-[11px] font-medium"
                            style={{ background: 'var(--bg-elevated)', color: 'var(--accent-fg-success)' }}
                          >
                            正在使用
                          </span>
                        ) : item.inLastSet ? (
                          <span
                            className="absolute left-2 top-2 px-1.5 py-0.5 rounded text-[11px] font-medium"
                            style={{ background: 'var(--bg-elevated)', color: 'var(--accent-fg-info)' }}
                          >
                            换稿前在用
                          </span>
                        ) : null}
                      </button>
                      <figcaption className="px-2 py-1.5 flex items-start gap-1.5">
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                            {item.mountedAt && item.mountedAt.length > 1
                              ? `配图 ${item.mountedAt.map((i) => i + 1).join('、')}`
                              : item.markerIndex != null ? `配图 ${item.markerIndex + 1}` : '未挂位置'}
                          </div>
                          <div
                            className="text-[11px] line-clamp-2"
                            style={{ color: 'var(--text-muted)' }}
                            title={item.markerText || item.prompt || ''}
                          >
                            {item.markerText || item.prompt || '（无描述）'}
                          </div>
                          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            {new Date(item.createdAt).toLocaleString()} 生成
                          </div>
                          {!item.isCurrent && item.replacedReason && (
                            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }} title={item.replacedReason}>
                              {item.replacedAt ? `${new Date(item.replacedAt).toLocaleString()} 换下` : '已换下'} · {item.replacedReason}
                            </div>
                          )}
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
                      <RestoreRow
                        item={item}
                        plan={planRestore(data, item)}
                        target={targetOf(item)}
                        onPick={(index) => setPickedTarget((prev) => ({ ...prev, [item.id]: index }))}
                        onRestore={() => void restore(item)}
                        busy={restoringId === item.id}
                        disabled={restoringId != null}
                      />
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

/**
 * 「放回」一行：当前方案有多个位置时先选放到哪（原位置还在就默认选它），只有一个位置时直接放回。
 */
function RestoreRow({
  item,
  plan,
  target,
  onPick,
  onRestore,
  busy,
  disabled,
}: {
  item: LiteraryIllustrationHistoryItem;
  plan: ReturnType<typeof planRestore>;
  target: number | undefined;
  onPick: (index: number) => void;
  onRestore: () => void;
  busy: boolean;
  disabled: boolean;
}) {
  if (!plan.restorable) return null;
  const chosen = plan.options.find((o) => o.index === target);
  return (
    <div className="px-2 pb-2 flex items-center gap-1.5" data-restore-for={item.id}>
      {plan.showPicker && (
        <select
          value={target ?? ''}
          onChange={(e) => onPick(Number(e.target.value))}
          disabled={disabled}
          className="flex-1 min-w-0 h-6 rounded px-1 text-[11px]"
          style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}
          title={chosen ? `放到配图 ${chosen.index + 1}：${chosen.description}` : '选择要放回的位置'}
          aria-label="放回到哪个配图位置"
        >
          {target == null && (
            <option value="" disabled>
              放到哪个位置…
            </option>
          )}
          {plan.options.map((o) => (
            <option key={o.index} value={o.index}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        onClick={onRestore}
        disabled={disabled || target == null}
        className="shrink-0 h-6 px-1.5 inline-flex items-center gap-1 rounded hover-bg-soft text-[11px] disabled:opacity-50"
        style={{ color: 'var(--accent-fg-info)', marginLeft: plan.showPicker ? undefined : 'auto' }}
        title={target != null ? `把这张放回配图 ${target + 1}（正在用的那张会留在历史里）` : '先选要放回的位置'}
      >
        {busy ? <MapSpinner size={11} /> : <RotateCcw size={11} />}
        {plan.showPicker ? '放回' : `放回配图 ${(target ?? 0) + 1}`}
      </button>
    </div>
  );
}

/**
 * 缩略图。加载失败时给一块干净的占位，而不是让浏览器把替代文字（可能是一长段提示词）铺满卡片。
 */
function HistoryThumb({ url, label }: { url: string; label: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-xs"
        style={{ color: 'var(--text-muted)' }}
      >
        <ImageOff size={20} />
        图片暂时加载不出来
      </span>
    );
  }
  return (
    <img
      src={url}
      alt={label}
      loading="lazy"
      onError={() => setFailed(true)}
      className="absolute inset-0 w-full h-full object-cover"
    />
  );
}
