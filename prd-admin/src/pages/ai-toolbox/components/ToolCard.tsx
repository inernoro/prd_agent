import { useState } from 'react';
import type { ToolboxItem } from '@/services';
import { useToolboxStore, NEW_BADGE_WINDOW_MS } from '@/stores/toolboxStore';
import { useNavigate } from 'react-router-dom';
import { DesktopDownloadDialog } from '@/components/ui/DesktopDownloadDialog';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import { resolveAvatarUrl } from '@/lib/avatar';
import { cn } from '@/lib/cn';
import { getAccent, glassTileStyle } from '@/lib/tileAccent';
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
  FolderKanban,
  Mail,
  AudioLines,
  Blocks,
  Clapperboard,
  ClipboardCheck,
  Factory,
  FileBarChart,
  GitPullRequest,
  Link2,
  ListTree,
  Mic,
  Route,
  Share2,
  Terminal,
  Workflow,
  ScanSearch,
  Wand2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PaSecretary } from '@/lib/paSecretaryIconRegistry';
import { AgentCardArtwork, AgentCardFrame, AgentCardTask, hasAgentCardArtwork } from '@/components/agent-shell/AgentCardArtwork';
import type { ToolboxDisplayMode } from '../toolboxDisplayMode';

interface ToolCardProps {
  item: ToolboxItem;
  /**
   * 卡片来源：
   * - 'mine'（默认）：BUILTIN 或用户自己的条目，点击进入详情；自定义工具支持快捷"编辑"
   * - 'marketplace'：他人公开的条目，点击**打开详情抽屉**（不直接 Fork！）
   *   用户必须在详情里显式点【创建副本】才会生成 Fork；平时只是"使用别人公开的原件"。
   */
  source?: 'mine' | 'marketplace';
  displayMode?: ToolboxDisplayMode;
}

// 图标组件映射
const ICON_MAP: Record<string, LucideIcon> = {
  FileText, Palette, PenTool, Bug, Code2, Languages, FileSearch, BarChart3,
  Bot, Lightbulb, Target, Wrench, Sparkles, Rocket, MessageSquare, Zap,
  Brain, Cpu, Database, Globe, Image, Music, Video, BookOpen,
  GraduationCap, Briefcase, Heart, Star, Shield, Lock, Search, Layers, Swords,
  FolderKanban, Mail,
  // 内置工具图标（toolboxStore BUILTIN_TOOLS 用到,与首页启动器覆盖面对齐;
  // 瓦片化后图标是主视觉,缺失会整排回退成 Bot —— Codex P2）
  AudioLines, Blocks, Clapperboard, ClipboardCheck, Factory, FileBarChart,
  GitPullRequest, Link2, ListTree, Mic, Route, Share2, Terminal, Workflow, ScanSearch, Wand2,
  PaSecretary,
};

function getIconComponent(iconName: string): LucideIcon {
  return ICON_MAP[iconName] || Bot;
}

/**
 * ToolCard —— 与首页启动器同一套视觉语言（2026-07-08 风格统一）。
 *
 * 早期版本是 16:10 封面卡（CDN 封面图 / 悬停视频 / 内联插画 / 星云兜底），
 * 与首页的紧凑玻璃瓦片是两套语言，用户点名"首页风格带入百宝箱，做成统一"。
 * 现改为 lib/tileAccent 的玻璃瓦片（色阶尺图标芯片 + 半透玻璃底 + hover 色相描边），
 * 全部行为保留：NEW/施工中/已公开徽章、编辑/公开/删除浮条、创建副本、收藏、标签过滤。
 * 封面/视频资产仍在 CDN 与 homepageAssetsStore 中，详情页可继续使用。
 */
