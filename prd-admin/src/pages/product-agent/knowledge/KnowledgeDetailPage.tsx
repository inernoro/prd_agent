/**
 * 知识详情页 — 独立路由 /product-agent/p/:productId/knowledge/:entryId（?edit=1 直接进编辑）。
 *
 * 居中阅读列：头部（标题/分类/标签/关联版本/元信息）+ 正文（markdown 阅读排版 /
 * 图片 / PDF / 附件下载）。操作：编辑（文本类）/ 关联版本 / 重新上传 / 删除。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Trash2, RefreshCw, GitBranch, Save, X, Tags, Layers, FileText } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import {
  getDocumentEntry, getDocumentContent, updateDocumentContent,
  updateDocumentEntry, deleteDocumentEntry, replaceDocumentFile, getDocumentStore,
} from '@/services';
import type { DocumentEntry, DocumentStore } from '@/services/contracts/documentStore';
import { listVersions } from '@/services/real/productAgent';
import type { ProductVersion } from '../types';
import { fileKindOf, fmtSize, fmtTime, isEditableText } from './shared';
import { VersionLinkDialog } from './VersionLinkDialog';

export function KnowledgeDetailPage() {
  const { productId = '', entryId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [entry, setEntry] = useState<DocumentEntry | null>(null);
  const [store, setStore] = useState<DocumentStore | null>(null);
  const [versions, setVersions] = useState<ProductVersion[]>([]);
  const [content, setContent] = useState<string | null>(null);
  const [fileUrl, setFileUrl] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  const editable = isEditableText(entry?.contentType);
  const kind = fileKindOf(entry?.contentType);
  const versionName = useMemo(() => new Map(versions.map((v) => [v.id, v.versionName])), [versions]);

  const reload = useCallback(async () => {
    const [entryRes, contentRes] = await Promise.all([getDocumentEntry(entryId), getDocumentContent(entryId)]);
    if (entryRes.success) {
      setEntry(entryRes.data);
      const storeRes = await getDocumentStore(entryRes.data.storeId);
      if (storeRes.success) setStore(storeRes.data);
    }
    if (contentRes.success) {
      setContent(contentRes.data.hasContent ? contentRes.data.content : null);
      setFileUrl(contentRes.data.fileUrl ?? '');
    }
  }, [entryId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      await reload();
      const verRes = await listVersions(productId);
      if (alive && verRes.success) setVersions(verRes.data.items);
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [reload, productId]);

  // ?edit=1 直接进入编辑（来自列表「编辑」按钮）
  useEffect(() => {
    if (!loading && searchParams.get('edit') === '1' && editable) {
      setDraft(content ?? '');
      setEditing(true);
      searchParams.delete('edit');
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const back = () => navigate(`/product-agent/p/${productId}?tab=knowledge`);

  const startEdit = () => { setDraft(content ?? ''); setEditing(true); };

  const handleSave = async () => {
    setSaving(true);
    const res = await updateDocumentContent(entryId, draft);
    setSaving(false);
    if (res.success) { setContent(draft); setEditing(false); toast.success('已保存'); void reload(); }
    else toast.error('保存失败', res.error?.message);
  };

  const handleRenameTitle = async () => {
    if (!entry) return;
    const name = await systemDialog.prompt({ title: '修改标题', message: '输入新的知识标题', defaultValue: entry.title, confirmText: '保存' });
    if (!name || !name.trim() || name.trim() === entry.title) return;
    const res = await updateDocumentEntry(entryId, { title: name.trim() });
    if (res.success) { setEntry(res.data); toast.success('已重命名'); }
    else toast.error('重命名失败', res.error?.message);
  };

  const handleSetCategory = async (cat: string) => {
    const res = await updateDocumentEntry(entryId, { category: cat });
    if (res.success) { setEntry(res.data); toast.success(cat ? `已归入「${cat}」` : '已移出分类'); }
    else toast.error('设置分类失败', res.error?.message);
  };

  const handleEditTags = async () => {
    if (!entry) return;
    const input = await systemDialog.prompt({
      title: '编辑标签', message: '多个标签用逗号分隔', defaultValue: (entry.tags ?? []).join(', '), confirmText: '保存',
    });
    if (input == null) return;
    const tags = Array.from(new Set(input.split(/[,，]/).map((t) => t.trim()).filter(Boolean)));
    const res = await updateDocumentEntry(entryId, { tags });
    if (res.success) { setEntry(res.data); toast.success('标签已更新'); }
    else toast.error('标签更新失败', res.error?.message);
  };

  const handleLinkVersions = async (ids: string[]) => {
    const res = await updateDocumentEntry(entryId, { versionIds: ids });
    if (res.success) { setEntry(res.data); setLinkOpen(false); toast.success('版本关联已更新'); }
    else toast.error('关联失败', res.error?.message);
  };

  const onReplacePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.currentTarget.value = '';
    if (!f) return;
    setBusy(true);
    const res = await replaceDocumentFile(entryId, f);
    setBusy(false);
    if (res.success) { toast.success('已重新上传', '内容已更新，标签与关联保留'); await reload(); }
    else toast.error('重新上传失败', res.error?.message);
  };

  const handleDelete = async () => {
    if (!entry) return;
    const ok = await systemDialog.confirm({
      title: '删除知识', message: `确定删除「${entry.title}」吗？此操作不可恢复。`,
      tone: 'danger', confirmText: '删除', cancelText: '取消',
    });
    if (!ok) return;
    const res = await deleteDocumentEntry(entryId);
    if (res.success) { toast.success('已删除'); back(); }
    else toast.error('删除失败', res.error?.message);
  };

  const categories = store?.categories ?? [];
  const vIds = entry?.versionIds ?? [];

  return (
    <div className="h-screen min-h-0 flex flex-col bg-[#0f1014]">
      <input ref={replaceInputRef} type="file" className="hidden" onChange={(e) => void onReplacePick(e)} />

      {/* 顶栏 */}
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-white/8">
        <button onClick={back} className="flex items-center justify-center w-8 h-8 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/5 shrink-0" title="返回知识库">
          <ArrowLeft size={16} />
        </button>
        <span className="text-[11px] px-1.5 py-0.5 rounded shrink-0 inline-flex items-center gap-1" style={{ color: kind.color, background: `${kind.color}1a` }}>
          <FileText size={11} /> 知识 · {kind.label}
        </span>
        <span className="text-sm text-white/45 truncate">{entry?.title}</span>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {busy && <MapSpinner size={14} />}
          {editing ? (
            <>
              <button onClick={() => setEditing(false)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm text-white/60 hover:bg-white/5 border border-white/10"><X size={13} /> 取消</button>
              <button onClick={() => void handleSave()} disabled={saving} className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm hover:bg-cyan-500/30 disabled:opacity-50">
                {saving ? <MapSpinner size={13} /> : <Save size={13} />} 保存
              </button>
            </>
          ) : (
            <>
              {editable && <TopBtn onClick={startEdit} icon={Pencil} label="编辑" />}
              <TopBtn onClick={() => setLinkOpen(true)} icon={GitBranch} label="关联版本" />
              <TopBtn onClick={() => replaceInputRef.current?.click()} icon={RefreshCw} label="重新上传" />
              <button onClick={() => void handleDelete()} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm text-red-300/60 hover:text-red-300 hover:bg-red-500/10" title="删除">
                <Trash2 size={13} /> 删除
              </button>
            </>
          )}
        </div>
      </div>

      {/* 正文区 */}
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
        {loading ? (
          <MapSectionLoader text="正在加载知识…" />
        ) : !entry ? (
          <div className="text-sm text-white/40 text-center py-20">知识不存在或已被删除</div>
        ) : (
          <div className="mx-auto py-8 px-6" style={{ maxWidth: 860 }}>
            {/* 标题 + 元信息 */}
            <div className="mb-6 pb-5 border-b border-white/8">
              <h1
                onClick={() => void handleRenameTitle()}
                className="text-2xl font-semibold text-white/95 leading-snug cursor-pointer hover:text-cyan-100"
                title="点击修改标题"
              >
                {entry.title}
              </h1>
              <div className="flex items-center gap-2 flex-wrap mt-3">
                {/* 分类 */}
                <span className="inline-flex items-center gap-1 text-[11px] text-white/40"><Layers size={11} /></span>
                <select
                  value={entry.category ?? ''}
                  onChange={(e) => void handleSetCategory(e.target.value)}
                  className="px-2 py-1 rounded-md bg-white/5 border border-white/10 text-[11px] text-cyan-300/90 outline-none focus:border-cyan-500/40 [&>option]:bg-[#16181d]"
                >
                  <option value="">未分类</option>
                  {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                {/* 标签 */}
                <button onClick={() => void handleEditTags()} className="inline-flex items-center gap-1 text-[11px] text-white/40 hover:text-white" title="编辑标签">
                  <Tags size={11} />
                </button>
                {(entry.tags ?? []).map((t) => (
                  <span key={t} className="text-[11px] px-1.5 py-0.5 rounded bg-white/8 text-white/60">{t}</span>
                ))}
                {(entry.tags ?? []).length === 0 && <button onClick={() => void handleEditTags()} className="text-[11px] text-white/30 hover:text-white/60">+ 加标签</button>}
                {/* 关联版本 */}
                <span className="text-white/15">|</span>
                {vIds.length === 0 ? (
                  <button onClick={() => setLinkOpen(true)} className="inline-flex items-center gap-1 text-[11px] text-white/30 hover:text-purple-300">
                    <GitBranch size={11} /> 关联版本
                  </button>
                ) : (
                  vIds.map((id) => (
                    <button key={id} onClick={() => setLinkOpen(true)} className="text-[11px] px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300/90 border border-purple-500/20 inline-flex items-center gap-1 hover:bg-purple-500/20">
                      <GitBranch size={10} /> {versionName.get(id) ?? '已删版本'}
                    </button>
                  ))
                )}
              </div>
              <div className="text-[11px] text-white/30 mt-3">
                {kind.label} · {fmtSize(entry.fileSize)} · 创建于 {fmtTime(entry.createdAt)}
                {entry.updatedByName ? ` · ${entry.updatedByName} 更新于 ${fmtTime(entry.updatedAt)}` : ` · 更新于 ${fmtTime(entry.updatedAt)}`}
              </div>
            </div>

            {/* 内容 */}
            {editing ? (
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="w-full rounded-xl bg-white/[0.03] border border-white/10 p-5 text-[13.5px] leading-relaxed text-white/90 font-mono outline-none focus:border-cyan-500/40 resize-none"
                style={{ minHeight: '60vh' }}
                placeholder="用 Markdown 书写知识内容…"
              />
            ) : content != null && content.trim() ? (
              <MarkdownContent content={content} variant="reading" />
            ) : entry.contentType.startsWith('image/') && fileUrl ? (
              <img src={fileUrl} alt={entry.title} className="max-w-full rounded-xl border border-white/10" />
            ) : entry.contentType.includes('pdf') && fileUrl ? (
              <iframe src={fileUrl} title={entry.title} className="w-full rounded-xl border border-white/10" style={{ height: '75vh' }} />
            ) : fileUrl ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <kind.icon size={36} style={{ color: kind.color }} className="opacity-60" />
                <div className="text-sm text-white/55">该文件类型暂不支持在线预览</div>
                <a href={fileUrl} target="_blank" rel="noreferrer" className="px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 text-sm">
                  下载 / 新窗口打开
                </a>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <div className="text-sm text-white/45">这篇知识还没有内容</div>
                {editable && (
                  <button onClick={startEdit} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 text-sm">
                    <Pencil size={13} /> 开始编写
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {linkOpen && entry && (
        <VersionLinkDialog entry={entry} versions={versions} onClose={() => setLinkOpen(false)} onSave={(ids) => void handleLinkVersions(ids)} />
      )}
    </div>
  );
}

function TopBtn({ onClick, icon: Icon, label }: { onClick: () => void; icon: typeof Pencil; label: string }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm text-white/60 hover:text-white hover:bg-white/5 border border-white/10">
      <Icon size={13} /> {label}
    </button>
  );
}
