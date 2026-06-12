import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ShieldCheck, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { listPmAuditLogs } from '@/services';
import type { PmAuditLog } from '@/services/contracts/pmAgent';

interface Props {
  /** 作为独立视图嵌入工作台导航时不传（无返回按钮） */
  onBack?: () => void;
}

const PAGE_SIZE = 50;

function fmt(s: string) {
  const d = new Date(s);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const METHOD_COLOR: Record<string, string> = { POST: '#10B981', PUT: '#F59E0B', DELETE: '#EF4444' };

/** 项目管理审计日志 — 操作留痕（管理层可见）。 */
export function AuditLogView({ onBack }: Props) {
  const [items, setItems] = useState<PmAuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    const res = await listPmAuditLogs({ page: p, pageSize: PAGE_SIZE });
    if (res.success) { setItems(res.data.items); setTotal(res.data.total); }
    else toast.error('加载失败', res.error?.message || '');
    setLoading(false);
  }, []);

  useEffect(() => { load(page); }, [load, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <div className="shrink-0">
        {onBack && (
          <button onClick={onBack} className="flex items-center gap-1 text-[12px] mb-2 hover:opacity-70" style={{ color: 'var(--text-muted)' }}>
            <ArrowLeft size={14} /> 返回项目列表
          </button>
        )}
        <div className="flex items-center gap-2">
          <ShieldCheck size={20} style={{ color: '#10B981' }} />
          <h2 className="text-[17px] font-semibold" style={{ color: 'var(--text-primary)' }}>操作审计日志</h2>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>项目管理所有写操作留痕（合规 / 追溯）· 共 {total} 条</span>
        </div>
      </div>

      {loading ? (
        <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载审计日志…" /></div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex-1 min-h-0 overflow-auto" style={{ overscrollBehavior: 'contain' }}>
            <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse' }}>
              <thead className="sticky top-0 z-10" style={{ background: 'var(--bg-base)' }}>
                <tr style={{ color: 'var(--text-secondary)' }}>
                  <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">时间</th>
                  <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">操作人</th>
                  <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">操作</th>
                  <th className="text-left font-semibold px-3 py-2">项目</th>
                  <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">方法 / 路径</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr><td colSpan={5} className="text-center py-10" style={{ color: 'var(--text-muted)' }}>暂无审计记录</td></tr>
                ) : items.map((l) => (
                  <tr key={l.id} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums" style={{ color: 'var(--text-muted)' }}>{fmt(l.createdAt)}</td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{l.actorName || l.actorId}</td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>{l.actionLabel}</td>
                    <td className="px-3 py-2" style={{ color: 'var(--text-secondary)' }}>
                      {l.projectTitle ? <span>{l.projectNo ? `${l.projectNo} · ` : ''}{l.projectTitle}</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono" style={{ color: 'var(--text-muted)' }}>
                      <span style={{ color: METHOD_COLOR[l.method] || 'var(--text-muted)' }}>{l.method}</span> {l.path}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="shrink-0 flex items-center justify-end gap-2 px-3 py-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>第 {page} / {totalPages} 页</span>
            <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}><ChevronLeft size={14} />上一页</Button>
            <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>下一页<ChevronRight size={14} /></Button>
          </div>
        </div>
      )}
    </div>
  );
}
