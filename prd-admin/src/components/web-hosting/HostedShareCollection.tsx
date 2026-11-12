import { Component, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { ArrowLeft, BookOpen, ChevronLeft, ChevronRight, Moon, Search, Waves } from 'lucide-react';
import Threads from '@/components/reactbits/Threads';
import { useDataTheme } from '@/hooks/useDataTheme';
import type { SharedSiteInfo, ShareViewData } from '@/services/real/webPages';
import { HostedCollectionReader, type CollectionReaderParts, type CollectionReaderRenderer } from './HostedCollectionReader';
import './HostedShareCollection.css';

const THREAD_COLORS: Record<'light' | 'dark', [number, number, number]> = {
  light: [0.19, 0.27, 0.77], dark: [0.56, 0.63, 1],
};
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
    update(); motion.addEventListener('change', update); document.addEventListener('visibilitychange', update);
    return () => { motion.removeEventListener('change', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  return <div className="hosted-share-background" aria-hidden="true"><div className="hosted-share-threads">
    {animate && !paused ? <BackgroundBoundary><Threads color={THREAD_COLORS[theme]} amplitude={0.6} distance={0.2} speed={0.25} /></BackgroundBoundary>
      : <svg className="hosted-share-still-threads" viewBox="0 0 1440 270" preserveAspectRatio="none">{Array.from({ length: 28 }, (_, i) => <path key={i} d={`M -60 ${25 + i * 7} C 380 ${85 + i * 4}, 850 ${-25 + i * 9}, 1500 ${15 + i * 8}`} />)}</svg>}
  </div></div>;
}
export interface LedgerSite extends SharedSiteInfo {
  /** Presentation metadata supplied by a caller; production never fills missing fields with demo data. */
  displayMeta?: string;
  documentTypeLabel?: string;
  section?: string;
  unavailable?: boolean;
  readingMeta?: string;
  toc?: string[];
}
export interface LedgerCollectionData extends Pick<ShareViewData, 'title' | 'description'> {
  sites: LedgerSite[];
  mainSiteId?: string;
  collectionNeedsUpdate?: boolean;
  collectionId?: string;
  createdByName?: string;
  createdAt?: string;
  updatedLabel?: string;
  mobileDescription?: string;
}
function formatSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export default function HostedShareCollection({ data, collectionPath, action, controls, paused: initialPaused = false, footer,
  selectedSiteId, onSelect, reader, related, sample = false }: {
  data: LedgerCollectionData; collectionPath: string; action?: ReactNode; controls?: ReactNode;
  paused?: boolean; footer?: ReactNode; selectedSiteId?: string | null;
  onSelect?: (id: string | null) => void; reader?: ReactNode | ((render: CollectionReaderRenderer) => ReactNode); related?: ReactNode; sample?: boolean;
}) {
  const theme = useDataTheme();
  const [paused, setPaused] = useState(initialPaused);
  const [keyword, setKeyword] = useState('');
  const [section, setSection] = useState('');
  const [page, setPage] = useState(1);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set());
  const mainRef = useRef<HTMLDivElement>(null);
  const query = keyword.trim().toLocaleLowerCase();
  const main = data.sites.find(site => site.id === data.mainSiteId);
  const selected = data.sites.find(site => site.id === selectedSiteId);
  const large = data.sites.length > 3;
  const positions = new Map(data.sites.map((site, index) => [site.id, index + 1]));
  const sections = [...new Set(data.sites.filter(site => site.id !== main?.id).map(site => site.section).filter((x): x is string => !!x))];
  const filtered = data.sites.filter(site => (!section || site.section === section) && (!query || `${site.title} ${site.description || ''} ${site.displayMeta || ''}`.toLocaleLowerCase().includes(query)));
  const pageCount = Math.max(1, Math.ceil(filtered.length / 30));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * 30, currentPage * 30);
  const href = (id: string | null) => { const [pathname, search = ''] = collectionPath.split('?'); const params = new URLSearchParams(search); if (id) params.set('siteId', id); else params.delete('siteId'); return pathname + (params.size ? `?${params}` : ''); };
  const navigate = (event: MouseEvent<HTMLAnchorElement>, id: string | null) => {
    if (!onSelect || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault(); onSelect(id);
  };
  const meta = (site: LedgerSite) => site.displayMeta || `${site.fileCount} 个文件 · ${formatSize(site.totalSize)}`;
  useEffect(() => { mainRef.current?.scrollTo?.({ top: 0 }); }, [selectedSiteId]);
  const search = <label className="ledger-search"><Search size={14} /><input aria-label="查找合集文档" placeholder={sample ? '查找标题、作者、摘要' : '查找标题或摘要'} value={keyword} onChange={event => { setKeyword(event.target.value); setPage(1); }} />{query && <button onClick={() => { setKeyword(''); setPage(1); }} aria-label="清除查找">清除</button>}</label>;
  const mainLink = main && <a className="ledger-button is-primary" href={href(main.id)} onClick={event => navigate(event, main.id)}><BookOpen size={14} />从主文档开始阅读</a>;
  const member = (site: LedgerSite, summary = false) => <a key={site.id} className={`hosted-share-member ledger-row${site.id === main?.id ? ' is-main' : ''}${selected?.id === site.id ? ' is-current' : ''}${site.unavailable ? ' is-unavailable' : ''}${summary ? ' is-summary' : ''}`}
    href={href(site.id)} onClick={event => navigate(event, site.id)} aria-current={selected?.id === site.id ? 'page' : undefined}>
    <span className="ledger-number">{site.id === main?.id ? '主' : String(positions.get(site.id)).padStart(2, '0')}</span>
    <span className="ledger-row-content"><span className="ledger-row-title">{site.title}</span>{summary && site.description && <span className="ledger-row-description">{site.description}</span>}<span className="ledger-row-meta">{meta(site)}</span></span>
    {site.unavailable ? <span className="ledger-tag is-danger">不可用</span> : site.id === main?.id ? <span className="ledger-tag">主文档</span> : summary ? <ChevronRight size={16} /> : null}
  </a>;
  const pager = (pageCount > 1 || query) && <div className="ledger-pager"><button aria-label="上一页目录" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={14} /></button><span>第 {currentPage} / {pageCount} 页 · {filtered.length} 份</span><button aria-label="下一页目录" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}><ChevronRight size={14} /></button></div>;
  const directory = <aside className="ledger-directory" aria-label="合集目录">
    <div className="ledger-directory-head"><div><strong>目录</strong><span className="ledger-mono">{data.sites.length} 份 · 作者排序</span></div>{search}{sections.length > 0 && <div className="ledger-chips">{sections.map(label => <button key={label} aria-pressed={section === label} onClick={() => { setSection(section === label ? '' : label); setPage(1); }}>{label} {data.sites.filter(site => site.section === label).length}</button>)}</div>}</div>
    <div className="ledger-directory-scroll">{!query && !section && currentPage === 1 && main && <div className="ledger-pinned">{member(main)}</div>}
      {visible.filter(site => query || section || currentPage > 1 || site.id !== main?.id).map((site, index, list) => <div key={site.id}>{site.section && (index === 0 || list[index - 1].section !== site.section) && <button className="ledger-group-label" aria-expanded={!collapsedSections.has(site.section)} onClick={() => setCollapsedSections(current => { const next = new Set(current); if (next.has(site.section!)) next.delete(site.section!); else next.add(site.section!); return next; })}><span>{String(sections.indexOf(site.section) + 1).padStart(2, '0')} {site.section}</span><span>{data.sites.filter(item => item.section === site.section).length}</span></button>}{(!site.section || !collapsedSections.has(site.section)) && member(site)}</div>)}
      {!filtered.length && <div className="ledger-empty" role="status"><strong>没有找到匹配文档</strong><span>试试其他关键词，或清除查找。</span><button className="ledger-button" onClick={() => { setKeyword(''); setSection(''); setPage(1); }}>清除查找，回到目录</button></div>}
    </div>{pager}
  </aside>;
  const renderReader = (parts: CollectionReaderParts) => <HostedCollectionReader title={selected?.title ?? ''}
    heading={<div className="ledger-reader-heading"><a className="ledger-button is-ghost" href={collectionPath} onClick={event => navigate(event, null)}><ArrowLeft size={14} />返回目录 <span className="ledger-mono">{selected?.id === main?.id ? '主' : String(selected ? positions.get(selected.id) : '').padStart(2, '0')}</span></a>
      <span className="ledger-mono ledger-reader-address" title={selected ? new URL(href(selected.id), window.location.origin).href : ''}>{selected ? new URL(href(selected.id), window.location.origin).href : ''}</span></div>}
    metadata={<>{selected?.id === main?.id && <span className="ledger-tag">主文档</span>}<span>第 {selected ? positions.get(selected.id) : '—'} / {data.sites.length} 篇 · {selected?.documentTypeLabel ?? selected?.wrappedAssetType?.toUpperCase() ?? selected?.entryFile.split('.').pop()?.toUpperCase()}</span></>}
    navigation={selected && <nav className="ledger-reading-pager" aria-label="连续阅读">{[-1, 1].map(step => { const target = data.sites[data.sites.findIndex(item => item.id === selected!.id) + step]; return target ? <a key={step} href={href(target.id)} onClick={event => navigate(event, target.id)}><span>{step < 0 ? '上一篇' : '下一篇'} {String(positions.get(target.id)).padStart(2, '0')}</span><strong>{target.title}</strong></a> : <span key={step} />; })}</nav>}
    related={<><div className="ledger-relation-group"><h2>本合集</h2><a href={collectionPath} onClick={event => navigate(event, null)}><span className="ledger-tag">成员</span>第 {selected ? positions.get(selected.id) : '—'} / {data.sites.length} 篇 · 打开目录</a></div>
      {parts.related ? parts.related({ memberIds: data.sites.map(site => site.id), collectionId: data.collectionId }) : related}</>}
    mobileDirectory={<a href={collectionPath} onClick={event => navigate(event, null)}>目录</a>}
    mobileNext={selected && data.sites[positions.get(selected.id)!] ? <a href={href(data.sites[positions.get(selected.id)!].id)} onClick={event => navigate(event, data.sites[positions.get(selected.id)!].id)}>下一篇 {String(positions.get(selected.id)! + 1).padStart(2, '0')}</a> : <span>已到最后一篇</span>}
    parts={parts} />;
  const remainder = data.sites.filter(site => site.id !== main?.id);
  const groups = sections.length ? sections : ['文档目录'];
  return <main className={`hosted-share-collection hosted-ledger${large ? ' is-large' : ' is-small'}${selectedSiteId ? ' is-reading' : ''}${sample ? ' is-sample' : ''}`}>
    <HostedShareBackground paused={paused} />
    <header className="ledger-topbar"><div className="ledger-breadcrumb"><svg viewBox="0 0 20 20" width="20" height="20" fill="none" aria-hidden="true"><rect x="2" y="2" width="16" height="16" rx="3" stroke="currentColor" strokeWidth="1.5" /><path d="M5 13V7l5 4 5-4v6" stroke="currentColor" strokeWidth="1.5" /></svg><span>网页托管</span><i>/</i><a href={collectionPath} onClick={event => navigate(event, null)}>合集</a><i>/</i><strong>{data.title || `${data.sites.length} 个站点合集`}</strong>{sample && <span className="ledger-tag is-reference">示例数据</span>}</div>
      <div className="ledger-header-actions">{controls}<button className="ledger-button is-ghost ledger-motion-toggle" aria-pressed={!paused} onClick={() => setPaused(!paused)}><Waves size={15} /><span>{paused ? '静止' : '动态'}</span></button><button className="ledger-button is-ghost" aria-label={theme === 'light' ? '切换深色' : '切换浅色'} onClick={() => { document.documentElement.dataset.theme = theme === 'light' ? 'dark' : 'light'; }}><Moon size={15} /><span>{theme === 'light' ? '浅色' : '深色'}</span></button>{action && <span className="ledger-header-divider" aria-hidden="true" />}{action}</div>
    </header>
    <div className="ledger-workspace">{large && directory}<div className="ledger-main" ref={mainRef}>
      {data.collectionNeedsUpdate && <p className="ledger-update-note" role="status">合集已有修改，本链接保留原成员快照。可在“管理合集”中重新生成分享，并停止旧链接。</p>}
      {selectedSiteId ? selected && !selected.unavailable ? <>{typeof reader === 'function' ? reader(renderReader) : renderReader({ content: reader, metadata: meta(selected) })}</>
          : <div className="ledger-empty" role="alert"><strong>{selected?.unavailable ? '文档暂不可用，请联系分享者' : '文档不存在或不在这条分享中'}</strong><a href={collectionPath} onClick={event => navigate(event, null)}>返回合集目录</a></div>
        : <><section className="ledger-intro"><div className="ledger-meta"><span>合集</span><span>{data.sites.length} 份文档</span>{data.createdByName && <span>作者 {data.createdByName}</span>}{data.updatedLabel ? <span>更新于 {data.updatedLabel}</span> : data.createdAt && <span>分享于 {new Date(data.createdAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</span>}</div><h1>{data.title || `${data.sites.length} 个站点合集`}</h1>{data.description && <p className={data.mobileDescription ? 'ledger-desktop-description' : undefined}>{data.description}</p>}{data.mobileDescription && <p className="ledger-mobile-description">{data.mobileDescription}</p>}<div className="ledger-desktop-start">{mainLink}</div></section>
          {main ? <section className={`ledger-main-document${main.toc?.length ? ' has-toc' : ''}`} aria-label="主文档概览"><div><div className="ledger-reading-meta"><span className="ledger-tag">主文档</span><span>{meta(main)}</span></div><h2><a href={href(main.id)} onClick={event => navigate(event, main.id)}>{main.title}</a></h2>{main.description && <p>{main.description}</p>}{main.readingMeta && <div className="ledger-mono">{main.readingMeta}</div>}<div className="ledger-mobile-start">{mainLink}</div></div>{main.toc && <div className="ledger-main-toc"><span>主文档目录</span>{main.toc.map((title, index) => <a key={title} href={href(main.id)} onClick={event => navigate(event, main.id)}><span className="ledger-number">{String(index + 1).padStart(2, '0')}</span>{title}</a>)}</div>}</section>
            : <div className="ledger-unset-main"><BookOpen size={18} /><p>尚未指定可用的主文档，请按目录阅读；作者可在管理中设置。</p></div>}
          {!large && <div className="ledger-small-search">{search}</div>}
          {remainder.length > 0 && <section className={`ledger-overview-lists${large ? ' is-large' : ''}`} aria-label="全部文档"><div className="ledger-section-heading"><h2>{sections.length ? '章节' : '继续阅读'}</h2><span>{sections.length ? `${sections.length} 个章节 · 由作者划分` : '按作者顺序'}</span></div>
            {large ? <div className="ledger-section-grid">{groups.map(label => { const items = sections.length ? remainder.filter(site => site.section === label) : remainder; return <section key={label}><div className="ledger-section-heading"><h3>{label}</h3><button onClick={() => { setSection(sections.length ? label : ''); setPage(1); setKeyword(''); }}>{sections.length ? `全部 ${items.length} 篇` : `${items.length} 篇`}</button></div>{items.slice(0, sections.length ? 4 : 12).map(site => <a key={site.id} href={href(site.id)} onClick={event => navigate(event, site.id)}><span className="ledger-number">{String(positions.get(site.id)).padStart(2, '0')}</span><span>{site.title}{site.unavailable && '（不可用）'}</span></a>)}</section>; })}</div>
              : <div className="ledger-small-members">{filtered.filter(site => site.id !== main?.id).map(site => member(site, true))}{!filtered.length && <div className="ledger-empty" role="status">没有找到匹配文档，试试其他关键词。</div>}</div>}
          </section>}{related && <section className="ledger-related"><div className="ledger-section-heading"><h2>{sample ? '合集之外的关联' : '关联与引用'}</h2><span>{sample ? '不属于本合集 · 仅供参考' : '按现有访问权限查看'}</span></div>{related}</section>}
          {!data.sites.length && <div className="ledger-empty"><BookOpen size={24} /><strong>还没有可阅读的文档</strong><span>请联系分享者补充内容。</span></div>}
        </>}{footer && <footer className="hosted-share-footer">{footer}</footer>}
    </div></div>
  </main>;
}
