import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, FileText, Upload, FolderPlus, Tags, Layers, Plus, Pencil, Trash2, X } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import { DocBrowser, type DocBrowserEntry, type EntryPreview } from '@/components/doc-browser/DocBrowser';
import type { DocumentEntry, DocumentStore } from '@/services/contracts/documentStore';
import {
  listDocumentEntries, searchDocumentEntries, rebuildContentIndex, getDocumentContent, updateDocumentContent,
  uploadDocumentFile, replaceDocumentFile, deleteDocumentEntry, updateDocumentEntry,
  moveDocumentEntry, createFolder, addDocumentEntry, getDocumentStore, updateDocumentStore,
} from '@/services';

interface Props {
  storeId: string;
  /** 是否可写。false 时不传写回调，DocBrowser 自动只读 */
  canWrite: boolean;
  /**
   * 可选：启用「分类」一等维度（区别于自由标签）。开启后顶部渲染分类筛选 chips +
   * 快速新建标准文档 + 分类/标签管理面板，右键可改条目分类。不传则维持原有无分类行为。
   */
  enableCategories?: boolean;
  /** 首次进入（store 无分类）时种子化的预置分类名。仅 enableCategories+canWrite 时生效。 */
  categoryPresets?: string[];
  /** 「添加」菜单项：从网页托管导入（可写时透传给 DocBrowser）。选择/导入流程由调用方实现。 */
  onImportFromHosting?: () => void;
}

const NO_CAT = '__none__';

/**
 * 文档库浏览器 —— 封装 DocBrowser + document-store 现有 service，按 storeId 渲染。
 * 复用文件夹/多格式上传/MD·HTML 预览/标签全套能力。供「项目知识库」等场景接入。
 * enableCategories 时额外提供：分类筛选 + 快速新建 + 分类/标签集中管理 + 右键改分类。
 */
