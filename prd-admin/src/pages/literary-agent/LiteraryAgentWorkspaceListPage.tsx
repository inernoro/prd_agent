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
import { Plus, Pencil, Trash2, FileText, SquarePen, FolderOpen, ChevronDown, ChevronRight, FolderPlus, MoveRight, BookOpen, Calendar, Clock, Folder } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { cn } from '@/lib/cn';

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

function getPlainPreviewText(ws: VisualAgentWorkspace, maxChars = 120) {
  const raw = ws.articleContent ?? ws.articleContentWithMarkers ?? '';
  let s = String(raw ?? '').trim();
  if (!s) return '';
  // Strip markers and block quotes
  s = s.replace(/^\s*\[插图\]\s*:\s*.*$/gm, '');
  s = s.replace(/^\s*>\s*配图.*$/gm, '');
  // Strip markdown syntax
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/\*(.+?)\*/g, '$1');
  s = s.replace(/`(.+?)`/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*\d+\.\s+/gm, '');
  s = s.replace(/\n{2,}/g, '\n');
  s = s.trim();
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '…';
}

// ── NotebookLM-style gradient backgrounds ──

const CARD_GRADIENTS = [
  'linear-gradient(135deg, #1a1a2e 0%, #16213e 40%, #0f3460 100%)',
  'linear-gradient(135deg, #2d1b69 0%, #11998e 100%)',
  'linear-gradient(135deg, #1f1c2c 0%, #928dab 100%)',
  'linear-gradient(135deg, #0f2027 0%, #203a43 40%, #2c5364 100%)',
  'linear-gradient(135deg, #1a002e 0%, #3d1f5c 50%, #5c3d7a 100%)',
  'linear-gradient(135deg, #141e30 0%, #243b55 100%)',
  'linear-gradient(135deg, #0d1117 0%, #161b22 40%, #21262d 100%)',
  'linear-gradient(135deg, #1b1b3a 0%, #2e1065 100%)',
];

function getCardGradient(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  return CARD_GRADIENTS[Math.abs(hash) % CARD_GRADIENTS.length];
}

// ── Types ──

type ViewMode = 'time' | 'folder';

type FolderGroup = {
  folderName: string | null;
  items: VisualAgentWorkspace[];
};

type DayGroup = {
  dateKey: string;
  items: VisualAgentWorkspace[];
};

// ── NotebookLM-style Workspace Card ──

function WorkspaceCard({
  ws,
  viewMode,
  onClick,
  onContextMenu,
  onDragStart,
}: {
  ws: VisualAgentWorkspace;
  viewMode: ViewMode;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
}) {
  const preview = getPlainPreviewText(ws, 100);
  const dateStr = formatDate(ws.updatedAt);
  const coverUrl = ws.coverAssets?.[0]?.url;
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const hasCover = !!coverUrl && !imgError;

  // Badge: show folder name in time mode, hide in folder mode
  const badgeLabel = viewMode === 'time' && ws.folderName ? ws.folderName : null;

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={onDragStart}
      onContextMenu={onContextMenu}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
      }}
      className="group cursor-pointer select-none"
    >
      <div
        className="relative w-full overflow-hidden rounded-2xl transition-all duration-300 group-hover:shadow-xl group-hover:shadow-black/30 group-hover:scale-[1.02]"
        style={{
          aspectRatio: '3/2',
          background: hasCover ? '#0a0a0f' : getCardGradient(ws.id),
        }}
      >
        {/* Cover image — full bleed */}
        {coverUrl && !imgError && (
          <img
            src={coverUrl}
            alt={ws.title}
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.06]"
            style={{ opacity: imgLoaded ? 1 : 0, transition: 'opacity 0.5s ease' }}
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgError(true)}
          />
        )}

        {/* Subtle decorative element — only when no cover */}
        {!hasCover && (
          <div className="absolute inset-0 pointer-events-none select-none">
            <span
              className="absolute -right-4 -top-4 text-[140px] font-serif leading-none"
              style={{ color: 'rgba(255,255,255,0.03)' }}
            >
              "
            </span>
          </div>
        )}

        {/* Bottom gradient for text readability */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: hasCover
              ? 'linear-gradient(180deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.15) 30%, rgba(0,0,0,0.7) 100%)'
              : 'linear-gradient(180deg, transparent 20%, rgba(0,0,0,0.35) 100%)',
          }}
        />

        {/* Content overlay */}
        <div className="absolute inset-0 z-10 flex flex-col justify-between p-4">
          {/* Top: folder badge + date */}
          <div className="flex items-center justify-between">
            {badgeLabel ? (
              <div
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full backdrop-blur-md"
                style={{
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                <FolderOpen size={11} style={{ color: 'rgba(165,180,252,0.9)' }} />
                <span className="text-[10px] font-medium truncate max-w-[120px]" style={{ color: 'rgba(255,255,255,0.75)' }}>
                  {badgeLabel}
                </span>
              </div>
            ) : (
              <div />
            )}
            <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.4)' }}>
              {dateStr}
            </span>
          </div>

          {/* Bottom: title + preview text */}
          <div className="flex flex-col gap-1.5">
            <h3
              className="text-[15px] font-bold leading-snug line-clamp-2 drop-shadow-lg"
              style={{ color: '#fff', textShadow: '0 1px 6px rgba(0,0,0,0.5)' }}
            >
              {ws.title || '未命名'}
            </h3>
            {preview && (
              <p
                className="text-[11px] leading-relaxed line-clamp-2"
                style={{ color: 'rgba(255,255,255,0.55)' }}
              >
                {preview}
              </p>
            )}
          </div>
        </div>

        {/* Hover border glow */}
        <div
          className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
          style={{
            boxShadow: 'inset 0 0 0 1px rgba(165,180,252,0.2)',
          }}
        />
      </div>
    </div>
  );
}

