import { useState } from 'react';
import {
  BookOpen,
  Check,
  Edit3,
  Eye,
  FolderInput,
  Globe,
  Link2,
  Lock,
  MessageCircleQuestion,
  MessageSquare,
  QrCode,
  Replace,
  Share2,
  Trash2,
} from 'lucide-react';
import type { HostedSite, SiteOwnerCard } from '@/services/real/webPages';
import { SitePreview } from '@/components/SitePreview';
import { PdfThumbnail, isPdfSite } from '@/components/PdfThumbnail';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { useDockDrag } from '@/components/share-dock';
import { CardIconAction, CardMoreButton, type CardMoreAction } from './SiteCardActions';
import { resolveSiteForm, siteFormBadge, siteSourceLabel, SITE_FORM_REGISTRY } from './siteFormRegistry';
import { fmtSize, relativeTime } from './siteFormat';

/** 网页托管卡片拖进 ShareDock 投放槽时用的 MIME（页面与卡片共用同一个常量，不各写一份）。 */
export const WEB_PAGE_MIME = 'application/x-map-site-id';

/** 卡片尺寸档：宽度与设计稿一致（小 176 / 中 264 / 大 360）。 */
export type SiteCardSize = 'small' | 'medium' | 'large';

export const SITE_CARD_SIZES: { value: SiteCardSize; label: string; width: number }[] = [
  { value: 'small', label: '小', width: 176 },
  { value: 'medium', label: '中', width: 264 },
  { value: 'large', label: '大', width: 360 },
];

export interface SiteCaps {
  canEdit: boolean;
  canDelete: boolean;
  canShare: boolean;
  canSetVisibility: boolean;
}

/** 该站点的分享侧真实数据；拿不到就不传，KPI 位显示「—」而不是编一个 0。 */
export interface SiteShareStats {
  /** 有效链接数（未过期、未撤销） */
  activeLinks: number;
  /** 这些链接里最近一次被打开的时间 */
  lastViewedAt?: string;
}

export interface SiteCardProps {
  site: HostedSite;
  size?: SiteCardSize;
  selected: boolean;
  fresh?: boolean;
  shared?: boolean;
  shareStats?: SiteShareStats;
  /** 该站点的独立访客数（后端按 userId / IP 去重聚合）；拿不到就不传，位上显示 —— */
  visitorCount?: number;
  caps?: SiteCaps;
  ownerCard?: SiteOwnerCard;
  onSelect: () => void;
  onVisit: () => void;
  onTogglePublic: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** 分享下拉要就地弹在按钮下方，所以回调带上那枚按钮当锚点 */
  onShare: (anchor: HTMLElement) => void;
  onQrCode: () => void;
  onTransferToLibrary: () => void;
  onReplaceFile: (file: File) => void;
  onViewers?: () => void;
  onMove?: () => void;
  onComments?: () => void;
  onAskConfig?: () => void;
}

/**
 * 把卡片操作分成 hover 层与菜单层 —— 这两层的关系是一条**契约**，不是排版细节：
 * hover 层的每一项都必须同时出现在菜单里，否则触屏和键盘用户就够不着它
 * （桌面 hover 条在 `sm` 断点以下根本不渲染）。
 *
 * 抽成纯函数是为了这条契约**可以被测红**：留在 JSX 里就只能靠断言 class 字面量，
 * 而 class 改个写法测试照绿，等价可达其实已经断了。
 */
