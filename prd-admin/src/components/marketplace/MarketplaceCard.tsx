import React, { useState } from 'react';
import { Button } from '@/components/design/Button';
import {
  Edit3,
  ExternalLink,
  GitFork,
  Globe,
  Hand,
  Heart,
  ShieldCheck,
} from 'lucide-react';
import { resolveAvatarUrl } from '@/lib/avatar';
import { formatDistanceToNow } from '@/lib/dateUtils';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { systemDialog } from '@/lib/systemDialog';
import {
  CONFIG_TYPE_REGISTRY,
  type MixedMarketplaceItem,
  type ConfigTypeDefinition,
  type MarketplaceSkill,
} from '@/lib/marketplaceTypes';
import { favoriteMarketplaceSkill, unfavoriteMarketplaceSkill } from '@/services';

export interface MarketplaceCardProps {
  item: MixedMarketplaceItem;
  onFork: (typeKey: string, id: string, customName?: string) => Promise<void>;
  onEdit?: (item: MixedMarketplaceItem) => void;
  currentUserId?: string;
  forking?: boolean;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function getCoverImageUrl(item: MixedMarketplaceItem): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = item.data as any;
  if (item.type === 'skill') return (d.coverImageUrl as string) || null;
  if (item.type === 'refImage') return (d.imageUrl as string) || null;
  if (item.type === 'watermark') return (d.previewUrl as string) || null;
  return null;
}

function getDescriptionText(item: MixedMarketplaceItem): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = item.data as any;
  if (item.type === 'skill') return (d.description as string) || '';
  if (item.type === 'prompt') return ((d.content as string) || '').slice(0, 120);
  if (item.type === 'refImage') return (d.prompt as string) || '';
  if (item.type === 'watermark') return (d.text as string) || '';
  return '';
}

function getTags(item: MixedMarketplaceItem): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((item.data as any).tags as string[]) || [];
}

function getPreviewLink(item: MixedMarketplaceItem): { url: string; isHosted: boolean } | null {
  if (item.type !== 'skill') return null;
  const d = item.data as MarketplaceSkill;
  if (!d.previewUrl) return null;
  return { url: d.previewUrl, isHosted: d.previewSource === 'hosted_site' };
}

/** Rewrite the alpha value of an rgba() string. */
function ra(rgba: string, newA: number): string {
  return rgba.replace(/[\d.]+\)$/, `${newA})`);
}

// ── skill favourite toggle ─────────────────────────────────────────────────

function SkillFavorite({ item }: { item: MarketplaceSkill }) {
  const [favorited, setFavorited] = useState(item.isFavoritedByCurrentUser);
  const [count, setCount] = useState(item.favoriteCount);
  const [pending, setPending] = useState(false);

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (pending) return;
    setPending(true);
    const next = !favorited;
    setFavorited(next);
    setCount((c) => (next ? c + 1 : Math.max(0, c - 1)));
    try {
      const res = next
        ? await favoriteMarketplaceSkill({ id: item.id })
        : await unfavoriteMarketplaceSkill({ id: item.id });
      if (!res.success) {
        setFavorited(!next);
        setCount((c) => (next ? Math.max(0, c - 1) : c + 1));
      } else if (res.data?.item) {
        // 官方虚拟行等后端 no-op 场景：以服务端返回的实际状态为准
        setFavorited(res.data.item.isFavoritedByCurrentUser);
        setCount(res.data.item.favoriteCount);
      }
    } catch {
      setFavorited(!next);
      setCount((c) => (next ? Math.max(0, c - 1) : c + 1));
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      title={favorited ? '取消收藏' : '收藏'}
      className="mkt-card-favorite"
      data-active={favorited ? 'true' : 'false'}
    >
      <Heart size={11} fill={favorited ? 'currentColor' : 'none'} />
      <span>{count}</span>
    </button>
  );
}

// ── main card ─────────────────────────────────────────────────────────────────

