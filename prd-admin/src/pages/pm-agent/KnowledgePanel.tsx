import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { getPmKnowledgeStore, getPmMemberSites } from '@/services';
import type { PmMemberSite } from '@/services/contracts/pmAgent';
import { DocumentStoreBrowser } from '@/components/doc-browser/DocumentStoreBrowser';

interface Props {
  projectId: string;
}

/**
 * 项目知识库 — 复用 document-store 能力（文件夹/多格式上传/MD·HTML 预览/标签），
 * 每个项目挂一个项目级 DocumentStore，按项目成员鉴权。下方聚合成员托管站点（免密查看）。
 */
export function KnowledgePanel({ projectId }: Props) {
  const [storeId, setStoreId] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [sites, setSites] = useState<PmMemberSite[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const [sr, mr] = await Promise.all([getPmKnowledgeStore(projectId), getPmMemberSites(projectId)]);
      if (!alive) return;
      if (sr.success) { setStoreId(sr.data.storeId); setCanWrite(sr.data.canWrite); }
      else toast.error('加载失败', sr.error?.message || '');
      if (mr.success) setSites(mr.data.sites);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [projectId]);

  if (loading) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载知识库…" /></div>;
  if (!storeId) return <div className="flex-1 min-h-0 flex items-center justify-center text-[13px]" style={{ color: 'var(--text-muted)' }}>知识库加载失败，请刷新重试</div>;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <DocumentStoreBrowser storeId={storeId} canWrite={canWrite} />

      {sites.length > 0 && (
        <div className="shrink-0">
          <div className="flex items-center gap-1.5 mb-2">
            <Globe size={14} style={{ color: '#10B981' }} />
            <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>成员托管站点</span>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>项目成员用「网页托管」发布的站点，点开免密查看</span>
          </div>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', maxHeight: 160, overflowY: 'auto', overscrollBehavior: 'contain' }}>
            {sites.map((s) => (
              <button key={s.siteId} onClick={() => window.open(s.url, '_blank', 'noopener')} className="text-left rounded-lg border px-3 py-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
                <div className="text-[12.5px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{s.title || '未命名站点'}</div>
                <div className="text-[11px] mt-0.5 inline-flex items-center gap-1" style={{ color: 'var(--text-muted)' }}><Globe size={10} />{s.userName}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
