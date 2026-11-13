import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BookOpen, ChevronRight, Search, X } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getHostedCollection, readHostedCollectionShare } from '@/services/real/hostedCollections';
import type { HostedCollectionItem, HostedCollectionSection, HostedCollectionView } from '@/services/contracts/hostedCollections';
import { CollectionShell, collectionDate } from './CollectionShell';
import { HostedCollectionManage } from './HostedCollectionManage';
import { HostedCollectionDocument } from './HostedCollectionDocument';

export default function HostedCollectionPage() {
  const { collectionId, token } = useParams();
  return <HostedCollectionReader key={token ? `share:${token}` : `collection:${collectionId}`} />;
}

function HostedCollectionReader() {
  const { collectionId, token } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<HostedCollectionView>();
  const [error, setError] = useState('');
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [password, setPassword] = useState('');
  const [submittedPassword, setSubmittedPassword] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [active, setActive] = useState<string>();
  const [last, setLast] = useState<string>();
  const [manage, setManage] = useState(false);
  const loadGeneration = useRef(0);
  const main = useRef<HTMLElement>(null);
  const rail = useRef<HTMLElement>(null);
  const load = useCallback(async () => {
    if (!collectionId && !token) return;
    const generation = ++loadGeneration.current;
    const result = token ? await readHostedCollectionShare(token, submittedPassword) : await getHostedCollection(collectionId!);
    if (generation !== loadGeneration.current) return;
    if (result.success) { setData(result.data); setError(''); setPasswordRequired(false); }
    else { setError(result.error.message); setPasswordRequired(!!token && result.error.code === 'UNAUTHORIZED'); }
  }, [collectionId, token, submittedPassword]);
  useEffect(() => {
    const generations = loadGeneration;
    void load();
    return () => { generations.current++; };
  }, [load]);
  useEffect(() => {
    if (!collectionId) return;
    try { setLast(localStorage.getItem(`hosted-collection:last:${collectionId}`) ?? undefined); } catch { /* 阅读仍可继续 */ }
  }, [collectionId]);
  if (!data) return <CollectionShell name="合集">{error ? <div className="hc-boundary" role="alert"><h1>合集暂时无法打开</h1><p>{error}</p>{token && passwordRequired && <form onSubmit={e => { e.preventDefault(); setSubmittedPassword(password); }}><label>访问密码<input className="field" type="password" value={password} onChange={e => setPassword(e.target.value)} /></label><button className="btn pri">打开合集</button></form>}<button className="btn" onClick={() => void load()}>重试</button><Link className="btn ghost" to="/web-pages">返回网页托管</Link></div> : <MapSectionLoader text="正在读取合集…" />}</CollectionShell>;
  const collection = data.collection;
  const byId = new Map(data.items.map(item => [item.id, item]));
  const members = collection.siteIds.map(id => byId.get(id)).filter((item): item is HostedCollectionItem => !!item);
  const primary = byId.get(collection.mainSiteId);
  const other = members.filter(item => item.id !== collection.mainSiteId);
  const explicit = collection.sections.map(section => ({ ...section, siteIds: section.siteIds.filter(id => id !== collection.mainSiteId && byId.has(id)) }));
  const assigned = new Set(explicit.flatMap(s => s.siteIds));
  const unassigned = other.filter(item => !assigned.has(item.id));
  const groups: HostedCollectionSection[] = [...explicit.filter(s => s.siteIds.length), ...(unassigned.length ? [{ id: 'other', title: explicit.length ? '其他文档' : '文档', siteIds: unassigned.map(item => item.id) }] : [])];
  const matching = (item: HostedCollectionItem) => !query || `${item.title} ${item.author ?? ''} ${item.summary ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const hits = members.filter(matching);
  const hasRail = members.length >= 12;
  const isSmall = members.length <= 3;
  const paginated = members.length >= 90 && !query;
  const visible = new Set((query ? hits : paginated ? other.slice(page * 30, (page + 1) * 30) : other).map(item => item.id));
  if (primary && matching(primary)) visible.add(primary.id);
  const locate = (id: string) => {
    const index = other.findIndex(item => item.id === id);
    if (members.length >= 90 && index >= 0) setPage(Math.floor(index / 30));
    const item = byId.get(id);
    if (item && !matching(item)) setQuery('');
  };
  const open = (id: string) => { setActive(id); setLast(id); locate(id); try { localStorage.setItem(`hosted-collection:last:${collection.id}`, id); } catch { /* 阅读仍可继续 */ } main.current?.scrollTo(0, 0); };
  const back = () => { setActive(undefined); if (last) locate(last); main.current?.scrollTo(0, 0); requestAnimationFrame(() => rail.current?.querySelector(`[data-member="${CSS.escape(last ?? '')}"]`)?.scrollIntoView({ block: 'nearest' })); };
  const search = <label className="hc-search"><Search size={14} /><input aria-label="在合集中查找" placeholder="查找标题、作者、摘要" value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} />{query && <button aria-label="清除查找" onClick={() => setQuery('')}><X size={12} /></button>}</label>;
  const row = (item: HostedCollectionItem, primaryRow = false) => <button key={item.id} data-member={item.id} className={`row ${primaryRow ? 'primary-row' : ''} ${active === item.id ? 'cur' : ''} ${item.unavailable ? 'gone' : ''} ${last === item.id ? 'last' : ''}`} onClick={() => open(item.id)} title={item.title}><span className="num">{primaryRow ? '主' : String(collection.siteIds.indexOf(item.id) + 1).padStart(2, '0')}</span><span><span className="tt">{item.title}</span><span className="sub">{item.author}{item.author && ' · '}{item.type}<span className="hc-row-date"> · {collectionDate(item.updatedAt)}</span></span></span><span>{primaryRow && <span className="tag t-m">主文档</span>}{item.unavailable && <span className="tag t-x">不可用</span>}{!primaryRow && last === item.id && <span className="tag t-m">刚读过</span>}</span></button>;
  const noHits = <div className="hc-no-hits"><strong>没有找到「{query}」</strong><p>已在本合集 {members.length} 份文档的标题、作者和摘要中查找。正文内容不在查找范围内。</p><div><button className="btn" onClick={() => setQuery('')}>清除查找</button><Link className="btn ghost" to={`/web-pages?keyword=${encodeURIComponent(query)}`}>在全部网页托管中查找</Link></div></div>;
  return <CollectionShell name={collection.name} shareHref={data.canManage ? `/web-pages/collections/${collection.id}/share` : undefined} onManage={data.canManage ? () => setManage(true) : undefined}>
    {error && <div className="hc-error" role="alert">{error}<button className="btn ghost" onClick={() => void load()}>重试</button></div>}
    <div className={`hc-layout ${hasRail ? 'has-rail' : 'small'}`}>
      {hasRail && <aside className="panel hc-rail" aria-label="合集目录"><div className="hc-rail-head"><div className="hc-between"><strong>目录</strong><span className="mono">{members.length} 份 · 作者排序</span></div>{search}{members.length >= 30 && <div className="hc-chips">{groups.map(g => <button key={g.id} className="chip" onClick={() => { setQuery(''); setPage(members.length >= 90 ? Math.floor(other.findIndex(item => item.id === g.siteIds[0]) / 30) : 0); requestAnimationFrame(() => rail.current?.querySelector(`[data-group="${CSS.escape(g.id)}"]`)?.scrollIntoView({ block: 'start' })); }}>{g.title} <span className="mono">{g.siteIds.length}</span></button>)}</div>}</div><nav className="scroll hc-rail-body" ref={rail}>{primary && visible.has(primary.id) && matching(primary) && <>{row(primary, true)}<div className="hc-divider" /></>}{groups.filter(group => group.siteIds.some(id => visible.has(id))).map((group) => <div key={group.id} data-group={group.id}><div className="mono hc-group-title"><span>{String(groups.indexOf(group) + 1).padStart(2, '0')} {group.title}</span><span>{group.siteIds.filter(id => visible.has(id)).length}</span></div>{group.siteIds.filter(id => visible.has(id)).map(id => byId.get(id)).filter((item): item is HostedCollectionItem => !!item).map(item => row(item))}</div>)}{query && !hits.length && noHits}</nav>{paginated && <div className="hc-pager"><span className="mono">第 {page * 30 + 2}–{Math.min((page + 1) * 30 + 1, members.length)} 篇 / 共 {members.length}</span><div>{Array.from({ length: Math.ceil(other.length / 30) }, (_, i) => <button className="pg" aria-current={page === i} key={i} onClick={() => setPage(i)}>{i + 1}</button>)}</div></div>}{query && <div className="mono hc-pager">找到 {hits.length} 篇 · 跨全部页</div>}</aside>}
      <main className="scroll hc-main" ref={main}>
        {active ? <HostedCollectionDocument key={active} item={byId.get(active)} collection={collection} token={token} password={submittedPassword} onBack={back} onNavigate={open} onManage={data.canManage && !token ? () => setManage(true) : undefined} items={members} /> : <div className={isSmall ? 'wrap-s' : 'wrap-l'}>
          <section className="hc-intro"><div className="mono hc-intro-mobile-meta">合集 · {members.length} 份 · {collection.ownerName}</div><div className="mono hc-meta"><span>合集</span><span>{members.length} 份文档</span>{collection.ownerName && <span>作者 {collection.ownerName}</span>}{collection.updatedAt && <span>更新于 {collectionDate(collection.updatedAt)}</span>}</div><h1 className="serif">{collection.name}</h1>{collection.description && <p>{collection.description}</p>}<div className="hc-read-actions">{primary && <button className="btn pri" onClick={() => open(primary.id)}><BookOpen size={15} />从主文档开始阅读</button>}{last && byId.has(last) && <button className="btn" onClick={() => open(last)}>继续 · {byId.get(last)?.title}</button>}</div></section>
          {primary && <section className={`panel hc-primary ${isSmall ? 'pc-s' : 'pc-l'}`}><div className="hc-primary-copy"><div className="hc-meta"><span className="tag t-m">主文档</span><span className="mono hc-primary-desktop-meta">{primary.type} · v{primary.versionNumber ?? 1} · {primary.author} · {collectionDate(primary.updatedAt)}</span><span className="mono hc-primary-mobile-meta">v{primary.versionNumber ?? 1} · {Math.max(1, Math.ceil((primary.characterCount ?? 0) / 400))} 分钟</span></div><h2 className="serif"><button className="lnk" onClick={() => open(primary.id)}>{primary.title}</button></h2><p className="serif">{primary.summary || `正文开头：${primary.excerpt ?? ''}`}</p><div className="hc-primary-metrics"><span>批注 {primary.annotationCount ?? 0}</span><span>讨论 {primary.discussionCount ?? 0}</span><span>{primary.unavailable ? '不可用' : `约 ${Math.max(1, Math.ceil((primary.characterCount ?? 0) / 400))} 分钟读完`}</span></div><button className="btn pri hc-mobile-read" onClick={() => open(primary.id)}><BookOpen size={15} />从主文档开始阅读</button>{last && byId.has(last) && <button className="btn hc-mobile-read" onClick={() => open(last)}>继续 · {String(collection.siteIds.indexOf(last) + 1).padStart(2, '0')}</button>}</div><div className="hc-primary-outline"><div className="mono">主文档目录</div>{primary.headings?.map((heading, i) => <button className="lnk" key={heading + i} onClick={() => open(primary.id)}><span className="mono">{String(i + 1).padStart(2, '0')}</span>{heading}</button>)}</div></section>}
          <div className="hc-mobile-search">{search}</div>
          <section className="hc-mobile-directory">{query && !hits.length ? noHits : groups.map((group, i) => <details key={group.id} open={!!query || i < 2}><summary><span>{String(i + 1).padStart(2, '0')} {group.title}</span><span>{group.siteIds.filter(id => byId.has(id) && matching(byId.get(id)!)).length}</span></summary>{group.siteIds.map(id => byId.get(id)).filter((item): item is HostedCollectionItem => !!item && matching(item)).map(item => row(item))}</details>)}</section>
          {query && !hasRail ? (hits.length ? <section className="hc-small-list">{hits.map(item => row(item))}</section> : noHits) : !hasRail ? <section className="hc-small-list"><div className="hc-section-header"><strong>继续阅读</strong><span className="mono">按作者顺序</span></div>{members.length === 1 && <p className="hc-single-note">此合集目前只有主文档。作者可在「管理合集」中添加成员。</p>}{other.map(item => <button className="lnk hc-small-row" key={item.id} onClick={() => open(item.id)}><span className="mono">{String(collection.siteIds.indexOf(item.id) + 1).padStart(2, '0')}</span><span><strong className="serif">{item.title}</strong>{item.summary && <span className="hc-summary">{item.summary}</span>}<span className="mono hc-meta">{item.author} · {item.type}<span className="hc-row-date"> · {collectionDate(item.updatedAt)}</span></span></span><ChevronRight size={16} /></button>)}</section> : <section className="hc-chapters"><div className="hc-section-header"><strong>章节</strong><span className="mono">{groups.length} 个章节 · 由作者划分</span></div><div className="hc-chapter-grid">{groups.map(group => <section key={group.id}><div className="hc-between"><strong>{group.title}</strong><button className="lnk mono" onClick={() => { setQuery(''); const index = other.findIndex(item => item.id === group.siteIds[0]); setPage(members.length >= 90 ? Math.floor(index / 30) : 0); requestAnimationFrame(() => rail.current?.querySelector(`[data-group="${CSS.escape(group.id)}"]`)?.scrollIntoView({ block: 'start' })); }}>全部 {group.siteIds.length} 篇</button></div>{group.siteIds.slice(0, 4).map(id => byId.get(id)).filter((item): item is HostedCollectionItem => !!item).map(item => <button className="lnk hc-chapter-link" key={item.id} onClick={() => open(item.id)}><span className="mono">{String(collection.siteIds.indexOf(item.id) + 1).padStart(2, '0')}</span><span>{item.title}{item.unavailable ? '（不可用）' : ''}</span></button>)}</section>)}</div></section>}
          {!!data.related?.items.filter(item => !collection.siteIds.includes(item.id)).length && <section className="hc-related"><div className="hc-section-header"><strong>合集之外的关联</strong><span className="mono">不属于本合集 · 仅供参考</span></div><div className="hc-related-grid">{[true, false].map(manual => <div key={String(manual)}>{data.related!.items.filter(item => !collection.siteIds.includes(item.id) && item.isManual === manual).map(item => <Link className="hc-related-row" key={item.id} to={item.href}><span className={`tag ${item.isManual ? 't-l' : 't-c'}`}>{item.isManual ? '手动关联' : '评论引用'}</span><span>{item.title}</span><span className="mono">{item.mentions?.[0]?.authorName ?? collectionDate(item.updatedAt)}</span></Link>)}</div>)}</div></section>}
        </div>}
      </main>
    </div>
    {manage && <HostedCollectionManage data={data} onClose={() => setManage(false)} onSaved={next => { setData(next); setManage(false); if (active && !next.collection.siteIds.includes(active)) setActive(undefined); navigate(`/web-pages/collections/${next.collection.id}`, { replace: true }); }} />}
  </CollectionShell>;
}