export function buildCardActionLayers(args: {
  site: Pick<HostedSite, 'id' | 'visibility'>;
  caps: SiteCaps;
  onEdit: () => void;
  onQrCode: () => void;
  onTogglePublic: () => void;
  onTransferToLibrary: () => void;
  onDelete: () => void;
  onViewers?: () => void;
  onMove?: () => void;
  onComments?: () => void;
  onAskConfig?: () => void;
}): { hover: CardMoreAction[]; menu: CardMoreAction[] } {
  const { site, caps: c } = args;
  const isPublic = site.visibility === 'public';

  const hover: CardMoreAction[] = [
    c.canEdit ? { label: '编辑信息', icon: <Edit3 size={13} />, onClick: args.onEdit } : null,
    c.canEdit
      ? {
          label: '替换内容',
          icon: <Replace size={13} />,
          onClick: () => document.getElementById(`site-replace-${site.id}`)?.click(),
        }
      : null,
    { label: '二维码', icon: <QrCode size={13} />, onClick: args.onQrCode },
  ].filter(Boolean) as CardMoreAction[];

  const lowFrequency: CardMoreAction[] = [
    c.canSetVisibility
      ? isPublic
        ? { label: '取消公开', icon: <Lock size={13} />, onClick: args.onTogglePublic }
        : { label: '发布到公开页', icon: <Globe size={13} />, onClick: args.onTogglePublic }
      : null,
    isPublic ? { label: '转存到知识库', icon: <BookOpen size={13} />, onClick: args.onTransferToLibrary } : null,
    args.onComments ? { label: '评论管理', icon: <MessageSquare size={13} />, onClick: args.onComments } : null,
    args.onAskConfig ? { label: '提问设置', icon: <MessageCircleQuestion size={13} />, onClick: args.onAskConfig } : null,
    args.onViewers ? { label: '查看访客', icon: <Eye size={13} />, onClick: args.onViewers } : null,
    c.canEdit && args.onMove ? { label: '移动到空间或文件夹', icon: <FolderInput size={13} />, onClick: args.onMove } : null,
    c.canDelete ? { label: '删除', icon: <Trash2 size={13} />, onClick: args.onDelete, danger: true } : null,
  ].filter(Boolean) as CardMoreAction[];

  // 菜单 = hover 层等价项置顶 + 低频配置。顺序即分组，CardMoreButton 按 hover 条数画分隔线。
  return { hover, menu: [...hover, ...lowFrequency] };
}

/**
 * 站点卡片 —— 网页托管的原子。
 *
 * 分区规则（设计稿屏 2，两组永不混排）：
 * - **缩略图层**只回答「这是什么」：左上内容形态（HTML / ZIP 站 / PDF / 视频 / MD），右上来源。
 * - **信息层**只回答「它现在怎么样」：状态胶囊一行（已分享 N / 已公开 / 团队共享）+ 归属头像靠右。
 * 于是四种状态同时成立时也不会挤在同一角。
 *
 * 操作分四层，按频次而不是按类型分：
 * - 常驻：预览、分享 / 管理分享·N、更多（kebab）。中卡以上一定可见。
 * - hover / focus：编辑、替换内容、二维码。**触屏等价路径**：无 hover 时这三项进 kebab 顶部
 *   （`@media (hover:none)` 下 hover 条不渲染），键盘 focus 同样展开。
 * - 菜单：公开 / 转存知识库 / 评论 / 提问设置 / 访客 / 移动。
 * - 二级弹窗：删除、替换内容的确认（不可逆的都不在卡片上直接发生）。
 */
