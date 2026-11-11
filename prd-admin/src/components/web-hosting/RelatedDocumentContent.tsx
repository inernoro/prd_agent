import { useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, FolderPlus, Grid2X2, Link2, List, ShieldAlert, ShieldCheck, Star, Tags } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { SitePreview } from '@/components/SitePreview';
import type { RelatedDocument, RelatedDocuments, RelatedDocumentSource } from '@/services/real/relatedDocuments';

export function RelatedDocumentContent({ siteId, data, error = '', loading, source, compact = true, onReload, onManage, onPermissions, onTagEdit, onNavigate, onClose, heading = '关联文档', links }: {
  siteId: string; data: RelatedDocuments | null; error?: string; loading: boolean; source?: RelatedDocumentSource; compact?: boolean;
  onReload: () => void; onManage: () => void; onPermissions: () => void; onTagEdit: (item: RelatedDocument) => void;
  onNavigate?: (item: RelatedDocument) => void; onClose: () => void; heading?: string; links?: React.ReactNode;
}) {
  const [page, setPage] = useState(0);
  const [tagFilter, setTagFilter] = useState('');
  const [referenceScope, setReferenceScope] = useState<'all' | 'members' | 'references'>('all');
  const [view, setView] = useState<'cards' | 'list'>(() => {
    try { return localStorage.getItem('hosted-related-view') === 'list' ? 'list' : 'cards'; } catch { return 'cards'; }
  });
  const changeView = (next: 'cards' | 'list') => {
    setView(next); try { localStorage.setItem('hosted-related-view', next); } catch { /* 私密浏览仍可切换。 */ }
  };
  const token = source?.token;
  const password = source?.password;
  const close = onClose;
  const openManager = onManage;
  const openPermissions = onPermissions;
  const setTagTarget = onTagEdit;
  const refresh = onReload;
  const main = data?.items.find(item => item.isMain);
  const availableTags = [...new Set(data?.items.flatMap(item => item.tags ?? []) ?? [])];
  const displayed = data?.items.filter(item => (!tagFilter || item.tags?.includes(tagFilter)) && (referenceScope === 'all' || (referenceScope === 'members' ? item.isManual !== false : item.isManual === false))) ?? [];
  const pages = Math.max(1, Math.ceil(displayed.length / 9));
  const currentPage = Math.min(page, pages - 1);
  return <section className="related-document-content" aria-label={heading} style={{ minHeight: 0, maxHeight: 'calc(100dvh - 44px)' }}>
    <div className="related-panel-heading"><div><strong>{heading}</strong>{data && <span>{data.items.length} 份可见文档 · 引用保留来源</span>}</div>
      <div className="related-heading-actions"><div className="related-view-switch" aria-label="关联文档展示方式">
        <button type="button" aria-label="卡片视图" aria-pressed={view === 'cards'} onClick={() => changeView('cards')}><Grid2X2 size={14} /></button>
        <button type="button" aria-label="列表视图" aria-pressed={view === 'list'} onClick={() => changeView('list')}><List size={15} /></button>
      </div>{data?.canManage && <button className="related-text-button" type="button" onClick={openManager}><FolderPlus size={14} />管理关联</button>}</div>
    </div>
    {links}
        {compact && (main || (data?.canManage && data.version > 0)) && <div className="related-context-row">
          {main && <span className="related-main-label"><Star size={12} />主文档<span title={main.title}>{main.title}</span></span>}
          {data?.canManage && data.version > 0 && <button type="button" className={`related-permission-hint ${data.hasPermissionDifferences ? 'is-warning' : ''}`} onClick={openPermissions}>
            {data.hasPermissionDifferences ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}{data.hasPermissionDifferences ? '权限不一致' : '权限与分享'}
          </button>}
        </div>}
        {data?.items.some(item => item.isManual === false) && <div className="related-tag-filters" aria-label="按关联来源筛选">
          <button type="button" aria-pressed={referenceScope === 'all'} onClick={() => { setReferenceScope('all'); setPage(0); }}>全部</button>
          <button type="button" aria-pressed={referenceScope === 'members'} onClick={() => { setReferenceScope('members'); setPage(0); }}>{data.contextLabel || '手动关联'}</button>
          <button type="button" aria-pressed={referenceScope === 'references'} onClick={() => { setReferenceScope('references'); setPage(0); }}>评论引用</button>
        </div>}
        {availableTags.length > 0 && <div className="related-tag-filters" aria-label="按标签筛选">
          <button type="button" aria-pressed={!tagFilter} onClick={() => { setTagFilter(''); setPage(0); }}>全部</button>
          {availableTags.map(tag => <button key={tag} type="button" aria-pressed={tagFilter === tag} onClick={() => { setTagFilter(tag); setPage(0); }}>{tag}</button>)}
        </div>}
        <div className="related-documents-scroll" style={{ minHeight: 0, overflowY: 'auto', maxHeight: 'calc(100dvh - 220px)', overscrollBehavior: 'contain' }}>
          {error ? <div className="related-empty" role="alert">{error}<Button size="sm" onClick={() => { refresh(); }}>重新加载</Button></div>
            : loading ? <div className="related-empty"><MapSpinner size={20} />正在加载关联文档…</div>
              : <div className={`related-document-grid ${view === 'list' ? 'is-list' : ''}`}>
                {displayed.slice(currentPage * 9, currentPage * 9 + 9).map((item, index) => <div key={item.id} className="related-item">
                  <a href={item.href} className={`related-document-card ${item.id === siteId ? 'is-current' : ''}`} aria-current={item.id === siteId ? 'page' : undefined}
                    onClick={event => {
                      if (item.id === siteId) { event.preventDefault(); close(); return; }
                      if (onNavigate && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onNavigate(item); }
                      close();
                    }}>
                    <div className="related-card-preview">
                      {item.preview ? <SitePreview url={item.preview.siteUrl} site={{ ...item.preview,
                        shareAccess: item.preview.useShareAccess && token ? { token, password } : undefined }} className="related-live-preview" />
                        : <span className="related-no-preview">暂无预览</span>}
                      <span className="related-preview-index">{String(currentPage * 9 + index + 1).padStart(2, '0')}</span>
                      {item.isMain && <span className="related-main-badge"><Star size={10} />主文档</span>}
                    </div>
                    <div className="related-card-content"><strong title={item.title}>{item.title}</strong><p>{item.description || '打开查看文档内容'}</p>
                      <div className="related-tag-list">{item.tags?.map(tag => <span className="related-custom-tag" key={tag}>{tag}</span>)}
                        {item.mentions?.slice(0, 2).map(mention => <span key={mention.commentId} className="related-mention-tag" title={`${mention.sourceTitle} · ${mention.label}`}>{mention.label}</span>)}
                      </div>
                      <span className="related-card-status">{item.id === siteId ? <><span className="related-current-dot" />当前文档</> : item.isMain ? '文档组的主要入口' : item.isManual === false ? '评论引用' : '关联文档'}</span>
                    </div>
                  </a>
                  <a className="related-open-new-tab" href={item.href} target="_blank" rel="noopener noreferrer" data-no-drag
                    aria-label={`在新标签页打开：${item.title}`} title="在新标签页打开" onClick={event => event.stopPropagation()}><ExternalLink size={12} /></a>
                  {item.canEditTags && <button type="button" className="related-tag-edit" aria-label={`编辑标签：${item.title}`} title="编辑文档标签"
                    onClick={() => { close(); setTagTarget(item); }}><Tags size={13} /></button>}
                </div>)}
                {!displayed.length && <p className="related-small-note">没有符合该标签的关联文档。</p>}
              </div>}

        </div>
        <div className="related-panel-footer"><span><Link2 size={13} />每份文档独立授权</span>
          {pages > 1 ? <div className="related-pagination"><button aria-label="上一页" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={15} /></button>
            <span>{currentPage + 1} / {pages}</span><button aria-label="下一页" disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={15} /></button></div>
            : data?.canManage && data.version > 0 && <button type="button" className="related-text-button" onClick={openPermissions}>{data.hasPermissionDifferences ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
              {data.hasPermissionDifferences ? '查看权限差异' : '查看权限与分享'}</button>}
        </div>
  </section>;
}
