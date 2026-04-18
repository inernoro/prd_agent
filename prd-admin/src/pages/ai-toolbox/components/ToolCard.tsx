import { useRef, useState } from 'react';
import type { ToolboxItem } from '@/services';
import { useToolboxStore } from '@/stores/toolboxStore';
import { useNavigate } from 'react-router-dom';
import { DesktopDownloadDialog } from '@/components/ui/DesktopDownloadDialog';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/lib/toast';
import {
  ArrowUpRight,
  FileText,
  Palette,
  PenTool,
  Bug,
  Code2,
  Languages,
  FileSearch,
  BarChart3,
  Bot,
  Lightbulb,
  Target,
  Wrench,
  Sparkles,
  Rocket,
  MessageSquare,
  Zap,
  Brain,
  Cpu,
  Database,
  Globe,
  Globe2,
  GitFork,
  Edit,
  Copy,
  Trash2,
  Image,
  Music,
  Video,
  BookOpen,
  GraduationCap,
  Briefcase,
  Heart,
  Star,
  Shield,
  Lock,
  Search,
  Layers,
  Swords,
  HardHat,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface ToolCardProps {
  item: ToolboxItem;
  /**
   * 卡片来源：
   * - 'mine'（默认）：用户自己的工具列表，点击进入详情；自定义工具支持快捷"编辑"
   * - 'marketplace'：他人公开的工具，点击 = Fork 到自己列表
   */
  source?: 'mine' | 'marketplace';
}

// 图标组件映射
const ICON_MAP: Record<string, LucideIcon> = {
  FileText, Palette, PenTool, Bug, Code2, Languages, FileSearch, BarChart3,
  Bot, Lightbulb, Target, Wrench, Sparkles, Rocket, MessageSquare, Zap,
  Brain, Cpu, Database, Globe, Image, Music, Video, BookOpen,
  GraduationCap, Briefcase, Heart, Star, Shield, Lock, Search, Layers, Swords,
};

const ACCENT_PALETTE: Record<string, { from: string; soft: string }> = {
  FileText:     { from: '#3B82F6', soft: '#93C5FD' },
  Palette:      { from: '#A855F7', soft: '#D8B4FE' },
  PenTool:      { from: '#F59E0B', soft: '#FDE68A' },
  Bug:          { from: '#EF4444', soft: '#FCA5A5' },
  Code2:        { from: '#10B981', soft: '#6EE7B7' },
  Languages:    { from: '#06B6D4', soft: '#67E8F9' },
  FileSearch:   { from: '#EAB308', soft: '#FDE68A' },
  BarChart3:    { from: '#8B5CF6', soft: '#C4B5FD' },
  Bot:          { from: '#6366F1', soft: '#A5B4FC' },
  Lightbulb:    { from: '#F59E0B', soft: '#FDE68A' },
  Target:       { from: '#EF4444', soft: '#FCA5A5' },
  Wrench:       { from: '#78716C', soft: '#D6D3D1' },
  Sparkles:     { from: '#A855F7', soft: '#D8B4FE' },
  Rocket:       { from: '#3B82F6', soft: '#93C5FD' },
  MessageSquare:{ from: '#14B8A6', soft: '#5EEAD4' },
  Brain:        { from: '#D946EF', soft: '#F0ABFC' },
  Cpu:          { from: '#64748B', soft: '#94A3B8' },
  Database:     { from: '#0EA5E9', soft: '#7DD3FC' },
  Globe:        { from: '#22D3EE', soft: '#A5F3FC' },
  Image:        { from: '#EC4899', soft: '#F9A8D4' },
  Music:        { from: '#D946EF', soft: '#F0ABFC' },
  Video:        { from: '#F43F5E', soft: '#FDA4AF' },
  BookOpen:     { from: '#22C55E', soft: '#86EFAC' },
  GraduationCap:{ from: '#3B82F6', soft: '#93C5FD' },
  Briefcase:    { from: '#78716C', soft: '#A8A29E' },
  Heart:        { from: '#F43F5E', soft: '#FDA4AF' },
  Star:         { from: '#F59E0B', soft: '#FCD34D' },
  Shield:       { from: '#3B82F6', soft: '#93C5FD' },
  Lock:         { from: '#64748B', soft: '#94A3B8' },
  Search:       { from: '#14B8A6', soft: '#5EEAD4' },
  Layers:       { from: '#8B5CF6', soft: '#C4B5FD' },
  Swords:       { from: '#F97316', soft: '#FDBA74' },
};

/** Agent 封面图 CDN 路径映射 */
const AGENT_COVER_PATHS: Record<string, string> = {
  'prd-agent': 'icon/backups/agent/prd-agent.png',
  'visual-agent': 'icon/backups/agent/visual-agent.png',
  'literary-agent': 'icon/backups/agent/literary-agent.png',
  'defect-agent': 'icon/backups/agent/defect-agent.png',
  'video-agent': 'icon/backups/agent/video-agent.png',
  'report-agent': 'icon/backups/agent/report-agent.png',
  'arena': 'icon/backups/agent/arena.png',
  'shortcuts-agent': 'icon/backups/agent/shortcuts-agent.png',
  'workflow-agent': 'icon/backups/agent/workflow-agent.png',
};

/** Agent 封面视频 CDN 路径映射 */
const AGENT_VIDEO_PATHS: Record<string, string> = {
  'prd-agent': 'icon/backups/agent/prd-agent.mp4',
  'visual-agent': 'icon/backups/agent/visual-agent.mp4',
  'literary-agent': 'icon/backups/agent/literary-agent.mp4',
  'defect-agent': 'icon/backups/agent/defect-agent.mp4',
  'video-agent': 'icon/backups/agent/video-agent.mp4',
  'report-agent': 'icon/backups/agent/report-agent.mp4',
  'arena': 'icon/backups/agent/arena.mp4',
  'shortcuts-agent': 'icon/backups/agent/shortcuts-agent.mp4',
  'workflow-agent': 'icon/backups/agent/workflow-agent.mp4',
};

function getCoverImageUrl(agentKey?: string): string | null {
  if (!agentKey) return null;
  const path = AGENT_COVER_PATHS[agentKey];
  if (!path) return null;
  const base = (useAuthStore.getState().cdnBaseUrl ?? '').replace(/\/+$/, '');
  return base ? `${base}/${path}` : `/${path}`;
}

function getCoverVideoUrl(agentKey?: string): string | null {
  if (!agentKey) return null;
  const path = AGENT_VIDEO_PATHS[agentKey];
  if (!path) return null;
  const base = (useAuthStore.getState().cdnBaseUrl ?? '').replace(/\/+$/, '');
  return base ? `${base}/${path}` : `/${path}`;
}

function getIconComponent(iconName: string): LucideIcon {
  return ICON_MAP[iconName] || Bot;
}

function getPalette(iconName: string) {
  return ACCENT_PALETTE[iconName] ?? ACCENT_PALETTE.Bot;
}

import { SpotlightEffect } from './SpotlightEffect';
import { ReviewAgentCardArt } from './ReviewAgentCardArt';

export function ToolCard({ item, source = 'mine' }: ToolCardProps) {
  const {
    selectItem,
    toggleFavorite,
    isFavorite,
    startEdit,
    forkItem,
    setCategory,
    togglePublish,
    deleteItem,
  } = useToolboxStore();
  const navigate = useNavigate();
  const palette = getPalette(item.icon);
  const IconComponent = getIconComponent(item.icon);
  const isCustomized = !!item.routePath;
  const favorited = isFavorite(item.id);
  const coverUrl = getCoverImageUrl(item.agentKey);
  const videoUrl = getCoverVideoUrl(item.agentKey);
  const [coverFailed, setCoverFailed] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
  const [forking, setForking] = useState(false);
  const [togglingPublish, setTogglingPublish] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const isMarketplaceCard = source === 'marketplace';
  // 双重判定：有 createdByUserId 也视为用户自建（兼容后端旧数据未返回 type 字段）
  const isOwnCustomCard =
    source === 'mine' && (item.type === 'custom' || !!item.createdBy || !!item.createdByName);
  /** 内置但非"定制版"（无独立路由页），可以被克隆为我的副本 */
  const isForkableBuiltin =
    source === 'mine' &&
    item.type === 'builtin' &&
    !isOwnCustomCard &&
    !item.routePath &&
    item.agentKey !== 'prd-agent';

  // 作者名 fallback 策略：
  // 1) 后端返回的 createdByName 优先
  // 2) 用户自建 + 未返回 name（GetUserName() 依赖 JWT "name" claim，可能为空）→ 用当前登录用户的 displayName
  // 3) marketplace 卡片：后端必然返回 createdByName，兜底"匿名用户"
  // 4) 其它（内置等）：兜底"官方"
  const currentUser = useAuthStore((s) => s.user);
  const authorName =
    item.createdByName ||
    (isOwnCustomCard
      ? currentUser?.displayName || currentUser?.username || '我'
      : isMarketplaceCard
      ? '匿名用户'
      : '官方');

  const handleFork = async () => {
    if (forking) return;
    setForking(true);
    try {
      const forked = await forkItem(item.id);
      if (forked) {
        // 跳到「我创建的」让用户立刻看到 Fork 出来的副本
        setCategory('custom');
      }
    } finally {
      setForking(false);
    }
  };

  const handleClick = () => {
    if (isMarketplaceCard) {
      // 市场卡片：直接 Fork，避免再多一步进详情
      void handleFork();
      return;
    }
    if (item.agentKey === 'prd-agent') {
      setDownloadDialogOpen(true);
      return;
    }
    if (isCustomized && item.routePath) {
      navigate(item.routePath);
    } else {
      selectItem(item);
    }
  };

  const handleToggleFavorite = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleFavorite(item.id);
  };

  const handleQuickEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    startEdit(item);
  };

  const handleCopyBuiltin = (e: React.MouseEvent) => {
    e.stopPropagation();
    // 与 ToolDetail 的「复制并编辑」逻辑一致
    startEdit({
      ...item,
      id: '', // 空 id = 新建
      name: `${item.name}（我的副本）`,
      category: 'custom',
      type: 'custom',
      prompt: item.systemPrompt,
    } as ToolboxItem);
  };

  const handleTogglePublish = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (togglingPublish) return;
    const newValue = !item.isPublic;
    if (newValue) {
      const ok = window.confirm(
        '公开发布后，所有用户都能在百宝箱「公开市场」Tab 看到并 Fork 这个智能体' +
          '（包含名称、描述、提示词、标签）。\n\n确定要公开发布吗？'
      );
      if (!ok) return;
    }
    setTogglingPublish(true);
    try {
      const ok = await togglePublish(item.id, newValue);
      if (ok) toast.success(newValue ? '已公开发布到市场' : '已取消公开');
      else toast.error('操作失败，请稍后重试');
    } finally {
      setTogglingPublish(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = window.confirm(`确定删除「${item.name}」吗？此操作不可恢复。`);
    if (!ok) return;
    const success = await deleteItem(item.id);
    if (success) toast.success('已删除');
    else toast.error('删除失败');
  };

  const handleMouseEnter = () => {
    setHovering(true);
    if (videoRef.current && videoReady) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(() => {});
    }
  };

  const handleMouseLeave = () => {
    setHovering(false);
    if (videoRef.current) {
      videoRef.current.pause();
    }
  };

  return (
    <>
    <SpotlightEffect
      spotlightColor={`${palette.from}33`} // 20% opacity of the main color
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="group relative rounded-xl overflow-hidden cursor-pointer transition-all duration-500 hover:-translate-y-1"
      style={{
        background: 'rgba(15, 23, 42, 0.4)',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3), inset 0 1px 1px rgba(255, 255, 255, 0.1)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        aspectRatio: '3 / 4',
      }}
    >
      {/* 噪点纹理涂层 */}
      <div
        className="absolute inset-0 z-0 opacity-[0.03] mix-blend-overlay pointer-events-none"
        style={{ backgroundImage: 'var(--glass-noise)' }}
      />
      {/* Cover visual — 内联插画 / CDN 图片 / 渐变兜底 */}
      {item.agentKey === 'review-agent' ? (
        <ReviewAgentCardArt />
      ) : coverUrl && !coverFailed ? (
        <>
          <img
            src={coverUrl}
            alt={item.name}
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04] z-0"
            draggable={false}
            onError={() => setCoverFailed(true)}
          />
          {videoUrl && (
            <video
              ref={videoRef}
              src={videoUrl}
              muted
              loop
              playsInline
              preload="metadata"
              onCanPlayThrough={() => setVideoReady(true)}
              className="absolute inset-0 w-full h-full object-cover z-[1] transition-opacity duration-500"
              style={{ opacity: hovering && videoReady ? 1 : 0 }}
            />
          )}
        </>
      ) : (
        <div
          className="absolute inset-0 z-0"
          style={{
            background: `
              radial-gradient(circle at 50% 0%, ${palette.from}25 0%, transparent 60%),
              radial-gradient(ellipse at 80% 80%, ${palette.from}15 0%, transparent 50%),
              linear-gradient(180deg, rgba(20, 22, 35, 0.8) 0%, rgba(12, 14, 22, 1) 100%)
            `,
          }}
        >
          {/* 图标视觉焦点 + 光晕 */}
          <div
            className="absolute inset-x-0 top-[18%] flex justify-center transition-transform duration-700 ease-out group-hover:scale-110 group-hover:-translate-y-1"
          >
            {/* 图标背后的柔光圈 */}
            <div
              className="absolute rounded-full blur-2xl transition-opacity duration-500 group-hover:opacity-100 opacity-60"
              style={{
                width: 64,
                height: 64,
                background: `radial-gradient(circle, ${palette.from}60 0%, ${palette.from}20 50%, transparent 100%)`,
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
              }}
            />
            <IconComponent
              size={28}
              strokeWidth={1.4}
              className="relative drop-shadow-2xl"
              style={{ color: palette.soft, opacity: 0.95 }}
            />
          </div>
          {/* 装饰性光点 */}
          <div
            className="absolute w-16 h-16 rounded-full blur-[20px] opacity-20 group-hover:opacity-40 transition-opacity duration-500"
            style={{
              background: palette.from,
              top: '5%',
              right: '5%',
            }}
          />
        </div>
      )}

      {/* 底部渐变遮罩 — 无缝衔接信息区 */}
      <div
        className="absolute inset-0 pointer-events-none z-10"
        style={{
          background: `linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0) 40%, rgba(0,0,0,0.85) 75%, rgba(0,0,0,0.95) 100%)`,
        }}
      />

      {/* Hover 时顶部边框流光高光边缘 */}
      <div
        className="absolute top-0 inset-x-0 h-[1px] pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-500 z-20"
        style={{
          background: `linear-gradient(90deg, transparent 10%, ${palette.from}90 50%, transparent 90%)`,
        }}
      />

      {/* 右上角操作浮条 — 卡片 hover 时显示核心操作：编辑/公开/删除 或 复制 */}
      {(isOwnCustomCard || isForkableBuiltin) && (
        <div
          className="absolute top-1.5 right-1.5 z-30 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
          style={{
            background: 'rgba(0, 0, 0, 0.55)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            borderRadius: 8,
            padding: '3px 4px',
            border: '1px solid rgba(255, 255, 255, 0.1)',
          }}
        >
          {isOwnCustomCard && (
            <>
              <button
                onClick={handleQuickEdit}
                title="编辑此智能体"
                className="w-6 h-6 rounded-md flex items-center justify-center transition-all duration-150 hover:bg-white/15 hover:scale-110"
              >
                <Edit size={12} style={{ color: 'rgba(255, 255, 255, 0.85)' }} />
              </button>
              <button
                onClick={handleTogglePublish}
                disabled={togglingPublish}
                title={
                  item.isPublic
                    ? '已公开 — 他人可在「公开市场」Tab 看到并 Fork；点击取消公开'
                    : '公开发布到「公开市场」，让所有用户都能看到并 Fork'
                }
                className="w-6 h-6 rounded-md flex items-center justify-center transition-all duration-150 hover:bg-white/15 hover:scale-110 disabled:opacity-50"
                style={item.isPublic ? { background: 'rgba(16, 185, 129, 0.25)' } : undefined}
              >
                <Globe2
                  size={12}
                  style={{ color: item.isPublic ? '#6ee7b7' : 'rgba(255, 255, 255, 0.85)' }}
                />
              </button>
              <button
                onClick={handleDelete}
                title="删除此智能体"
                className="w-6 h-6 rounded-md flex items-center justify-center transition-all duration-150 hover:bg-red-500/30 hover:scale-110"
              >
                <Trash2 size={12} style={{ color: 'rgba(252, 165, 165, 0.95)' }} />
              </button>
            </>
          )}
          {isForkableBuiltin && (
            <button
              onClick={handleCopyBuiltin}
              title="复制一份到我的百宝箱（可自由修改提示词、模型等参数）"
              className="flex items-center gap-1 h-6 px-2 rounded-md transition-all duration-150 hover:bg-white/15 text-[10px] font-medium"
              style={{ color: 'rgba(255, 255, 255, 0.9)' }}
            >
              <Copy size={11} />
              复制并编辑
            </button>
          )}
        </div>
      )}

      {/* 底部信息区 */}
      <div
        className="absolute bottom-0 left-0 right-0 px-3 pb-2.5 pt-1.5 z-20"
      >
        {/* 标题行 */}
        <div className="flex items-center gap-1 mb-1">
          <div
            className="font-semibold text-[13px] truncate flex-1"
            style={{
              color: '#ffffff',
              textShadow: '0 1px 4px rgba(0,0,0,0.8)',
            }}
          >
            {item.name}
          </div>
          <ArrowUpRight
            size={13}
            className="shrink-0 opacity-0 group-hover:opacity-100 transition-all duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
            style={{ color: palette.soft }}
          />
        </div>

        {/* 描述 */}
        <div
          className="text-[11px] line-clamp-2 leading-snug mb-2 transition-colors duration-300 group-hover:text-white/85"
          style={{
            color: 'rgba(255, 255, 255, 0.6)',
            textShadow: '0 1px 4px rgba(0,0,0,0.8)',
            minHeight: '2em',
          }}
        >
          {item.description}
        </div>

        {/* Tags */}
        {item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {item.tags.slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-1.5 py-0.5 rounded backdrop-blur-md transition-colors duration-300"
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  color: 'rgba(255, 255, 255, 0.7)',
                  border: '1px solid rgba(255, 255, 255, 0.05)',
                }}
              >
                {tag}
              </span>
            ))}
            {item.tags.length > 2 && (
              <span className="text-[10px] px-0.5 font-medium" style={{ color: 'rgba(255, 255, 255, 0.4)' }}>
                +{item.tags.length - 2}
              </span>
            )}
          </div>
        )}

        {/* Footer —
         * 定制版（有独立路由页）：显示「定制版」徽章，不显示作者
         * 其它所有：显示作者头像/名字 + 状态徽章
         *   - 用户自建 && !isPublic → 橙色「施工中」
         *   - isPublic              → 绿色「已公开」
         *   - 对话型内置             → 无状态徽章（官方默认公开）
         */}
        <div
          className="flex items-center justify-between gap-1 pt-1.5"
          style={{ borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}
        >
          {!isCustomized ? (
            <>
              {/* 作者头像 + 名字 + 状态徽章 */}
              <div className="flex items-center gap-1 min-w-0">
                {isOwnCustomCard && !item.isPublic && (
                  <span
                    className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium inline-flex items-center gap-1"
                    style={{
                      background: 'rgba(245, 158, 11, 0.18)',
                      color: '#fcd34d',
                      border: '1px solid rgba(245, 158, 11, 0.45)',
                    }}
                    title="未公开 — 仅自己可见；点卡片右上角 🌍 即可公开发布"
                  >
                    <HardHat size={10} />
                    施工中
                  </span>
                )}
                {item.isPublic && !isMarketplaceCard && (
                  <span
                    className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium inline-flex items-center gap-1"
                    style={{
                      background: 'rgba(16, 185, 129, 0.18)',
                      color: '#6ee7b7',
                      border: '1px solid rgba(16, 185, 129, 0.45)',
                    }}
                    title="已公开到市场，他人可 Fork"
                  >
                    <Globe2 size={10} />
                    已公开
                  </span>
                )}
                <div
                  className="w-4 h-4 rounded-full shrink-0 flex items-center justify-center text-[9px] font-bold"
                  style={{
                    background: `linear-gradient(135deg, ${palette.from}, ${palette.soft})`,
                    color: 'rgba(0, 0, 0, 0.7)',
                  }}
                  title={authorName}
                >
                  {authorName[0]}
                </div>
                <span
                  className="text-[10px] truncate"
                  style={{ color: 'rgba(255, 255, 255, 0.5)' }}
                >
                  {authorName}
                </span>
              </div>
              {/* 右侧：marketplace 模式显示 Fork 数 + Fork 按钮；自有卡片显示使用次数 + 快捷编辑 + 收藏 */}
              <div className="flex items-center gap-1.5 shrink-0">
                {isMarketplaceCard ? (
                  <>
                    {(item.forkCount ?? 0) > 0 && (
                      <span
                        className="flex items-center gap-0.5 text-[10px]"
                        style={{ color: 'rgba(255, 255, 255, 0.5)' }}
                        title="被 Fork 次数"
                      >
                        <GitFork size={10} style={{ color: palette.soft }} />
                        {item.forkCount}
                      </span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleFork();
                      }}
                      disabled={forking}
                      className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded font-medium transition-all duration-300 hover:scale-105 disabled:opacity-50"
                      style={{
                        background: `${palette.from}25`,
                        color: palette.soft,
                        border: `1px solid ${palette.from}40`,
                      }}
                      title="复制到我的百宝箱"
                    >
                      <GitFork size={11} />
                      {forking ? 'Fork 中…' : 'Fork'}
                    </button>
                  </>
                ) : (
                  <>
                    {item.usageCount > 0 && (
                      <span
                        className="flex items-center gap-0.5 text-[10px]"
                        style={{ color: 'rgba(255, 255, 255, 0.45)' }}
                      >
                        <Zap size={10} style={{ color: palette.soft }} />
                        {item.usageCount >= 1000 ? `${(item.usageCount / 1000).toFixed(1)}k` : item.usageCount}
                      </span>
                    )}
                    <button
                      onClick={handleToggleFavorite}
                      className="flex items-center justify-center transition-all duration-300 hover:scale-125"
                      title={favorited ? '取消收藏' : '收藏'}
                    >
                      <Star
                        size={12}
                        fill={favorited ? '#FBBF24' : 'none'}
                        style={{
                          color: favorited ? '#FBBF24' : 'rgba(255, 255, 255, 0.25)',
                          filter: favorited ? 'drop-shadow(0 0 4px rgba(251, 191, 36, 0.5))' : 'none',
                        }}
                      />
                    </button>
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              {/* 定制版：徽章 + 收藏（定制版是官方独立页面，不需要作者信息） */}
              <div className="flex items-center gap-1 min-w-0">
                {item.wip && (
                  <span
                    className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium inline-flex items-center gap-1"
                    style={{
                      background: 'rgba(245, 158, 11, 0.18)',
                      color: '#fcd34d',
                      border: '1px solid rgba(245, 158, 11, 0.45)',
                    }}
                    title="未正式发布"
                  >
                    <HardHat size={10} />
                    施工中
                  </span>
                )}
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-medium inline-flex items-center gap-1"
                  style={{
                    background: `${palette.from}25`,
                    color: palette.soft,
                    border: `1px solid ${palette.from}40`,
                  }}
                >
                  <Sparkles size={10} />
                  定制版
                </span>
              </div>
              <button
                onClick={handleToggleFavorite}
                className="flex items-center justify-center transition-all duration-300 hover:scale-125"
                title={favorited ? '取消收藏' : '收藏'}
              >
                <Star
                  size={12}
                  fill={favorited ? '#FBBF24' : 'none'}
                  style={{
                    color: favorited ? '#FBBF24' : 'rgba(255, 255, 255, 0.25)',
                    filter: favorited ? 'drop-shadow(0 0 4px rgba(251, 191, 36, 0.5))' : 'none',
                  }}
                />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Hover inner border glow */}
      <div
        className="absolute inset-0 rounded-xl pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-500 z-30"
        style={{
          boxShadow: `inset 0 0 0 1px ${palette.from}60`,
        }}
      />
    </SpotlightEffect>

    <DesktopDownloadDialog open={downloadDialogOpen} onOpenChange={setDownloadDialogOpen} />
    </>
  );
}
