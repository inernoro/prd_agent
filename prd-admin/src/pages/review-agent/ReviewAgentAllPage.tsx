import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Search, ChevronLeft, ChevronRight, CheckCircle, XCircle, Clock, Loader2 } from 'lucide-react';
import { getAllReviewSubmissions } from '@/services';
import type { ReviewSubmission } from '@/services';

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  Queued: { label: '等待评审', color: 'text-amber-400/80' },
  Running: { label: '评审中', color: 'text-blue-400/80' },
  Done: { label: '已完成', color: 'text-emerald-400/80' },
  Error: { label: '失败', color: 'text-red-400/80' },
};

export function ReviewAgentAllPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ReviewSubmission[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const pageSize = 20;

  const loadData = useCallback(async () => {
    setLoading(true);
    const res = await getAllReviewSubmissions(page, pageSize, undefined, statusFilter || undefined);
    if (res.success && res.data) {
      setItems(res.data.items);
      setTotal(res.data.total);
    }
    setLoading(false);
  }, [page, statusFilter]);

  useEffect(() => { loadData(); }, [loadData]);

  const filtered = search
    ? items.filter(i =>
        i.title.toLowerCase().includes(search.toLowerCase()) ||
        i.submitterName.toLowerCase().includes(search.toLowerCase())
      )
    : items;

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-9 h-9 rounded-lg bg-indigo-500/10 flex items-center justify-center">
          <ClipboardList className="w-4 h-4 text-indigo-400" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-white">全部评审提交</h1>
          <p className="text-xs text-white/40 mt-0.5">共 {total} 条提交记录</p>
        </div>
      </div>

      {/* 过滤栏 */}
      <div className="flex items-center gap-3 mb-5">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索方案标题或提交人..."
            className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-4 py-2.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-indigo-500/50 transition-colors"
          />
        </div>
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white/70 focus:outline-none focus:border-indigo-500/50 transition-colors"
        >
          <option value="">全部状态</option>
          <option value="Queued">等待评审</option>
          <option value="Running">评审中</option>
          <option value="Done">已完成</option>
          <option value="Error">失败</option>
        </select>
      </div>

      {/* 列表 */}
      {loading ? (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-white/30 text-sm">暂无提交记录</div>
      ) : (
        <div className="space-y-2">
          {filtered.map(item => {
            const statusInfo = STATUS_LABELS[item.status] ?? { label: item.status, color: 'text-white/50' };
            return (
              <button
                key={item.id}
                onClick={() => navigate(`/review-agent/submissions/${item.id}`)}
                className="w-full flex items-center gap-4 bg-white/3 hover:bg-white/5 border border-white/8 rounded-lg px-5 py-4 text-left transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-white truncate">{item.title}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-white/40">
                    <span>{item.submitterName}</span>
                    <span>·</span>
                    <span>{item.fileName}</span>
                    <span>·</span>
                    <span>{new Date(item.submittedAt).toLocaleDateString('zh-CN')}</span>
                  </div>
                </div>
                <div className={`text-xs flex-shrink-0 ${statusInfo.color}`}>
                  {item.status === 'Running' && <Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1" />}
                  {statusInfo.label}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-6">
          <button
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
            className="p-2 rounded-lg bg-white/5 border border-white/10 disabled:opacity-30 hover:bg-white/10 transition-colors"
          >
            <ChevronLeft className="w-4 h-4 text-white/70" />
          </button>
          <span className="text-sm text-white/50">第 {page} / {totalPages} 页</span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            className="p-2 rounded-lg bg-white/5 border border-white/10 disabled:opacity-30 hover:bg-white/10 transition-colors"
          >
            <ChevronRight className="w-4 h-4 text-white/70" />
          </button>
        </div>
      )}
    </div>
  );
}