export function DocumentStoreBrowser({ storeId, canWrite, enableCategories, categoryPresets, onImportFromHosting }: Props) {
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const [store, setStore] = useState<DocumentStore | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>();
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [autoEditEntryId, setAutoEditEntryId] = useState<string | undefined>();
  const [dragging, setDragging] = useState(false);
  const [managePanel, setManagePanel] = useState<'category' | 'tag' | null>(null);
  const dragCounter = useRef(0);
  const seededRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetRef = useRef<string | null>(null);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    const res = await listDocumentEntries(storeId, 1, 200);
    if (res.success) setEntries(res.data.items);
    setLoading(false);
  }, [storeId]);
  useEffect(() => { loadEntries(); }, [loadEntries]);

  // 加载 store（取分类清单）；首次无分类时种子化预置分类
  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await getDocumentStore(storeId);
      if (!alive || !res.success) return;
      let s = res.data;
      if (enableCategories && canWrite && !seededRef.current && (s.categories?.length ?? 0) === 0 && (categoryPresets?.length ?? 0) > 0) {
        seededRef.current = true;
        const up = await updateDocumentStore(storeId, { categories: categoryPresets });
        if (up.success) s = up.data;
      }
      if (alive) setStore(s);
    })();
    return () => { alive = false; };
  }, [storeId, enableCategories, canWrite, categoryPresets]);

  const categories = useMemo(() => store?.categories ?? [], [store]);

  const handleFiles = useCallback(async (files: File[]) => {
    setUploading(true);
    let ok = 0;
    for (const file of files) {
      const res = await uploadDocumentFile(storeId, file);
      if (res.success) { setEntries((prev) => [res.data.entry, ...prev]); ok++; }
      else toast.error(`上传失败: ${file.name}`, res.error?.message);
    }
    if (ok > 0) toast.success('上传完成', `${ok} 个文件已存储`);
    setUploading(false);
  }, [storeId]);

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fs = Array.from(e.target.files ?? []);
    e.currentTarget.value = '';
    if (fs.length) handleFiles(fs);
  };

  const handleReplaceFile = useCallback((entryId: string) => { replaceTargetRef.current = entryId; replaceInputRef.current?.click(); }, []);
  const onReplacePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.currentTarget.value = '';
    const entryId = replaceTargetRef.current;
    replaceTargetRef.current = null;
    if (!f || !entryId) return;
    setUploading(true);
    const res = await replaceDocumentFile(entryId, f);
    if (res.success) { setEntries((prev) => prev.map((x) => (x.id === entryId ? { ...x, ...res.data.entry } : x))); toast.success('替换成功', '内容已更新，标签与位置保留'); }
    else toast.error('替换失败', res.error?.message);
    setUploading(false);
  };

  const isFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');
  const handleDragEnter = useCallback((e: React.DragEvent) => { if (!canWrite || !isFileDrag(e)) return; e.preventDefault(); e.stopPropagation(); dragCounter.current += 1; if (dragCounter.current === 1) setDragging(true); }, [canWrite]);
  const handleDragLeave = useCallback((e: React.DragEvent) => { if (!canWrite || !isFileDrag(e)) return; e.preventDefault(); e.stopPropagation(); dragCounter.current -= 1; if (dragCounter.current === 0) setDragging(false); }, [canWrite]);
  const handleDragOver = useCallback((e: React.DragEvent) => { if (!canWrite || !isFileDrag(e)) return; e.preventDefault(); }, [canWrite]);
  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!canWrite || !isFileDrag(e)) return;
    e.preventDefault(); e.stopPropagation();
    setDragging(false); dragCounter.current = 0;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) handleFiles(files);
  }, [canWrite, handleFiles]);

  const loadContent = useCallback(async (entryId: string): Promise<EntryPreview | null> => {
    const res = await getDocumentContent(entryId);
    if (!res.success) return null;
    return { text: res.data.hasContent ? res.data.content : null, fileUrl: res.data.fileUrl, contentType: res.data.contentType };
  }, []);

  const handleSaveContent = useCallback(async (entryId: string, newContent: string) => {
    const res = await updateDocumentContent(entryId, newContent);
    if (!res.success) { toast.error('保存失败', res.error?.message); throw new Error(res.error?.message ?? '保存失败'); }
    const summary = newContent.length > 200 ? newContent.slice(0, 200) : newContent;
    setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, summary: summary.trim(), updatedAt: res.data.updatedAt ?? e.updatedAt, updatedBy: res.data.updatedBy ?? e.updatedBy, updatedByName: res.data.updatedByName ?? e.updatedByName } : e)));
    toast.success('已保存');
  }, []);

  const handleDeleteEntry = useCallback(async (entryId: string) => {
    const res = await deleteDocumentEntry(entryId);
    if (res.success) { setEntries((prev) => prev.filter((e) => e.id !== entryId)); if (selectedEntryId === entryId) setSelectedEntryId(undefined); toast.success('已删除'); }
    else toast.error('删除失败', res.error?.message);
  }, [selectedEntryId]);

  const handleUpdateEntryTags = useCallback(async (entryId: string, tags: string[]) => {
    const res = await updateDocumentEntry(entryId, { tags });
    if (!res.success) { toast.error('标签更新失败', res.error?.message); throw new Error(res.error?.message ?? '标签更新失败'); }
    setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, ...res.data, tags: res.data.tags ?? tags } : e)));
    toast.success(tags.length > 0 ? '标签已更新' : '标签已清空');
  }, []);

  const handleRenameEntry = useCallback(async (entryId: string, newTitle: string) => {
    const res = await updateDocumentEntry(entryId, { title: newTitle });
    if (!res.success) { toast.error('重命名失败', res.error?.message); throw new Error(res.error?.message ?? '重命名失败'); }
    setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, ...res.data, title: res.data.title ?? newTitle } : e)));
    toast.success('已重命名');
  }, []);

  const handleMoveEntry = useCallback(async (entryId: string, targetFolderId: string | null) => {
    const res = await moveDocumentEntry(entryId, targetFolderId);
    if (res.success) { setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, parentId: targetFolderId ?? undefined } : e))); toast.success('已移动'); }
    else toast.error('移动失败', res.error?.message);
  }, []);

  const handleCreateFolder = useCallback(async (name: string, parentId?: string) => {
    const res = await createFolder(storeId, name, parentId);
    if (res.success) { setEntries((prev) => [res.data, ...prev]); toast.success('文件夹已创建'); }
    else toast.error('创建失败', res.error?.message);
  }, [storeId]);

  // 顶部可见「新建文件夹」按钮（提升可发现性）
  const promptCreateFolder = useCallback(async () => {
    const name = await systemDialog.prompt({ title: '新建文件夹', message: '输入文件夹名称', defaultValue: '新建文件夹', confirmText: '创建' });
    if (name && name.trim()) await handleCreateFolder(name.trim());
  }, [handleCreateFolder]);

  const handleCreateDocument = useCallback(async () => {
    const res = await addDocumentEntry(storeId, { title: '新建文档', sourceType: 'upload', contentType: 'text/markdown', summary: '' });
    if (res.success) { setEntries((prev) => [res.data, ...prev]); setSelectedEntryId(res.data.id); setAutoEditEntryId(res.data.id); toast.success('已创建文档，开始写作吧'); }
    else toast.error('创建失败', res.error?.message);
  }, [storeId]);

  // 按分类快速新建标准文档（分类为一等字段）
  const handleCreateInCategory = useCallback(async (cat: string) => {
    const res = await addDocumentEntry(storeId, { title: `${cat} 文档`, sourceType: 'upload', contentType: 'text/markdown', summary: '', category: cat });
    if (res.success) {
      const entry = { ...res.data, category: res.data.category ?? cat };
      setEntries((prev) => [entry, ...prev]);
      setSelectedEntryId(entry.id); setAutoEditEntryId(entry.id); setActiveCat(cat);
      toast.success(`已创建 ${cat} 文档`);
    } else toast.error('创建失败', res.error?.message);
  }, [storeId]);

  // 右键设置条目分类（null=清除）
  const handleSetEntryCategory = useCallback(async (entryId: string, cat: string | null) => {
    const res = await updateDocumentEntry(entryId, { category: cat ?? '' });
    if (!res.success) { toast.error('设置分类失败', res.error?.message); return; }
    setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, category: cat ?? undefined } : e)));
    toast.success(cat ? `已归入「${cat}」` : '已移出分类');
  }, []);

  const handleSearch = useCallback(async (keyword: string, contentSearch: boolean): Promise<DocBrowserEntry[] | null> => {
    if (contentSearch) await rebuildContentIndex(storeId);
    const res = await searchDocumentEntries(storeId, keyword, contentSearch);
    return res.success ? res.data.items : null;
  }, [storeId]);

  // ── 分类管理（写 store.categories；改名/删除同步条目）──
  const persistCategories = useCallback(async (next: string[]) => {
    const res = await updateDocumentStore(storeId, { categories: next });
    if (res.success) setStore(res.data);
    else { toast.error('保存分类失败', res.error?.message); throw new Error('保存分类失败'); }
  }, [storeId]);

  const addCategory = useCallback(async (name: string) => {
    const n = name.trim();
    if (!n || categories.includes(n)) return;
    await persistCategories([...categories, n]);
    toast.success(`已新增分类「${n}」`);
  }, [categories, persistCategories]);

  const renameCategory = useCallback(async (oldName: string, newName: string) => {
    const n = newName.trim();
    if (!n || n === oldName || categories.includes(n)) return;
    await persistCategories(categories.map((c) => (c === oldName ? n : c)));
    // 同步条目
    const affected = entries.filter((e) => e.category === oldName);
    for (const e of affected) await updateDocumentEntry(e.id, { category: n });
    setEntries((prev) => prev.map((e) => (e.category === oldName ? { ...e, category: n } : e)));
    if (activeCat === oldName) setActiveCat(n);
    toast.success('分类已改名');
  }, [categories, entries, persistCategories, activeCat]);

  const deleteCategory = useCallback(async (name: string) => {
    const ok = await systemDialog.confirm({ title: '删除分类', message: `删除分类「${name}」？该分类下的文档将变为未分类（文档本身不删除）。`, tone: 'danger', confirmText: '删除', cancelText: '取消' });
    if (!ok) return;
    await persistCategories(categories.filter((c) => c !== name));
    const affected = entries.filter((e) => e.category === name);
    for (const e of affected) await updateDocumentEntry(e.id, { category: '' });
    setEntries((prev) => prev.map((e) => (e.category === name ? { ...e, category: undefined } : e)));
    if (activeCat === name) setActiveCat(null);
    toast.success('分类已删除');
  }, [categories, entries, persistCategories, activeCat]);

  // ── 标签管理（批量改写条目 tags）──
  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) for (const t of e.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0], 'zh'));
  }, [entries]);

  const renameTag = useCallback(async (oldName: string, newName: string) => {
    const n = newName.trim();
    if (!n || n === oldName) return;
    const affected = entries.filter((e) => (e.tags ?? []).includes(oldName));
    for (const e of affected) {
      const next = Array.from(new Set((e.tags ?? []).map((t) => (t === oldName ? n : t))));
      await updateDocumentEntry(e.id, { tags: next });
    }
    setEntries((prev) => prev.map((e) => ((e.tags ?? []).includes(oldName) ? { ...e, tags: Array.from(new Set((e.tags ?? []).map((t) => (t === oldName ? n : t)))) } : e)));
    toast.success('标签已改名');
  }, [entries]);

  const deleteTag = useCallback(async (name: string) => {
    const ok = await systemDialog.confirm({ title: '删除标签', message: `从所有文档移除标签「${name}」？`, tone: 'danger', confirmText: '删除', cancelText: '取消' });
    if (!ok) return;
    const affected = entries.filter((e) => (e.tags ?? []).includes(name));
    for (const e of affected) await updateDocumentEntry(e.id, { tags: (e.tags ?? []).filter((t) => t !== name) });
    setEntries((prev) => prev.map((e) => ((e.tags ?? []).includes(name) ? { ...e, tags: (e.tags ?? []).filter((t) => t !== name) } : e)));
    toast.success('标签已删除');
  }, [entries]);

  // ── 分类筛选（按 entry.category；文件夹始终保留以维持树结构）──
  const docCount = (value: string | null): number => {
    const docs = entries.filter((e) => !e.isFolder);
    if (value === null) return docs.length;
    if (value === NO_CAT) return docs.filter((e) => !e.category).length;
    return docs.filter((e) => e.category === value).length;
  };
  const displayEntries = !enableCategories || activeCat === null
    ? entries
    : entries.filter((e) => {
        if (e.isFolder) return true;
        if (activeCat === NO_CAT) return !e.category;
        return e.category === activeCat;
      });

  const catChip = (value: string | null, label: string) => {
    const on = activeCat === value;
    return (
      <button
        key={value ?? '__all__'}
        onClick={() => setActiveCat(value)}
        className={`px-2 py-0.5 rounded-md text-[11px] border ${on ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' : 'text-white/45 border-white/10 hover:bg-white/5'}`}
      >
        {label} <span className="opacity-60">{docCount(value)}</span>
      </button>
    );
  };

  const categoryHeader = enableCategories ? (
    <div className="flex flex-col gap-2 px-1 pb-2">
      <div className="flex flex-wrap gap-1">
        {catChip(null, '全部')}
        {categories.map((c) => catChip(c, c))}
        {catChip(NO_CAT, '未分类')}
      </div>
      {canWrite && (
        <div className="flex flex-wrap items-center gap-1">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => handleCreateInCategory(c)}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] text-white/50 border border-dashed border-white/15 hover:bg-white/5 hover:text-cyan-300"
              title={`快速新建 ${c} 文档`}
            >
              <FileText size={11} /> {c}
            </button>
          ))}
        </div>
      )}
      {canWrite && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <button onClick={promptCreateFolder} className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-white/55 border border-white/10 hover:bg-white/5"><FolderPlus size={12} /> 新建文件夹</button>
          <button onClick={() => setManagePanel('category')} className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-white/55 border border-white/10 hover:bg-white/5"><Layers size={12} /> 分类管理</button>
          <button onClick={() => setManagePanel('tag')} className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-white/55 border border-white/10 hover:bg-white/5"><Tags size={12} /> 标签管理</button>
        </div>
      )}
    </div>
  ) : undefined;

  const writeProps = canWrite ? {
    onDeleteEntry: handleDeleteEntry,
    onUpdateEntryTags: handleUpdateEntryTags,
    onRenameEntry: handleRenameEntry,
    onMoveEntry: handleMoveEntry,
    onSaveContent: handleSaveContent,
    onCreateFolder: handleCreateFolder,
    onCreateDocument: handleCreateDocument,
    onUploadFile: () => fileInputRef.current?.click(),
    onImportFromHosting,
    onReplaceFile: handleReplaceFile,
  } : {};

  return (
    <div className="flex-1 min-h-0 flex flex-col relative"
      onDragEnter={handleDragEnter} onDragLeave={handleDragLeave} onDragOver={handleDragOver} onDrop={handleDrop}>
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onPickFiles} />
      <input ref={replaceInputRef} type="file" className="hidden" onChange={onReplacePick} />

      {dragging && (
        <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed pointer-events-none"
          style={{ background: 'rgba(59,130,246,0.08)', borderColor: '#3B82F6' }}>
          <div className="flex flex-col items-center gap-2" style={{ color: '#3B82F6' }}>
            <Upload size={28} /><span className="text-[13px]">松开上传到当前知识库</span>
          </div>
        </div>
      )}

      <DocBrowser
        entries={displayEntries}
        selectedEntryId={selectedEntryId}
        onSelectEntry={setSelectedEntryId}
        loadContent={loadContent}
        onSearch={handleSearch}
        loading={loading}
        autoEditEntryId={autoEditEntryId}
        onAutoEditConsumed={() => setAutoEditEntryId(undefined)}
        sidebarHeader={categoryHeader}
        defaultUseContentTitle={enableCategories ? false : undefined}
        categories={enableCategories ? categories : undefined}
        onSetEntryCategory={enableCategories && canWrite ? handleSetEntryCategory : undefined}
        {...writeProps}
        emptyState={
          <div className="flex-1 flex flex-col items-center justify-center py-16">
            <FolderOpen size={40} className="mb-4 opacity-30" style={{ color: 'var(--text-muted)' }} />
            <p className="mb-1 text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>还没有文档</p>
            <p className="mb-5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {canWrite ? '新建一篇空白文档，或上传 / 拖拽文件（md / html / pdf / Office 等）' : '该项目知识库暂无内容'}
            </p>
            {canWrite && (
              <div className="flex items-center gap-2.5">
                <Button variant="primary" size="md" onClick={handleCreateDocument}><FileText size={15} />新建文档</Button>
                <Button variant="secondary" size="md" onClick={() => fileInputRef.current?.click()} disabled={uploading}><Upload size={15} />上传文件</Button>
              </div>
            )}
          </div>
        }
      />

      {managePanel === 'category' && (
        <ListManagerDialog
          title="分类管理"
          items={categories.map((c) => ({ name: c, count: docCount(c) }))}
          countLabel="篇"
          addPlaceholder="新分类名称"
          onAdd={addCategory}
          onRename={renameCategory}
          onDelete={deleteCategory}
          onClose={() => setManagePanel(null)}
        />
      )}
      {managePanel === 'tag' && (
        <ListManagerDialog
          title="标签管理"
          items={allTags.map(([name, count]) => ({ name, count }))}
          countLabel="处"
          addPlaceholder=""
          onRename={renameTag}
          onDelete={deleteTag}
          onClose={() => setManagePanel(null)}
        />
      )}
    </div>
  );
}

