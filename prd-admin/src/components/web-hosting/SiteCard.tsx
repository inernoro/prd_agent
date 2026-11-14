import { useRef, useState, type ReactNode } from 'react';
import {
  BookOpen,
  Check,
  Edit3,
  Eye,
  FolderInput,
  Globe,
  Info,
  Link2,
  Lock,
  MessageCircleQuestion,
  MessageSquare,
  QrCode,
  Replace,
  Share2,
  Trash2,
  WandSparkles,
  Users,
  MoreHorizontal,
} from 'lucide-react';
import type { HostedSite, HostedSiteActivity, HostedSiteTraffic, SiteOwnerCard } from '@/services/real/webPages';
import { SiteDetailsDialog } from './SiteDetailsDialog';
import { SiteNewBadge } from './SiteActivityMeta';
import { SitePreview } from '@/components/SitePreview';
import { PdfThumbnail, isPdfSite } from '@/components/PdfThumbnail';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { useDockDrag } from '@/components/share-dock';
import { CardIconAction, CardMoreButton, type CardMoreAction } from './SiteCardActions';
import { resolveSiteForm, siteFormBadge, SITE_FORM_REGISTRY } from './siteFormRegistry';
import { fmtSize } from './siteFormat';
import RelatedDocumentsBar from './RelatedDocumentsBar';
import { SiteCardMetrics } from './SiteCardMetrics';
import type { RelatedSummary } from '@/services/real/relatedDocuments';
import { WEB_HOSTING_UPLOAD_ACCEPT } from '@/lib/webHostingUploadLimits';

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

/** 拖拽会触发分享或移动写操作，必须沿用站点的分享写权限。 */
export function canDragSiteCard(caps: SiteCaps): boolean {
  return caps.canShare;
}

/** 分享操作的链接摘要；访问指标只读取独立的 traffic 摘要。 */
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
  selectionMode?: boolean;
  fresh?: boolean;
  shared?: boolean;
  shareStats?: SiteShareStats;
  relatedSummary?: RelatedSummary;
  /** 可嵌入不访问业务接口的导航，例如独立组件演示。默认沿用真实关联导航。 */
  relatedNavigation?: ReactNode;
  onNavigateRelated?: (id: string) => void;
  /** 后端统一口径的访问摘要；拿不到时三个访问指标均显示未知。 */
  traffic?: HostedSiteTraffic;
  activity?: HostedSiteActivity;
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
  /** 原操作菜单中的 AI 微调入口；版本记录留在编辑面板内部。 */
  onAiEdit?: () => void;
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
  shared?: boolean;
  linkCount?: number;
  onShare: (anchor: HTMLElement) => void;
  onEdit: () => void;
  onQrCode: () => void;
  onTogglePublic: () => void;
  onTransferToLibrary: () => void;
  onDelete: () => void;
  onViewers?: () => void;
  onMove?: () => void;
  onComments?: () => void;
  onAskConfig?: () => void;
  onAiEdit?: () => void;
}): { hover: CardMoreAction[]; menu: CardMoreAction[]; touchActions: number } {
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
    c.canEdit && args.onAiEdit ? { label: '帮我修改', icon: <WandSparkles size={13} />, onClick: args.onAiEdit } : null,
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

  // 分享必须在所有尺寸与触屏的菜单中可达；菜单关闭后仍用常驻的更多按钮锚定分享面板。
  const share: CardMoreAction[] = c.canShare ? [{
    label: args.shared ? `管理分享${args.linkCount ? ` · ${args.linkCount}` : ''}` : '分享',
    icon: args.shared ? <Link2 size={13} /> : <Share2 size={13} />,
    onClick: args.onShare,
  }] : [];
  return { hover, menu: [...share, ...hover, ...lowFrequency], touchActions: share.length + hover.length };
}

