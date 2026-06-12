/**
 * 知识库治理三 tab：分类管理 / 文件夹管理 / 标签管理。
 * 分类是 store.categories 白名单（改名/删除批量同步条目）；
 * 文件夹是 isFolder 条目（删除级联）；标签是条目 tags 的聚合视图（改名/删除批量改写）。
 */
import { useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, Check, X, FolderTree, Layers, Tags } from 'lucide-react';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import { updateDocumentStore, updateDocumentEntry, deleteDocumentEntry, createFolder } from '@/services';
import type { DocumentStore, DocumentEntry } from '@/services/contracts/documentStore';

// ── 分类管理 ──

export function CategoryManagerTab({ store, allEntries, onChanged }: {
  store: DocumentStore | null;
  allEntries: DocumentEntry[];
  onChanged: () => void;
}) {
  const categories = store?.categories ?? [];
  const docs = allEntries.filter((e) => !e.isFolder);
  const countOf = (c: string) => docs.filter((e) => e.category === c).length;
  const uncategorized = docs.filter((e) => !e.category).length;

  const persist = async (next: string[]) => {
    if (!store) return false;
    const res = await updateDocumentStore(store.id, { categories: next });
    if (!res.success) { toast.error('保存分类失败', res.error?.message); return false; }
    return true;
  };

  const handleAdd = async (name: string) => {
    const n = name.trim();
    if (!n) return;
    if (categories.includes(n)) { toast.error('分类已存在'); return; }
    if (await persist([...categories, n])) { toast.success(`已新增分类「${n}」`); onChanged(); }
  };

  const handleRename = async (oldName: string, newName: string) => {
    const n = newName.trim();
    if (!n || n === oldName) return;
    if (categories.includes(n)) { toast.error('目标分类名已存在'); return; }
    if (!(await persist(categories.map((c) => (c === oldName ? n : c))))) return;
    for (const e of docs.filter((x) => x.category === oldName)) await updateDocumentEntry(e.id, { category: n });
    toast.success('分类已改名');
    onChanged();
  };

  const handleDelete = async (name: string) => {
    const ok = await systemDialog.confirm({
      title: '删除分类', message: `删除分类「${name}」？该分类下的 ${countOf(name)} 篇文档将变为未分类（文档不删除）。`,
      tone: 'danger', confirmText: '删除', cancelText: '取消',
    });
    if (!ok) return;
    if (!(await persist(categories.filter((c) => c !== name)))) return;
    for (const e of docs.filter((x) => x.category === name)) await updateDocumentEntry(e.id, { category: '' });
    toast.success('分类已删除');
    onChanged();
  };

  return (
    <ManagerList
      icon={Layers}
      hint="分类是知识的一等维度（每篇知识归属一个分类）。改名 / 删除会自动同步所有文档。"
      items={categories.map((c) => ({ name: c, desc: `${countOf(c)} 篇` }))}
      footer={uncategorized > 0 ? `另有 ${uncategorized} 篇未分类文档` : undefined}
      addPlaceholder="新分类名称（如：竞品分析）"
      onAdd={handleAdd}
      onRename={handleRename}
      onDelete={handleDelete}
      empty="还没有分类。新增第一个分类，把知识按 MRD / SRS / PRD 等维度组织起来。"
    />
  );
}

// ── 文件夹管理 ──

export function FolderManagerTab({ storeId, allEntries, onChanged }: {
  storeId: string;
  allEntries: DocumentEntry[];
  onChanged: () => void;
}) {
  const folders = allEntries.filter((e) => e.isFolder);
  const childCount = (folderId: string) => allEntries.filter((e) => e.parentId === folderId && !e.isFolder).length;

  const handleAdd = async (name: string) => {
    const n = name.trim();
    if (!n) return;
    const res = await createFolder(storeId, n);
    if (res.success) { toast.success('文件夹已创建'); onChanged(); }
    else toast.error('创建失败', res.error?.message);
  };

  const handleRename = async (folderId: string, newName: string) => {
    const n = newName.trim();
    if (!n) return;
    const res = await updateDocumentEntry(folderId, { title: n });
    if (res.success) { toast.success('已重命名'); onChanged(); }
    else toast.error('重命名失败', res.error?.message);
  };

  const handleDelete = async (folder: DocumentEntry) => {
    const cnt = childCount(folder.id);
    const ok = await systemDialog.confirm({
      title: '删除文件夹',
      message: cnt > 0
        ? `删除文件夹「${folder.title}」将级联删除其中 ${cnt} 篇文档，此操作不可恢复。确定？`
        : `删除空文件夹「${folder.title}」？`,
      tone: 'danger', confirmText: '删除', cancelText: '取消',
    });
    if (!ok) return;
    const res = await deleteDocumentEntry(folder.id);
    if (res.success) { toast.success('已删除'); onChanged(); }
    else toast.error('删除失败', res.error?.message);
  };

  return (
    <ManagerList
      icon={FolderTree}
      hint="文件夹用于物理归档（一篇知识只在一个文件夹里）。删除文件夹会级联删除其中文档，谨慎操作。"
      items={folders.map((f) => ({ name: f.title, key: f.id, desc: `${childCount(f.id)} 篇` }))}
      addPlaceholder="新文件夹名称"
      onAdd={handleAdd}
      onRename={(key, n) => handleRename(key, n)}
      onDelete={(key) => {
        const f = folders.find((x) => x.id === key);
        if (f) void handleDelete(f);
      }}
      renameByKey
      empty="还没有文件夹。需要物理归档时再建，平铺列表 + 分类筛选通常已够用。"
    />
  );
}

