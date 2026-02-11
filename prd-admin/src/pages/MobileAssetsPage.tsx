import { useEffect, useState, useMemo, useCallback } from 'react';
import { Image, FileText, Paperclip, FolderOpen, Loader2 } from 'lucide-react';
import { getMobileAssets } from '@/services';
import type { MobileAssetItem } from '@/services/contracts/mobile';

/* ── Tab 定义 ── */
type AssetTab = 'all' | 'image' | 'document' | 'attachment';

const TABS: { key: AssetTab; label: string; icon: typeof Image }[] = [
  { key: 'all',        label: '全部', icon: FolderOpen },
  { key: 'image',      label: '图片', icon: Image },
  { key: 'document',   label: '文档', icon: FileText },
  { key: 'attachment', label: '附件', icon: Paperclip },
];

/**
 * 移动端「资产」页 — 聚合用户所有产出物，支持分类过滤。
 *
 * 数据来自 GET /api/mobile/assets 聚合 API。
 */
export default function MobileAssetsPage() {
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

  return (
    <div className="h-full min-h-0 flex flex-col" style={{ background: 'var(--bg-base)' }}>
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
                background: active ? 'rgba(255,255,255,0.10)' : 'transparent',
                color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                border: active ? '1px solid rgba(255,255,255,0.10)' : '1px solid transparent',
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
          <div className="flex items-center justify-center h-40">
            <Loader2 size={24} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2">
            <FolderOpen size={32} style={{ color: 'rgba(255,255,255,0.15)' }} />
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {activeTab === 'all' ? '还没有任何资产' : '该分类下暂无内容'}
            </div>
            <div className="text-[11px]" style={{ color: 'rgba(255,255,255,0.3)' }}>
              使用 Agent 创作后，产出物会自动出现在这里
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 pt-2">
            {filtered.map((asset) => (
              <div
                key={asset.id}
                className="flex flex-col rounded-xl overflow-hidden"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
              >
                {/* 缩略图 */}
                <div
                  className="w-full aspect-[4/3] flex items-center justify-center"
                  style={{ background: 'rgba(255,255,255,0.02)' }}
                >
                  {asset.thumbnailUrl ? (
                    <img
                      src={asset.thumbnailUrl}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : asset.type === 'image' ? (
                    <Image size={24} style={{ color: 'rgba(255,255,255,0.12)' }} />
                  ) : asset.type === 'document' ? (
                    <FileText size={24} style={{ color: 'rgba(255,255,255,0.12)' }} />
                  ) : (
                    <Paperclip size={24} style={{ color: 'rgba(255,255,255,0.12)' }} />
                  )}
                </div>
                {/* 信息 */}
                <div className="p-2.5">
                  <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {asset.title}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span
                      className="inline-block px-1.5 py-0.5 rounded text-[9px] font-medium"
                      style={{
                        background: asset.type === 'image' ? 'rgba(251,146,60,0.15)' : asset.type === 'document' ? 'rgba(129,140,248,0.15)' : 'rgba(255,255,255,0.08)',
                        color: asset.type === 'image' ? '#FB923C' : asset.type === 'document' ? '#818CF8' : 'var(--text-muted)',
                      }}
                    >
                      {asset.type === 'image' ? '图片' : asset.type === 'document' ? '文档' : '附件'}
                    </span>
                    {asset.sizeBytes > 0 && (
                      <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>
                        {asset.sizeBytes > 1024 * 1024
                          ? `${(asset.sizeBytes / (1024 * 1024)).toFixed(1)}MB`
                          : `${(asset.sizeBytes / 1024).toFixed(0)}KB`}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
