import { Card } from '@/components/design/Card';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { systemDialog } from '@/lib/systemDialog';
import {
  createImageMasterWorkspace,
  deleteImageMasterWorkspace,
  getUsers,
  listImageMasterWorkspaces,
  refreshImageMasterWorkspaceCover,
  updateImageMasterWorkspace,
} from '@/services';
import type { AdminUser } from '@/types/admin';
import type { ImageMasterWorkspace } from '@/services/contracts/imageMaster';
import {
  Plus,
  Users2,
  Pencil,
  Trash2,
  ArrowRight,
  Image,
  Paperclip,
  MapPin,
  Zap,
  Globe,
  Smile,
  ArrowUp,
  ChevronRight,
  Palette,
  ShoppingCart,
  PenTool,
  Video,
  LayoutGrid,
  Star,
  Sparkles,
  FolderPlus,
  FilePlus,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

function formatDate(iso: string | null | undefined) {
  const s = String(iso ?? '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function CoverMosaic(props: { title: string; assets: ImageMasterWorkspace['coverAssets'] }) {
  const assets = Array.isArray(props.assets) ? props.assets : [];
  const n = assets.length;

  const Tile = (p: { idx: number; style?: React.CSSProperties }) => {
    const a = assets[p.idx];
    return a?.url ? (
      <img
        src={a.url}
        alt=""
        className="h-full w-full object-cover"
        style={p.style}
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    ) : (
      <div
        className="h-full w-full"
        style={{
          ...p.style,
          background: 'rgba(255,255,255,0.03)',
        }}
      />
    );
  };

  if (n <= 0) return null;
  if (n === 1) {
    return (
      <img
        src={assets[0]?.url}
        alt={props.title || 'workspace cover'}
        className="absolute inset-0 h-full w-full object-cover"
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }

  if (n === 2) {
    return (
      <div
        className="absolute inset-0 grid"
        style={{
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gridTemplateRows: 'repeat(1, minmax(0, 1fr))',
          gap: 2,
        }}
      >
        <Tile idx={0} />
        <Tile idx={1} />
      </div>
    );
  }

  if (n === 3) {
    return (
      <div
        className="absolute inset-0 grid"
        style={{
          gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
          gridTemplateRows: 'repeat(2, minmax(0, 1fr))',
          gap: 2,
        }}
      >
        <Tile idx={0} style={{ gridColumn: '1', gridRow: '1 / span 2' }} />
        <Tile idx={1} style={{ gridColumn: '2', gridRow: '1' }} />
        <Tile idx={2} style={{ gridColumn: '2', gridRow: '2' }} />
      </div>
    );
  }

  return (
    <div
      className="absolute inset-0 grid"
      style={{
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gridTemplateRows: 'repeat(2, minmax(0, 1fr))',
        gap: 2,
      }}
    >
      <Tile idx={0} />
      <Tile idx={1} />
      <Tile idx={2} />
      <Tile idx={3} />
    </div>
  );
}

// ============ 浮动工具栏 ============
function FloatingToolbar(props: {
  onNewProject: () => void;
  onNewFolder: () => void;
}) {
  const { onNewProject, onNewFolder } = props;

  return (
    <div
      className="rounded-[20px] p-2 flex flex-col gap-2 bg-transparent"
      style={{
        border: '1px solid rgba(255,255,255,0.12)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        boxShadow: '0 18px 60px rgba(0,0,0,0.35)',
      }}
    >
      {/* 新建项目 */}
      <button
        type="button"
        className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center bg-transparent transition-colors hover:bg-white/12"
        style={{ color: 'rgba(255,255,255,0.86)' }}
        title="新建项目"
        onClick={onNewProject}
      >
        <FilePlus size={18} />
      </button>

      {/* 新建文件夹 */}
      <button
        type="button"
        className="h-11 w-11 rounded-[14px] inline-flex items-center justify-center bg-transparent transition-colors hover:bg-white/12"
        style={{ color: 'rgba(255,255,255,0.86)' }}
        title="新建文件夹"
        onClick={onNewFolder}
      >
        <FolderPlus size={18} />
      </button>
    </div>
  );
}

// ============ 场景标签定义 ============
const SCENARIO_TAGS = [
  { key: 'pro', label: 'PRD Agent Pro', icon: Sparkles, prompt: '', isPro: true },
  { key: 'design', label: '平面设计', icon: LayoutGrid, prompt: '帮我设计一张' },
  { key: 'branding', label: '品牌设计', icon: Star, prompt: '帮我设计一个品牌视觉，包括' },
  { key: 'illustration', label: '插画创作', icon: PenTool, prompt: '帮我创作一幅插画，主题是' },
  { key: 'ecommerce', label: '电商设计', icon: ShoppingCart, prompt: '帮我设计一张电商主图，产品是' },
  { key: 'video', label: '视频封面', icon: Video, prompt: '帮我设计一张视频封面，内容是' },
];

// ============ Hero 区域 ============
function HeroSection() {
  return (
    <div className="text-center py-6">
      {/* Logo + 主标题 */}
      <div className="flex items-center justify-center gap-3 mb-2">
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center"
          style={{
            background: '#1a1a1a',
            border: '2px solid #333',
          }}
        >
          <Image size={16} style={{ color: '#fff' }} />
        </div>
        <h1 className="text-[26px] font-bold" style={{ color: 'var(--text-primary)' }}>
          视觉创作 Agent
        </h1>
      </div>
      {/* 副标题 */}
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        AI 驱动的设计助手，让创作更简单
      </p>
    </div>
  );
}

// ============ 打字动效占位符 ============
const TYPING_TEXTS = [
  '帮我设计一张活动海报...',
  '帮我创作一个品牌LOGO...',
  '帮我设计一张电商主图...',
  '帮我创作一幅插画作品...',
];

function useTypingPlaceholder() {
  const [displayText, setDisplayText] = useState('');
  const [textIndex, setTextIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [charIndex, setCharIndex] = useState(0);

  useEffect(() => {
    const currentText = TYPING_TEXTS[textIndex] || '';
    
    const timeout = setTimeout(() => {
      if (!isDeleting) {
        // 打字中
        if (charIndex < currentText.length) {
          setDisplayText(currentText.slice(0, charIndex + 1));
          setCharIndex(charIndex + 1);
        } else {
          // 打完了，等待后开始删除
          setTimeout(() => setIsDeleting(true), 1500);
        }
      } else {
        // 删除中
        if (charIndex > 0) {
          setDisplayText(currentText.slice(0, charIndex - 1));
          setCharIndex(charIndex - 1);
        } else {
          // 删完了，切换到下一个文本
          setIsDeleting(false);
          setTextIndex((textIndex + 1) % TYPING_TEXTS.length);
        }
      }
    }, isDeleting ? 25 : 45);

    return () => clearTimeout(timeout);
  }, [charIndex, isDeleting, textIndex]);

  return displayText;
}

// ============ 快捷输入框（深色卡片样式） ============
function QuickInputBox(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  loading: boolean;
}) {
  const { value, onChange, onSubmit, loading } = props;
  const typingPlaceholder = useTypingPlaceholder();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  // 点击整个输入框区域时聚焦到textarea
  const handleContainerClick = () => {
    textareaRef.current?.focus();
  };

  return (
    <div className="max-w-[768px] w-full mx-auto px-5 mt-[5vh]">
      <div
        className="rounded-2xl overflow-hidden cursor-text"
        style={{
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 4px 32px rgba(0,0,0,0.3)',
        }}
        onClick={handleContainerClick}
      >
        {/* 输入区域 - 整个区域可点击 */}
        <div className="px-6 pt-5 pb-14 relative min-h-[80px]">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            className="w-full bg-transparent text-[16px] resize-none outline-none"
            style={{ 
              color: 'var(--text-primary)',
              minHeight: '32px',
            }}
            disabled={loading}
          />
          {/* 自定义打字动效占位符 */}
          {!value && (
            <div
              className="absolute top-5 left-6 pointer-events-none text-[16px]"
              style={{ color: 'rgba(255,255,255,0.4)' }}
            >
              {typingPlaceholder}
              <span className="animate-pulse">|</span>
            </div>
          )}
        </div>
        {/* 底部工具栏 */}
        <div className="flex items-center justify-between px-5 pb-4">
          {/* 左侧：附件按钮 */}
          <button
            type="button"
            className="w-9 h-9 rounded-full flex items-center justify-center transition-colors hover:bg-white/10"
            style={{
              background: 'rgba(255,255,255,0.08)',
              color: 'var(--text-muted)',
            }}
            title="附件"
            disabled
          >
            <Paperclip size={18} />
          </button>
          {/* 右侧：功能按钮组 */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="w-9 h-9 rounded-full flex items-center justify-center transition-colors hover:bg-white/10"
              style={{ color: 'var(--text-muted)' }}
              title="位置"
              disabled
            >
              <MapPin size={18} />
            </button>
            <button
              type="button"
              className="w-9 h-9 rounded-full flex items-center justify-center transition-colors hover:bg-white/10"
              style={{ color: 'var(--text-muted)' }}
              title="快捷"
              disabled
            >
              <Zap size={18} />
            </button>
            <button
              type="button"
              className="w-9 h-9 rounded-full flex items-center justify-center transition-colors hover:bg-white/10"
              style={{ color: 'var(--text-muted)' }}
              title="语言"
              disabled
            >
              <Globe size={18} />
            </button>
            <button
              type="button"
              className="w-9 h-9 rounded-full flex items-center justify-center transition-colors"
              style={{
                background: 'rgba(56,189,248,0.15)',
                color: 'rgb(56,189,248)',
              }}
              title="表情"
              disabled
            >
              <Smile size={18} />
            </button>
            {/* 发送按钮 */}
            <button
              type="button"
              onClick={onSubmit}
              disabled={loading || !value.trim()}
              className="w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200"
              style={{
                background: value.trim() ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.12)',
                color: value.trim() ? '#000' : 'var(--text-muted)',
                cursor: value.trim() ? 'pointer' : 'not-allowed',
              }}
            >
              <ArrowUp size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============ 场景标签 ============
function ScenarioTags(props: { onSelect: (prompt: string) => void; activeKey: string | null }) {
  const { onSelect, activeKey } = props;

  return (
    <div className="flex items-center justify-center gap-2 flex-wrap px-5 mt-8">
      {SCENARIO_TAGS.map((tag) => {
        const Icon = tag.icon;
        const isActive = activeKey === tag.key;
        const isPro = tag.isPro;

        if (isPro) {
          return (
            <button
              key={tag.key}
              type="button"
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] font-medium transition-all duration-200"
              style={{
                background: 'transparent',
                border: '1px solid rgba(250,176,5,0.5)',
                color: 'rgba(250,176,5,1)',
              }}
              onClick={() => {}}
            >
              <Icon size={14} />
              {tag.label}
            </button>
          );
        }

        return (
          <button
            key={tag.key}
            type="button"
            onClick={() => onSelect(tag.prompt)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] font-medium transition-all duration-200"
            style={{
              background: isActive ? 'rgba(255,255,255,0.08)' : 'transparent',
              border: '1px solid rgba(255,255,255,0.12)',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            <Icon size={14} />
            {tag.label}
          </button>
        );
      })}
    </div>
  );
}

// ============ 项目卡片（网格布局） ============
function ProjectCard(props: {
  workspace: ImageMasterWorkspace;
  onRename: () => void;
  onShare: () => void;
  onDelete: () => void;
  onClick: () => void;
}) {
  const { workspace: ws, onRename, onShare, onDelete, onClick } = props;
  const hasCover = ws.coverAssets && ws.coverAssets.length > 0;

  return (
    <div
      className="group cursor-pointer"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {/* 封面区域 */}
      <div
        className="h-[160px] w-full relative overflow-hidden rounded-lg transition-transform duration-200 group-hover:scale-[1.02]"
        data-ws-card="1"
        data-ws-id={ws.id}
        style={{
          background: hasCover ? 'transparent' : 'rgba(255,255,255,0.04)',
          border: hasCover ? 'none' : '1px solid rgba(255,255,255,0.06)',
        }}
      >
        {hasCover && <CoverMosaic title={ws.title || ws.id} assets={ws.coverAssets} />}
      </div>
      {/* 信息区域 */}
      <div className="pt-2 px-0.5">
        <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
          {ws.title || '未命名'}
        </div>
        <div className="mt-0.5 text-[11px] flex items-center justify-between" style={{ color: 'var(--text-muted)' }}>
          <span>更新于 {formatDate(ws.updatedAt)}</span>
          <div
            className="flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity duration-100 group-hover:opacity-100 group-hover:pointer-events-auto"
          >
            <Button
              size="xs"
              variant="secondary"
              className="h-5 w-5 p-0 rounded-md gap-0"
              onClick={(e) => { e.stopPropagation(); onRename(); }}
              title="重命名"
            >
              <Pencil size={10} />
            </Button>
            <Button
              size="xs"
              variant="secondary"
              className="h-5 w-5 p-0 rounded-md gap-0"
              onClick={(e) => { e.stopPropagation(); onShare(); }}
              title="共享"
            >
              <Users2 size={10} />
            </Button>
            <Button
              size="xs"
              variant="danger"
              className="h-5 w-5 p-0 rounded-md gap-0"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              title="删除"
            >
              <Trash2 size={10} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============ 新建项目卡片（网格布局） ============
function NewProjectCard(props: { onClick: () => void }) {
  return (
    <div
      className="cursor-pointer"
      onClick={props.onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onClick();
        }
      }}
    >
      {/* 封面区域 - 与其他卡片高度一致 */}
      <div
        className="h-[160px] rounded-lg flex flex-col items-center justify-center gap-2 transition-all duration-200 hover:bg-white/5"
        style={{
          border: '1px dashed rgba(255,255,255,0.15)',
          background: 'transparent',
        }}
      >
        <Plus size={24} style={{ color: 'var(--text-muted)' }} />
        <span className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
          新建项目
        </span>
      </div>
    </div>
  );
}

// ============ 项目列表（网格布局，一排5个） ============
function ProjectCarousel(props: {
  items: ImageMasterWorkspace[];
  loading: boolean;
  onCreate: () => void;
  onRename: (ws: ImageMasterWorkspace) => void;
  onShare: (ws: ImageMasterWorkspace) => void;
  onDelete: (ws: ImageMasterWorkspace) => void;
  onOpen: (ws: ImageMasterWorkspace) => void;
}) {
  const { items, loading, onCreate, onRename, onShare, onDelete, onOpen } = props;

  if (loading) {
    return (
      <div className="px-5 py-8">
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          加载中...
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 flex-1">
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-3 max-w-[1340px] mx-auto px-5">
        <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          最近项目
        </h2>
        <button
          type="button"
          className="flex items-center gap-0.5 text-[13px] font-medium transition-colors hover:opacity-80"
          style={{ color: 'rgba(250,176,5,0.9)' }}
        >
          查看全部
          <ChevronRight size={14} />
        </button>
      </div>
      {/* 网格布局，固定5列，居中 */}
      <div
        className="grid gap-4 pb-4 px-5 max-w-[1340px] mx-auto"
        style={{
          gridTemplateColumns: 'repeat(5, 250px)',
        }}
      >
        <NewProjectCard onClick={onCreate} />
        {items.map((ws) => (
          <ProjectCard
            key={ws.id}
            workspace={ws}
            onRename={() => onRename(ws)}
            onShare={() => onShare(ws)}
            onDelete={() => onDelete(ws)}
            onClick={() => onOpen(ws)}
          />
        ))}
      </div>
    </div>
  );
}

// ============ 主页面 ============
export default function VisualAgentWorkspaceListPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ImageMasterWorkspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const refreshBusyRef = useRef<Set<string>>(new Set());
  const lastRefreshHashRef = useRef<Map<string, string>>(new Map());

  // 快捷输入框状态
  const [inputValue, setInputValue] = useState('');
  const [inputLoading, setInputLoading] = useState(false);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // 共享对话框状态
  const [shareOpen, setShareOpen] = useState(false);
  const [shareWs, setShareWs] = useState<ImageMasterWorkspace | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [memberSet, setMemberSet] = useState<Set<string>>(new Set());

  const memberIds = useMemo(() => Array.from(memberSet), [memberSet]);

  const reload = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await listImageMasterWorkspaces({ limit: 30 });
      if (!res.success) {
        setError(res.error?.message || '加载 workspace 失败');
        return;
      }
      const list = Array.isArray(res.data?.items) ? res.data.items : [];
      const filtered = list.filter((item) => item.scenarioType !== 'article-illustration');
      setItems(filtered);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  // 封面刷新逻辑
  useEffect(() => {
    if (items.length === 0) return;
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-ws-card="1"][data-ws-id]'));
    if (els.length === 0) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const ent of entries) {
          if (!ent.isIntersecting) continue;
          const el = ent.target as HTMLElement;
          const wid = String(el.getAttribute('data-ws-id') || '').trim();
          if (!wid) continue;

          const ws = items.find((x) => x.id === wid);
          if (!ws) continue;
          if (!ws.coverStale) continue;

          const contentHash = String(ws.contentHash ?? '').trim();
          const last = lastRefreshHashRef.current.get(wid) ?? '';
          if (contentHash && last === contentHash) continue;
          if (refreshBusyRef.current.has(wid)) continue;

          refreshBusyRef.current.add(wid);
          lastRefreshHashRef.current.set(wid, contentHash);

          void (async () => {
            try {
              const res = await refreshImageMasterWorkspaceCover({
                id: wid,
                limit: 6,
                idempotencyKey: contentHash ? `ws_cover_${wid}_${contentHash}` : `ws_cover_${wid}_${Date.now()}`,
              });
              if (res.success && res.data?.workspace) {
                const next = res.data.workspace;
                setItems((prev) => prev.map((x) => (x.id === wid ? { ...x, ...next } : x)));
              }
            } finally {
              refreshBusyRef.current.delete(wid);
            }
          })();
        }
      },
      { root: null, threshold: 0.15 }
    );

    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, [items]);

  // 创建新 workspace（无初始 prompt）
  const onCreate = async () => {
    const title = await systemDialog.prompt({
      title: '新建 Workspace',
      message: '请输入项目名称',
      defaultValue: '未命名',
      confirmText: '创建',
      cancelText: '取消',
    });
    if (title == null) return;
    const res = await createImageMasterWorkspace({ title: title.trim() || '未命名', idempotencyKey: `ws_create_${Date.now()}` });
    if (!res.success) {
      await systemDialog.alert(res.error?.message || '创建失败');
      return;
    }
    const ws = res.data.workspace;
    navigate(`/visual-agent/${encodeURIComponent(ws.id)}`);
  };

  // 快捷输入提交：创建 workspace 并跳转（带初始 prompt）
  const onQuickSubmit = async () => {
    const prompt = inputValue.trim();
    if (!prompt) return;

    setInputLoading(true);
    try {
      const res = await createImageMasterWorkspace({
        title: prompt.slice(0, 20) || '未命名',
        idempotencyKey: `ws_quick_${Date.now()}`,
      });
      if (!res.success) {
        await systemDialog.alert(res.error?.message || '创建失败');
        return;
      }
      const ws = res.data.workspace;
      navigate(`/visual-agent/${encodeURIComponent(ws.id)}?prompt=${encodeURIComponent(prompt)}`);
    } finally {
      setInputLoading(false);
    }
  };

  // 场景标签选择
  const onTagSelect = (prompt: string) => {
    if (!prompt) return;
    setInputValue(prompt);
    const tag = SCENARIO_TAGS.find((t) => t.prompt === prompt);
    setActiveTag(tag?.key ?? null);
  };

  // 新建文件夹（目前作为占位功能，后续可接入后端）
  const onCreateFolder = async () => {
    const folderName = await systemDialog.prompt({
      title: '新建文件夹',
      message: '请输入文件夹名称',
      defaultValue: '新文件夹',
      confirmText: '创建',
      cancelText: '取消',
    });
    if (folderName == null) return;
    // TODO: 后端尚未支持文件夹功能，暂时提示
    await systemDialog.alert(`文件夹功能正在开发中，将创建名为「${folderName.trim() || '新文件夹'}」的文件夹。`);
  };

  const onRename = async (ws: ImageMasterWorkspace) => {
    const title = await systemDialog.prompt({
      title: '重命名',
      message: '请输入新名称',
      defaultValue: ws.title || '',
      confirmText: '保存',
      cancelText: '取消',
    });
    if (title == null) return;
    const res = await updateImageMasterWorkspace({
      id: ws.id,
      title: title.trim() || '未命名',
      idempotencyKey: `ws_rename_${Date.now()}`,
    });
    if (!res.success) {
      await systemDialog.alert(res.error?.message || '重命名失败');
      return;
    }
    await reload();
  };

  const onDelete = async (ws: ImageMasterWorkspace) => {
    const ok = await systemDialog.confirm({
      title: '确认删除',
      message: `确认删除「${ws.title || '未命名'}」？（将删除画布与消息，资产记录会被清理）`,
      tone: 'danger',
      confirmText: '删除',
      cancelText: '取消',
    });
    if (!ok) return;
    const res = await deleteImageMasterWorkspace({ id: ws.id, idempotencyKey: `ws_del_${Date.now()}` });
    if (!res.success) {
      await systemDialog.alert(res.error?.message || '删除失败');
      return;
    }
    await reload();
  };

  const openShare = async (ws: ImageMasterWorkspace) => {
    setShareWs(ws);
    setMemberSet(new Set((ws.memberUserIds ?? []).filter(Boolean)));
    setShareOpen(true);
    if (users.length === 0 && !usersLoading) {
      setUsersLoading(true);
      try {
        const res = await getUsers({ page: 1, pageSize: 200, role: 'ADMIN' });
        if (res.success) {
          setUsers(Array.isArray(res.data?.items) ? res.data.items : []);
        }
      } finally {
        setUsersLoading(false);
      }
    }
  };

  const saveShare = async () => {
    const ws = shareWs;
    if (!ws) return;
    const res = await updateImageMasterWorkspace({
      id: ws.id,
      memberUserIds: memberIds,
      idempotencyKey: `ws_share_${Date.now()}`,
    });
    if (!res.success) {
      await systemDialog.alert(res.error?.message || '保存共享失败');
      return;
    }
    setShareOpen(false);
    setShareWs(null);
    await reload();
  };

  return (
    <div
      className="h-full min-h-0 flex flex-col overflow-auto relative"
      style={{
        background: 'linear-gradient(180deg, #1a1a1a 0%, #0f0f0f 100%)',
      }}
    >
      {/* 浮动工具栏 - 页面左侧垂直居中 */}
      <div className="absolute left-4 top-1/2 -translate-y-1/2 z-20">
        <FloatingToolbar onNewProject={onCreate} onNewFolder={onCreateFolder} />
      </div>

      {/* 顶部居中区域 */}
      <div className="flex flex-col items-center justify-center pt-[12vh] pb-6">
        {/* Hero 区域 */}
        <HeroSection />

        {/* 快捷输入框 */}
        <QuickInputBox
        value={inputValue}
        onChange={(v) => {
          setInputValue(v);
          const tag = SCENARIO_TAGS.find((t) => t.prompt === v);
          setActiveTag(tag?.key ?? null);
        }}
        onSubmit={onQuickSubmit}
        loading={inputLoading}
      />

        {/* 场景标签 */}
        <ScenarioTags onSelect={onTagSelect} activeKey={activeTag} />
      </div>

      {/* 错误提示 */}
      {error ? (
        <div className="px-5 mt-4">
          <Card>
            <div className="text-sm" style={{ color: 'rgba(255,120,120,0.95)' }}>
              {error}
            </div>
          </Card>
        </div>
      ) : null}

      {/* 项目列表 */}
      <ProjectCarousel
        items={items}
        loading={loading}
        onCreate={onCreate}
        onRename={onRename}
        onShare={openShare}
        onDelete={onDelete}
        onOpen={(ws) => navigate(`/visual-agent/${encodeURIComponent(ws.id)}`)}
      />

      {/* 共享对话框 */}
      <Dialog
        open={shareOpen}
        onOpenChange={(o) => {
          setShareOpen(o);
          if (!o) setShareWs(null);
        }}
        title="共享 Workspace"
        description="选择可访问该 Workspace 的管理员账号（最小共享：成员可编辑）。"
        maxWidth={720}
        content={
          <div className="h-full min-h-0 flex flex-col gap-3">
            <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              当前项目：{shareWs?.title || '未命名'}
            </div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              已选成员：{memberIds.length} 个
            </div>
            <div className="flex-1 min-h-0 overflow-auto rounded-xl" style={{ border: '1px solid var(--border-subtle)' }}>
              {usersLoading ? (
                <div className="p-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                  加载管理员列表中...
                </div>
              ) : users.length === 0 ? (
                <div className="p-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                  未加载到管理员用户
                </div>
              ) : (
                <div className="p-2 space-y-1">
                  {users.map((u) => {
                    const checked = memberSet.has(u.userId);
                    return (
                      <button
                        key={u.userId}
                        type="button"
                        className="w-full flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-white/5"
                        style={{ border: '1px solid transparent', color: 'var(--text-primary)' }}
                        onClick={() => {
                          setMemberSet((prev) => {
                            const next = new Set(prev);
                            if (next.has(u.userId)) next.delete(u.userId);
                            else next.add(u.userId);
                            return next;
                          });
                        }}
                      >
                        <input type="checkbox" checked={checked} readOnly />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold truncate">{u.displayName || u.username}</div>
                          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {u.userId}
                          </div>
                        </div>
                        <ArrowRight size={16} style={{ opacity: 0.6 }} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => setShareOpen(false)}>
                取消
              </Button>
              <Button variant="primary" onClick={() => void saveShare()} disabled={!shareWs}>
                保存
              </Button>
            </div>
          </div>
        }
      />
    </div>
  );
}