// ── 标签管理 ──

export function TagManagerTab({ allEntries, onChanged }: {
  allEntries: DocumentEntry[];
  onChanged: () => void;
}) {
  const docs = allEntries.filter((e) => !e.isFolder);
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of docs) for (const t of e.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0], 'zh'));
  }, [docs]);

  const handleRename = async (oldName: string, newName: string) => {
    const n = newName.trim();
    if (!n || n === oldName) return;
    for (const e of docs.filter((x) => (x.tags ?? []).includes(oldName))) {
      const next = Array.from(new Set((e.tags ?? []).map((t) => (t === oldName ? n : t))));
      await updateDocumentEntry(e.id, { tags: next });
    }
    toast.success('标签已改名');
    onChanged();
  };

  const handleDelete = async (name: string) => {
    const ok = await systemDialog.confirm({
      title: '删除标签', message: `从所有文档移除标签「${name}」？`,
      tone: 'danger', confirmText: '删除', cancelText: '取消',
    });
    if (!ok) return;
    for (const e of docs.filter((x) => (x.tags ?? []).includes(name))) {
      await updateDocumentEntry(e.id, { tags: (e.tags ?? []).filter((t) => t !== name) });
    }
    toast.success('标签已删除');
    onChanged();
  };

  return (
    <ManagerList
      icon={Tags}
      hint="标签是自由维度（一篇知识可挂多个标签），在知识详情页编辑。这里做全局改名 / 删除。"
      items={tagCounts.map(([name, count]) => ({ name, desc: `${count} 处引用` }))}
      onRename={handleRename}
      onDelete={handleDelete}
      empty="还没有标签。在知识详情页给文档打标签后，这里可统一治理。"
    />
  );
}

// ── 通用管理列表（行内改名 + 删除 + 可选底部新增）──

interface ManagerItem { name: string; desc?: string; key?: string }

function ManagerList({ icon: Icon, hint, items, footer, addPlaceholder, onAdd, onRename, onDelete, renameByKey, empty }: {
  icon: typeof Layers;
  hint: string;
  items: ManagerItem[];
  footer?: string;
  addPlaceholder?: string;
  onAdd?: (name: string) => void | Promise<void>;
  onRename: (nameOrKey: string, newName: string) => void | Promise<void>;
  onDelete: (nameOrKey: string) => void | Promise<void>;
  /** true 时 onRename/onDelete 的第一个参数用 item.key（文件夹场景用 id） */
  renameByKey?: boolean;
  empty: string;
}) {
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const idOf = (it: ManagerItem) => (renameByKey ? (it.key ?? it.name) : it.name);

  const submitAdd = () => {
    if (!adding.trim() || !onAdd) return;
    void onAdd(adding.trim());
    setAdding('');
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3 max-w-2xl">
      <div className="shrink-0 flex items-start gap-2 text-xs text-white/45 px-1">
        <Icon size={14} className="mt-0.5 shrink-0 text-cyan-400/70" /> {hint}
      </div>

      {onAdd && (
        <div className="shrink-0 flex items-center gap-2">
          <input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitAdd(); }}
            placeholder={addPlaceholder}
            className="flex-1 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40 placeholder:text-white/25"
          />
          <button
            onClick={submitAdd}
            disabled={!adding.trim()}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 disabled:opacity-40 text-sm"
          >
            <Plus size={14} /> 新增
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5" style={{ overscrollBehavior: 'contain' }}>
        {items.length === 0 ? (
          <div className="text-xs text-white/35 text-center py-12 px-6">{empty}</div>
        ) : (
          items.map((it) => {
            const id = idOf(it);
            const isEditing = editing === id;
            return (
              <div key={id} className="pa-row flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/5">
                {isEditing ? (
                  <>
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { void onRename(id, editValue); setEditing(null); }
                        if (e.key === 'Escape') setEditing(null);
                      }}
                      className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm text-white outline-none focus:border-cyan-500/40"
                    />
                    <button onClick={() => { void onRename(id, editValue); setEditing(null); }} className="text-cyan-300 hover:text-cyan-200 p-1" title="保存"><Check size={14} /></button>
                    <button onClick={() => setEditing(null)} className="text-white/40 hover:text-white p-1" title="取消"><X size={14} /></button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-sm text-white/85 truncate">{it.name}</span>
                    {it.desc && <span className="text-[11px] text-white/35 shrink-0">{it.desc}</span>}
                    <button onClick={() => { setEditing(id); setEditValue(it.name); }} className="text-white/40 hover:text-cyan-300 p-1 shrink-0" title="改名"><Pencil size={13} /></button>
                    <button onClick={() => void onDelete(id)} className="text-white/40 hover:text-red-300 p-1 shrink-0" title="删除"><Trash2 size={13} /></button>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
      {footer && <div className="shrink-0 text-[11px] text-white/30 px-1">{footer}</div>}
    </div>
  );
}
