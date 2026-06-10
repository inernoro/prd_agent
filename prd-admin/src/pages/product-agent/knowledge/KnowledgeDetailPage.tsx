/**
 * 知识详情页 — 独立路由 /product-agent/p/:productId/knowledge/:entryId（?edit=1 直接进编辑）。
 *
 * 左侧：同库文件夹目录（同文件夹文件可快速切换，高亮当前）。
 * 右侧：头部（标题/分类/标签/关联版本/元信息）+ 正文。
 *   - 富文本/HTML：直接预览，可切「代码」模式看源码。
 *   - markdown：阅读排版。图片/PDF/其它文件：内联预览或下载。
 * 编辑：富文本编辑器（图片上传/粘贴/拖拽 + 附件上传），保存为 text/html。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Trash2, RefreshCw, GitBranch, Save, X, Tags, Layers, FolderOpen, Eye, Code as CodeIcon } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { sanitizeHtml } from '@/lib/sanitizeHtml';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import {
  getDocumentEntry, getDocumentContent, updateDocumentContent,
  updateDocumentEntry, deleteDocumentEntry, replaceDocumentFile, getDocumentStore,
  listDocumentEntries,
} from '@/services';
import type { DocumentEntry, DocumentStore } from '@/services/contracts/documentStore';
import { listVersions } from '@/services/real/productAgent';
import type { ProductVersion } from '../types';
import type { LucideIcon } from 'lucide-react';
import { fileKindOf, fmtSize, fmtTime, isEditableText, isHtml, isFullHtmlDocument, contentLooksHtml } from './shared';
import { htmlToMarkdown, markdownToHtml } from './htmlMarkdown';
import './knowledge.css';
import { VersionLinkDialog } from './VersionLinkDialog';
import { RichKnowledgeEditor, FileKindBadge } from './RichKnowledgeEditor';

export function KnowledgeDetailPage() {
  const { productId = '', entryId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [entry, setEntry] = useState<DocumentEntry | null>(null);
  const [store, setStore] = useState<DocumentStore | null>(null);
  const [versions, setVersions] = useState<ProductVersion[]>([]);
  const [siblings, setSiblings] = useState<DocumentEntry[]>([]);
  const [content, setContent] = useState<string | null>(null);
  const [fileUrl, setFileUrl] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [codeMode, setCodeMode] = useState(false);
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
      const listRes = await listDocumentEntries(entryRes.data.storeId, 1, 500);
      if (listRes.success) setSiblings(listRes.data.items);
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
      setCodeMode(false);
      setEditing(false);
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
  const openEntry = (id: string) => { if (id !== entryId) navigate(`/product-agent/p/${productId}/knowledge/${id}`); };

  // 左侧目录双击改名（同步当前条目标题）
  const handleRenameSibling = async (id: string, title: string) => {
    const name = title.trim();
    if (!name) return;
    const res = await updateDocumentEntry(id, { title: name });
    if (res.success) {
      setSiblings((prev) => prev.map((x) => (x.id === id ? { ...x, title: name } : x)));
      if (id === entryId) setEntry((e) => (e ? { ...e, title: name } : e));
      toast.success('已重命名');
    } else toast.error('重命名失败', res.error?.message);
  };

  // 进入编辑：markdown 模式但正文是 HTML（历史混存）→ 转成干净 Markdown 再编辑
  const startEdit = () => {
    const raw = content ?? '';
    setDraft(effectiveMarkdown && contentLooksHtml(raw) ? htmlToMarkdown(raw) : raw);
    setEditing(true);
  };

  const handleSave = async (asMarkdown: boolean) => {
    setSaving(true);
    // markdown 文档保持 markdown；富文本编辑产出 HTML（顺带纠正历史误标的 contentType）
    const res = await updateDocumentContent(entryId, draft, asMarkdown ? 'text/markdown' : 'text/html');
    setSaving(false);
    if (res.success) { setContent(draft); setEditing(false); toast.success('已保存'); void reload(); }
    else toast.error('保存失败', res.error?.message);
  };

  /** 格式切换：把正文真正在 Markdown ↔ 富文本 HTML 间转换，并持久化（不是只翻标记） */
  const handleSetFormat = async (ct: string) => {
    const raw = content ?? '';
    let next = raw;
    if (ct.includes('markdown') && contentLooksHtml(raw)) next = htmlToMarkdown(raw);
    else if (ct === 'text/html' && raw && !contentLooksHtml(raw)) next = markdownToHtml(raw);
    const res = await updateDocumentContent(entryId, next, ct);
    if (res.success) {
      setContent(next);
      setEntry((e) => (e ? { ...e, contentType: ct } : e));
      toast.success(ct.includes('markdown') ? '已转为 Markdown' : '已转为富文本');
    } else toast.error('切换格式失败', res.error?.message);
  };

  const handleRenameTitle = async () => {
    if (!entry) return;
    const name = await systemDialog.prompt({ title: '修改标题', message: '输入新的知识标题', defaultValue: entry.title, confirmText: '保存' });
    if (!name || !name.trim() || name.trim() === entry.title) return;
    const res = await updateDocumentEntry(entryId, { title: name.trim() });
    if (res.success) { setEntry(res.data); void reload(); toast.success('已重命名'); }
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
  const html = isHtml(entry?.contentType);
  // 仅「完整 HTML 网页」需要预览/代码切换（iframe 渲染）；md / 富文本片段没有代码视角，不显示切换
  const fullHtml = html && isFullHtmlDocument(content);
  // 格式纠错：contentType 标了 html 但正文没有任何 HTML 标签（历史误存的 markdown）→ 按 markdown 处理
  const effectiveMarkdown = !!entry && !entry.isFolder
    && (entry.contentType.includes('markdown') || entry.contentType === 'text/plain' || (html && content != null && !contentLooksHtml(content)));
  const effectiveContentType = effectiveMarkdown ? 'text/markdown' : entry?.contentType;

  return (
    <div className="h-screen min-h-0 flex flex-col bg-[#0f1014]">
      <input ref={replaceInputRef} type="file" className="hidden" onChange={(e) => void onReplacePick(e)} />

      {/* 顶栏 */}
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-white/8">
        <button onClick={back} className="flex items-center justify-center w-8 h-8 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/5 shrink-0" title="返回知识库">
          <ArrowLeft size={16} />
        </button>
        <FileKindBadge contentType={effectiveContentType} />
        <span className="text-sm text-white/45 truncate">{entry?.title}</span>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {busy && <MapSpinner size={14} />}
          {editing ? (
            <>
              <button onClick={() => setEditing(false)} className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm text-white/60 hover:bg-white/5 border border-white/10"><X size={13} /> 取消</button>
              <button onClick={() => void handleSave(effectiveMarkdown)} disabled={saving} className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm hover:bg-cyan-500/30 disabled:opacity-50">
                {saving ? <MapSpinner size={13} /> : <Save size={13} />} 保存
              </button>
            </>
          ) : (
            <>
              {/* HTML 预览/代码切换 */}
              {fullHtml && (
                <div className="flex items-center rounded-lg border border-white/10 overflow-hidden mr-1">
                  <button onClick={() => setCodeMode(false)} className={`flex items-center gap-1 px-2.5 py-1.5 text-xs ${!codeMode ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/50 hover:bg-white/5'}`}><Eye size={13} /> 预览</button>
                  <button onClick={() => setCodeMode(true)} className={`flex items-center gap-1 px-2.5 py-1.5 text-xs ${codeMode ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/50 hover:bg-white/5'}`}><CodeIcon size={13} /> 代码</button>
                </div>
              )}
              {editable && <TopBtn onClick={startEdit} icon={Pencil} label="编辑" />}
              <TopBtn onClick={() => setLinkOpen(true)} icon={GitBranch} label="关联版本" />
              {entry?.attachmentId && <TopBtn onClick={() => replaceInputRef.current?.click()} icon={RefreshCw} label="重新上传" />}
              <button onClick={() => void handleDelete()} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm text-red-300/60 hover:text-red-300 hover:bg-red-500/10" title="删除">
                <Trash2 size={13} /> 删除
              </button>
            </>
          )}
        </div>
      </div>

      {/* 主体：左目录 + 右内容 */}
      <div className="flex-1 min-h-0 flex">
        <FolderNav entries={siblings} currentId={entryId} onOpen={openEntry} onRename={handleRenameSibling} />

        <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          {loading ? (
            <MapSectionLoader text="正在加载知识…" />
          ) : !entry ? (
            <div className="text-sm text-white/40 text-center py-20">知识不存在或已被删除</div>
          ) : editing ? (
            <div className="mx-auto py-6 px-6" style={{ maxWidth: 1400 }}>
              {effectiveMarkdown ? (
                <textarea
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  className="no-focus-ring w-full rounded-xl bg-white/[0.02] border border-white/10 px-7 py-6 text-[13.5px] leading-relaxed text-white/90 font-mono outline-none focus:border-cyan-500/40 resize-none"
                  style={{ minHeight: '70vh' }}
                  placeholder="用 Markdown 书写知识内容…"
                />
              ) : (
                <RichKnowledgeEditor value={draft} onChange={setDraft} />
              )}
            </div>
          ) : (
            <div className="mx-auto py-8 px-6" style={{ maxWidth: 1400 }}>
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
                  <span className="inline-flex items-center gap-1 text-[11px] text-white/40"><Layers size={11} /></span>
                  <select
                    value={entry.category ?? ''}
                    onChange={(e) => void handleSetCategory(e.target.value)}
                    className="no-focus-ring px-2 py-1 rounded-md bg-white/5 border border-white/10 text-[11px] text-cyan-300/90 outline-none focus:border-cyan-500/40 [&>option]:bg-[#16181d]"
                  >
                    <option value="">未分类</option>
                    {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <button onClick={() => void handleEditTags()} className="inline-flex items-center gap-1 text-[11px] text-white/40 hover:text-white" title="编辑标签">
                    <Tags size={11} />
                  </button>
                  {(entry.tags ?? []).map((t) => (
                    <span key={t} className="text-[11px] px-1.5 py-0.5 rounded bg-white/8 text-white/60">{t}</span>
                  ))}
                  {(entry.tags ?? []).length === 0 && <button onClick={() => void handleEditTags()} className="text-[11px] text-white/30 hover:text-white/60">+ 加标签</button>}
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
                <div className="flex items-center gap-2 text-[11px] text-white/30 mt-3">
                  {/* 文本类知识允许手动纠错格式（Markdown ↔ 富文本），历史误标一键修正 */}
                  {(editable || effectiveMarkdown) && !fullHtml ? (
                    <select
                      value={effectiveMarkdown ? 'text/markdown' : 'text/html'}
                      onChange={(e) => void handleSetFormat(e.target.value)}
                      className="no-focus-ring px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-[11px] text-white/50 outline-none focus:border-cyan-500/40 [&>option]:bg-[#16181d]"
                      title="文档格式（渲染与编辑方式）"
                    >
                      <option value="text/markdown">Markdown</option>
                      <option value="text/html">富文本</option>
                    </select>
                  ) : (
                    <span>{kind.label}</span>
                  )}
                  <span>
                    {fmtSize(entry.fileSize)} · 创建于 {fmtTime(entry.createdAt)}
                    {entry.updatedByName ? ` · ${entry.updatedByName} 更新于 ${fmtTime(entry.updatedAt)}` : ` · 更新于 ${fmtTime(entry.updatedAt)}`}
                  </span>
                </div>
              </div>

              <DocBody
                entry={entry}
                content={content}
                fileUrl={fileUrl}
                html={html}
                markdown={effectiveMarkdown}
                codeMode={codeMode}
                editable={editable}
                onStartEdit={startEdit}
                kindColor={kind.color}
                KindIcon={kind.icon}
              />
            </div>
          )}
        </div>
      </div>

      {linkOpen && entry && (
        <VersionLinkDialog entry={entry} versions={versions} onClose={() => setLinkOpen(false)} onSave={(ids) => void handleLinkVersions(ids)} />
      )}
    </div>
  );
}

/** 正文渲染：markdown → 富文本/HTML 预览或代码 → 图片 → PDF → 文件下载 → 空态 */
function DocBody({ entry, content, fileUrl, html, markdown, codeMode, editable, onStartEdit, kindColor, KindIcon }: {
  entry: DocumentEntry;
  content: string | null;
  fileUrl: string;
  html: boolean;
  markdown: boolean;
  codeMode: boolean;
  editable: boolean;
  onStartEdit: () => void;
  kindColor: string;
  KindIcon: LucideIcon;
}) {
  const hasText = content != null && content.trim() !== '';

  // markdown（含 contentType 误标 html 但正文无标签的纠错场景）→ 阅读排版。
  // 若被标为 markdown 但正文其实是 HTML（历史混存），按 HTML 渲染避免吐裸标签；编辑时会转成干净 md。
  if (hasText && markdown) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.02] px-7 py-6">
        {contentLooksHtml(content) ? (
          <div className="knowledge-rich text-[14.5px]" style={{ lineHeight: 1.85 }} dangerouslySetInnerHTML={{ __html: sanitizeHtml(content!) }} />
        ) : (
          <MarkdownContent content={content!} variant="reading" />
        )}
      </div>
    );
  }
  if (hasText && html) {
    if (codeMode) {
      return <pre className="rounded-xl border border-white/10 bg-white/[0.02] p-4 text-[12.5px] leading-relaxed text-white/80 overflow-x-auto whitespace-pre-wrap break-words" style={{ fontFamily: 'monospace' }}>{content}</pre>;
    }
    // 完整 HTML 文档（含 doctype/html/head/style）→ 沙箱 iframe 按真实网页渲染，保留自带样式与布局。
    // sandbox 不带 allow-same-origin：脚本跑在不透明源，拿不到父页 token/DOM，安全隔离。
    if (isFullHtmlDocument(content)) {
      return (
        <iframe
          srcDoc={content!}
          title={entry.title}
          sandbox="allow-scripts allow-popups"
          className="w-full rounded-xl border border-white/10"
          style={{ height: '78vh', background: '#fff' }}
        />
      );
    }
    // 富文本片段 → 内联渲染，融入当前主题；与编辑器同 class（knowledge-rich），所见即所得
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.02] px-7 py-6">
        <div className="knowledge-rich text-[14.5px]" style={{ lineHeight: 1.85 }} dangerouslySetInnerHTML={{ __html: sanitizeHtml(content!) }} />
      </div>
    );
  }
  if (hasText) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.02] px-7 py-6">
        <MarkdownContent content={content!} variant="reading" />
      </div>
    );
  }
  if (entry.contentType.startsWith('image/') && fileUrl) {
    return <img src={fileUrl} alt={entry.title} className="max-w-full rounded-xl border border-white/10" />;
  }
  if (entry.contentType.includes('pdf') && fileUrl) {
    return <iframe src={fileUrl} title={entry.title} className="w-full rounded-xl border border-white/10" style={{ height: '78vh' }} />;
  }
  if (fileUrl) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <KindIcon size={36} style={{ color: kindColor }} className="opacity-60" />
        <div className="text-sm text-white/55">该文件类型暂不支持在线预览</div>
        <a href={fileUrl} target="_blank" rel="noreferrer" className="px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 text-sm">
          下载 / 新窗口打开
        </a>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <div className="text-sm text-white/45">这篇知识还没有内容</div>
      {editable && (
        <button onClick={onStartEdit} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 text-sm">
          <Pencil size={13} /> 开始编写
        </button>
      )}
    </div>
  );
}

