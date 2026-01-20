import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { TabBar } from '@/components/design/TabBar';
import { useContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { systemDialog } from '@/lib/systemDialog';
import {
  createVisualAgentWorkspace,
  deleteVisualAgentWorkspace,
  listVisualAgentWorkspaces,
  updateVisualAgentWorkspace,
} from '@/services';
import type { VisualAgentWorkspace } from '@/services/contracts/visualAgent';
import { Plus, Pencil, Trash2, FileText, SquarePen, FolderOpen, ChevronDown, ChevronRight, FolderPlus, MoveRight, BookOpen } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';

function formatDate(iso: string | null | undefined) {
  const s = String(iso ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString();
}

function getArticlePreviewText(ws: VisualAgentWorkspace, maxChars = 200) {
  const raw = ws.articleContent ?? ws.articleContentWithMarkers ?? '';
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/^\s*\[插图\]\s*:\s*.*$/gm, '');
  s = s.replace(/^\s*>\s*配图.*$/gm, '');
  s = s.trim();
  const softLimit = Math.max(800, maxChars);
  if (s.length <= softLimit) return s;
  return s.slice(0, softLimit);
}

function ArticlePreview({ markdown }: { markdown: string }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [overflowed, setOverflowed] = useState(false);
  const md = useMemo(() => String(markdown || '').trim(), [markdown]);
  const maxHeightPx = 100;

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setOverflowed(el.scrollHeight - el.clientHeight > 1);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure()) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [md]);

  if (!md) return <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>(暂无内容)</div>;

  return (
    <div className="relative overflow-hidden" style={{ maxHeight: maxHeightPx }}>
      <div ref={rootRef} className="overflow-hidden" style={{ maxHeight: maxHeightPx }}>
        <style>{`
          .literary-preview-md { font-size: 10px; line-height: 1.4; color: var(--text-secondary); white-space: normal; word-break: break-word; }
          .literary-preview-md h1,.literary-preview-md h2,.literary-preview-md h3 { color: var(--text-primary); font-weight: 700; margin: 4px 0 2px; font-size: 11px; }
          .literary-preview-md p { margin: 2px 0; }
          .literary-preview-md ul,.literary-preview-md ol { margin: 2px 0; padding-left: 12px; }
          .literary-preview-md li { margin: 1px 0; }
          .literary-preview-md blockquote { margin: 2px 0; padding: 2px 6px; border-left: 2px solid rgba(231,206,151,0.35); background: rgba(231,206,151,0.06); border-radius: 4px; }
          .literary-preview-md code { font-size: 9px; background: rgba(255,255,255,0.06); padding: 0 3px; border-radius: 3px; }
        `}</style>
        <div className="literary-preview-md">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            skipHtml
            allowedElements={['p', 'strong', 'em', 'code', 'blockquote', 'ul', 'ol', 'li', 'br', 'h1', 'h2', 'h3']}
            unwrapDisallowed
            components={{ a: ({ children }) => <span>{children}</span> }}
          >
            {md}
          </ReactMarkdown>
        </div>
      </div>
      {overflowed && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0"
          style={{ height: 24, background: 'linear-gradient(to bottom, rgba(18,18,18,0), rgba(18,18,18,0.95))' }}
        />
      )}
    </div>
  );
}

type FolderGroup = {
  folderName: string | null;
  items: VisualAgentWorkspace[];
};

export default function LiteraryAgentWorkspaceListPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<VisualAgentWorkspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const contextMenu = useContextMenu();

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await listVisualAgentWorkspaces({ limit: 100 });
      if (!res.success) {
        setError(res.error?.message || '加载失败');
        return;
      }
      const list = Array.isArray(res.data?.items) ? res.data.items : [];
      const filtered = list.filter((item) => item.scenarioType === 'article-illustration');
      setItems(filtered);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 按 folderName 分组
  const groups = useMemo<FolderGroup[]>(() => {
    const map = new Map<string | null, VisualAgentWorkspace[]>();
    for (const ws of items) {
      const key = ws.folderName ?? null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ws);
    }
    const result: FolderGroup[] = [];
    // 有文件夹的先显示，按名称排序
    const folderNames = [...map.keys()].filter((k) => k !== null).sort() as string[];
    for (const fn of folderNames) {
      result.push({ folderName: fn, items: map.get(fn)! });
    }
    // 未分类的最后显示
    if (map.has(null)) {
      result.push({ folderName: null, items: map.get(null)! });
    }
    return result;
  }, [items]);

  // 获取所有文件夹名称
  const allFolderNames = useMemo(() => {
    const set = new Set<string>();
    for (const ws of items) {
      if (ws.folderName) set.add(ws.folderName);
    }
    return [...set].sort();
  }, [items]);

  const onCreate = async (folderName?: string | null) => {
    const title = await systemDialog.prompt({
      title: '新建文章',
      message: '请输入文章标题',
      placeholder: '未命名',
      confirmText: '创建',
      cancelText: '取消',
    });
    if (!title) return;
    const res = await createVisualAgentWorkspace({
      title,
      scenarioType: 'article-illustration',
      idempotencyKey: `create-literary-${Date.now()}`,
    });
    if (!res.success) {
      await systemDialog.alert({ title: '创建失败', message: res.error?.message || '未知错误', confirmText: '确定' });
      return;
    }
    // 如果指定了文件夹，设置 folderName
    if (folderName && res.data?.workspace?.id) {
      await updateVisualAgentWorkspace({
        id: res.data.workspace.id,
        folderName,
        idempotencyKey: `set-folder-${res.data.workspace.id}-${Date.now()}`,
      });
    }
    await reload();
    if (res.data?.workspace?.id) {
      navigate(`/literary-agent/${res.data.workspace.id}`);
    }
  };

  const onCreateFolder = async () => {
    const name = await systemDialog.prompt({
      title: '新建文件夹',
      message: '请输入文件夹名称',
      placeholder: '我的文件夹',
      confirmText: '创建',
      cancelText: '取消',
    });
    if (!name) return;
    // 创建一个新文章并设置 folderName
    const res = await createVisualAgentWorkspace({
      title: '未命名',
      scenarioType: 'article-illustration',
      idempotencyKey: `create-literary-folder-${Date.now()}`,
    });
    if (res.success && res.data?.workspace?.id) {
      await updateVisualAgentWorkspace({
        id: res.data.workspace.id,
        folderName: name,
        idempotencyKey: `set-folder-${res.data.workspace.id}-${Date.now()}`,
      });
      await reload();
    }
  };

  const onRenameFolder = async (oldName: string) => {
    const newName = await systemDialog.prompt({
      title: '重命名文件夹',
      message: '请输入新的文件夹名称',
      placeholder: oldName,
      defaultValue: oldName,
      confirmText: '重命名',
      cancelText: '取消',
    });
    if (!newName || newName === oldName) return;
    // 批量更新所有同名文章的 folderName
    const toUpdate = items.filter((ws) => ws.folderName === oldName);
    for (const ws of toUpdate) {
      await updateVisualAgentWorkspace({
        id: ws.id,
        folderName: newName,
        idempotencyKey: `rename-folder-${ws.id}-${Date.now()}`,
      });
    }
    await reload();
  };

  const onDeleteFolder = async (folderName: string) => {
    const count = items.filter((ws) => ws.folderName === folderName).length;
    const ok = await systemDialog.confirm({
      title: '删除文件夹',
      message: `确定删除文件夹 "${folderName}" 吗? 其中的 ${count} 篇文章将移至"未分类"。`,
      tone: 'danger',
      confirmText: '删除',
      cancelText: '取消',
    });
    if (!ok) return;
    const toUpdate = items.filter((ws) => ws.folderName === folderName);
    for (const ws of toUpdate) {
      await updateVisualAgentWorkspace({
        id: ws.id,
        folderName: null,
        idempotencyKey: `delete-folder-${ws.id}-${Date.now()}`,
      });
    }
    await reload();
  };

  const onRename = async (ws: VisualAgentWorkspace) => {
    const title = await systemDialog.prompt({
      title: '重命名',
      message: '请输入新标题',
      placeholder: ws.title,
      defaultValue: ws.title,
      confirmText: '确定',
      cancelText: '取消',
    });
    if (!title || title === ws.title) return;
    const res = await updateVisualAgentWorkspace({ id: ws.id, title, idempotencyKey: `rename-${ws.id}-${Date.now()}` });
    if (!res.success) {
      await systemDialog.alert({ title: '重命名失败', message: res.error?.message || '未知错误', confirmText: '确定' });
      return;
    }
    await reload();
  };

  const onDelete = async (ws: VisualAgentWorkspace) => {
    const ok = await systemDialog.confirm({
      title: '删除',
      message: `确定删除 "${ws.title}" 吗? 此操作无法撤销。`,
      tone: 'danger',
      confirmText: '删除',
      cancelText: '取消',
    });
    if (!ok) return;
    const res = await deleteVisualAgentWorkspace({ id: ws.id, idempotencyKey: `delete-${ws.id}-${Date.now()}` });
    if (!res.success) {
      await systemDialog.alert({ title: '删除失败', message: res.error?.message || '未知错误', confirmText: '确定' });
      return;
    }
    await reload();
  };

  const onMoveToFolder = async (ws: VisualAgentWorkspace, targetFolder: string | null) => {
    await updateVisualAgentWorkspace({
      id: ws.id,
      folderName: targetFolder,
      idempotencyKey: `move-${ws.id}-${Date.now()}`,
    });
    await reload();
  };

  const toggleFolder = (folderName: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderName)) next.delete(folderName);
      else next.add(folderName);
      return next;
    });
  };

  // 右键菜单：空白区
  const handleContainerContextMenu = (e: React.MouseEvent) => {
    contextMenu.show(e, [
      { key: 'new-article', label: '新建文章', icon: <Plus size={12} />, onClick: () => void onCreate() },
      { key: 'new-folder', label: '新建文件夹', icon: <FolderPlus size={12} />, onClick: () => void onCreateFolder() },
    ]);
  };

  // 右键菜单：文件夹
  const handleFolderContextMenu = (e: React.MouseEvent, folderName: string) => {
    e.stopPropagation();
    contextMenu.show(e, [
      { key: 'new-in-folder', label: '在此新建文章', icon: <Plus size={12} />, onClick: () => void onCreate(folderName) },
      { key: 'divider1', label: '', divider: true },
      { key: 'rename-folder', label: '重命名文件夹', icon: <Pencil size={12} />, onClick: () => void onRenameFolder(folderName) },
      { key: 'delete-folder', label: '删除文件夹', icon: <Trash2 size={12} />, danger: true, onClick: () => void onDeleteFolder(folderName) },
    ]);
  };

  // 右键菜单：文章卡片
  const handleCardContextMenu = (e: React.MouseEvent, ws: VisualAgentWorkspace) => {
    e.stopPropagation();
    const moveItems: ContextMenuItem[] = allFolderNames
      .filter((fn) => fn !== ws.folderName)
      .map((fn) => ({
        key: `move-to-${fn}`,
        label: fn,
        icon: <FolderOpen size={12} />,
        onClick: () => void onMoveToFolder(ws, fn),
      }));
    if (ws.folderName) {
      moveItems.push({
        key: 'move-to-uncategorized',
        label: '未分类',
        onClick: () => void onMoveToFolder(ws, null),
      });
    }

    const items: ContextMenuItem[] = [
      { key: 'edit', label: '编辑', icon: <SquarePen size={12} />, onClick: () => navigate(`/literary-agent/${ws.id}`) },
      { key: 'rename', label: '重命名', icon: <Pencil size={12} />, onClick: () => void onRename(ws) },
    ];
    if (moveItems.length > 0) {
      items.push({ key: 'divider1', label: '', divider: true });
      items.push({ key: 'move-header', label: '移动到...', icon: <MoveRight size={12} />, disabled: true });
      items.push(...moveItems);
    }
    items.push({ key: 'divider2', label: '', divider: true });
    items.push({ key: 'delete', label: '删除', icon: <Trash2 size={12} />, danger: true, onClick: () => void onDelete(ws) });

    contextMenu.show(e, items);
  };

  // 拖拽处理
  const handleDragStart = (e: React.DragEvent, ws: VisualAgentWorkspace) => {
    e.dataTransfer.setData('text/plain', ws.id);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, folderName: string | null) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverFolder(folderName);
  };

  const handleDragLeave = () => {
    setDragOverFolder(null);
  };

  const handleDrop = async (e: React.DragEvent, targetFolder: string | null) => {
    e.preventDefault();
    setDragOverFolder(null);
    const wsId = e.dataTransfer.getData('text/plain');
    if (!wsId) return;
    const ws = items.find((w) => w.id === wsId);
    if (!ws || ws.folderName === targetFolder) return;
    await onMoveToFolder(ws, targetFolder);
  };

  const renderCard = (ws: VisualAgentWorkspace) => (
    <Card key={ws.id} className="p-0 overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        title={ws.title || ws.id}
        draggable
        onDragStart={(e) => handleDragStart(e, ws)}
        onContextMenu={(e) => handleCardContextMenu(e, ws)}
        className={[
          'group relative cursor-pointer select-none',
          'transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15',
          'flex flex-col h-full',
        ].join(' ')}
        onClick={() => navigate(`/literary-agent/${ws.id}`)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            navigate(`/literary-agent/${ws.id}`);
          }
        }}
      >
        <div className="p-2 pb-1 flex-shrink-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <FileText size={12} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
            <div className="font-medium text-[12px] truncate" style={{ color: 'var(--text-primary)' }}>
              {ws.title}
            </div>
          </div>
        </div>
        <div className="px-2 pb-2 flex-1 min-h-0 overflow-hidden">
          <div
            className="h-full overflow-hidden border rounded-[5px] text-[10px] flex flex-col"
            style={{ borderColor: 'var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
          >
            <div className="p-1.5 flex-1 overflow-hidden">
              <ArticlePreview markdown={getArticlePreviewText(ws)} />
            </div>
            <div
              className="px-1.5 py-1 text-[9px] border-t flex items-center"
              style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}
            >
              <div
                className={[
                  'flex items-center gap-0.5',
                  'opacity-0 pointer-events-none transition-opacity duration-100',
                  'group-hover:opacity-100 group-hover:pointer-events-auto',
                ].join(' ')}
              >
                <Button
                  size="xs"
                  variant="secondary"
                  className="h-5 w-5 p-0 rounded-[6px] gap-0"
                  onClick={(e) => { e.stopPropagation(); navigate(`/literary-agent/${ws.id}`); }}
                  title="编辑"
                >
                  <SquarePen size={10} />
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  className="h-5 w-5 p-0 rounded-[6px] gap-0"
                  onClick={(e) => { e.stopPropagation(); void onRename(ws); }}
                  title="重命名"
                >
                  <Pencil size={10} />
                </Button>
                <Button
                  size="xs"
                  variant="danger"
                  className="h-5 w-5 p-0 rounded-[6px] gap-0"
                  onClick={(e) => { e.stopPropagation(); void onDelete(ws); }}
                  title="删除"
                >
                  <Trash2 size={10} />
                </Button>
              </div>
              <div className="flex-1 text-right truncate">{formatDate(ws.updatedAt)}</div>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );

  const renderFolderGroup = (group: FolderGroup) => {
    const { folderName, items: groupItems } = group;
    const isCollapsed = folderName ? collapsedFolders.has(folderName) : false;
    const isDragOver = dragOverFolder === (folderName ?? '__uncategorized__');
    const displayName = folderName || '未分类';

    return (
      <div key={folderName ?? '__uncategorized__'} className="mb-4">
        {/* 文件夹标题栏 */}
        <div
          className={[
            'flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer select-none mb-2 transition-colors',
            isDragOver ? 'bg-white/10 ring-1 ring-white/20' : 'hover:bg-white/5',
          ].join(' ')}
          onClick={() => folderName && toggleFolder(folderName)}
          onContextMenu={(e) => folderName && handleFolderContextMenu(e, folderName)}
          onDragOver={(e) => handleDragOver(e, folderName ?? '__uncategorized__')}
          onDragLeave={handleDragLeave}
          onDrop={(e) => void handleDrop(e, folderName)}
        >
          {folderName ? (
            isCollapsed ? <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} /> : <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} />
          ) : (
            <div className="w-[14px]" />
          )}
          <FolderOpen size={14} style={{ color: folderName ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
          <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
            {displayName}
          </span>
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            ({groupItems.length})
          </span>
        </div>
        {/* 文章网格 */}
        {!isCollapsed && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2 pl-6">
            {groupItems.map(renderCard)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="h-full min-h-0 flex flex-col gap-5"
      onContextMenu={handleContainerContextMenu}
    >
      {contextMenu.Menu}

      <TabBar
        title="文学创作"
        icon={<BookOpen size={16} />}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void onCreateFolder()} disabled={loading}>
              <FolderPlus size={14} />
            </Button>
            <Button variant="primary" size="sm" onClick={() => void onCreate()} disabled={loading}>
              <Plus size={14} />
              新建
            </Button>
          </>
        }
      />

      {error && (
        <Card className="py-2 px-3">
          <div className="text-[12px]" style={{ color: 'rgba(255,120,120,0.95)' }}>{error}</div>
        </Card>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <Card className="py-2 px-3">
            <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中...</div>
          </Card>
        ) : items.length === 0 ? (
          <Card className="py-6 px-3">
            <div className="text-center">
              <FileText size={36} className="mx-auto mb-2" style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
              <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                暂无文章，右键可创建文件夹或文章。
              </div>
            </div>
          </Card>
        ) : (
          <div className="max-w-[1680px]">
            {groups.map(renderFolderGroup)}
          </div>
        )}
      </div>
    </div>
  );
}