// ── Page ──

export default function LiteraryAgentWorkspaceListPage() {
  const navigate = useNavigate();
  const { isMobile } = useBreakpoint();
  const [items, setItems] = useState<VisualAgentWorkspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = sessionStorage.getItem('literary-view-mode');
    return saved === 'folder' ? 'folder' : 'time';
  });
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const contextMenu = useContextMenu();
  const gridRef = useRef<HTMLDivElement>(null);

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

  // 按日期分组（全局）
  const dayGroups = useMemo<DayGroup[]>(() => {
    const map = new Map<string, VisualAgentWorkspace[]>();
    const sorted = [...items].sort((a, b) => {
      const ta = new Date(a.updatedAt).getTime() || 0;
      const tb = new Date(b.updatedAt).getTime() || 0;
      return tb - ta;
    });
    for (const ws of sorted) {
      const key = toDateKey(ws.updatedAt);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ws);
    }
    return [...map.entries()].map(([dateKey, dayItems]) => ({ dateKey, items: dayItems }));
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

  // ── Render: Card grid (responsive) ──

  const renderCardGrid = (workspaces: VisualAgentWorkspace[]) => (
    <div
      className="grid gap-4"
      style={{
        gridTemplateColumns: isMobile
          ? 'repeat(auto-fill, minmax(160px, 1fr))'
          : 'repeat(auto-fill, minmax(240px, 1fr))',
      }}
    >
      {workspaces.map((ws) => (
        <WorkspaceCard
          key={ws.id}
          ws={ws}
          viewMode={viewMode}
          onClick={() => navigate(`/literary-agent/${ws.id}`)}
          onContextMenu={(e) => handleCardContextMenu(e, ws)}
          onDragStart={(e) => handleDragStart(e, ws)}
        />
      ))}
    </div>
  );

  // ── Render: Time view (按时间) ──

  const renderTimeView = () => (
    <div className="space-y-6">
      {dayGroups.map((dayGroup) => (
        <div key={dayGroup.dateKey}>
          {/* Date header */}
          <div className="flex items-center gap-2 mb-3 pl-0.5">
            <Calendar size={12} style={{ color: 'var(--text-muted)' }} />
            <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              {formatDateLabel(dayGroup.dateKey)}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {dayGroup.dateKey}
            </span>
            <div className="flex-1 h-px ml-2" style={{ background: 'rgba(255,255,255,0.06)' }} />
          </div>
          {renderCardGrid(dayGroup.items)}
        </div>
      ))}
    </div>
  );

  // ── Render: Folder view (按文件夹) ──

  const renderFolderView = () => (
    <div className="space-y-6">
      {groups.map((group) => {
        const { folderName, items: groupItems } = group;
        const isCollapsed = folderName ? collapsedFolders.has(folderName) : false;
        const isDragOver = dragOverFolder === (folderName ?? '__uncategorized__');
        const displayName = folderName || '未分类';

        return (
          <div key={folderName ?? '__uncategorized__'}>
            {/* Folder header */}
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
            {/* Cards */}
            {!isCollapsed && (
              <div className={isMobile ? '' : 'pl-4'}>
                {renderCardGrid(groupItems)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  // ── View mode toggle ──

  const viewModeToggle = (
    <div
      className="flex items-center rounded-lg overflow-hidden"
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <button
        type="button"
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium transition-all duration-200',
        )}
        style={{
          background: viewMode === 'time' ? 'rgba(99,102,241,0.15)' : 'transparent',
          color: viewMode === 'time' ? 'var(--accent-primary, #818CF8)' : 'var(--text-muted)',
        }}
        onClick={() => { setViewMode('time'); sessionStorage.setItem('literary-view-mode', 'time'); }}
      >
        <Clock size={12} />
        按时间
      </button>
      <button
        type="button"
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium transition-all duration-200',
        )}
        style={{
          background: viewMode === 'folder' ? 'rgba(99,102,241,0.15)' : 'transparent',
          color: viewMode === 'folder' ? 'var(--accent-primary, #818CF8)' : 'var(--text-muted)',
        }}
        onClick={() => { setViewMode('folder'); sessionStorage.setItem('literary-view-mode', 'folder'); }}
      >
        <Folder size={12} />
        按文件夹
      </button>
    </div>
  );

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
            {viewModeToggle}
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

      <div className="flex-1 min-h-0 overflow-auto" ref={gridRef}>
        {loading ? (
          <div
            className="grid gap-4"
            style={{
              gridTemplateColumns: isMobile
                ? 'repeat(auto-fill, minmax(160px, 1fr))'
                : 'repeat(auto-fill, minmax(240px, 1fr))',
            }}
          >
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="animate-pulse rounded-2xl"
                style={{
                  aspectRatio: '3/2',
                  background: 'rgba(255,255,255,0.03)',
                }}
              />
            ))}
          </div>
        ) : items.length === 0 ? (
          <GlassCard animated glow className="py-6 px-3">
            <div className="text-center">
              <FileText size={36} className="mx-auto mb-2" style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
              <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                暂无文章，右键可创建文件夹或文章。
              </div>
            </div>
          </GlassCard>
        ) : viewMode === 'time' ? (
          renderTimeView()
        ) : (
          renderFolderView()
        )}
      </div>
    </div>
  );
}
