import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BookOpen, FilePlus, Search, Share2, SlidersHorizontal, X, ArrowUp, ArrowDown, Star } from 'lucide-react';
import { apiRequest } from '@/services/real/apiClient';
import { createShareLink, listShareLinks, revokeShareLink, setPrimaryEntry, updateDocumentEntryReal, updateDocumentStoreReal } from '@/services/real/documentStore';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import type { DocumentStore, DocumentEntry, DocumentStoreShareLink } from '@/services/contracts/documentStore';
import type { WritingTemplate } from '@/services/contracts/writing';
import { WritingThemeButton } from './WritingWorkspacePage';
import { writingKnowledgeHref } from './writingView';
import './writing.css';

interface CollectionData { store: DocumentStore; entries: DocumentEntry[]; templates: WritingTemplate[]; canEdit: boolean }
export default function WritingCollectionPage() {
  const { storeId = '' } = useParams();
  const [data, setData] = useState<CollectionData>();
  const [error, setError] = useState('');
  const [keyword, setKeyword] = useState('');
  const [type, setType] = useState('');
  const [dialog, setDialog] = useState<'manage' | 'share'>();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [shares, setShares] = useState<DocumentStoreShareLink[]>([]);
  const load = useCallback(async () => {
    const res = await apiRequest<CollectionData>(`/api/document-store/stores/${encodeURIComponent(storeId)}/writing-collection`);
    if (res.success) { setData(res.data); setName(res.data.store.name); setDescription(res.data.store.description ?? ''); setError(''); }
    else setError(res.error.message);
  }, [storeId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (dialog !== 'share') return;
    void listShareLinks(storeId).then(res => { if (res.success) setShares(res.data.items); else setError(res.error.message); });
  }, [dialog, storeId]);
  async function mutate(action: () => Promise<{ success: boolean; error?: { message: string } | null }>) {
    if (busy) return;
    setBusy(true); setError('');
    try { const res = await action(); if (!res.success) throw new Error(res.error?.message ?? '保存失败'); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(false); }
  }
  if (!data) return <div className="writing-reader writing-root">{error ? <div className="writing-error" role="alert">{error}<button className="btn" onClick={() => void load()}>重试</button></div> : <MapSectionLoader text="正在读取合集…" />}</div>;
  const href = (e: DocumentEntry) => e.metadata?.writing_template ? `/document-store/${storeId}/write/${e.id}/read` : writingKnowledgeHref(storeId, e.id);
  const label = (e: DocumentEntry) => data.templates.find(t => t.id === e.metadata?.writing_template)?.type ?? '文档';
  const entries = data.entries.filter(e => (!keyword || `${e.title} ${e.summary ?? ''}`.toLowerCase().includes(keyword.toLowerCase())) && (!type || e.metadata?.writing_template === type));
  const primary = data.entries.find(e => e.id === data.store.primaryEntryId) ?? data.entries.find(e => e.metadata?.writing_template === 'overview');
  const groups = [...new Set(entries.map(e => e.category || '文档'))];
  async function move(entry: DocumentEntry, delta: number) {
    const from = data!.entries.findIndex(e => e.id === entry.id); const to = from + delta;
    if (to < 0 || to >= data!.entries.length) return;
    const next = [...data!.entries]; [next[from], next[to]] = [next[to], next[from]];
    await mutate(async () => {
      for (let i = 0; i < next.length; i++) { const res = await updateDocumentEntryReal(next[i].id, { sortOrder: i }); if (!res.success) return res; }
      return { success: true };
    });
  }
  return <div className="writing-reader writing-root" data-writing-page="collection"><header className="writing-top"><div className="writing-breadcrumb"><Link to="/document-store"><BookOpen size={19} /></Link><Link to="/document-store">团队知识库</Link><span>/</span><span>合集</span><span>/</span><span>{data.store.name}</span></div><div className="writing-actions"><WritingThemeButton />{data.canEdit && <><button className="btn" onClick={() => setDialog('share')}><Share2 size={13} />分享</button><button className="btn" onClick={() => setDialog('manage')}><SlidersHorizontal size={13} />管理合集</button></>}</div></header>{error && <div className="writing-banner danger" role="alert">{error}</div>}<div className="writing-collection-layout"><aside className="panel scroll writing-collection-directory"><div className="writing-section-heading"><strong>目录</strong><span className="cap">{data.entries.length} 份 · 作者排序</span></div><label className="writing-collection-search"><Search size={13} /><input className="field" aria-label="查找文档" placeholder="查找标题、摘要" value={keyword} onChange={e => setKeyword(e.target.value)} /></label><div className="writing-type-filters"><button className={`role ${type === '' ? 'on' : ''}`} onClick={() => setType('')}>全部 {data.entries.length}</button>{data.templates.filter(t => data.entries.some(e => e.metadata?.writing_template === t.id)).map(t => <button className="role" aria-checked={type === t.id} onClick={() => setType(type === t.id ? '' : t.id)} key={t.id}>{t.type}</button>)}</div>{primary && <Link className="writing-collection-primary-link" to={href(primary)}><span className="tag t-m">主文档</span><strong>{primary.title}</strong></Link>}{entries.map((e, i) => <Link className="writing-collection-nav" key={e.id} to={href(e)}><span className="mono">{String(i + 1).padStart(2, '0')}</span><span><strong>{e.title}</strong><span className="hint writing-block">{label(e)} · {new Date(e.updatedAt).toLocaleDateString('zh-CN')}</span></span></Link>)}{!entries.length && <p className="hint">{keyword || type ? '没有匹配的文档' : '合集还没有已发布文档'}</p>}</aside><main className="scroll writing-collection-main"><div className="cap">合集 · {data.entries.length} 份文档</div><h1>{data.store.name}</h1>{data.store.description && <p className="writing-collection-description">{data.store.description}</p>}<div className="writing-actions">{primary && <Link className="btn pri" to={href(primary)}><BookOpen size={13} />从主文档开始阅读</Link>}{data.canEdit && <Link className="btn" to={`/document-store/${storeId}/write`}><FilePlus size={13} />按模版成文</Link>}</div>{primary && <section className="panel writing-collection-hero"><span className="tag t-m">主文档</span><h2><Link to={href(primary)}>{primary.title}</Link></h2><p>{primary.metadata?.writing_summary_origin === 'body' && '正文开头：'}{primary.summary || '请打开文档查看内容。'}</p></section>}<div className="writing-section-heading writing-collection-section-title"><strong>章节</strong><span className="cap">{groups.length} 个章节 · 由作者划分</span></div><div className="writing-collection-groups">{groups.map(group => <section key={group}><h3>{group}</h3>{entries.filter(e => (e.category || '文档') === group).map(e => <Link key={e.id} to={href(e)}><span className="mono">{String(data.entries.indexOf(e) + 1).padStart(2, '0')}</span><span>{e.title}</span><span className="hint">{label(e)}</span></Link>)}</section>)}</div>{data.entries.length === 0 && <div className="panel writing-empty"><BookOpen size={40} /><strong>从一份总览开始组织阅读</strong><p className="hint">主文档说明结论与阅读顺序，成员文档提供方案、依据和细节。</p>{data.canEdit && <Link className="btn pri" to={`/document-store/${storeId}/write?template=overview`}>用总览模版新建主文档</Link>}</div>}</main></div>
    {dialog && <div className="writing-dialog-scrim" onClick={() => setDialog(undefined)}><section className="panel scroll writing-source-dialog" role="dialog" aria-modal="true" aria-label={dialog === 'manage' ? '管理合集' : '分享合集'} onClick={e => e.stopPropagation()}><div className="writing-section-heading"><h2>{dialog === 'manage' ? '管理合集' : '分享、权限与停止'}</h2><button className="btn ghost" aria-label="关闭" onClick={() => setDialog(undefined)}><X size={16} /></button></div>{dialog === 'manage' ? <div className="writing-manage-form"><label className="writing-input-label">合集名称<input className="field" value={name} onChange={e => setName(e.target.value)} /></label><label className="writing-input-label">说明<textarea className="field" rows={3} value={description} onChange={e => setDescription(e.target.value)} /></label><button className="btn pri" disabled={busy || !name.trim()} onClick={() => void mutate(() => updateDocumentStoreReal(storeId, { name, description }))}>保存合集</button><h3>主文档与阅读顺序</h3>{data.entries.map((e, i) => <div className="writing-manage-row" key={e.id}><span className="mono">{String(i + 1).padStart(2, '0')}</span><span>{e.title}</span><button className="btn ghost sm" aria-label={`设${e.title}为主文档`} disabled={busy} onClick={() => void mutate(() => setPrimaryEntry(storeId, e.id))}><Star size={13} />{data.store.primaryEntryId === e.id ? '主文档' : '设为主文档'}</button><button className="btn ghost sm" aria-label={`上移${e.title}`} disabled={busy || i === 0} onClick={() => void move(e, -1)}><ArrowUp size={13} /></button><button className="btn ghost sm" aria-label={`下移${e.title}`} disabled={busy || i === data.entries.length - 1} onClick={() => void move(e, 1)}><ArrowDown size={13} /></button></div>)}</div> : <div className="writing-manage-form"><p>成员访问沿用知识库权限。创建分享链接后，持有链接的人可以查看分享范围内的文档。</p><p className="hint">此操作复用现有知识库分享规则；停止后链接失效。</p><button className="btn pri" disabled={busy} onClick={() => void mutate(async () => { const res = await createShareLink(storeId, { title: data.store.name }); if (res.success) setShares(prev => [res.data, ...prev]); return res; })}>创建合集分享链接</button>{shares.map(s => <div className="writing-share-row" key={s.id}><strong>{s.title || s.storeName}</strong><span className="hint">{s.isRevoked ? '已停止' : '分享中'}</span>{!s.isRevoked && <><a className="btn" target="_blank" rel="noopener" href={`/s/lib/${s.token}`}>打开分享</a><button className="btn dgr" disabled={busy} onClick={() => void mutate(async () => { const res = await revokeShareLink(s.id); if (res.success) setShares(prev => prev.map(x => x.id === s.id ? { ...x, isRevoked: true } : x)); return res; })}>停止分享</button></>}</div>)}</div>}</section></div>}
  </div>;
}
