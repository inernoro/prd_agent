import { useEffect, useState, useMemo } from 'react';
import { Image, FolderOpen } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { SitePreview } from '@/components/SitePreview';
import { getMobileAssets } from '@/services';
import type { AssetCategory, MobileAssetItem } from '@/services/contracts/mobile';
import { AS_FONT_FAMILY } from '@/lib/appStoreTokens';
import { useAppStoreColors } from '@/hooks/useAppStoreColors';
import { ASSET_CATEGORIES, ASSET_CATEGORY_REGISTRY, isAudioAsset } from '@/lib/assetCategories';
import { AudioAssetPlayer } from '@/components/assets/AudioAssetPlayer';

/* ── Tab 定义 ── */
type AssetTab = 'all' | AssetCategory;

const TABS: { key: AssetTab; label: string; icon: typeof Image }[] = [
  { key: 'all',        label: '全部', icon: FolderOpen },
  ...ASSET_CATEGORIES.map((key) => ({ key, label: ASSET_CATEGORY_REGISTRY[key].label, icon: ASSET_CATEGORY_REGISTRY[key].icon })),
];

/**
 * 移动端「资产」页 — 聚合用户所有产出物，支持分类过滤。
 *
 * 数据来自 GET /api/mobile/assets 聚合 API。
 */
export default function MobileAssetsPage() {
  const C = useAppStoreColors();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = TABS.find((tab) => tab.key === searchParams.get('tab'))?.key ?? 'all';
  const setActiveTab = (tab: AssetTab) => {
    const next = new URLSearchParams(searchParams);
    if (tab === 'all') next.delete('tab'); else next.set('tab', tab);
    setSearchParams(next, { replace: true });
  };
  const [loading, setLoading] = useState(true);
  const [assets, setAssets] = useState<MobileAssetItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getMobileAssets({ category: activeTab === 'all' ? undefined : activeTab, limit: 50 })
      .then((res) => {
        if (cancelled) return;
        if (res.success) setAssets(res.data.items ?? []);
        else setError(res.error?.message || '资产加载失败，请重试。');
      })
      .catch(() => { if (!cancelled) setError('资产加载失败，请重试。'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeTab, retry]);

  const filtered = useMemo(() => {
    if (activeTab === 'all') return assets;
    return assets.filter((a) => a.type === activeTab);
  }, [assets, activeTab]);

  return (
    <div className="h-full min-h-0 flex flex-col" style={{ background: C.bg, fontFamily: AS_FONT_FAMILY }}>
      {/* ── Tab 栏 ── */}
      <div className="flex items-center gap-1 overflow-x-auto px-4 pt-4 pb-2 shrink-0" style={{ overscrollBehavior: 'contain' }}>
        {TABS.map((tab) => {
          const active = activeTab === tab.key;
          const TabIcon = tab.icon;
          return (
            <button
              key={tab.key}
              type="button"
              aria-pressed={active}
              onClick={() => setActiveTab(tab.key)}
              className="flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{
                background: active ? C.pillBg : 'transparent',
                color: active ? C.label : C.labelSecondary,
                border: active ? `1px solid ${C.hairline}` : '1px solid transparent',
              }}
            >
              <TabIcon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ── 内容区 ── */}
      <div className="flex-1 min-h-0 overflow-auto px-4 pb-28" style={{ overscrollBehavior: 'contain' }}>
        {loading ? (
          <MapSectionLoader />
        ) : error ? (
          <div role="alert" className="flex flex-col items-center gap-3 py-8" style={{ color: C.labelSecondary }}>
            <p>{error}</p>
            <button type="button" onClick={() => setRetry((value) => value + 1)}>重新加载</button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2">
            <FolderOpen size={32} style={{ color: C.labelTertiary }} />
            <div className="text-sm" style={{ color: C.labelSecondary }}>
              {activeTab === 'all' ? '还没有任何资产' : '该分类下暂无内容'}
            </div>
            <div className="text-[11px]" style={{ color: C.labelTertiary }}>
              使用 Agent 创作后，产出物会自动出现在这里
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 pt-2">
            {filtered.map((asset) => {
              const meta = ASSET_CATEGORY_REGISTRY[asset.type] ?? ASSET_CATEGORY_REGISTRY.attachment;
              const AssetIcon = meta.icon;
              const audio = isAudioAsset(asset);
              return (
              <div
                key={asset.id}
                className={`flex flex-col rounded-xl overflow-hidden${audio ? ' col-span-2' : ''}`}
                style={{ background: C.card, border: `1px solid ${C.hairline}` }}
              >
                {/* 缩略图 */}
                <div
                  className={`w-full flex items-center justify-center${audio ? ' py-5' : ' aspect-[4/3]'}`}
                  style={{ background: C.surface }}
                >
                  {asset.thumbnailUrl ? (
                    <img
                      src={asset.thumbnailUrl}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : asset.type === 'webpage' && asset.url ? (
                    <SitePreview url={asset.url} className="w-full h-full" />
                  ) : (
                    <AssetIcon size={24} style={{ color: C.labelTertiary }} />
                  )}
                </div>
                {/* 信息 */}
                <div className="p-2.5">
                  <div className="text-xs font-medium truncate" style={{ color: C.label }}>
                    {asset.title}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span
                      className="inline-block px-1.5 py-0.5 rounded text-[9px] font-medium"
                      style={{ background: meta.bg, color: meta.text }}
                    >
                      {meta.label}
                    </span>
                    {asset.sizeBytes > 0 && (
                      <span className="text-[9px]" style={{ color: C.labelSecondary }}>
                        {asset.sizeBytes > 1024 * 1024
                          ? `${(asset.sizeBytes / (1024 * 1024)).toFixed(1)}MB`
                          : `${(asset.sizeBytes / 1024).toFixed(0)}KB`}
                      </span>
                    )}
                  </div>
                  {audio && (
                    <div className="mt-2 space-y-2">
                      {asset.source && <p className="text-[11px]" style={{ color: C.labelSecondary }}>{asset.source}</p>}
                      {asset.summary && <p className="text-xs leading-relaxed" style={{ color: C.labelSecondary }}>{asset.summary}</p>}
                      {asset.url && <AudioAssetPlayer url={asset.url} title={asset.title} />}
                    </div>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
