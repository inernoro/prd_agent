import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, User, Users } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { listImportableWeeklyReports, importWeeklyReport } from '@/services';
import type { ImportableWeeklyReport, PmWeeklyReport } from '@/services/contracts/pmAgent';

interface Props {
  projectId: string;
  onClose: () => void;
  onImported: (report: PmWeeklyReport) => void;
}

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿', submitted: '已提交', reviewed: '已审阅', viewed: '已查看', returned: '已退回', overdue: '逾期', vacation: '休假', 'not-started': '未开始',
};

/**
 * 导入个人周报（report-agent）—— 列出当前用户【可见范围内】的个人周报（服务端已按权限过滤），
 * 选中后快照复制为一条项目周报（带回溯）。
 */
export function ImportPersonalReportModal({ projectId, onClose, onImported }: Props) {
  const [items, setItems] = useState<ImportableWeeklyReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [importingId, setImportingId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await listImportableWeeklyReports();
      if (!alive) return;
      if (res.success) setItems(res.data.items);
      else toast.error('加载失败', res.error?.message || '');
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const doImport = async (it: ImportableWeeklyReport) => {
    setImportingId(it.id);
    const res = await importWeeklyReport(projectId, { sourceReportId: it.id });
    setImportingId(null);
    if (res.success) { toast.success('已导入', `${it.userName || '成员'} 的周报已转为项目周报`); onImported(res.data); }
    else toast.error('导入失败', res.error?.message || '');
  };

  const modal = (
    <div className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="rounded-xl border flex flex-col w-full" style={{ maxWidth: 640, height: '78vh', maxHeight: '78vh', background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-4 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <Download size={16} style={{ color: '#3B82F6' }} />
          <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>导入个人周报</div>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>仅显示你可见范围内的周报（自己的 + 作为负责人可见的）</span>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:opacity-70 shrink-0" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
        </div>

        <div className="flex-1 px-3 py-3 flex flex-col gap-1.5" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {loading ? (
            <div className="flex-1 flex items-center justify-center"><MapSectionLoader text="正在加载可导入的周报…" /></div>
          ) : items.length === 0 ? (
            <div className="text-[12px] text-center py-10" style={{ color: 'var(--text-muted)' }}>暂无可导入的个人周报。去周报Agent 写一份，或确认你有可见权限。</div>
          ) : items.map((it) => (
            <div key={it.id} className="group flex items-center gap-3 rounded-lg border px-3 py-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
              <span className="shrink-0" style={{ color: it.isMine ? '#3B82F6' : '#A855F7' }}>{it.isMine ? <User size={15} /> : <Users size={15} />}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {it.userName || '成员'} · {it.weekYear} 年第 {it.weekNumber} 周
                </div>
                <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
                  {it.teamName || '团队'} · {STATUS_LABEL[it.status] || it.status} · {it.sectionCount} 个章节
                </div>
              </div>
              <Button variant="ghost" size="sm" className="shrink-0 opacity-0 group-hover:opacity-100" onClick={() => doImport(it)} disabled={importingId === it.id}>
                {importingId === it.id ? <MapSpinner size={13} /> : <Download size={13} />}导入
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
