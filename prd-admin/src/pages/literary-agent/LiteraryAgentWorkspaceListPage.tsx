import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { TabBar } from '@/components/design/TabBar';
import { useContextMenu, type ContextMenuItem } from '@/components/ui/ContextMenu';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import {
  listLiteraryAgentWorkspacesReal as listLiteraryAgentWorkspaces,
  createLiteraryAgentWorkspaceReal as createLiteraryAgentWorkspace,
  updateLiteraryAgentWorkspaceReal as updateLiteraryAgentWorkspace,
  deleteLiteraryAgentWorkspaceReal as deleteLiteraryAgentWorkspace,
} from '@/services/real/literaryAgentConfig';
import type { VisualAgentWorkspace } from '@/services/contracts/visualAgent';
import { Plus, Pencil, Trash2, FileText, SquarePen, FolderOpen, ChevronDown, ChevronRight, FolderPlus, MoveRight, BookOpen, Calendar } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { cn } from '@/lib/cn';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';

// ── Helpers ──

function formatDate(iso: string | null | undefined) {
  const s = String(iso ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString();
}

/** 将 ISO 日期转为 YYYY-MM-DD 格式的日期 key */
function toDateKey(iso: string | null | undefined): string {
  const s = String(iso ?? '').trim();
  if (!s) return '未知日期';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '未知日期';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 将日期 key 格式化为友好显示 */
function formatDateLabel(dateKey: string): string {
  if (dateKey === '未知日期') return dateKey;
  const today = new Date();
  const todayKey = toDateKey(today.toISOString());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = toDateKey(yesterday.toISOString());

  if (dateKey === todayKey) return '今天';
  if (dateKey === yesterdayKey) return '昨天';

  const d = new Date(dateKey);
  if (Number.isNaN(d.getTime())) return dateKey;

  const thisYear = today.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();

  if (d.getFullYear() === thisYear) {
    return `${month}月${day}日`;
  }
  return `${d.getFullYear()}年${month}月${day}日`;
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

// ── Article Preview ──

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
          .literary-preview-md blockquote { margin: 2px 0; padding: 2px 6px; border-left: 2px solid rgba(165,180,252,0.35); background: rgba(165,180,252,0.06); border-radius: 4px; }
          .literary-preview-md code { font-size: 9px; background: var(--bg-input-hover); padding: 0 3px; border-radius: 3px; }
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

// ── Types ──

type FolderGroup = {
  folderName: string | null;
  items: VisualAgentWorkspace[];
};

type DayGroup = {
  dateKey: string;
  items: VisualAgentWorkspace[];
};

// ── Page ──

export default function LiteraryAgentWorkspaceListPage() {
  const navigate = useNavigate();
  const { isMobile } = useBreakpoint();
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
      const res = await listLiteraryAgentWorkspaces({ limit: 100 });
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
    const folderNames = [...map.keys()].filter((k) => k !== null).sort() as string[];
    for (const fn of folderNames) {
      result.push({ folderName: fn, items: map.get(fn)! });
    }
    if (map.has(null)) {
      result.push({ folderName: null, items: map.get(null)! });
    }
    return result;
  }, [items]);

  const allFolderNames = useMemo(() => {
    const set = new Set<string>();
    for (const ws of items) {
      if (ws.folderName) set.add(ws.folderName);
    }
    return [...set].sort();
  }, [items]);

  // ── CRUD handlers ──

  const onCreate = async (folderName?: string | null) => {
    const title = await systemDialog.prompt({
      title: '新建文章',
      message: '请输入文章标题',
      placeholder: '未命名',
      confirmText: '创建',
      cancelText: '取消',
    });
    if (!title) return;
    const res = await createLiteraryAgentWorkspace({
      title,
      scenarioType: 'article-illustration',
      idempotencyKey: `create-literary-${Date.now()}`,
    });
    if (!res.success) {
      toast.error('创建失败', res.error?.message || '未知错误');
      return;
    }
    if (folderName && res.data?.workspace?.id) {
      await updateLiteraryAgentWorkspace({
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
    const res = await createLiteraryAgentWorkspace({
      title: '未命名',
      scenarioType: 'article-illustration',
      idempotencyKey: `create-literary-folder-${Date.now()}`,
    });
    if (res.success && res.data?.workspace?.id) {
      await updateLiteraryAgentWorkspace({
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
    const toUpdate = items.filter((ws) => ws.folderName === oldName);
    for (const ws of toUpdate) {
      await updateLiteraryAgentWorkspace({
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
      await updateLiteraryAgentWorkspace({
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
    const res = await updateLiteraryAgentWorkspace({ id: ws.id, title, idempotencyKey: `rename-${ws.id}-${Date.now()}` });
    if (!res.success) {
      toast.error('重命名失败', res.error?.message || '未知错误');
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
    const res = await deleteLiteraryAgentWorkspace({ id: ws.id, idempotencyKey: `delete-${ws.id}-${Date.now()}` });
    if (!res.success) {
      toast.error('删除失败', res.error?.message || '未知错误');
      return;
    }
    await reload();
  };

  const onMoveToFolder = async (ws: VisualAgentWorkspace, targetFolder: string | null) => {
    await updateLiteraryAgentWorkspace({
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

  // ── Context menus ──

  const handleContainerContextMenu = (e: React.MouseEvent) => {
    contextMenu.show(e, [
      { key: 'new-article', label: '新建文章', icon: <Plus size={12} />, onClick: () => void onCreate() },
      { key: 'new-folder', label: '新建文件夹', icon: <FolderPlus size={12} />, onClick: () => void onCreateFolder() },
    ]);
  };

  const handleFolderContextMenu = (e: React.MouseEvent, folderName: string) => {
    e.stopPropagation();
    contextMenu.show(e, [
      { key: 'new-in-folder', label: '在此新建文章', icon: <Plus size={12} />, onClick: () => void onCreate(folderName) },
      { key: 'divider1', label: '', divider: true },
      { key: 'rename-folder', label: '重命名文件夹', icon: <Pencil size={12} />, onClick: () => void onRenameFolder(folderName) },
      { key: 'delete-folder', label: '删除文件夹', icon: <Trash2 size={12} />, danger: true, onClick: () => void onDeleteFolder(folderName) },
    ]);
  };

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

    const menuItems: ContextMenuItem[] = [
      { key: 'edit', label: '编辑', icon: <SquarePen size={12} />, onClick: () => navigate(`/literary-agent/${ws.id}`) },
      { key: 'rename', label: '重命名', icon: <Pencil size={12} />, onClick: () => void onRename(ws) },
    ];
    if (moveItems.length > 0) {
      menuItems.push({ key: 'divider1', label: '', divider: true });
      menuItems.push({ key: 'move-header', label: '移动到...', icon: <MoveRight size={12} />, disabled: true });
      menuItems.push(...moveItems);
    }
    menuItems.push({ key: 'divider2', label: '', divider: true });
    menuItems.push({ key: 'delete', label: '删除', icon: <Trash2 size={12} />, danger: true, onClick: () => void onDelete(ws) });

    contextMenu.show(e, menuItems);
  };

  // ── Drag & drop ──

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

  // ── 将文章列表按日期分组（时间线） ──

  function groupByDay(workspaces: VisualAgentWorkspace[]): DayGroup[] {
    const map = new Map<string, VisualAgentWorkspace[]>();
    // 按 updatedAt 降序排列
    const sorted = [...workspaces].sort((a, b) => {
      const ta = new Date(a.updatedAt).getTime() || 0;
      const tb = new Date(b.updatedAt).getTime() || 0;
      return tb - ta;
    });
    for (const ws of sorted) {
      const key = toDateKey(ws.updatedAt);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ws);
    }
    // 保持日期降序
    return [...map.entries()].map(([dateKey, dayItems]) => ({ dateKey, items: dayItems }));
  }

  // ── Render: Timeline card ──

  const renderTimelineCard = (ws: VisualAgentWorkspace, isLast: boolean) => (
    <div key={ws.id} className="relative flex gap-3">
      {/* 时间线连线 */}
      <div className="flex flex-col items-center shrink-0" style={{ width: 20 }}>
        <div
          className="w-2 h-2 rounded-full shrink-0 mt-2.5"
          style={{ background: 'var(--accent-primary, #818CF8)', boxShadow: '0 0 6px rgba(129,140,248,0.4)' }}
        />
        {!isLast && (
          <div className="flex-1 w-px" style={{ background: 'rgba(99,102,241,0.15)' }} />
        )}
      </div>

      {/* 卡片内容 */}
      <div className="flex-1 min-w-0 pb-3">
        <GlassCard animated glow className="p-0 overflow-hidden">
          <div
            role="button"
            tabIndex={0}
            title={ws.title || ws.id}
            draggable
            onDragStart={(e) => handleDragStart(e, ws)}
            onContextMenu={(e) => handleCardContextMenu(e, ws)}
            className="group relative cursor-pointer select-none transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15"
            onClick={() => navigate(`/literary-agent/${ws.id}`)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                navigate(`/literary-agent/${ws.id}`);
              }
            }}
          >
            <div className="flex gap-3 p-3">
              {/* 左侧：文章内容 */}
              <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <FileText size={13} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
                  <div className="font-semibold text-[13px] truncate" style={{ color: 'var(--text-primary)' }}>
                    {ws.title}
                  </div>
                </div>
                <div className="overflow-hidden rounded-md" style={{ maxHeight: 80 }}>
                  <ArticlePreview markdown={getArticlePreviewText(ws)} />
                </div>
              </div>
            </div>

            {/* 底栏：操作按钮 + 时间 */}
            <div
              className="px-3 py-1.5 text-[10px] border-t flex items-center"
              style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}
            >
              <div
                className={cn(
                  'flex items-center gap-0.5',
                  'opacity-0 pointer-events-none transition-opacity duration-100',
                  'group-hover:opacity-100 group-hover:pointer-events-auto',
                  'mobile-show-actions',
                )}
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
        </GlassCard>
      </div>
    </div>
  );

  // ── Render: Day group (时间线分组) ──

  const renderDayGroup = (dayGroup: DayGroup) => (
    <div key={dayGroup.dateKey} className="mb-2">
      {/* 日期标题 */}
      <div className="flex items-center gap-2 mb-2 pl-0.5">
        <Calendar size={12} style={{ color: 'var(--text-muted)' }} />
        <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
          {formatDateLabel(dayGroup.dateKey)}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {dayGroup.dateKey}
        </span>
        <div className="flex-1 h-px ml-2" style={{ background: 'rgba(255,255,255,0.06)' }} />
      </div>
      {/* 该日的文章列表 — 时间线形式 */}
      <div className={isMobile ? '' : 'pl-4'}>
        {dayGroup.items.map((ws, idx) =>
          renderTimelineCard(ws, idx === dayGroup.items.length - 1)
        )}
      </div>
    </div>
  );

  // ── Render: Folder group ──

  const renderFolderGroup = (group: FolderGroup) => {
    const { folderName, items: groupItems } = group;
    const isCollapsed = folderName ? collapsedFolders.has(folderName) : false;
    const isDragOver = dragOverFolder === (folderName ?? '__uncategorized__');
    const displayName = folderName || '未分类';

    // 在文件夹内按日期分组
    const dayGroups = groupByDay(groupItems);

    return (
      <div key={folderName ?? '__uncategorized__'} className="mb-6">
        {/* 文件夹标题栏 */}
        <div
          className={cn(
            'flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer select-none mb-3 transition-colors',
            isDragOver ? 'bg-white/10 ring-1 ring-white/20' : 'hover:bg-white/5',
          )}
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
          <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
            {displayName}
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            ({groupItems.length})
          </span>
        </div>
        {/* 时间线内容 */}
        {!isCollapsed && (
          <div className={isMobile ? '' : 'pl-6'}>
            {dayGroups.map(renderDayGroup)}
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
        <GlassCard animated glow className="py-2 px-3">
          <div className="text-[12px]" style={{ color: 'rgba(255,120,120,0.95)' }}>{error}</div>
        </GlassCard>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <GlassCard animated glow className="py-2 px-3">
            <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中...</div>
          </GlassCard>
        ) : items.length === 0 ? (
          <GlassCard animated glow className="py-6 px-3">
            <div className="text-center">
              <FileText size={36} className="mx-auto mb-2" style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
              <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                暂无文章，右键可创建文件夹或文章。
              </div>
            </div>
          </GlassCard>
        ) : (
          <div className="max-w-[960px]">
            {groups.map(renderFolderGroup)}
          </div>
        )}
      </div>
    </div>
  );
}