export const MarketplaceCard: React.FC<MarketplaceCardProps> = ({
  item,
  onFork,
  onEdit,
  currentUserId,
  forking = false,
}) => {
  const typeDef = CONFIG_TYPE_REGISTRY[item.type] as ConfigTypeDefinition | undefined;
  const [localForking, setLocalForking] = useState(false);
  const cardRef = React.useRef<HTMLDivElement>(null);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
    el.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
  };

  const handleMouseLeave = () => {
    const el = cardRef.current;
    if (el) {
      el.style.setProperty('--mx', '50%');
      el.style.setProperty('--my', '50%');
    }
  };

  if (!typeDef) {
    console.warn(`[MarketplaceCard] Unknown type: ${item.type}`);
    return null;
  }

  const { icon: TypeIcon, color } = typeDef;
  const displayName = typeDef.getDisplayName(item.data);
  const descText = getDescriptionText(item);
  const tags = getTags(item);
  const coverUrl = getCoverImageUrl(item);
  const previewLink = getPreviewLink(item);
  const isOfficial = item.data.ownerUserId === 'official';
  const canEdit =
    item.type === 'skill' &&
    !!onEdit &&
    !!currentUserId &&
    item.data.ownerUserId === currentUserId;

  const cardGradient = coverUrl
    ? undefined
    : `linear-gradient(145deg, ${ra(color.bg, 0.55)} 0%, ${ra(color.bg, 0.30)} 45%, ${ra(color.bg, 0.12)} 100%)`;

  const handleForkClick = async () => {
    setLocalForking(true);
    try {
      const result = await systemDialog.prompt({
        title: '拿来吧',
        message: '请为下载的配置命名',
        defaultValue: displayName,
        placeholder: '输入配置名称',
      });
      if (result !== null) {
        await onFork(item.type, item.data.id, result || displayName);
      }
    } finally {
      setLocalForking(false);
    }
  };

  const stopAndOpen = (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    e.preventDefault();
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div
      ref={cardRef}
      className="mkt-card"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{
        backgroundImage: cardGradient,
        ['--glow' as string]: ra(color.bg, 0.45),
      }}
    >
      {/* Full-bleed cover image (when available) */}
      {coverUrl && (
        <img src={coverUrl} alt={displayName} className="mkt-card-bg-img" />
      )}

      {/* Icon centred in the upper area (no cover) */}
      {!coverUrl && (
        <div
          className="mkt-card-icon-zone"
          style={{
            color: color.iconColor,
            filter: `drop-shadow(0 0 16px ${ra(color.bg, 0.55)}) drop-shadow(0 0 5px ${ra(color.bg, 0.35)})`,
          }}
        >
          <TypeIcon size={54} />
        </div>
      )}

      {/* Preview link — top-right pill */}
      {previewLink && (
        <button
          type="button"
          className="mkt-card-preview-badge"
          onClick={(e) => stopAndOpen(e, previewLink.url)}
          title={previewLink.url}
        >
          {previewLink.isHosted ? <Globe size={9} /> : <ExternalLink size={9} />}
          预览
        </button>
      )}

      {/* ── Frosted glass info panel ── */}
      <div className="mkt-card-glass">
        {/* Title row */}
        <div className="mkt-card-title-row">
          <span className="mkt-card-title" title={displayName}>
            {displayName}
          </span>
          {isOfficial && (
            <span className="mkt-card-official">
              <ShieldCheck size={9} />
              官方
            </span>
          )}
        </div>

        {/* Description */}
        {descText ? (
          <div className="mkt-card-desc">{descText}</div>
        ) : null}

        {/* Tags */}
        {tags.length > 0 && (
          <div className="mkt-card-tags">
            {tags.slice(0, 3).map((t) => (
              <span key={t} className="mkt-card-tag">
                {t}
              </span>
            ))}
            {tags.length > 3 && (
              <span className="mkt-card-tag-more">+{tags.length - 3}</span>
            )}
          </div>
        )}

        {/* Footer inside glass */}
        <div className="mkt-card-glass-footer">
          {/* Left: author + fork count */}
          <div className="mkt-card-meta">
            <UserAvatar
              src={resolveAvatarUrl({ avatarFileName: item.data.ownerUserAvatar })}
              className="w-4 h-4 rounded-full object-cover flex-shrink-0"
            />
            <span className="truncate max-w-[64px]">
              {item.data.ownerUserName || '未知'}
            </span>
            <span className="opacity-40 flex-shrink-0">·</span>
            <GitFork size={10} className="opacity-55 flex-shrink-0" />
            <span className="flex-shrink-0">{item.data.forkCount}</span>
            {(item.data.updatedAt || item.data.createdAt) && (
              <>
                <span className="opacity-40 flex-shrink-0">·</span>
                <span className="opacity-55 flex-shrink-0 truncate" title={item.data.updatedAt || item.data.createdAt}>
                  {formatDistanceToNow(item.data.updatedAt || item.data.createdAt)}
                </span>
              </>
            )}
          </div>

          {/* Right: actions */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {item.type === 'skill' && (
              <SkillFavorite item={item.data as MarketplaceSkill} />
            )}
            {canEdit && (
              <Button
                size="xs"
                variant="secondary"
                onClick={() => onEdit?.(item)}
                title="编辑"
              >
                <Edit3 size={11} />
              </Button>
            )}
            <Button
              size="xs"
              variant="secondary"
              disabled={forking || localForking}
              onClick={handleForkClick}
            >
              <Hand size={11} />
              {forking || localForking ? '...' : '拿来吧'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MarketplaceCard;