/**
 * 站点卡片 —— 网页托管的原子。
 *
 * 三档共用位置：缩略图左上关联与状态，右上格式与悬浮选择，右下操作。
 * 标题下方仅一行文件大小与编辑、访问、访客；完整来源和标签进入详情。
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
  selectionMode = false,
  fresh,
  shared,
  shareStats,
  relatedSummary,
  relatedNavigation,
  onNavigateRelated,
  traffic,
  activity,
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
  onAiEdit,
}: SiteCardProps) {
  const c = caps ?? { canEdit: true, canDelete: true, canShare: true, canSetVisibility: true };
  const canDrag = canDragSiteCard(c);
  const isPublic = site.visibility === 'public';
  const isSmall = size === 'small';
  const isLarge = size === 'large';
  const [fileDragOver, setFileDragOver] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
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

  const { hover: hoverActions, menu: menuActions, touchActions } = buildCardActionLayers({
    site,
    caps: c,
    shared,
    linkCount,
    onShare,
    onEdit,
    onQrCode,
    onTogglePublic,
    onTransferToLibrary,
    onDelete,
    onViewers,
    onMove,
    onComments,
    onAskConfig,
    onAiEdit,
  });

  const statusItems = [
    ...(shared ? [{ label: '已分享', icon: <Share2 size={12} /> }] : []),
    ...(isPublic ? [{ label: '已公开', icon: <Globe size={12} /> }] : []),
    ...((site.sharedTeamIds?.length ?? 0) > 0 ? [{ label: '团队共享', icon: <Users size={12} /> }] : []),
  ];

  return (
    <>
    <div
      ref={cardRef}
      data-tour-id="webpages-card"
      data-card
      data-hosted-site-id={site.id}
      data-selected={selected}
      /* h-full + flex 链：grid item 本来就被拉伸到行高，但内部盒子是内容高，
         于是同一行的卡片下边缘参差（标题一行/两行、有无标签都会差几十像素）。
         设计稿的 grid 是默认 stretch，卡片在行内等高——这条链把高度真正传下去。 */
      className={['group @container relative flex h-full w-full flex-col touch-none', selectionMode ? 'cursor-crosshair' : canDrag ? 'cursor-grab active:cursor-grabbing' : 'cursor-default', fresh ? 'site-card-fresh' : ''].join(' ')}
      data-dock-draggable={!selectionMode && canDrag ? 'true' : 'false'}
      /* 半径必须跟内框同一个值：`.site-card-fresh::before` 的光环是 border-radius:inherit，
         这里写死 20 而内框是 SPEC.radius(10/11/12)，光环就会比卡片圆一大圈、错开成两条边。
         选中态也**不在这一层画圈**——外层 outline(半径 20 + offset 3) 叠上内框自己的
         accent 边框，就是用户看到的「两条线」：两个不同半径的硬轮廓套在一起。
         选中只由内框那一个圆角矩形表达。 */
      style={{ borderRadius: SPEC.radius }}
      onPointerDown={!selectionMode && canDrag ? onPointerDown : undefined}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 替换内容走隐藏 input：hover 条与 kebab 两条路径共用同一个入口，行为不会漂 */}
      <input
        id={`site-replace-${site.id}`}
        type="file"
        className="hidden"
        accept={WEB_HOSTING_UPLOAD_ACCEPT}
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
          // 选中就是这一条边加粗变色 + 一圈同半径的柔光；不再往外面套第二个轮廓。
          // box-sizing 是 border-box，加粗不推动布局。
          borderWidth: selected ? 2 : 1,
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
          data-site-card-thumbnail
          className="relative shrink-0 cursor-pointer overflow-hidden"
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

          <div data-site-card-badges className="absolute left-2 top-2 z-20 inline-flex items-center gap-1" onClick={event => event.stopPropagation()}>
            {relatedNavigation === undefined ? <div className={!relatedSummary?.count ? 'hidden group-hover:flex group-focus-within:flex [@media(hover:none)]:flex' : 'flex'}>
              <RelatedDocumentsBar siteId={site.id} siteTitle={site.title} collectionNavigation variant="badge" summary={relatedSummary}
                onNavigate={onNavigateRelated ? item => onNavigateRelated(item.id) : undefined} />
            </div> : relatedNavigation}
            {statusItems.length > 0 && <span data-site-shared-badge={shared ? '' : undefined} className="inline-flex items-center">
              <span className="hidden items-center gap-1 @[235px]:inline-flex" aria-label={statusItems.map(item => item.label).join('、')}>
                {statusItems.map(item => <span key={item.label} title={item.label} className="inline-flex h-4 w-4 items-center justify-center rounded" style={{ color: 'var(--text-secondary)', background: 'var(--scrim-badge-bg)' }}>{item.icon}</span>)}
              </span>
              <button type="button" data-no-drag className="inline-flex h-4 w-4 items-center justify-center rounded @[235px]:hidden"
                aria-label={`查看状态：${statusItems.map(item => item.label).join('、')}`} title={statusItems.map(item => item.label).join('、')}
                style={{ color: 'var(--text-secondary)', background: 'var(--scrim-badge-bg)' }} onClick={() => setDetailsOpen(true)}>
                {statusItems.length > 1 ? <MoreHorizontal size={12} /> : statusItems[0].icon}
              </button>
            </span>}
          </div>
          {form !== 'html' && <span data-site-card-type
            className={`absolute top-2 z-20 inline-flex items-center gap-[3px] backdrop-blur-md transition-[right] group-hover:right-11 group-focus-within:right-11 ${selected || selectionMode ? 'right-11' : 'right-2'}`}
            style={{ height: 20, padding: '0 4px', borderRadius: 'var(--radius-chip)', fontFamily: 'var(--font-code)', fontSize: 9,
              background: 'var(--scrim-badge-bg)', color: 'var(--text-secondary)', border: '1px solid var(--scrim-badge-border)' }}
            title={[formConfig.hint, formBadge].filter(Boolean).join(' · ')}><FormIcon size={10} />{formConfig.label}</span>}

          {/* 触屏没有 hover：中卡和大卡必须另有常驻菜单入口，不能把唯一 kebab 藏在 hover 条里。 */}
          {!isSmall && (
            <div
              className="absolute right-[7px] bottom-[7px] z-20 hidden [@media(hover:none)]:block"
              onClick={(e) => e.stopPropagation()}
            >
              <CardMoreButton actions={menuActions} touchActions={touchActions} onScrim />
            </div>
          )}

          {/* 右下（小卡）：唯一一枚 kebab。小卡不渲染 hover 条，这颗就是全部操作入口。
              必须**绝对定位压在缩略图上**：放进信息层的常规流会永久吃掉 28px 一行，而它平时
              是透明的，于是每张小卡的正文底下都挂着一截空白（用户原话「下巴」）。中/大卡的
              同一颗 kebab 本来就在 hover 条里绝对定位，这里是把小卡对齐到同一条规矩。
              hover / focus 才显形（几十张卡时不留灰框噪点）；触屏没有 hover，必须常显，
              否则小卡在触屏上一个操作入口都没有。 */}
          {isSmall && (
            <div
              className="absolute right-[7px] bottom-[7px] z-20 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              <CardMoreButton actions={menuActions} touchActions={touchActions} onScrim contextTargetRef={cardRef} />
            </div>
          )}

          {/* 右上：视觉勾选框保持 20×20，真实按钮热区为 44×44，触屏不用精准点中小方框。 */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onSelect(); }}
            aria-label={selected ? '取消选择' : '选择'}
            title="按住勾选框滑过卡片，可连续选择或取消选择"
            data-no-drag
            data-site-select
            aria-pressed={selected}
            className={`absolute right-1 top-1 z-30 inline-flex h-7 w-7 items-center justify-center transition-opacity max-sm:right-[-4px] max-sm:top-[-4px] max-sm:h-11 max-sm:w-11 ${selected || selectionMode ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none group-hover:opacity-100 group-focus-within:opacity-100 group-hover:pointer-events-auto group-focus-within:pointer-events-auto'}`}
          >
            <span
              className="inline-flex h-5 w-5 items-center justify-center transition-opacity hover:!opacity-100 group-hover:opacity-100"
              style={{
                borderRadius: 'var(--radius-chip)',
                background: selected ? 'var(--accent-primary)' : 'var(--scrim-badge-bg)',
                border: `1px solid ${selected ? 'var(--accent-primary)' : 'var(--border-strong)'}`,
                opacity: 1,
              }}
            >
              {selected && <Check size={12} strokeWidth={2.8} style={{ color: 'var(--accent-on-primary)' }} />}
            </span>
          </button>

          {/*
            操作条压在缩略图内、常驻信息带上方：底衬一层渐变让按钮在任何画面上都读得出来。
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
              className="pointer-events-none absolute inset-x-0 bottom-1 z-20 hidden translate-y-[6px] items-center gap-[5px] opacity-0 transition-[opacity,transform] duration-[180ms] ease-out group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100 [@media(hover:hover)]:flex"
              style={{ padding: '7px', background: 'var(--scrim-fade)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <CardIconAction label="预览" icon={<Eye size={12} />} onClick={onVisit} primary />
              {c.canShare && (
                <CardIconAction
                  label={shared ? `管理分享${linkCount > 0 ? ` · ${linkCount}` : ''}` : '分享'}
                  icon={shared ? <Link2 size={12} /> : <Share2 size={12} />}
                  onClick={onShare}
                  compact={size === 'medium'}
                />
              )}
              <div className="ml-auto flex shrink-0 items-center gap-[5px]">
                {/* 窄屏按钮放大至 44px，次要操作由更多菜单承接，避免挤掉菜单入口。 */}
                <div className="hidden items-center gap-[5px] sm:flex">
                  {hoverActions.map((a) => (
                    <CardIconAction key={a.label} label={a.label} icon={a.icon} onClick={a.onClick} compact onScrim />
                  ))}
                </div>
                <CardMoreButton actions={menuActions} touchActions={touchActions} onScrim contextTargetRef={cardRef} />
              </div>
            </div>
          )}
        </div>

        {/* ── 信息层：只放「它现在怎么样」 ── */}
        <div className="flex flex-1 flex-col" style={{ padding: SPEC.pad, gap: SPEC.gap }}>
          {/* 标题恒定单行：多一行标题就把整行卡片撑高，短卡下面留出一截空白（用户原话「胡子太长」）。
              截断了也不丢信息——title 属性给全文，右栏「站点上下文」也显示完整标题。 */}
          <div data-site-card-title className="flex min-w-0 items-center gap-1.5" style={{ minHeight: 20 }}>
            <h3
              className="min-w-0 truncate cursor-pointer hover:underline"
              style={{ fontSize: SPEC.title, fontWeight: 600, lineHeight: 1.35, letterSpacing: 'var(--tracking-title)', color: 'var(--text-primary)' }}
              onClick={onVisit}
              title={site.title}
            >
              {site.title}
            </h3>
            <SiteNewBadge activity={activity} />
            {ownerCard && <span className="shrink-0" title={ownerCard.displayName}><UserAvatar src={resolveAvatarUrl({ avatarFileName: ownerCard.avatarFileName })} className="h-[18px] w-[18px] rounded-full" /></span>}
            <button ref={detailsButton} type="button" data-site-details-button data-no-drag
              aria-label="查看网页详情" aria-haspopup="dialog" aria-expanded={detailsOpen} title="查看完整信息"
              className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover-bg-soft focus-visible:outline focus-visible:outline-2"
              style={{ color: 'var(--text-tertiary)' }}
              onClick={(event) => { event.stopPropagation(); setDetailsOpen(true); }}>
              <Info size={14} aria-hidden />
            </button>
          </div>

          <div data-site-card-meta className="flex min-w-0 items-center gap-2" style={{ fontFamily: 'var(--font-code)', fontSize: 10, lineHeight: '16px', color: 'var(--text-tertiary)' }}>
            <span className="shrink-0" title={fmtSize(site.totalSize)}>{fmtSize(site.totalSize)}</span>
            <SiteCardMetrics activity={activity} traffic={traffic} onViewers={onViewers} />
          </div>
          {isLarge && site.description && <p className="line-clamp-2" style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text-secondary)' }}>{site.description}</p>}

        </div>
      </div>
    </div>
      {detailsOpen && <SiteDetailsDialog site={site} activity={activity} traffic={traffic}
        shared={shared} ownerCard={ownerCard} onClose={() => {
          setDetailsOpen(false);
          requestAnimationFrame(() => detailsButton.current?.focus());
        }} />}
    </>
  );
}
