import { useEffect, useMemo, useState } from 'react';
import { Globe, BookOpen, Search, ExternalLink, Eye, Lock, Image as ImageIcon } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { getPmKnowledgeStore, getPmMemberSites } from '@/services';
import type { PmMemberSite } from '@/services/contracts/pmAgent';
import { DocumentStoreBrowser } from '@/components/doc-browser/DocumentStoreBrowser';
import { relTime, filterInputCls, filterInputStyle } from './materialUtils';

interface Props {
  projectId: string;
}

type SubView = 'docs' | 'sites';
type VisFilter = 'all' | 'public' | 'private';

/**
 * 项目知识库 — 「知识文档」复用 document-store（文件夹/多格式/MD·HTML 预览/标签），
 * 「成员作品」聚合项目成员的网页托管作品（公开 + 私有均可见可访问，项目空间内免门禁查看）。
 */
export function KnowledgePanel({ projectId }: Props) {
  const [storeId, setStoreId] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [sites, setSites] = useState<PmMemberSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [sub, setSub] = useState<SubView>('docs');
  // 成员作品筛选
  const [q, setQ] = useState('');
  const [memberFilter, setMemberFilter] = useState('');
  const [visFilter, setVisFilter] = useState<VisFilter>('all');

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

  const members = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sites) m.set(s.userId, s.userName);
    return [...m.entries()];
  }, [sites]);

  const filteredSites = useMemo(() => sites.filter((s) => {
    if (memberFilter && s.userId !== memberFilter) return false;
    if (visFilter === 'public' && s.visibility !== 'public') return false;
    if (visFilter === 'private' && s.visibility === 'public') return false;
    if (q.trim() && !(`${s.title} ${s.userName}`.toLowerCase().includes(q.trim().toLowerCase()))) return false;
    return true;
  }), [sites, memberFilter, visFilter, q]);

  if (loading) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载知识库…" /></div>;
  if (!storeId) return <div className="flex-1 min-h-0 flex items-center justify-center text-[13px]" style={{ color: 'var(--text-muted)' }}>知识库加载失败，请刷新重试</div>;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      {/* 子视图切换 */}
      <div className="shrink-0 flex items-center gap-1 p-0.5 rounded-lg w-fit" style={{ background: 'var(--bg-base)' }}>
        {([['docs', '知识文档', BookOpen], ['sites', '成员作品', Globe]] as const).map(([key, label, Icon]) => {
          const active = sub === key;
          return (
            <button key={key} onClick={() => setSub(key)}
              className="px-3 py-1.5 rounded-md text-[12.5px] inline-flex items-center gap-1.5"
              style={{ background: active ? 'var(--bg-card)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: active ? 600 : 400 }}>
              <Icon size={13} />{label}
              {key === 'sites' && sites.length > 0 && (
                <span className="text-[10px] px-1.5 rounded-full" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>{sites.length}</span>
              )}
            </button>
          );
        })}
      </div>

      {sub === 'docs' ? (
        <div className="flex-1 min-h-0"><DocumentStoreBrowser storeId={storeId} canWrite={canWrite} /></div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col gap-3">
          {/* 筛选栏 */}
          <div className="shrink-0 flex items-center gap-2 flex-wrap">
            <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>项目成员用「网页托管」发布的作品，公开与未公开均可在此查看与访问</span>
            <div className="ml-auto flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search size={13} style={{ color: 'var(--text-muted)', position: 'absolute', left: 8, top: 8 }} />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索作品 / 成员"
                  className={`${filterInputCls} pl-7`} style={{ ...filterInputStyle, width: 180 }} />
              </div>
              <select value={memberFilter} onChange={(e) => setMemberFilter(e.target.value)} className={filterInputCls} style={filterInputStyle} title="成员">
                <option value="">全部成员</option>
                {members.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
              <select value={visFilter} onChange={(e) => setVisFilter(e.target.value as VisFilter)} className={filterInputCls} style={filterInputStyle} title="可见性">
                <option value="all">全部可见性</option>
                <option value="public">已公开</option>
                <option value="private">未公开</option>
              </select>
            </div>
          </div>

          {/* 作品卡片网格 */}
          <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
            {filteredSites.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center gap-3" style={{ color: 'var(--text-muted)' }}>
                <Globe size={32} style={{ opacity: 0.4 }} />
                <div className="text-[12.5px]">{sites.length === 0 ? '项目成员还没有网页托管作品' : '没有符合筛选条件的作品'}</div>
              </div>
            ) : (
              <div className="grid gap-3 pb-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
                {filteredSites.map((s) => {
                  const isPublic = s.visibility === 'public';
                  return (
                    <button key={s.siteId} onClick={() => window.open(s.url, '_blank', 'noopener')}
                      className="group text-left rounded-xl border overflow-hidden flex flex-col transition-colors hover:border-[var(--border-strong)]"
                      style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }} title={`打开 ${s.title || '站点'}`}>
                      {/* 封面：优先封面图 → 托管页缩放 iframe 实时预览 → 占位图标 */}
                      <div className="relative h-28 flex items-center justify-center overflow-hidden" style={{ background: 'var(--bg-base)' }}>
                        {s.coverImageUrl ? (
                          <img src={s.coverImageUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                        ) : s.url ? (
                          <iframe
                            src={s.url}
                            title={s.title || '站点预览'}
                            loading="lazy"
                            scrolling="no"
                            referrerPolicy="no-referrer"
                            aria-hidden
                            tabIndex={-1}
                            style={{
                              position: 'absolute', top: 0, left: 0,
                              width: `${100 / 0.32}%`, height: `${112 / 0.32}px`,
                              transform: 'scale(0.32)', transformOrigin: 'top left',
                              border: 0, pointerEvents: 'none', background: 'var(--bg-base)',
                            }}
                          />
                        ) : (
                          <ImageIcon size={26} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
                        )}
                        <span className="absolute top-2 right-2 text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-1"
                          style={{ background: isPublic ? 'rgba(16,185,129,0.16)' : 'rgba(148,163,184,0.18)', color: isPublic ? '#10B981' : 'var(--text-secondary)' }}>
                          {isPublic ? <><Globe size={9} />公开</> : <><Lock size={9} />未公开</>}
                        </span>
                        <span className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-1" style={{ background: 'rgba(0,0,0,0.5)', color: '#fff' }}>
                          <ExternalLink size={9} />打开
                        </span>
                      </div>
                      {/* 信息 */}
                      <div className="p-2.5 flex flex-col gap-1">
                        <div className="text-[12.5px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{s.title || '未命名站点'}</div>
                        <div className="flex items-center gap-2 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                          <span className="truncate flex-1">{s.userName}</span>
                          {typeof s.viewCount === 'number' && <span className="inline-flex items-center gap-0.5 shrink-0"><Eye size={9} />{s.viewCount}</span>}
                          {s.updatedAt && <span className="shrink-0">{relTime(s.updatedAt)}</span>}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