/** 通用清单管理对话框：用于分类/标签的新增/改名/删除。onAdd 不传则不显示新增框。 */
function ListManagerDialog({
  title, items, countLabel, addPlaceholder, onAdd, onRename, onDelete, onClose,
}: {
  title: string;
  items: { name: string; count: number }[];
  countLabel: string;
  addPlaceholder: string;
  onAdd?: (name: string) => Promise<void>;
  onRename: (oldName: string, newName: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="rounded-xl border border-white/10 bg-[#16181d] flex flex-col" style={{ width: 440, maxWidth: '92vw', maxHeight: '80vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-1.5" style={{ minHeight: 0, overscrollBehavior: 'contain' }}>
          {items.length === 0 && <div className="text-[12px] text-white/35 text-center py-6">暂无{title.replace('管理', '')}</div>}
          {items.map((it) => (
            <div key={it.name} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/[0.03] border border-white/5">
              {editing === it.name ? (
                <>
                  <input
                    autoFocus
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { void onRename(it.name, editValue).then(() => setEditing(null)); } if (e.key === 'Escape') setEditing(null); }}
                    className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm text-white outline-none focus:border-cyan-500/40"
                  />
                  <button onClick={() => void onRename(it.name, editValue).then(() => setEditing(null))} className="text-[12px] text-cyan-300 hover:text-cyan-200 px-1.5">保存</button>
                  <button onClick={() => setEditing(null)} className="text-[12px] text-white/40 hover:text-white px-1">取消</button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-sm text-white/85 truncate">{it.name}</span>
                  <span className="text-[11px] text-white/35 shrink-0">{it.count} {countLabel}</span>
                  <button onClick={() => { setEditing(it.name); setEditValue(it.name); }} className="text-white/40 hover:text-cyan-300 shrink-0" title="改名"><Pencil size={13} /></button>
                  <button onClick={() => void onDelete(it.name)} className="text-white/40 hover:text-red-300 shrink-0" title="删除"><Trash2 size={13} /></button>
                </>
              )}
            </div>
          ))}
        </div>
        {onAdd && (
          <div className="flex items-center gap-2 px-3 py-3 border-t border-white/10 shrink-0">
            <input
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && adding.trim()) { void onAdd(adding.trim()).then(() => setAdding('')); } }}
              placeholder={addPlaceholder}
              className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white outline-none focus:border-cyan-500/40 placeholder:text-white/25"
            />
            <button
              onClick={() => { if (adding.trim()) void onAdd(adding.trim()).then(() => setAdding('')); }}
              disabled={!adding.trim()}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 disabled:opacity-40 text-sm"
            >
              <Plus size={14} /> 新增
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
