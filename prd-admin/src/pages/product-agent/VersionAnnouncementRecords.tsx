import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { getProductAnnouncementRecords, type ProductAnnouncementRecordPage } from '@/services/real/productAgent';

const buttonClass = 'inline-flex items-center justify-center gap-1.5 rounded border border-token-subtle bg-token-nested px-3 py-1.5 text-xs text-token-secondary hover:bg-token-hover disabled:opacity-50';

export function VersionAnnouncementRecords({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState(1);
  const [failedOnly, setFailedOnly] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<ProductAnnouncementRecordPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setData(null);
    void getProductAnnouncementRecords(page, failedOnly).then((result) => {
      if (!active) return;
      if (result.success) setData(result.data);
      else setError(result.error?.message ?? '抓取记录读取失败，请点击重试。');
    }).catch(() => {
      if (active) setError('抓取记录读取失败，请点击重试。');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, failedOnly, refresh]);

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title="上线公告抓取记录"
    description="每条公告分别保存抓取结果。中断后继续处理待抓取和失败记录，已保存的公告不会丢失。"
    maxWidth={1280} contentStyle={{ height: '80vh', maxHeight: '90vh' }}
    content={<div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-xs text-token-secondary">
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={failedOnly} onChange={(event) => { setPage(1); setFailedOnly(event.target.checked); }} />
          仅看抓取失败
        </label>
        <button type="button" className={buttonClass} disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          {loading && <MapSpinner size={12} />}刷新记录
        </button>
      </div>
      {loading ? <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-token-secondary"><MapSpinner size={18} />正在读取抓取记录…</div>
        : error ? <div role="alert" className="rounded border border-token-subtle bg-token-nested p-4 text-sm text-token-secondary">
          {error}<button type="button" className={`${buttonClass} ml-3`} onClick={() => setRefresh((value) => value + 1)}>重试</button>
        </div>
          : data?.items.length ? <div className="flex-1 rounded border border-token-subtle" style={{ minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain' }}>
            <table className="w-full text-left text-xs text-token-secondary" style={{ minWidth: 1100 }}>
              <thead className="sticky top-0 bg-token-nested text-token-primary"><tr>
                {['公告名称', '公告链接', '应用', 'V 版本号', '发布时间', '公告右下角时间', '抓取状态', '版本匹配', '失败原因'].map((title) => <th key={title} className="whitespace-nowrap border-b border-token-subtle px-3 py-2 font-medium">{title}</th>)}
              </tr></thead>
              <tbody>{data.items.map((item) => <tr key={item.id} className="border-b border-token-subtle last:border-b-0">
                <td className="max-w-56 px-3 py-2 align-top text-token-primary">{item.title || '待提取'}</td>
                <td className="max-w-60 break-all px-3 py-2 align-top"><a href={item.url} target="_blank" rel="noreferrer" className="text-[color:var(--accent-fg-blue)] hover:underline">{item.url}</a></td>
                <td className="px-3 py-2 align-top">{item.applicationName || '待识别'}</td>
                <td className="whitespace-nowrap px-3 py-2 align-top">{item.version || '待识别'}</td>
                <td className="px-3 py-2 align-top">{item.publishedAtRaw || '未提取'}</td>
                <td className="px-3 py-2 align-top">{item.footerTimeRaw || '未提取'}</td>
                <td className="whitespace-nowrap px-3 py-2 align-top">{item.statusLabel}</td>
                <td className="whitespace-nowrap px-3 py-2 align-top">{item.matchStatusLabel}</td>
                <td className="max-w-64 px-3 py-2 align-top">{item.error || '—'}</td>
              </tr>)}</tbody>
            </table>
          </div>
            : <div role="status" className="flex flex-1 items-center justify-center p-6 text-center text-sm text-token-secondary">
              {failedOnly ? '当前没有抓取失败的公告。' : '还没有抓取记录。关闭后点击“更新公告”，后台会逐条保存公告和抓取进度。'}
            </div>}
    </div>}
    actions={<>
      <span role="status" className="mr-auto text-xs text-token-secondary">{data ? `共 ${data.total} 条，第 ${data.page} / ${Math.max(1, data.totalPages)} 页` : `第 ${page} 页`}</span>
      <button type="button" className={buttonClass} disabled={loading || page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button>
      <button type="button" className={buttonClass} disabled={loading || !data || page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>下一页</button>
    </>} />;
}
