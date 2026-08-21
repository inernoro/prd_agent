import { useState } from 'react';
import {
  BookOpen,
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
  Users,
} from 'lucide-react';
import type { HostedSite, SiteOwnerCard } from '@/services/real/webPages';
import { SitePreview } from '@/components/SitePreview';
import { PdfThumbnail, isPdfSite } from '@/components/PdfThumbnail';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { useDockDrag } from '@/components/share-dock';
import { CardActionBar, CardIconAction, CardMoreButton, type CardMoreAction } from './SiteCardActions';
import { resolveSiteForm, siteFormBadge, siteSourceLabel, SITE_FORM_REGISTRY } from './siteFormRegistry';

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
  caps?: SiteCaps;
  ownerCard?: SiteOwnerCard;
  onSelect: () => void;
  onVisit: () => void;
  onTogglePublic: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onShare: () => void;
  onQrCode: () => void;
  onTransferToLibrary: () => void;
  onReplaceFile: (file: File) => void;
  onViewers?: () => void;
  onMove?: () => void;
  onComments?: () => void;
  onAskConfig?: () => void;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '—';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
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

  const statusChips = (
    <>
      {shared && (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
          style={{
            background: 'var(--semantic-success-soft)',
            color: 'var(--semantic-success-text)',
            border: '1px solid var(--semantic-success-border)',
          }}
        >
          <Link2 size={9} />
          已分享{linkCount > 0 ? ` ${linkCount}` : ''}
        </span>
      )}
      {isPublic && (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
          style={{
            background: 'var(--semantic-warning-soft)',
            color: 'var(--semantic-warning-text)',
            border: '1px solid var(--semantic-warning-border)',
          }}
        >
          已公开
        </span>
      )}
      {(site.sharedTeamIds?.length ?? 0) > 0 && (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
          style={{
            background: 'var(--bg-tertiary)',
            color: 'var(--accent-fg-blue)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <Users size={9} />
          团队共享
        </span>
      )}
    </>
  );

  return (
    <div
      data-tour-id="webpages-card"
      data-card
      className={['group relative w-full cursor-grab touch-none active:cursor-grabbing', fresh ? 'site-card-fresh' : ''].join(' ')}
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
        className="relative overflow-hidden rounded-[16px] border transition-all duration-300 group-hover:-translate-y-0.5 group-hover:shadow-xl"
        style={{
          background: 'var(--nested-block-bg)',
          borderColor: fileDragOver || selected ? 'var(--accent-primary)' : 'var(--border-default)',
        }}
      >
        {fileDragOver && (
          <div
            className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 rounded-[16px] backdrop-blur-sm"
            style={{
              background: 'color-mix(in srgb, var(--accent-primary) 26%, var(--bg-tertiary))',
              border: '2px dashed var(--accent-primary)',
            }}
          >
            <Replace size={26} style={{ color: 'var(--text-primary)' }} />
            <span className="text-[13px] font-semibold text-token-primary">替换此网页</span>
            <span className="px-3 text-center text-[11px] text-token-secondary">松开以替换「{site.title}」的内容</span>
          </div>
        )}

        {/* ── 缩略图层：只放「这是什么」 ── */}
        <div
          className="relative cursor-pointer overflow-hidden"
          style={{ aspectRatio: '16 / 10', background: 'var(--bg-tertiary)' }}
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

          <div className="absolute left-2 top-2 z-20 flex items-center gap-1">
            <span
              className="inline-flex h-[22px] items-center gap-1 rounded-md px-1.5 text-[10px] font-semibold backdrop-blur-md"
              style={{ background: 'var(--panel-solid)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}
              title={formConfig.hint}
            >
              <FormIcon size={11} />
              {formConfig.label}
            </span>
          </div>

          <div className="absolute right-2 top-2 z-20">
            <span
              className="inline-flex h-[22px] items-center gap-1 rounded-md px-1.5 text-[10px] backdrop-blur-md"
              style={{ background: 'var(--panel-solid)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}
            >
              {siteSourceLabel(site.sourceType)}
            </span>
          </div>

          {formBadge && (
            <span
              className="absolute bottom-2 right-2 z-20 inline-flex h-[20px] items-center rounded px-1.5 font-mono text-[10px] backdrop-blur-md"
              style={{ background: 'var(--panel-solid)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}
            >
              {formBadge}
            </span>
          )}

          {/* 选择框：hover / 已选中时显形，几十张卡时不留常驻噪点 */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
            aria-label={selected ? '取消选择' : '选择'}
            className={[
              'absolute bottom-2 left-2 z-20 inline-flex h-6 w-6 items-center justify-center rounded-md backdrop-blur-md transition-opacity',
              selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
            ].join(' ')}
            style={{ background: 'var(--panel-solid)', border: '1px solid var(--border-subtle)' }}
          >
            <input
              type="checkbox"
              checked={selected}
              readOnly
              className="pointer-events-none"
              style={{ accentColor: 'var(--accent-primary)' }}
            />
          </button>
        </div>

        {/* ── 信息层：只放「它现在怎么样」 ── */}
        <div className="flex flex-col gap-1.5 px-2.5 py-2">
          {!isSmall && (
            <div className="flex min-w-0 items-center gap-1">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{statusChips}</div>
              {ownerCard && (
                <span className="shrink-0" title={ownerCard.displayName}>
                  <UserAvatar
                    src={resolveAvatarUrl({ avatarFileName: ownerCard.avatarFileName })}
                    className="h-[18px] w-[18px] rounded-full"
                  />
                </span>
              )}
            </div>
          )}

          <div className="flex min-w-0 items-start gap-1">
            {isSmall && shared && (
              <span
                className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: 'var(--semantic-success-text)' }}
                title={linkCount > 0 ? `已分享 ${linkCount} 条链接` : '已分享'}
              />
            )}
            <h3
              className="line-clamp-2 flex-1 cursor-pointer text-[13px] font-semibold leading-tight hover:underline"
              style={{ color: 'var(--text-primary)' }}
              onClick={onVisit}
              title={site.title}
            >
              {site.title}
            </h3>
          </div>

          {isLarge && (
            <p className="line-clamp-2 text-[11px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
              {site.description || formConfig.hint}
            </p>
          )}

          {isLarge && site.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {site.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="rounded px-1.5 py-0.5 text-[10px]"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
                >
                  {tag}
                </span>
              ))}
              {site.tags.length > 3 && (
                <span className="text-[10px] text-token-muted">+{site.tags.length - 3}</span>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-1.5 font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
            <span>{fmtSize(site.totalSize)}</span>
            <span aria-hidden>·</span>
            <span>{site.viewCount} 浏览</span>
            {!isSmall && (
              <>
                <span aria-hidden>·</span>
                <span>{relativeTime(site.updatedAt)}</span>
              </>
            )}
          </div>

          {/* 大卡的成果数据：浏览 / 有效链接 / 最近访问。体积是属性不是成果，退回上面那行元信息。 */}
          {isLarge && (
            <div className="mt-1 flex items-end gap-4">
              <div>
                <div className="text-[20px] font-semibold leading-none tracking-tight" style={{ color: 'var(--text-primary)' }}>
                  {site.viewCount}
                </div>
                <div className="mt-1 font-mono text-[9.5px]" style={{ color: 'var(--text-muted)' }}>浏览</div>
              </div>
              <div>
                <div className="text-[20px] font-semibold leading-none tracking-tight" style={{ color: 'var(--text-primary)' }}>
                  {shareStats ? linkCount : '—'}
                </div>
                <div className="mt-1 font-mono text-[9.5px]" style={{ color: 'var(--text-muted)' }}>有效链接</div>
              </div>
              <div>
                <div className="text-[13px] font-semibold leading-none" style={{ color: 'var(--text-primary)' }}>
                  {shareStats?.lastViewedAt ? relativeTime(shareStats.lastViewedAt) : '—'}
                </div>
                <div className="mt-1 font-mono text-[9.5px]" style={{ color: 'var(--text-muted)' }}>最近访问</div>
              </div>
            </div>
          )}

          {/* 常驻操作条：预览 + 分享/管理分享·N + kebab */}
          <CardActionBar>
            {!isSmall && (
              <CardIconAction label="预览" icon={<Eye size={12} />} onClick={onVisit} primary />
            )}
            {!isSmall && c.canShare && (
              <CardIconAction
                label={shared ? `管理分享${linkCount > 0 ? ` · ${linkCount}` : ''}` : '分享'}
                icon={shared ? <Link2 size={12} /> : <Share2 size={12} />}
                onClick={onShare}
              />
            )}
            <div className="ml-auto flex items-center gap-1">
              {/* hover 层：桌面显形，触屏不渲染（等价项已在 kebab 顶部） */}
              <div data-hoverbar className="hidden items-center gap-1 sm:flex">
                {hoverActions.map((a) => (
                  <CardIconAction key={a.label} label={a.label} icon={a.icon} onClick={a.onClick} compact />
                ))}
              </div>
              <CardMoreButton actions={menuActions} touchActions={hoverActions.length} />
            </div>
          </CardActionBar>
        </div>
      </div>
    </div>
  );
}
