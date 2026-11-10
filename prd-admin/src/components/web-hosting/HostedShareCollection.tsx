import { Component, useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight, FileCode2, Grid2X2, Layers3, List, Search, Star } from 'lucide-react';
import Threads from '@/components/reactbits/Threads';
import { useDataTheme } from '@/hooks/useDataTheme';
import type { ShareViewData } from '@/services/real/webPages';
import './HostedShareCollection.css';

const THREAD_COLORS: Record<'light' | 'dark', [number, number, number]> = {
  light: [0.16, 0.48, 0.38],
  dark: [0.35, 0.88, 0.69],
};

// Canvas is decoration. A browser without WebGL must still show the collection.
class BackgroundBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}

export function HostedShareBackground({ paused = false }: { paused?: boolean }) {
  const theme = useDataTheme();
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setAnimate(!motion.matches && !document.hidden);
    update();
    motion.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      motion.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return <div className="hosted-share-background" aria-hidden="true">
    <div className="hosted-share-threads">
      {animate && !paused
        ? <BackgroundBoundary><Threads color={THREAD_COLORS[theme]} amplitude={1.1} distance={0.2} /></BackgroundBoundary>
        : <svg className="hosted-share-still-threads" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
          {Array.from({ length: 24 }, (_, index) => <path key={index}
            d={`M -160 ${430 + index * 8} C 240 ${220 + index * 8}, 360 ${800 + index * 5}, 780 ${570 + index * 7} S 1200 ${200 + index * 8}, 1600 ${470 + index * 6}`} />)}
        </svg>}
    </div>
  </div>;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The demo and public collection use the same cards and member links. */
export default function HostedShareCollection({ data, collectionPath, action, paused = false, footer }: {
  data: Pick<ShareViewData, 'title' | 'description' | 'sites'> & Partial<Pick<ShareViewData, 'mainSiteId' | 'collectionNeedsUpdate'>>;
  collectionPath: string;
  action?: ReactNode;
  paused?: boolean;
  footer?: ReactNode;
}) {
  const [keyword, setKeyword] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [page, setPage] = useState(1);
  const query = keyword.trim().toLocaleLowerCase();
  const filtered = data.sites.filter(site => !query || `${site.title} ${site.description || ''}`.toLocaleLowerCase().includes(query));
  const pageCount = Math.max(1, Math.ceil(filtered.length / 12));
  const currentPage = Math.min(page, pageCount);
  const positions = new Map(data.sites.map((site, index) => [site.id, index + 1]));
  const visible = filtered.slice((currentPage - 1) * 12, currentPage * 12);
  const memberHref = (id: string) => `${collectionPath}?${new URLSearchParams({ siteId: id })}`;
  return <main className="hosted-share-collection">
    <HostedShareBackground paused={paused} />
    <section className="hosted-share-content" aria-label="站点合集">
      <div className="hosted-share-topbar">
        <div className="hosted-share-brand"><span><Layers3 size={20} strokeWidth={1.5} /></span>网页托管<i />共享合集</div>
        {action}
      </div>
      <header className="hosted-share-heading">
        <div className="hosted-share-heading-icon" aria-hidden="true"><Layers3 size={28} strokeWidth={1.4} /></div>
        <div className="hosted-share-title-row">
          <h1>{data.title || `${data.sites.length} 个站点合集`}</h1>
          {data.description && <p className="hosted-share-description">{data.description}</p>}
        </div>
      </header>
      {data.collectionNeedsUpdate && <p className="hosted-share-update-note" role="status">合集已有修改，本链接保留原成员快照。可在“管理合集”中重新生成分享，并停止旧链接。</p>}
      <section className="hosted-share-directory" aria-label="合集目录">
        <div className="hosted-share-directory-heading">
          <h2>全部内容 <span className="hosted-share-count">{data.sites.length}</span></h2>
          <div className="hosted-share-browse-controls">
            <label className="hosted-share-search"><Search size={14} /><input aria-label="查找合集文档" placeholder="查找标题或摘要" value={keyword} onChange={event => { setKeyword(event.target.value); setPage(1); }} /></label>
            <div className="hosted-share-view-switch"><button type="button" aria-label="网格视图" aria-pressed={view === 'grid'} onClick={() => setView('grid')}><Grid2X2 size={16} /></button><button type="button" aria-label="紧凑列表" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={17} /></button></div>
          </div>
        </div>
        <div className={`hosted-share-members${view === 'list' ? ' is-list' : ''}`}>
          {visible.map((site) => <a key={site.id} className={`hosted-share-member${site.id === data.mainSiteId ? ' is-main' : ''}`}
            href={memberHref(site.id)} target="_blank" rel="noopener noreferrer">
            <div className="hosted-share-card-cover">
              {site.coverImageUrl ? <img src={site.coverImageUrl} alt="" loading="lazy" /> : <>
                <div className="hosted-share-cover-corner" aria-hidden="true"><FileCode2 size={16} strokeWidth={1.5} /><span>{String(positions.get(site.id)).padStart(2, '0')}</span></div>
                <div className="hosted-share-paper" aria-hidden="true">
                  <FileCode2 size={16} strokeWidth={1.4} />
                  <span className="hosted-share-paper-title">{site.title}</span>
                  <span className="hosted-share-paper-lines" />
                  <span className="hosted-share-paper-page">{String(positions.get(site.id)).padStart(2, '0')}</span>
                </div>
              </>}
            </div>
            <div className="hosted-share-member-text">
              {site.id === data.mainSiteId && <span className="hosted-share-main-badge"><Star size={12} />主文档</span>}
              <h2>{site.title}</h2>
              {site.description && <p>{site.description}</p>}
              <div className="hosted-share-card-bottom">
                <div className="hosted-share-file-meta">{site.fileCount} 个文件<span>·</span>{formatSize(site.totalSize)}</div>
                <ArrowUpRight className="hosted-share-open-icon" size={17} aria-label="在新标签页打开阅读页" />
              </div>
            </div>
          </a>)}
        </div>
        {!filtered.length && <div className="hosted-share-empty" role="status">没有找到匹配的文档，试试其他关键词。</div>}
        {(pageCount > 1 || query) && <div className="hosted-share-pager"><button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</button><span>第 {currentPage} / {pageCount} 页 · {filtered.length} 份可见文档</span><button type="button" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button></div>}
      </section>
      <footer className="hosted-share-footer">{footer ?? '网页托管 · 内容与讨论，留在同一个阅读页'}</footer>
    </section>
  </main>;
}
