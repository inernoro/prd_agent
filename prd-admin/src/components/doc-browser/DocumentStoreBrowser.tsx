import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, FileText, Upload } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { DocBrowser, type DocBrowserEntry, type EntryPreview } from '@/components/doc-browser/DocBrowser';
import type { DocumentEntry } from '@/services/contracts/documentStore';
import {
  listDocumentEntries, searchDocumentEntries, rebuildContentIndex, getDocumentContent, updateDocumentContent,
  uploadDocumentFile, replaceDocumentFile, deleteDocumentEntry, updateDocumentEntry,
  moveDocumentEntry, createFolder, addDocumentEntry,
} from '@/services';

interface Props {
  storeId: string;
  /** 是否可写。false 时不传写回调，DocBrowser 自动只读 */
  canWrite: boolean;
  /**
   * 可选：预置文档分类（以文档标签实现）。传入后在左侧顶部渲染分类筛选 chips
   * + 快速新建标准文档按钮。不传则维持原有无分类行为（pm-agent 等不受影响）。
   */
  categories?: { key: string; label: string }[];
}

/**
 * 文档库浏览器 —— 封装 DocBrowser + document-store 现有 service，按 storeId 渲染。
 * 复用文件夹/多格式上传/MD·HTML 预览/标签全套能力。供「项目知识库」等场景接入。
 */
export function DocumentStoreBrowser({ storeId, canWrite, categories }: Props) {
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>();
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [autoEditEntryId, setAutoEditEntryId] = useState<string | undefined>();
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);
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

  const handleCreateDocument = useCallback(async () => {
    const res = await addDocumentEntry(storeId, { title: '新建文档', sourceType: 'upload', contentType: 'text/markdown', summary: '' });
    if (res.success) { setEntries((prev) => [res.data, ...prev]); setSelectedEntryId(res.data.id); setAutoEditEntryId(res.data.id); toast.success('已创建文档，开始写作吧'); }
    else toast.error('创建失败', res.error?.message);
  }, [storeId]);

  // 按分类快速新建标准文档（分类即文档标签）
  const handleCreateInCategory = useCallback(async (label: string) => {
    const res = await addDocumentEntry(storeId, { title: `${label} 文档`, sourceType: 'upload', contentType: 'text/markdown', summary: '', tags: [label] });
    if (res.success) {
      const entry = { ...res.data, tags: res.data.tags?.length ? res.data.tags : [label] };
      setEntries((prev) => [entry, ...prev]);
      setSelectedEntryId(entry.id); setAutoEditEntryId(entry.id); setActiveCat(label);
      toast.success(`已创建 ${label} 文档`);
    } else toast.error('创建失败', res.error?.message);
  }, [storeId]);

  const handleSearch = useCallback(async (keyword: string, contentSearch: boolean): Promise<DocBrowserEntry[] | null> => {
    if (contentSearch) await rebuildContentIndex(storeId);
    const res = await searchDocumentEntries(storeId, keyword, contentSearch);
    return res.success ? res.data.items : null;
  }, [storeId]);

  // 分类筛选（仅当传入 categories）：分类=文档标签，文件夹始终保留以维持树结构
  const cats = categories ?? [];
  const catLabels = cats.map((c) => c.label);
  const docCount = (label: string | null): number => {
    const docs = entries.filter((e) => !e.isFolder);
    if (label === null) return docs.length;
    if (label === '__other__') return docs.filter((e) => !catLabels.some((l) => (e.tags ?? []).includes(l))).length;
    return docs.filter((e) => (e.tags ?? []).includes(label)).length;
  };
  const displayEntries = !cats.length || activeCat === null
    ? entries
    : entries.filter((e) => {
        if (e.isFolder) return true;
        const tags = e.tags ?? [];
        if (activeCat === '__other__') return !catLabels.some((l) => tags.includes(l));
        return tags.includes(activeCat);
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

  const categoryHeader = cats.length ? (
    <div className="flex flex-col gap-2 px-1 pb-2">
      <div className="flex flex-wrap gap-1">
        {catChip(null, '全部')}
        {cats.map((c) => catChip(c.label, c.label))}
        {catChip('__other__', '其他')}
      </div>
      {canWrite && (
        <div className="flex flex-wrap gap-1">
          {cats.map((c) => (
            <button
              key={c.key}
              onClick={() => handleCreateInCategory(c.label)}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] text-white/50 border border-dashed border-white/15 hover:bg-white/5 hover:text-cyan-300"
              title={`快速新建 ${c.label} 文档`}
            >
              <FileText size={11} /> {c.label}
            </button>
          ))}
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
        defaultUseContentTitle={cats.length ? false : undefined}
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
    </div>
  );
}
