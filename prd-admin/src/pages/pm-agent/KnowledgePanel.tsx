import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Globe, Search, X, Download, Lock } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { getPmKnowledgeStore, listSites, getSiteContent, addDocumentEntry, updateDocumentContent } from '@/services';
import type { HostedSite } from '@/services/real/webPages';
import { DocumentStoreBrowser } from '@/components/doc-browser/DocumentStoreBrowser';
import { relTime, filterInputCls, filterInputStyle } from './materialUtils';

interface Props {
  projectId: string;
}

/**
 * 项目知识库 — 复用 document-store 知识文档全套能力（文件夹/多格式/MD·HTML 预览/标签）。
 * 可写时额外支持「从网页托管导入」：选择自己有权限的托管站点（我的 + 团队共享），
 * 服务端代理取回 HTML 正文存为知识文档（2026-06-12 起「成员作品」子视图已按用户要求移除）。
 */
export function KnowledgePanel({ projectId }: Props) {
  const [storeId, setStoreId] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [loading, setLoading] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  // 导入成功后重挂载浏览器以刷新条目列表（DocumentStoreBrowser 内部自管加载）
  const [browserKey, setBrowserKey] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const sr = await getPmKnowledgeStore(projectId);
      if (!alive) return;
      if (sr.success) { setStoreId(sr.data.storeId); setCanWrite(sr.data.canWrite); }
      else toast.error('加载失败', sr.error?.message || '');
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [projectId]);

  if (loading) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载知识库…" /></div>;
  if (!storeId) return <div className="flex-1 min-h-0 flex items-center justify-center text-[13px]" style={{ color: 'var(--text-muted)' }}>知识库加载失败，请刷新重试</div>;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      {canWrite && (
        <div className="shrink-0 flex items-center justify-end">
          <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)} title="选择你有权限的托管站点，把 HTML 内容导入为知识文档">
            <Globe size={13} />从网页托管导入
          </Button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        <DocumentStoreBrowser key={browserKey} storeId={storeId} canWrite={canWrite} />
      </div>
      {importOpen && (
        <HostedSiteImportModal storeId={storeId}
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); setBrowserKey((k) => k + 1); }} />
      )}
    </div>
  );
}

/** 从网页托管导入弹窗 —— 列出「我的 + 团队共享」站点，选中即服务端取回 HTML 存为知识文档。 */
function HostedSiteImportModal({ storeId, onClose, onImported }: { storeId: string; onClose: () => void; onImported: () => void }) {
  const [sites, setSites] = useState<HostedSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [importingId, setImportingId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      // 用户有权限的站点 = 我的 + 我加入团队的共享站点（跨团队聚合），按 id 去重
      const [mine, team] = await Promise.all([
        listSites({ limit: 100, sort: 'updated' }),
        listSites({ scope: 'team', limit: 100, sort: 'updated' }),
      ]);
      if (!alive) return;
      const map = new Map<string, HostedSite>();
      for (const s of [...(mine.success ? mine.data.items : []), ...(team.success ? team.data.items : [])]) map.set(s.id, s);
      setSites([...map.values()]);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return sites.filter((s) => !kw || (s.title || '').toLowerCase().includes(kw));
  }, [sites, q]);

  const importSite = async (site: HostedSite) => {
    setImportingId(site.id);
    const cr = await getSiteContent(site.id);
    if (!cr.success) { setImportingId(null); toast.error('读取站点内容失败', cr.error?.message || ''); return; }
    const er = await addDocumentEntry(storeId, {
      title: cr.data.title || site.title || '托管站点导入',
      sourceType: 'import',
      contentType: 'text/html',
      summary: '',
    });
    if (!er.success) { setImportingId(null); toast.error('创建知识文档失败', er.error?.message || ''); return; }
    const ur = await updateDocumentContent(er.data.id, cr.data.html);
    setImportingId(null);
    if (ur.success) { toast.success('已导入知识库', `「${cr.data.title}」可在知识文档中预览`); onImported(); }
    else toast.error('正文保存失败', ur.error?.message || '');
  };

  const modal = (
    <div className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="rounded-xl border flex flex-col w-full" style={{ maxWidth: 640, height: '70vh', maxHeight: '70vh', background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-4 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <Globe size={16} style={{ color: '#2563EB' }} />
          <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>从网页托管导入</div>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>我的与团队共享站点的 HTML 内容，导入后可在知识文档中预览</span>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:opacity-70 shrink-0" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
        </div>
        <div className="px-5 py-3 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="relative">
            <Search size={13} style={{ color: 'var(--text-muted)', position: 'absolute', left: 8, top: 8 }} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索站点标题" autoFocus
              className={`${filterInputCls} pl-7 w-full`} style={filterInputStyle} />
          </div>
        </div>
        <div className="flex-1 px-3 py-2" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {loading ? (
            <MapSectionLoader text="正在加载站点…" />
          ) : filtered.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-2" style={{ color: 'var(--text-muted)' }}>
              <Globe size={28} style={{ opacity: 0.4 }} />
              <div className="text-[12.5px]">{sites.length === 0 ? '你还没有可导入的托管站点' : '没有匹配的站点'}</div>
            </div>
          ) : (
            filtered.map((s) => {
              const isPublic = s.visibility === 'public';
              const wrapped = !!s.wrappedAssetType;
              return (
                <div key={s.id} className="flex items-center gap-3 py-2 px-2 rounded-md hover:bg-[var(--bg-base)]">
                  <Globe size={14} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] truncate" style={{ color: 'var(--text-primary)' }}>{s.title || '未命名站点'}</div>
                    <div className="text-[10.5px] flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                      <span className="inline-flex items-center gap-1">{isPublic ? <><Globe size={9} />公开</> : <><Lock size={9} />未公开</>}</span>
                      {s.updatedAt && <span>{relTime(s.updatedAt)}</span>}
                      {wrapped && <span style={{ color: '#B45309' }}>包装资产站（pdf/视频/md），不支持 HTML 导入</span>}
                    </div>
                  </div>
                  <Button variant="secondary" size="sm" disabled={!!importingId || wrapped} onClick={() => importSite(s)}>
                    {importingId === s.id ? <MapSpinner size={13} /> : <Download size={13} />}导入
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
  return createPortal(modal, document.body);
}
