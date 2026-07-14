import { useEffect, useState, useMemo, useCallback } from 'react';
import { Image, FileText, Paperclip, FolderOpen, Globe } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { SitePreview } from '@/components/SitePreview';
import { getMobileAssets } from '@/services';
import type { MobileAssetItem } from '@/services/contracts/mobile';
import { AS_FONT_FAMILY } from '@/lib/appStoreTokens';
import { useAppStoreColors } from '@/hooks/useAppStoreColors';

/* ── Tab 定义 ── */
type AssetTab = 'all' | 'image' | 'document' | 'attachment' | 'webpage';

const TABS: { key: AssetTab; label: string; icon: typeof Image }[] = [
  { key: 'all',        label: '全部', icon: FolderOpen },
  { key: 'image',      label: '图片', icon: Image },
  { key: 'document',   label: '文档', icon: FileText },
  { key: 'attachment', label: '附件', icon: Paperclip },
  { key: 'webpage',    label: '网页', icon: Globe },
];

/**
 * 移动端「资产」页 — 聚合用户所有产出物，支持分类过滤。
 *
 * 数据来自 GET /api/mobile/assets 聚合 API。
 */
export default function MobileAssetsPage() {
  const C = useAppStoreColors();
  const [activeTab, setActiveTab] = useState<AssetTab>('all');
  const [loading, setLoading] = useState(true);
  const [assets, setAssets] = useState<MobileAssetItem[]>([]);

  const fetchAssets = useCallback(async (category?: AssetTab) => {
    setLoading(true);
    const res = await getMobileAssets({
      category: category === 'all' ? undefined : category,
      limit: 50,
    });
    if (res.success) {
      setAssets(res.data.items ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAssets(activeTab);
  }, [activeTab, fetchAssets]);

  const filtered = useMemo(() => {
    if (activeTab === 'all') return assets;
    return assets.filter((a) => a.type === activeTab);
  }, [assets, activeTab]);

  // 类型徽章语义色（走 iOS 系统色，随双皮肤切换）。彩色档用 hex+alpha 底，附件用中性 pillBg。
  const typeMeta = (t: string): { label: string; color: string; bg: string } => {
    switch (t) {
      case 'image': return { label: '图片', color: C.orange, bg: `${C.orange}26` };
      case 'document': return { label: '文档', color: C.indigo, bg: `${C.indigo}26` };
      case 'webpage': return { label: '网页', color: C.green, bg: `${C.green}26` };
      default: return { label: '附件', color: C.labelSecondary, bg: C.pillBg };
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col" style={{ background: C.bg, fontFamily: AS_FONT_FAMILY }}>
      {/* ── Tab 栏 ── */}
      <div className="flex items-center gap-1 px-4 pt-4 pb-2 shrink-0">
        {TABS.map((tab) => {
          const active = activeTab === tab.key;
          const TabIcon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
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
      <div className="flex-1 min-h-0 overflow-auto px-4 pb-28">
        {loading ? (
          <MapSectionLoader />
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
              const meta = typeMeta(asset.type);
              return (
              <div
                key={asset.id}
                className="flex flex-col rounded-xl overflow-hidden"
                style={{ background: C.card, border: `1px solid ${C.hairline}` }}
              >
                {/* 缩略图 */}
                <div
                  className="w-full aspect-[4/3] flex items-center justify-center"
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
                  ) : asset.type === 'image' ? (
                    <Image size={24} style={{ color: C.labelTertiary }} />
                  ) : asset.type === 'document' ? (
                    <FileText size={24} style={{ color: C.labelTertiary }} />
                  ) : asset.type === 'webpage' ? (
                    <Globe size={24} style={{ color: C.labelTertiary }} />
                  ) : (
                    <Paperclip size={24} style={{ color: C.labelTertiary }} />
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
                      style={{ background: meta.bg, color: meta.color }}
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
