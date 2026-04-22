import { useRef, useState } from 'react';
import type { ToolboxItem } from '@/services';
import { useToolboxStore, NEW_BADGE_WINDOW_MS } from '@/stores/toolboxStore';
import { useNavigate } from 'react-router-dom';
import { DesktopDownloadDialog } from '@/components/ui/DesktopDownloadDialog';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import { resolveAvatarUrl } from '@/lib/avatar';
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
   * - 'mine'（默认）：BUILTIN 或用户自己的条目，点击进入详情；自定义工具支持快捷"编辑"
   * - 'marketplace'：他人公开的条目，点击**打开详情抽屉**（不直接 Fork！）
   *   用户必须在详情里显式点【创建副本】才会生成 Fork；平时只是"使用别人公开的原件"。
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
    newUnpublishedIds,
    dismissNewUnpublished,
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
  const isBuiltin = item.type === 'builtin';
  // "我自建的"严格判定：必须不是 BUILTIN，且满足 custom/或有后端返回的创建者 id 字段。
  // 不能再用 createdByName 兜底 —— BUILTIN普通版（如代码审查员）硬编码 createdByName='官方'，
  // 如果走 createdByName 兜底就会被误判成"自建草稿"，进而错挂「施工中」徽章给所有用户看。
  const isOwnCustomCard =
    source === 'mine' &&
    !isBuiltin &&
    (item.type === 'custom' || !!item.createdByUserId || !!item.createdBy);
  /** 新创建但还没公开发布的工具 — 脉动高亮「公开发布」按钮，引导用户完成发布动作 */
  const needsPublishHint = isOwnCustomCard && !item.isPublic && newUnpublishedIds.has(item.id);
  /** 内置但非"定制版"（无独立路由页），可以被克隆为我的副本 */
  const isForkableBuiltin =
    source === 'mine' &&
    item.type === 'builtin' &&
    !isOwnCustomCard &&
    !item.routePath &&
    item.agentKey !== 'prd-agent';
  /** 别人公开 ≤ 7 天内 → 卡片右上角红底 NEW 徽章，帮助用户发现新发布 */
  const isNewByOthers =
    isMarketplaceCard &&
    !!item.createdAt &&
    Date.now() - new Date(item.createdAt).getTime() < NEW_BADGE_WINDOW_MS;

  // 作者名 fallback 策略：
  // 1) 后端返回的 createdByName 优先（后端已在 /marketplace + GetItem 上按 User 表回填）
  // 2) 我自己创建的 → 用当前登录用户的 displayName/username（JWT name claim 兜底）
  // 3) BUILTIN → "官方"
  // 4) 其它（公开条目但后端也查不到作者）→ 根据 createdByUserId 末 6 位生成"用户 #xxxxxx"，而不是误导性的"匿名用户"
  const currentUser = useAuthStore((s) => s.user);
  const authorName =
    item.createdByName ||
    (isBuiltin
      ? '官方'
      : isOwnCustomCard
      ? currentUser?.displayName || currentUser?.username || '我'
      : (item.createdByUserId || item.createdBy)
      ? `用户 #${(item.createdByUserId || item.createdBy || '').slice(-6)}`
      : '官方');

  // 后端返回的字段是 createdByUserId（PascalCase→camelCase），历史代码里的 createdBy 是未被后端填充过的残留字段。
  // 两个都对比，确保与当前用户对照能正确判断 isMe。
  const isMe =
    !!currentUser?.userId &&
    (item.createdByUserId === currentUser.userId ||
      item.createdBy === currentUser.userId ||
      (isOwnCustomCard && !item.createdByUserId && !item.createdBy));
  // 头像 URL — BUILTIN官方 走 MAP 品牌徽标（下方 JSX 专门渲染），不走 img 通道
  const authorAvatarUrl = isBuiltin
    ? null
    : item.createdByAvatarFileName
    ? resolveAvatarUrl({ avatarFileName: item.createdByAvatarFileName })
    : isMe
    ? currentUser?.avatarUrl || null
    : null;

  const handleFork = async () => {
    if (forking) return;
    // 显式二次确认 —— 避免用户误点"拿来吧"后反复创建副本（反人类设计的历史教训）
    const ok = await systemDialog.confirm({
      title: `创建「${item.name}」的副本？`,
      message:
        '复制后你将拥有独立的副本，可以自由修改提示词、模型等参数；原作者的更新不会再同步给你。\n\n' +
        '如果只是想使用原版，直接在详情里对话即可，不需要创建副本。',
      confirmText: '创建副本',
      cancelText: '取消',
    });
    if (!ok) return;
    setForking(true);
    try {
      const forked = await forkItem(item.id);
      if (forked) {
        // 跳到「我的」让用户立刻看到 Fork 出来的副本
        setCategory('mine');
        toast.success('已创建副本', '你的副本已出现在「我的」筛选里');
      } else {
        toast.error('创建副本失败');
      }
    } finally {
      setForking(false);
    }
  };

  const handleClick = () => {
    // 不管卡片是"我的"还是"别人公开的"，点击一律打开详情抽屉 —— 不再偷偷 Fork。
    // 「创建副本」只能通过详情里或 Fork 按钮显式二次确认后才触发。
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
      const ok = await systemDialog.confirm({
        title: '确认公开发布',
        message:
          '公开发布后，其他用户会在百宝箱首页的「全部 / 别人的」里看到这个智能体' +
          '（包含名称、描述、提示词、标签；7 天内带 NEW 徽章）。\n\n' +
          '其他用户默认使用原版（数据存自己名下）；显式「创建副本」才会复制一份。',
        confirmText: '公开发布',
        cancelText: '取消',
      });
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
    const ok = await systemDialog.confirm({
      title: `删除「${item.name}」？`,
      message: '此操作不可恢复。该智能体下你自己的所有会话与消息也会失去入口（数据会短暂保留但无法继续对话）。',
      tone: 'danger',
      confirmText: '删除',
      cancelText: '取消',
    });
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

      {/* NEW 徽章 — 别人 7 天内发布的公开条目，左上角红底脉动，帮助用户一眼看到新发布 */}
      {isNewByOthers && (
        <div
          className="absolute top-1.5 left-1.5 z-30 text-[10px] font-bold px-1.5 py-0.5 rounded-md inline-flex items-center gap-0.5 animate-pulse"
          style={{
            background: 'linear-gradient(135deg, #ef4444, #dc2626)',
            color: '#fff',
            letterSpacing: '0.05em',
            boxShadow: '0 2px 8px rgba(239, 68, 68, 0.55), 0 0 0 1px rgba(255,255,255,0.2) inset',
          }}
          title={`这是一个 ${Math.max(
            1,
            Math.round((Date.now() - new Date(item.createdAt).getTime()) / 86400000)
          )} 天内新发布的公开智能体`}
        >
          <Sparkles size={9} />
          NEW
        </div>
      )}

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
          className={`absolute top-1.5 right-1.5 z-30 flex items-center gap-0.5 transition-opacity duration-200 ${
            needsPublishHint ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          style={{
            background: 'rgba(0, 0, 0, 0.55)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            borderRadius: 8,
            padding: '3px 4px',
            border: needsPublishHint
              ? '1px solid rgba(16, 185, 129, 0.6)'
              : '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: needsPublishHint
              ? '0 0 12px rgba(16, 185, 129, 0.5), 0 0 0 1px rgba(16, 185, 129, 0.3)'
              : undefined,
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
                onClick={(e) => {
                  // 用户已经注意到按钮，清除脉动标记（无论点后是否确认）
                  dismissNewUnpublished(item.id);
                  void handleTogglePublish(e);
                }}
                disabled={togglingPublish}
                title={
                  item.isPublic
                    ? '已公开 — 他人可在「公开市场」Tab 看到并 Fork；点击取消公开'
                    : needsPublishHint
                    ? '👈 点我公开发布！让同事也能看到这个智能体（否则只有你自己可见）'
                    : '公开发布到「公开市场」，让所有用户都能看到并 Fork'
                }
                className="relative w-6 h-6 rounded-md flex items-center justify-center transition-all duration-150 hover:bg-white/15 hover:scale-110 disabled:opacity-50"
                style={item.isPublic ? { background: 'rgba(16, 185, 129, 0.25)' } : undefined}
              >
                {needsPublishHint && (
                  <span
                    className="absolute inset-[-4px] rounded-lg animate-ping pointer-events-none"
                    style={{
                      background: 'rgba(16, 185, 129, 0.35)',
                      border: '1px solid rgba(16, 185, 129, 0.8)',
                    }}
                  />
                )}
                <Globe2
                  size={12}
                  className="relative"
                  style={{ color: item.isPublic ? '#6ee7b7' : needsPublishHint ? '#6ee7b7' : 'rgba(255, 255, 255, 0.85)' }}
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
                {isBuiltin ? (
                  // BUILTIN官方 工具 → MAP 品牌徽标（与 VideoLoader 一致的 M/A/P 三色缩写），
                  // 不再用首字母圆形块误导成"某用户头像"
                  <div
                    className="shrink-0 flex items-center justify-center rounded-md font-bold tracking-wide"
                    style={{
                      width: 22,
                      height: 14,
                      background:
                        'linear-gradient(135deg, rgba(192,192,204,0.18), rgba(106,106,122,0.08))',
                      border: '1px solid rgba(192,192,204,0.35)',
                      color: '#e0e0ec',
                      fontSize: 8,
                      letterSpacing: '0.08em',
                      lineHeight: 1,
                      fontFamily:
                        "'Inter', 'SF Pro Display', -apple-system, system-ui, sans-serif",
                    }}
                    title="MAP 平台官方工具"
                  >
                    MAP
                  </div>
                ) : authorAvatarUrl ? (
                  <img
                    src={authorAvatarUrl}
                    alt={authorName}
                    className="w-4 h-4 rounded-full shrink-0 object-cover"
                    style={{ border: '1px solid rgba(255, 255, 255, 0.15)' }}
                    title={authorName}
                    draggable={false}
                  />
                ) : (
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
                )}
                <span
                  className="text-[10px] truncate"
                  style={{ color: 'rgba(255, 255, 255, 0.5)' }}
                >
                  {authorName}
                </span>
              </div>
              {/* 右侧：别人公开的（marketplace）显示 Fork 数 +「我要创建副本」按钮；自有卡片显示使用次数 + 快捷编辑 + 收藏 */}
              <div className="flex items-center gap-1.5 shrink-0">
                {isMarketplaceCard ? (
                  <>
                    {(item.forkCount ?? 0) > 0 && (
                      <span
                        className="flex items-center gap-0.5 text-[10px]"
                        style={{ color: 'rgba(255, 255, 255, 0.5)' }}
                        title="被复制成副本的次数"
                      >
                        <GitFork size={10} style={{ color: palette.soft }} />
                        {item.forkCount}
                      </span>
                    )}
                    <button
                      onClick={(e) => {
                        // 显式按钮 + handleFork 自带二次 confirm —— 避免"点一下就偷偷复制"的反人类流程
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
                      title="显式创建副本到我的百宝箱（会弹窗确认）；只想使用原版的话直接点卡片主体即可"
                    >
                      <GitFork size={11} />
                      {forking ? '复制中…' : '创建副本'}
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
