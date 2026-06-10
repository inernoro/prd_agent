/**
 * 知识列表 tab — 分页列表 + 多维筛选（关键词/分类/标签/版本）+ 行操作。
 * 行操作：查看详情（独立详情页）/ 编辑 / 重新上传 / 关联版本 / 删除。
 * 新建与上传在工具栏；上传支持多文件。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, Upload, ChevronLeft, ChevronRight, Trash2, Pencil, RefreshCw, GitBranch, Eye, X } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import {
  listKnowledgeEntriesPaged, uploadDocumentFile, replaceDocumentFile,
  deleteDocumentEntry, addDocumentEntry, updateDocumentEntry,
} from '@/services';
import type { DocumentStore, DocumentEntry } from '@/services/contracts/documentStore';
import type { ProductVersion } from '../types';
import { fileKindOf, fmtSize, fmtTime, isUploadedFile, isEditableText, NO_CATEGORY, FOCUS_BOX } from './shared';
import { VersionLinkDialog } from './VersionLinkDialog';

const PAGE_SIZE = 20;

interface Props {
  storeId: string;
  productId: string;
  store: DocumentStore | null;
  versions: ProductVersion[];
  allEntries: DocumentEntry[];
  onChanged: () => void;
}

export function KnowledgeListTab({ storeId, productId, store, versions, allEntries, onChanged }: Props) {
  const navigate = useNavigate();
  const [items, setItems] = useState<DocumentEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [tag, setTag] = useState('');
  const [versionId, setVersionId] = useState('');
  const [linkTarget, setLinkTarget] = useState<DocumentEntry | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetRef = useRef<string | null>(null);

  const categories = store?.categories ?? [];
  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const e of allEntries) for (const t of e.tags ?? []) s.add(t);
    return Array.from(s).sort((a, b) => a.localeCompare(b, 'zh'));
  }, [allEntries]);
  const versionName = useMemo(() => new Map(versions.map((v) => [v.id, v.versionName])), [versions]);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await listKnowledgeEntriesPaged(storeId, {
      page, pageSize: PAGE_SIZE,
      keyword: appliedKeyword || undefined,
      searchContent: !!appliedKeyword,
      category: category || undefined,
      tag: tag || undefined,
      versionId: versionId || undefined,
    });
    if (res.success) { setItems(res.data.items); setTotal(res.data.total); }
    setLoading(false);
  }, [storeId, page, appliedKeyword, category, tag, versionId]);
  useEffect(() => { void reload(); }, [reload]);

  const resetToFirstPage = () => setPage(1);
  const applySearch = () => { setAppliedKeyword(keyword.trim()); resetToFirstPage(); };
  const hasFilter = !!(appliedKeyword || category || tag || versionId);
  const clearFilters = () => { setKeyword(''); setAppliedKeyword(''); setCategory(''); setTag(''); setVersionId(''); resetToFirstPage(); };

  const goDetail = (entryId: string, edit = false) =>
    navigate(`/product-agent/p/${productId}/knowledge/${entryId}${edit ? '?edit=1' : ''}`);

  const handleCreate = async () => {
    const res = await addDocumentEntry(storeId, { title: '新建文档', sourceType: 'upload', contentType: 'text/markdown', summary: '' });
    if (res.success) { toast.success('已创建文档'); onChanged(); goDetail(res.data.id, true); }
    else toast.error('创建失败', res.error?.message);
  };

  const handleFiles = async (files: File[]) => {
    setUploading(true);
    let ok = 0;
    for (const f of files) {
      const res = await uploadDocumentFile(storeId, f);
      if (res.success) ok++;
      else toast.error(`上传失败: ${f.name}`, res.error?.message);
    }
    if (ok > 0) { toast.success('上传完成', `${ok} 个文件已存储`); onChanged(); await reload(); }
    setUploading(false);
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fs = Array.from(e.target.files ?? []);
    e.currentTarget.value = '';
    if (fs.length) void handleFiles(fs);
  };

  const handleReplace = (entryId: string) => { replaceTargetRef.current = entryId; replaceInputRef.current?.click(); };
  const onReplacePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.currentTarget.value = '';
    const id = replaceTargetRef.current;
    replaceTargetRef.current = null;
    if (!f || !id) return;
    setUploading(true);
    const res = await replaceDocumentFile(id, f);
    if (res.success) { toast.success('已重新上传', '内容已更新，标签与关联保留'); onChanged(); await reload(); }
    else toast.error('重新上传失败', res.error?.message);
    setUploading(false);
  };

  const handleDelete = async (entry: DocumentEntry) => {
    const ok = await systemDialog.confirm({
      title: '删除知识', message: `确定删除「${entry.title}」吗？此操作不可恢复。`,
      tone: 'danger', confirmText: '删除', cancelText: '取消',
    });
    if (!ok) return;
    const res = await deleteDocumentEntry(entry.id);
    if (res.success) { toast.success('已删除'); onChanged(); await reload(); }
    else toast.error('删除失败', res.error?.message);
  };

  const handleLinkVersions = async (entry: DocumentEntry, ids: string[]) => {
    const res = await updateDocumentEntry(entry.id, { versionIds: ids });
    if (res.success) { toast.success('版本关联已更新'); setLinkTarget(null); onChanged(); await reload(); }
    else toast.error('关联失败', res.error?.message);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const selectCls = 'px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-white/70 outline-none focus:border-cyan-500/40 [&>option]:bg-[#16181d]';

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onPickFiles} />
      <input ref={replaceInputRef} type="file" className="hidden" onChange={(e) => void onReplacePick(e)} />

      {/* 工具栏：搜索 + 筛选 + 新建/上传 */}
      <div className="shrink-0 flex items-center gap-2 flex-wrap" data-tour-id="knowledge-toolbar">
        <div className={FOCUS_BOX}>
          <Search size={14} className="text-white/40" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applySearch(); }}
            placeholder="搜索标题 / 全文，回车确认"
            className="no-focus-ring bg-transparent text-sm text-white outline-none w-52"
          />
          {keyword && <button onClick={clearFilters} className="text-white/30 hover:text-white"><X size={13} /></button>}
        </div>
        <select value={category} onChange={(e) => { setCategory(e.target.value); resetToFirstPage(); }} className={selectCls}>
          <option value="">全部分类</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          <option value={NO_CATEGORY}>未分类</option>
        </select>
        <select value={tag} onChange={(e) => { setTag(e.target.value); resetToFirstPage(); }} className={selectCls}>
          <option value="">全部标签</option>
          {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={versionId} onChange={(e) => { setVersionId(e.target.value); resetToFirstPage(); }} className={selectCls}>
          <option value="">全部版本</option>
          {versions.map((v) => <option key={v.id} value={v.id}>{v.versionName}</option>)}
        </select>
        {hasFilter && (
          <button onClick={clearFilters} className="text-[11px] text-white/40 hover:text-white underline underline-offset-2">清除筛选</button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {uploading && <MapSpinner size={14} />}
          <button onClick={() => void handleCreate()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 text-sm" data-tour-id="knowledge-create">
            <Plus size={14} /> 新建文档
          </button>
          <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-white/70 border border-white/10 hover:bg-white/5 text-sm disabled:opacity-50" data-tour-id="knowledge-upload">
            <Upload size={14} /> 上传文件
          </button>
        </div>
      </div>

      {/* 列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5" style={{ overscrollBehavior: 'contain' }} data-tour-id="knowledge-list">
        {loading ? (
          <MapSectionLoader text="正在加载知识…" />
        ) : items.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center py-16 gap-2">
            <div className="text-sm text-white/55">{hasFilter ? '没有匹配的知识' : '还没有知识文档'}</div>
            <div className="text-xs text-white/35">
              {hasFilter ? '换个筛选条件，或清除筛选看全部' : '新建一篇空白文档，或上传文件（md / html / pdf / Office 等）'}
            </div>
            {!hasFilter && (
              <div className="flex items-center gap-2 mt-2">
                <button onClick={() => void handleCreate()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 text-sm"><Plus size={14} /> 新建文档</button>
                <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-white/70 border border-white/10 hover:bg-white/5 text-sm"><Upload size={14} /> 上传文件</button>
              </div>
            )}
          </div>
        ) : (
          items.map((e) => {
            const kind = fileKindOf(e.contentType);
            const Icon = kind.icon;
            const vIds = e.versionIds ?? [];
            return (
              <div
                key={e.id}
                onClick={() => goDetail(e.id)}
                className="pa-row group cursor-pointer flex items-center gap-3 px-3 py-2.5 rounded-lg border border-white/10 bg-white/[0.02]"
              >
                <Icon size={16} className="shrink-0" style={{ color: kind.color }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm text-white/90 truncate">{e.title}</span>
                    {e.category && <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-300/90 border border-cyan-500/20 shrink-0">{e.category}</span>}
                    {(e.tags ?? []).slice(0, 3).map((t) => (
                      <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-white/8 text-white/55 shrink-0">{t}</span>
                    ))}
                    {vIds.slice(0, 3).map((id) => (
                      <span key={id} className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300/90 border border-purple-500/20 shrink-0 inline-flex items-center gap-0.5">
                        <GitBranch size={9} /> {versionName.get(id) ?? '已删版本'}
                      </span>
                    ))}
                    {vIds.length > 3 && <span className="text-[10px] text-white/35 shrink-0">+{vIds.length - 3}</span>}
                  </div>
                  <div className="text-[11px] text-white/35 mt-0.5 truncate">
                    {kind.label} · {fmtSize(e.fileSize)} · {e.updatedByName || e.createdBy} 更新于 {fmtTime(e.updatedAt)}
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(ev) => ev.stopPropagation()}>
                  <RowBtn title="查看详情" onClick={() => goDetail(e.id)}><Eye size={13} /></RowBtn>
                  {isEditableText(e.contentType) && <RowBtn title="编辑" onClick={() => goDetail(e.id, true)}><Pencil size={13} /></RowBtn>}
                  <RowBtn title="关联版本" onClick={() => setLinkTarget(e)}><GitBranch size={13} /></RowBtn>
                  {isUploadedFile(e) && <RowBtn title="重新上传" onClick={() => handleReplace(e.id)}><RefreshCw size={13} /></RowBtn>}
                  <RowBtn title="删除" danger onClick={() => void handleDelete(e)}><Trash2 size={13} /></RowBtn>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 分页 */}
      {total > PAGE_SIZE && (
        <div className="shrink-0 flex items-center justify-between text-xs text-white/40">
          <span>共 {total} 篇</span>
          <div className="flex items-center gap-2">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="flex items-center gap-0.5 px-2 py-1 rounded-md border border-white/10 hover:bg-white/5 disabled:opacity-30">
              <ChevronLeft size={13} /> 上一页
            </button>
            <span className="text-white/55">{page} / {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="flex items-center gap-0.5 px-2 py-1 rounded-md border border-white/10 hover:bg-white/5 disabled:opacity-30">
              下一页 <ChevronRight size={13} />
            </button>
          </div>
        </div>
      )}

      {linkTarget && (
        <VersionLinkDialog
          entry={linkTarget}
          versions={versions}
          onClose={() => setLinkTarget(null)}
          onSave={(ids) => void handleLinkVersions(linkTarget, ids)}
        />
      )}
    </div>
  );
}

function RowBtn({ title, danger, onClick, children }: { title: string; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`p-1.5 rounded-md ${danger ? 'text-red-300/60 hover:text-red-300 hover:bg-red-500/10' : 'text-white/45 hover:text-white hover:bg-white/10'}`}
    >
      {children}
    </button>
  );
}