/** 左侧目录：按文件夹分组列出同库知识，高亮当前，单击切换、双击标题改名。无文件夹时平铺。 */
function FolderNav({ entries, currentId, onOpen, onRename }: {
  entries: DocumentEntry[];
  currentId: string;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const folders = entries.filter((e) => e.isFolder);
  const docs = entries.filter((e) => !e.isFolder);
  const rootDocs = docs.filter((d) => !d.parentId);
  const byFolder = (fid: string) => docs.filter((d) => d.parentId === fid);

  if (entries.length === 0) return null;

  return (
    <div className="shrink-0 w-60 border-r border-white/8 overflow-y-auto py-3 px-2" style={{ overscrollBehavior: 'contain' }}>
      <div className="px-2 pb-2 text-[11px] text-white/35 flex items-center gap-1"><FolderOpen size={12} /> 目录 · 双击标题改名</div>
      {rootDocs.map((d) => <NavItem key={d.id} entry={d} active={d.id === currentId} onOpen={onOpen} onRename={onRename} />)}
      {folders.map((f) => {
        const kids = byFolder(f.id);
        return (
          <div key={f.id} className="mt-1">
            <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-white/45">
              <FolderOpen size={12} className="text-amber-300/70" /> {f.title} <span className="text-white/25">{kids.length}</span>
            </div>
            <div className="pl-2">
              {kids.map((d) => <NavItem key={d.id} entry={d} active={d.id === currentId} onOpen={onOpen} onRename={onRename} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NavItem({ entry, active, onOpen, onRename }: {
  entry: DocumentEntry;
  active: boolean;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(entry.title);
  const kind = fileKindOf(entry.contentType);
  const Icon = kind.icon;

  const submit = () => {
    setEditing(false);
    if (val.trim() && val.trim() !== entry.title) onRename(entry.id, val.trim());
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } if (e.key === 'Escape') setEditing(false); }}
        onBlur={submit}
        className="no-focus-ring w-full text-sm bg-white/10 border border-cyan-500/40 rounded-md px-2 py-1 text-white outline-none"
      />
    );
  }

  return (
    <button
      onClick={() => onOpen(entry.id)}
      onDoubleClick={() => { setVal(entry.title); setEditing(true); }}
      className={`w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-md text-sm truncate ${active ? 'bg-cyan-500/15 text-cyan-100' : 'text-white/70 hover:bg-white/5'}`}
      title={`${entry.title}（双击改名）`}
    >
      <Icon size={13} className="shrink-0" style={{ color: active ? undefined : kind.color }} />
      <span className="truncate">{entry.title}</span>
    </button>
  );
}

function TopBtn({ onClick, icon: Icon, label }: { onClick: () => void; icon: typeof Pencil; label: string }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-sm text-white/60 hover:text-white hover:bg-white/5 border border-white/10">
      <Icon size={13} /> {label}
    </button>
  );
}
