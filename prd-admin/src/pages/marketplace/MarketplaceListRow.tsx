import React, { useState } from 'react';
import { Button } from '@/components/design/Button';
import { Edit3, GitFork, Hand, Heart, ShieldCheck } from 'lucide-react';
import { resolveAvatarUrl } from '@/lib/avatar';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { systemDialog } from '@/lib/systemDialog';
import {
  CONFIG_TYPE_REGISTRY,
  type MixedMarketplaceItem,
  type ConfigTypeDefinition,
  type MarketplaceSkill,
} from '@/lib/marketplaceTypes';
import { favoriteMarketplaceSkill, unfavoriteMarketplaceSkill } from '@/services';

export interface MarketplaceListRowProps {
  rank: number;
  item: MixedMarketplaceItem;
  onFork: (typeKey: string, id: string, customName?: string) => Promise<void>;
  onEdit?: (item: MixedMarketplaceItem) => void;
  currentUserId?: string;
  forking?: boolean;
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

export const MarketplaceListRow: React.FC<MarketplaceListRowProps> = ({
  rank,
  item,
  onFork,
  onEdit,
  currentUserId,
  forking = false,
}) => {
  const typeDef = CONFIG_TYPE_REGISTRY[item.type] as ConfigTypeDefinition | undefined;
  const [localForking, setLocalForking] = useState(false);

  if (!typeDef) return null;

  const { icon: TypeIcon, color } = typeDef;
  const displayName = typeDef.getDisplayName(item.data);
  const descText = getDescriptionText(item);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tags = ((item.data as any).tags as string[]) || [];
  const isOfficial = item.data.ownerUserId === 'official';
  const canEdit =
    item.type === 'skill' &&
    !!onEdit &&
    !!currentUserId &&
    item.data.ownerUserId === currentUserId;

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

  return (
    <div className="mkt-lb-row">
      <div className="mkt-lb-rank">{rank}</div>

      <div className="mkt-lb-type-icon" style={{ color: color.iconColor }}>
        <TypeIcon size={18} />
      </div>

      <div className="mkt-lb-info">
        <div className="mkt-lb-name-row">
          <span className="mkt-lb-name">{displayName}</span>
          {isOfficial && (
            <span className="mkt-lb-official-badge">
              <ShieldCheck size={9} />
              官方
            </span>
          )}
          {tags.slice(0, 4).map((t) => (
            <span key={t} className="mkt-lb-tag">
              #{t}
            </span>
          ))}
          {tags.length > 4 && (
            <span className="mkt-lb-tag-more">+{tags.length - 4}</span>
          )}
        </div>
        <div className="mkt-lb-sub-row">
          <UserAvatar
            src={resolveAvatarUrl({ avatarFileName: item.data.ownerUserAvatar })}
            className="w-3.5 h-3.5 rounded-full object-cover flex-shrink-0"
          />
          <span className="mkt-lb-author">{item.data.ownerUserName || '未知'}</span>
          {descText && (
            <>
              <span className="mkt-lb-dot">·</span>
              <span className="mkt-lb-desc">{descText.slice(0, 100)}</span>
            </>
          )}
        </div>
      </div>

      <div className="mkt-lb-actions">
        {item.type === 'skill' && (
          <SkillFavorite item={item.data as MarketplaceSkill} />
        )}
        <span className="mkt-lb-fork-count">
          <GitFork size={10} />
          {item.data.forkCount}
        </span>
        {canEdit && (
          <Button size="xs" variant="secondary" onClick={() => onEdit?.(item)} title="编辑">
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
  );
};

export default MarketplaceListRow;