export function ToolCard({ item, source = 'mine', displayMode = 'standard' }: ToolCardProps) {
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
    activeTagFilter,
    setActiveTagFilter,
    trackRecentlyUsed,
  } = useToolboxStore();
  const navigate = useNavigate();
  const accent = getAccent(item.icon);
  const IconComponent = getIconComponent(item.icon);
  const hasArtwork = hasAgentCardArtwork(item.agentKey);
  const isCompact = displayMode === 'compact';
  const visibleTagCount = isCompact ? 2 : displayMode === 'showcase' ? 4 : 3;
  const isPaAgent = item.agentKey === 'pa-agent';
  const isCustomized = !!item.routePath;
  const favorited = isFavorite(item.id);
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
  const [forking, setForking] = useState(false);
  const [togglingPublish, setTogglingPublish] = useState(false);

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
  // 头像 URL — BUILTIN官方 走首字母圆标，不走 img 通道
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
    if (item.agentKey === 'prd-agent') {
      setDownloadDialogOpen(true);
      return;
    }
    trackRecentlyUsed(item.id);
    if (isCustomized && item.routePath) {
      if (item.agentKey === 'cds-agent') {
        window.location.assign(item.routePath);
        return;
      }
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

  return (
    <>
      <div
        role="button"
        data-display-mode={displayMode}
        data-has-artwork={hasArtwork}
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={(e) => {
          // 只在焦点落在卡片本体时接管;子操作按钮(收藏/编辑/公开/删除/复制)的
          // Enter/Space 冒泡到这里若被 preventDefault 会变成"打开卡片"(Codex P2)
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
          }
        }}
        className="toolbox-tool-card group relative w-full h-full overflow-hidden text-left cursor-pointer transition-all duration-200 hover:-translate-y-0.5 flex flex-col"
        style={{
          ...glassTileStyle(accent),
          background: hasArtwork ? 'var(--media-card-base)' : glassTileStyle(accent).background,
          border: hasArtwork ? 'none' : glassTileStyle(accent).border,
        }}
      >
        <AgentCardArtwork agentKey={item.agentKey} tint={accent.color} compact={isCompact} />
        {hasArtwork && (
          <div
            aria-hidden
            className="toolbox-tool-card-media-panel absolute inset-x-0 bottom-0 pointer-events-none"
            style={{
              background: 'var(--media-card-panel-translucent)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
            }}
          />
        )}
        {hasArtwork ? (
          <AgentCardFrame hoverBorder="var(--media-card-border-hover)" />
        ) : (
          <div
            className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none"
            style={{ boxShadow: `inset 0 0 0 1px ${accent.border}, 0 12px 32px -16px ${accent.glow}` }}
          />
        )}

        {/* 头行：大图卡显示名称与直接任务；普通卡保留图标芯片。 */}
        <div className="relative z-10 flex items-start justify-between gap-2">
          {hasArtwork ? (
            <div
              className="toolbox-tool-card-title max-w-[60%] font-semibold leading-[1.2] tracking-[-0.02em]"
              style={{ color: 'var(--text-on-media)' }}
            >
              {item.name}
            </div>
          ) : (
            <div
              className="shrink-0 w-10 h-10 rounded-[10px] flex items-center justify-center transition-transform duration-200 group-hover:scale-105"
              style={{ background: accent.soft, border: `1px solid ${accent.border}` }}
            >
              <IconComponent size={19} style={{ color: accent.color }} />
            </div>
          )}

          <div className="flex flex-col items-end gap-2 shrink-0">
            {hasArtwork && (
              <AgentCardTask agentKey={item.agentKey} compact={isCompact} dense={isCompact} />
            )}
            <div className="flex items-center gap-1">
            {/* NEW 徽章 — 别人 7 天内发布的公开条目 */}
            {isNewByOthers && (
              <span
                className="text-[10px] font-bold px-1.5 py-0.5 rounded-md inline-flex items-center gap-0.5 animate-pulse"
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
              </span>
            )}

            {/* 操作浮条 — hover 时显示核心操作：编辑/公开/删除 或 复制 */}
            {(isOwnCustomCard || isForkableBuiltin) && (
              <div
                data-publish-hint={needsPublishHint}
                className={`toolbox-card-actions flex items-center gap-0.5 transition-opacity duration-200 ${
                  needsPublishHint ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
              >
                {isOwnCustomCard && (
                  <>
                    <button
                      onClick={handleQuickEdit}
                      title="编辑此智能体"
                      className="toolbox-card-icon-button w-6 h-6 rounded-md flex items-center justify-center transition-all duration-150 hover:scale-110"
                    >
                      <Edit size={12} className="text-token-secondary" />
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
                          ? '点击公开发布，让同事也能看到这个智能体（否则只有你自己可见）'
                          : '公开发布到「公开市场」，让所有用户都能看到并 Fork'
                      }
                      data-active={item.isPublic}
                      className="toolbox-card-icon-button relative w-6 h-6 rounded-md flex items-center justify-center transition-all duration-150 hover:scale-110 disabled:opacity-50"
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
                        className={cn('relative', (item.isPublic || needsPublishHint) ? 'text-token-success' : 'text-token-secondary')}
                      />
                    </button>
                    <button
                      onClick={handleDelete}
                      title="删除此智能体"
                      className="toolbox-card-icon-button toolbox-card-danger-button w-6 h-6 rounded-md flex items-center justify-center transition-all duration-150 hover:scale-110"
                    >
                      <Trash2 size={12} className="text-token-error" />
                    </button>
                  </>
                )}
                {isForkableBuiltin && (
                  <button
                    onClick={handleCopyBuiltin}
                    title="复制一份到我的百宝箱（可自由修改提示词、模型等参数）"
                    className="toolbox-card-copy-action text-token-primary flex items-center gap-1 h-6 px-2 rounded-md transition-all duration-150 text-[10px] font-medium"
                  >
                    <Copy size={11} />
                    复制并编辑
                  </button>
                )}
              </div>
            )}

            <ArrowUpRight
              size={15}
              className="shrink-0 opacity-0 -translate-x-1 group-hover:opacity-[0.45] group-hover:translate-x-0 transition-all duration-200"
              style={{ color: hasArtwork ? 'var(--media-card-task-muted)' : 'var(--text-muted)' }}
            />
            </div>
          </div>
        </div>

        {/* 普通卡保留名称与描述；大图卡只显示更易扫描的标签。 */}
        {!hasArtwork && (
          <div className="relative z-10 min-w-0">
            <div className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              {item.name}
            </div>
            <p
              className="mt-1 line-clamp-2 text-[12px] leading-relaxed"
              style={{ color: 'var(--text-muted)' }}
            >
              {item.description}
            </p>
          </div>
        )}

        {/* Tags — 可点击进行过滤 */}
        {item.tags.length > 0 && (
          <div className={`relative z-10 flex flex-wrap gap-1 ${hasArtwork ? 'mt-auto' : ''}`}>
            {item.tags.slice(0, visibleTagCount).map((tag) => {
              const isActive = !!activeTagFilter && activeTagFilter.toLowerCase() === tag.toLowerCase();
              return (
                <button
                  key={tag}
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveTagFilter(tag);
                  }}
                  title={isActive ? `已按「${tag}」过滤，点击取消` : `按「${tag}」过滤`}
                  className={`toolbox-card-tag text-[10px] px-1.5 py-0.5 rounded transition-colors duration-300 ${isActive ? 'toolbox-card-tag-active' : 'toolbox-card-tag-clickable'}`}
                  style={hasArtwork ? {
                    color: 'var(--media-card-tag-text)',
                    background: 'var(--media-card-tag-bg)',
                    borderColor: 'var(--media-card-tag-border)',
                  } : undefined}
                >
                  {tag}
                </button>
              );
            })}
            {item.tags.length > visibleTagCount && (
              <span className="text-token-muted-faint text-[10px] px-0.5 font-medium">
                +{item.tags.length - visibleTagCount}
              </span>
            )}
          </div>
        )}

        {/* Footer —
         * 规则：只有"用户创建的通用智能体"（我的 + 别人公开的）才显示作者头像。
         * BUILTIN（含定制版 + 普通版）一律按"默认智能体样子"处理，不加特殊标记 —
         *   - 我的未公开 → 橙色「施工中」
         *   - 我的已公开 → 绿色「已公开」
         *   - 别人公开   → 右侧 Fork 数 +「创建副本」按钮（NEW 徽章在头行渲染）
         */}
        <div
          className={`relative z-10 flex items-center justify-between gap-1 pt-1.5 border-t ${hasArtwork ? 'mt-0' : 'mt-auto'}`}
          style={{ borderColor: hasArtwork ? 'var(--media-card-border)' : 'var(--border-faint)' }}
        >
          {isPaAgent ? (
            <div className="flex items-center gap-1 min-w-0">
              <span
                className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium inline-flex items-center gap-1"
                style={{
                  background: 'var(--selection-icon-bg)',
                  color: 'var(--selection-text)',
                  border: '1px solid var(--selection-border)',
                }}
                title="定位：私人助理"
              >
                私人助理
              </span>
            </div>
          ) : (isOwnCustomCard || isMarketplaceCard) ? (
            <>
              {/* 用户创建的智能体：左侧 头像 + 名字 + 状态徽章 */}
              <div className="flex items-center gap-1 min-w-0">
                {isOwnCustomCard && !item.isPublic && (
                  <span
                    className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium inline-flex items-center gap-1"
                    style={{
                      background: 'rgba(245, 158, 11, 0.18)',
                      color: '#fcd34d',
                      border: '1px solid rgba(245, 158, 11, 0.45)',
                    }}
                    title="未公开 — 仅自己可见；点卡片右上角公开发布即可让同事看到"
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
                    title="已公开到市场，他人可使用或 Fork"
                  >
                    <Globe2 size={10} />
                    已公开
                  </span>
                )}
                {authorAvatarUrl ? (
                  <img
                    src={authorAvatarUrl}
                    alt={authorName}
                    className="toolbox-card-avatar w-4 h-4 rounded-full shrink-0 object-cover"
                    title={authorName}
                    draggable={false}
                  />
                ) : (
                  <div
                    className="w-4 h-4 rounded-full shrink-0 flex items-center justify-center text-[9px] font-bold"
                    style={{
                      background: accent.color,
                      color: 'rgba(0, 0, 0, 0.7)',
                    }}
                    title={authorName}
                  >
                    {authorName[0]}
                  </div>
                )}
                <span className="text-token-muted text-[10px] truncate">
                  {authorName}
                </span>
              </div>
              {/* 右侧：别人公开的 → Fork 数 +「创建副本」按钮；自己的 → 使用次数 + 收藏 */}
              <div className="flex items-center gap-1.5 shrink-0">
                {isMarketplaceCard ? (
                  <>
                    {(item.forkCount ?? 0) > 0 && (
                      <span
                        className="text-token-muted flex items-center gap-0.5 text-[10px]"
                        title="被复制成副本的次数"
                      >
                        <GitFork size={10} style={{ color: accent.color }} />
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
                        background: accent.soft,
                        color: accent.color,
                        border: `1px solid ${accent.border}`,
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
                      <span className="text-token-muted flex items-center gap-0.5 text-[10px]">
                        <Zap size={10} style={{ color: accent.color }} />
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
            // BUILTIN（定制版或普通版）：默认智能体样子，仅使用次数 + 收藏，无作者无徽章
            <>
              <div className="flex items-center gap-1 min-w-0">
                {item.usageCount > 0 && (
                  <span className="text-token-muted flex items-center gap-0.5 text-[10px]">
                    <Zap size={10} style={{ color: accent.color }} />
                    {item.usageCount >= 1000 ? `${(item.usageCount / 1000).toFixed(1)}k` : item.usageCount}
                  </span>
                )}
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

      <DesktopDownloadDialog open={downloadDialogOpen} onOpenChange={setDownloadDialogOpen} />
    </>
  );
}
