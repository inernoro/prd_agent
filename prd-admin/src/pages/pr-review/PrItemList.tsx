import { Inbox, ChevronLeft, ChevronRight } from 'lucide-react';
import { usePrReviewStore } from './usePrReviewStore';
import { PrItemCard } from './PrItemCard';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';

/**
 * PR 记录列表 + 分页。列表为空/加载中有专门状态。
 */
export function PrItemList() {
  const items = usePrReviewStore((s) => s.items);
  const total = usePrReviewStore((s) => s.total);
  const page = usePrReviewStore((s) => s.page);
  const pageSize = usePrReviewStore((s) => s.pageSize);
  const listLoading = usePrReviewStore((s) => s.listLoading);
  const loadItems = usePrReviewStore((s) => s.loadItems);
  const authStatus = usePrReviewStore((s) => s.authStatus);

  if (!authStatus?.connected) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-10 flex flex-col items-center gap-3 text-white/50 text-sm">
        <Inbox size={32} className="text-white/30" />
        <div>请先连接 GitHub 账号，然后即可添加并审查任意有访问权限的 PR</div>
      </div>
    );
  }

  if (listLoading && items.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03]">
        <MapSectionLoader text="加载列表..." />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-10 flex flex-col items-center gap-3 text-white/50 text-sm">
        <Inbox size={32} className="text-white/30" />
        <div>还没有添加任何 PR——在左侧粘贴 GitHub PR 链接即可开始</div>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <div className="text-xs text-white/40">共 {total} 条</div>
        {listLoading && (
          <div className="flex items-center gap-1 text-xs text-white/40">
            <MapSpinner size={12} />
            刷新中
          </div>
        )}
      </div>

      {items.map((item) => (
        <PrItemCard key={item.id} item={item} />
      ))}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <button
            type="button"
            onClick={() => void loadItems(page - 1)}
            disabled={page <= 1 || listLoading}
            className="p-2 rounded-lg bg-white/5 text-white/70 hover:bg-white/10 disabled:opacity-30 transition"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-xs text-white/50 px-3">
            第 {page} / {totalPages} 页
          </span>
          <button
            type="button"
            onClick={() => void loadItems(page + 1)}
            disabled={page >= totalPages || listLoading}
            className="p-2 rounded-lg bg-white/5 text-white/70 hover:bg-white/10 disabled:opacity-30 transition"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