export function SiteCard({
  site,
  size = 'medium',
  selected,
  fresh,
  shared,
  shareStats,
  visitorCount,
  caps,
  ownerCard,
  onSelect,
  onVisit,
  onTogglePublic,
  onEdit,
  onDelete,
  onShare,
  onQrCode,
  onTransferToLibrary,
  onReplaceFile,
  onViewers,
  onMove,
  onComments,
  onAskConfig,
}: SiteCardProps) {
  const c = caps ?? { canEdit: true, canDelete: true, canShare: true, canSetVisibility: true };
  const isPublic = site.visibility === 'public';
  const isSmall = size === 'small';
  const isLarge = size === 'large';
  const [fileDragOver, setFileDragOver] = useState(false);
  // 拖卡片到 ShareDock 投放槽（把站点投给别的功能用）；与「拖文件进卡片替换内容」是两个方向，互不干扰
  const { onPointerDown } = useDockDrag({ mime: WEB_PAGE_MIME, id: site.id, label: site.title, icon: 'WEB' });

  // 三档尺寸的规格（设计稿屏 2）：圆角、缩略图高、体 padding/gap、标题字号
  const SPEC = {
    small: { radius: 10, thumb: 92, pad: '8px 9px 9px', gap: 5, title: 11.5 },
    medium: { radius: 11, thumb: 140, pad: '10px 11px 11px', gap: 5, title: 13 },
    large: { radius: 12, thumb: 190, pad: '12px 13px 13px', gap: 8, title: 14.5 },
  }[size];

  const form = resolveSiteForm(site);
  const formConfig = SITE_FORM_REGISTRY[form];
  const FormIcon = formConfig.icon;
  const formBadge = siteFormBadge(site);
  const linkCount = shareStats?.activeLinks ?? 0;

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  const handleDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e) || !c.canEdit) return; // 无编辑权（viewer）不接受拖拽替换
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!fileDragOver) setFileDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setFileDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!hasFiles(e) || !c.canEdit) return;
    e.preventDefault();
    setFileDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onReplaceFile(f);
  };

  const { hover: hoverActions, menu: menuActions } = buildCardActionLayers({
    site,
    caps: c,
    onEdit,
    onQrCode,
    onTogglePublic,
    onTransferToLibrary,
    onDelete,
    onViewers,
    onMove,
    onComments,
    onAskConfig,
  });

  // 状态胶囊（设计稿：10.5px / padding 2-6 / radius 5 / 同色系描边 + 淡底，胶囊内无图标）
  const chip = (key: string, text: string, fg: string, bd: string, bg: string) => (
    <span
      key={key}
      className="inline-flex shrink-0 items-center"
      style={{ fontSize: 10.5, padding: '2px 6px', borderRadius: 'var(--radius-xs)', color: fg, border: `1px solid ${bd}`, background: bg }}
    >
      {text}
    </span>
  );

  const statusChips = (
    <>
      {shared && chip('shared', `已分享${linkCount > 0 ? ` ${linkCount}` : ''}`,
        'var(--semantic-success-text)', 'var(--semantic-success-border)', 'var(--semantic-success-soft)')}
      {/* 「已公开」在设计稿里走强调色系（#E8A87C），不是警告黄——它不是一个警告 */}
      {isPublic && chip('public', '已公开',
        'var(--accent-gold-2)', 'rgba(var(--accent-primary-rgb), 0.4)', 'rgba(var(--accent-primary-rgb), 0.12)')}
      {(site.sharedTeamIds?.length ?? 0) > 0 && chip('team', '团队共享',
        'var(--accent-fg-blue)', 'var(--semantic-info-border)', 'var(--semantic-info-soft)')}
      {!shared && !isPublic && (site.sharedTeamIds?.length ?? 0) === 0 &&
        chip('none', '未分享', 'var(--text-tertiary)', 'var(--border-subtle)', 'transparent')}
    </>
  );

  return (
    <div
      data-tour-id="webpages-card"
      data-card
      /* h-full + flex 链：grid item 本来就被拉伸到行高，但内部盒子是内容高，
         于是同一行的卡片下边缘参差（标题一行/两行、有无标签都会差几十像素）。
         设计稿的 grid 是默认 stretch，卡片在行内等高——这条链把高度真正传下去。 */
      className={['group relative flex h-full w-full flex-col cursor-grab touch-none active:cursor-grabbing', fresh ? 'site-card-fresh' : ''].join(' ')}
      style={{
        borderRadius: 20,
        outline: selected ? '2px solid var(--accent-primary)' : '1px solid transparent',
        outlineOffset: selected ? 3 : 0,
      }}
      onPointerDown={onPointerDown}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 替换内容走隐藏 input：hover 条与 kebab 两条路径共用同一个入口，行为不会漂 */}
      <input
        id={`site-replace-${site.id}`}
        type="file"
        className="hidden"
        accept=".html,.htm,.zip,.md,.markdown,.pdf,.mp4,.webm,.mov,.m4v"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onReplaceFile(f);
          e.target.value = '';
        }}
      />

      <div
        className="relative flex h-full flex-col overflow-hidden border transition-colors duration-200"
        style={{
          borderRadius: SPEC.radius,
          background: 'var(--bg-site-card)',
          borderColor: fileDragOver || selected ? 'var(--accent-primary)' : 'var(--border-subtle)',
          boxShadow: selected ? 'var(--ring-focus)' : 'var(--shadow-site-card)',
        }}
      >
        {fileDragOver && (
          <div
            className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 backdrop-blur-sm"
            style={{
              borderRadius: SPEC.radius,
              background: 'color-mix(in srgb, var(--accent-primary) 26%, var(--bg-tertiary))',
              border: '2px dashed var(--accent-primary)',
            }}
          >
            <Replace size={26} style={{ color: 'var(--text-primary)' }} />
            <span className="text-[13px] font-semibold text-token-primary">替换此网页</span>
            <span className="px-3 text-center text-[11px] text-token-secondary">松开以替换「{site.title}」的内容</span>
          </div>
        )}

        {/* ── 缩略图层：只放「这是什么」+ 压在底部的操作条 ── */}
        <div
          className="relative cursor-pointer overflow-hidden"
          style={{ height: SPEC.thumb, background: 'var(--bg-well)', borderBottom: '1px solid var(--border-subtle)' }}
          onClick={onVisit}
        >
          {site.coverImageUrl ? (
            <img src={site.coverImageUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
          ) : isPdfSite(site) ? (
            <PdfThumbnail
              sizeBytes={site.files.find((f) => f.path?.toLowerCase().endsWith('.pdf'))?.size ?? site.totalSize}
              className="absolute inset-0 h-full w-full"
            />
          ) : (
            <SitePreview site={site} url={site.siteUrl} className="h-full w-full" />
          )}

          {/* 左上：内容形态 */}
          <span
            className="absolute left-2 top-2 z-20 inline-flex items-center gap-1 backdrop-blur-md"
            style={{
              height: 20, padding: '0 6px', borderRadius: 'var(--radius-chip)',
              fontFamily: 'var(--font-code)', fontSize: 9.5, letterSpacing: 'var(--tracking-badge)',
              background: 'var(--scrim-badge-bg)', color: 'var(--text-secondary)',
              border: '1px solid var(--scrim-badge-border)', boxShadow: 'var(--scrim-badge-shadow)',
            }}
            title={formConfig.hint}
          >
            <FormIcon size={11} />
            {formConfig.label}
          </span>

          {/* 右上：来源。小卡不渲染——176px 宽的缩略图顶部放两枚徽章就满了（设计稿小卡只有形态） */}
          {!isSmall && (
            <span
              className="absolute right-2 top-2 z-20 inline-flex items-center gap-1 backdrop-blur-md"
              style={{
                height: 20, padding: '0 6px', borderRadius: 'var(--radius-chip)',
                fontFamily: 'var(--font-code)', fontSize: 9, letterSpacing: 'var(--tracking-badge)',
                background: 'var(--scrim-badge-bg)', color: 'var(--text-tertiary)',
                border: '1px solid var(--scrim-badge-border)', boxShadow: 'var(--scrim-badge-shadow)',
              }}
            >
              {siteSourceLabel(site.sourceType)}
            </span>
          )}

          {/* 右上（小卡）：唯一一枚 kebab。小卡不渲染 hover 条，这颗就是全部操作入口。
              必须**绝对定位压在缩略图上**：放进信息层的常规流会永久吃掉 28px 一行，而它平时
              是透明的，于是每张小卡的正文底下都挂着一截空白（用户原话「下巴」）。中/大卡的
              同一颗 kebab 本来就在 hover 条里绝对定位，这里是把小卡对齐到同一条规矩。
              hover / focus 才显形（几十张卡时不留灰框噪点）；触屏没有 hover，必须常显，
              否则小卡在触屏上一个操作入口都没有。 */}
          {isSmall && (
            <div
              className="absolute right-[7px] top-[7px] z-20 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              <CardMoreButton actions={menuActions} touchActions={hoverActions.length} onScrim />
            </div>
          )}

          {/* 右下：形态量（单页 / N 文件 / N 页 / 时长） */}
          {formBadge && (
            <span
              className="absolute bottom-2 right-2 z-20 inline-flex items-center backdrop-blur-md"
              style={{
                height: 20, padding: '0 6px', borderRadius: 'var(--radius-chip)',
                fontFamily: 'var(--font-code)', fontSize: 9.5, letterSpacing: 'var(--tracking-badge)',
                background: 'var(--scrim-badge-bg)', color: 'var(--text-tertiary)',
                border: '1px solid var(--scrim-badge-border)', boxShadow: 'var(--scrim-badge-shadow)',
              }}
            >
              {formBadge}
            </span>
          )}

          {/* 左下：批量勾选（设计稿是常驻 20×20，未选时低对比，不是 hover 才出现） */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onSelect(); }}
            aria-label={selected ? '取消选择' : '选择'}
            data-no-drag
            className="absolute bottom-[7px] left-[7px] z-20 inline-flex items-center justify-center transition-opacity hover:!opacity-100 group-hover:opacity-100"
            style={{
              width: 20, height: 20, borderRadius: 'var(--radius-chip)',
              background: selected ? 'var(--accent-primary)' : 'var(--scrim-badge-bg)',
              border: `1px solid ${selected ? 'var(--accent-primary)' : 'var(--border-strong)'}`,
              opacity: selected ? 1 : 0.5,
            }}
          >
            {selected && <Check size={12} strokeWidth={2.8} style={{ color: 'var(--accent-on-primary)' }} />}
          </button>

          {/*
            操作条压在缩略图底部（设计稿屏 2）：底衬一层渐变让按钮在任何画面上都读得出来。
            hover / focus 才浮起；触屏（hover:none）整条不渲染，等价项在 kebab 顶部——
            这条契约由 buildCardActionLayers 保证，改这里不会破它。
          */}
          {!isSmall && (
            <div
              data-hoverbar
              /* 容器**永远** pointer-events-none，可点的只有里面的按钮（每个自带 pointer-events-auto）。
                 曾经写的是 group-hover:pointer-events-auto —— 一旦 hover，这条横条就以整条宽度接管
                 了指针，把它左下角盖住的批量勾选框整个吞掉：勾选框看得见、点不动，
                 而程序化 .click() 又能过，所以单测和源码扫描都发现不了（只有真实指针序列会红）。 */
              className="pointer-events-none absolute inset-x-0 bottom-0 z-20 hidden translate-y-[6px] items-center gap-[5px] opacity-0 transition-[opacity,transform] duration-[180ms] ease-out group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100 [@media(hover:hover)]:flex"
              style={{ padding: '7px 7px 7px 33px', background: 'var(--scrim-fade)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <CardIconAction label="预览" icon={<Eye size={12} />} onClick={onVisit} primary />
              {c.canShare && (
                <CardIconAction
                  label={shared ? `管理分享${linkCount > 0 ? ` · ${linkCount}` : ''}` : '分享'}
                  icon={shared ? <Link2 size={12} /> : <Share2 size={12} />}
                  onClick={onShare}
                />
              )}
              <div className="ml-auto flex items-center gap-[5px]">
                {hoverActions.map((a) => (
                  <CardIconAction key={a.label} label={a.label} icon={a.icon} onClick={a.onClick} compact onScrim />
                ))}
                <CardMoreButton actions={menuActions} touchActions={hoverActions.length} onScrim />
              </div>
            </div>
          )}
        </div>

        {/* ── 信息层：只放「它现在怎么样」 ── */}
        <div className="flex flex-1 flex-col" style={{ padding: SPEC.pad, gap: SPEC.gap }}>
          {!isSmall && (
            <div className="flex min-w-0 items-center gap-1" style={{ height: 20 }}>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{statusChips}</div>
              {/* 第四个状态（归属人）本身就是头像，不占胶囊位；个人空间没有 ownerCard 时兜底成「我」 */}
              <span className="shrink-0" title={ownerCard?.displayName ?? '我创建的'}>
                {ownerCard ? (
                  <UserAvatar
                    src={resolveAvatarUrl({ avatarFileName: ownerCard.avatarFileName })}
                    className="h-[18px] w-[18px] rounded-full"
                  />
                ) : (
                  <span
                    className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full"
                    style={{ background: 'var(--avatar-bg-neutral)', color: 'var(--text-secondary)', fontSize: 9 }}
                  >
                    我
                  </span>
                )}
              </span>
            </div>
          )}

          {/* 小卡：状态点 + 已分享，独占一行（设计稿小卡的状态表达） */}
          {isSmall && (
            <div
              className="flex items-center gap-1.5"
              style={{ height: 12 }}
              title={shared ? (linkCount > 0 ? `已分享 ${linkCount} 条链接` : '已分享') : '未分享'}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: shared ? 'var(--semantic-success-text)' : 'var(--text-disabled)' }}
              />
              <span style={{ fontFamily: 'var(--font-code)', fontSize: 9.5, letterSpacing: 'var(--tracking-badge)', color: shared ? 'var(--semantic-success-text)' : 'var(--text-tertiary)' }}>
                {shared ? '已分享' : '未分享'}
              </span>
            </div>
          )}

          {/* 标题恒定单行：多一行标题就把整行卡片撑高，短卡下面留出一截空白（用户原话「胡子太长」）。
              截断了也不丢信息——title 属性给全文，右栏「站点上下文」也显示完整标题。 */}
          <h3
            className="truncate cursor-pointer hover:underline"
            style={{ fontSize: SPEC.title, fontWeight: 600, lineHeight: 1.35, letterSpacing: 'var(--tracking-title)', color: 'var(--text-primary)' }}
            onClick={onVisit}
            title={site.title}
          >
            {site.title}
          </h3>

          {isLarge && (
            <p className="line-clamp-2" style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
              {site.description || formConfig.hint}
            </p>
          )}

          {/* 元信息：中卡是「体积 · N 浏览 · N 访客」，大卡是「体积 · 形态量 · 更新于 X」 */}
          <div
            className="flex flex-wrap items-center gap-x-1.5"
            style={{ fontFamily: 'var(--font-code)', fontSize: 10, letterSpacing: 'var(--tracking-meta)', color: 'var(--text-tertiary)' }}
          >
            <span>{fmtSize(site.totalSize)}</span>
            {isLarge ? (
              <>
                {formBadge && (<><span className="opacity-40" aria-hidden>·</span><span>{formBadge}</span></>)}
                <span className="opacity-40" aria-hidden>·</span>
                <span>更新于 {relativeTime(site.updatedAt || site.createdAt)}</span>
              </>
            ) : (
              <>
                <span className="opacity-40" aria-hidden>·</span>
                <span>{site.viewCount} 浏览</span>
                {!isSmall && (
                  <>
                    <span className="opacity-40" aria-hidden>·</span>
                    <span>{typeof visitorCount === 'number' ? `${visitorCount} 访客` : '— 访客'}</span>
                  </>
                )}
              </>
            )}
          </div>

          {/* 标签行：中卡以上都有，最多 3 个 + 折叠计数，右端是更新时间（设计稿把时间放这一行）。
              mt-auto：等高之后多出来的空间沉到这一行**之上**，末行始终贴着卡片底边，
              否则短卡片会在中间空出一块，看着像没加载完。 */}
          {/* 这一行**恒定渲染**（有没有标签都在）：它同时承载更新时间，条件渲染会让
              没标签的卡片既少一行高度、又莫名其妙不显示时间。恒定之后同一档尺寸的卡片
              内容高度是确定的，等高不再靠拉伸填空（就没有那截「胡子」了）。 */}
          {!isSmall && (
            <div className="mt-auto flex min-w-0 items-center gap-1" style={{ minHeight: 18 }}>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                {site.tags.slice(0, 3).map((tag) => (
                  <span
                    key={tag}
                    style={{ fontSize: 10.5, padding: '2px 6px', borderRadius: 'var(--radius-xs)', background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
                  >
                    {tag}
                  </span>
                ))}
                {site.tags.length > 3 && (
                  <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>+{site.tags.length - 3}</span>
                )}
              </div>
              {!isLarge && (
                <span className="shrink-0" style={{ fontFamily: 'var(--font-code)', fontSize: 10, letterSpacing: 'var(--tracking-meta)', color: 'var(--text-tertiary)' }}>
                  {relativeTime(site.createdAt)}
                </span>
              )}
            </div>
          )}

          {/* 大卡成果数据四格（设计稿：浏览 / 访客 / 有效链接 / 最近访问，统一 22px） */}
          {isLarge && (
            <div className="flex items-end" style={{ gap: 18, borderTop: '1px solid var(--border-subtle)', paddingTop: 8, marginTop: 2 }}>
              {[
                { v: String(site.viewCount), label: '浏览' },
                { v: typeof visitorCount === 'number' ? String(visitorCount) : '—', label: '访客' },
                { v: shareStats ? String(linkCount) : '—', label: '有效链接' },
                { v: shareStats?.lastViewedAt ? relativeTime(shareStats.lastViewedAt) : '—', label: '最近访问' },
              ].map((k) => (
                <div key={k.label}>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, lineHeight: 1, letterSpacing: 'var(--tracking-number)', color: 'var(--text-primary)' }}>
                    {k.v}
                  </div>
                  <div style={{ marginTop: 4, fontFamily: 'var(--font-code)', fontSize: 9.5, letterSpacing: 'var(--tracking-badge)', color: 'var(--text-tertiary)' }}>{k.label}</div>
                </div>
              ))}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
