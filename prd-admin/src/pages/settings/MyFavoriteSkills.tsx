/**
 * 我收藏的技能（我的空间 banner 下）
 *
 * 数据源：GET /api/marketplace/skills/favorites
 * 交互：点击卡片 → 触发浏览器下载 zip；取消收藏 → 立刻从本列表移除
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, ExternalLink, Hash, Heart, Package, Store } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import {
  forkMarketplaceSkill,
  listMyFavoriteSkills,
  unfavoriteMarketplaceSkill,
} from '@/services';
import type { MarketplaceSkillDto } from '@/services/contracts/marketplaceSkills';
import { toast } from '@/lib/toast';

function SectionHeader({
  icon,
  title,
  subtitle,
  count,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  count: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3 shrink-0">
      <div className="flex items-center gap-2.5 min-w-0">
        <div
          className="surface-state-danger flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]"
        >
          {icon}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-bold text-token-primary">
            {title}
            <span
              className="surface-inset rounded px-1.5 py-0.5 font-mono text-[10px] text-token-muted"
            >
              {count}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-token-muted">
            {subtitle}
          </div>
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function MyFavoriteSkills() {
  const navigate = useNavigate();
  const [items, setItems] = useState<MarketplaceSkillDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listMyFavoriteSkills();
      if (res.success && res.data?.items) {
        setItems(res.data.items);
      } else {
        setItems([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleDownload = async (item: MarketplaceSkillDto) => {
    setPendingId(item.id);
    try {
      const res = await forkMarketplaceSkill({ id: item.id });
      if (res.success) {
        toast.success('已开始下载技能包');
        // forkMarketplaceSkillReal 已自动触发浏览器下载；这里同步计数
        setItems((xs) =>
          xs.map((x) =>
            x.id === item.id ? { ...x, downloadCount: x.downloadCount + 1, forkCount: x.forkCount + 1 } : x,
          ),
        );
      } else {
        toast.error('下载失败', res.error?.message || '未知错误');
      }
    } finally {
      setPendingId(null);
    }
  };

  const handleUnfavorite = async (item: MarketplaceSkillDto) => {
    setPendingId(item.id);
    // 乐观更新：直接从列表移除
    const prev = items;
    setItems((xs) => xs.filter((x) => x.id !== item.id));
    try {
      const res = await unfavoriteMarketplaceSkill({ id: item.id });
      if (!res.success) {
        setItems(prev);
        toast.error('取消收藏失败', res.error?.message || '');
      }
    } catch {
      setItems(prev);
    } finally {
      setPendingId(null);
    }
  };

  return (
    <GlassCard animated accentHue={340} className="mb-5">
      <SectionHeader
        icon={<Heart size={14} fill="currentColor" />}
        title="我收藏的技能"
        subtitle="在海鲜市场心标的技能包，在此一键下载"
        count={items.length}
        action={
          <Button variant="ghost" size="xs" onClick={() => navigate('/marketplace?type=skill')}>
            <Store size={12} />
            去海鲜市场
          </Button>
        }
      />

      {loading ? (
        <div
          className="flex items-center justify-center py-6 text-[12px] text-token-muted"
        >
          加载中…
        </div>
      ) : items.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center gap-1.5 py-6 text-center text-token-muted"
        >
          <div className="text-[13px] font-medium">还没有收藏的技能</div>
          <div className="text-[11px] max-w-[320px] leading-relaxed">
            去海鲜市场的「技能」Tab，在喜欢的卡片右上角点♥️收藏，收藏列表会出现在这里
          </div>
          <Button
            variant="secondary"
            size="xs"
            onClick={() => navigate('/marketplace?type=skill')}
            className="mt-2"
          >
            <ExternalLink size={12} />
            去浏览技能
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {items.map((item) => (
            <FavoriteSkillRow
              key={item.id}
              item={item}
              busy={pendingId === item.id}
              onDownload={() => handleDownload(item)}
              onUnfavorite={() => handleUnfavorite(item)}
            />
          ))}
        </div>
      )}
    </GlassCard>
  );
}

function FavoriteSkillRow({
  item,
  busy,
  onDownload,
  onUnfavorite,
}: {
  item: MarketplaceSkillDto;
  busy: boolean;
  onDownload: () => void;
  onUnfavorite: () => void;
}) {
  return (
    <div
      className="surface-row group flex items-center gap-3 rounded-[10px] border border-token-nested px-3 py-2.5 transition-colors"
    >
      <div
        className="surface-action-accent flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] text-[18px]"
      >
        {item.iconEmoji || <Package size={16} />}
      </div>
      <div className="flex-1 min-w-0">
        <div
          className="truncate text-[13px] font-medium text-token-primary"
          title={item.title}
        >
          {item.title}
        </div>
        <div
          className="truncate text-[11px] text-token-muted"
          title={item.description}
        >
          {item.description || '（暂无详情）'}
        </div>
        {item.tags && item.tags.length > 0 && (
          <div className="mt-1 flex max-h-[18px] flex-wrap items-center gap-1 overflow-hidden">
            {item.tags.slice(0, 3).map((t) => (
              <span
                key={t}
                className="surface-inset inline-flex h-4 items-center gap-0.5 rounded-full px-1.5 text-[9px] text-token-muted"
              >
                <Hash size={8} />
                {t}
              </span>
            ))}
            {item.tags.length > 3 && (
              <span className="text-[9px] text-token-muted">
                +{item.tags.length - 3}
              </span>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onUnfavorite}
        disabled={busy}
        title="取消收藏"
        className="surface-state-danger flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-wait"
      >
        <Heart size={12} fill="currentColor" />
      </button>
      <Button variant="secondary" size="xs" onClick={onDownload} disabled={busy}>
        <Download size={12} />
        {busy ? '下载中...' : '下载'}
      </Button>
    </div>
  );
}

export default MyFavoriteSkills;
