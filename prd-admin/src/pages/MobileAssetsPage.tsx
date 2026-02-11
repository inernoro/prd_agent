import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Image, FileText, Paperclip, FolderOpen, Loader2 } from 'lucide-react';
import { listVisualAgentWorkspaces } from '@/services';

/* ── Tab 定义 ── */
type AssetTab = 'all' | 'images' | 'documents' | 'attachments';

const TABS: { key: AssetTab; label: string; icon: typeof Image }[] = [
  { key: 'all',         label: '全部',   icon: FolderOpen },
  { key: 'images',      label: '图片',   icon: Image },
  { key: 'documents',   label: '文档',   icon: FileText },
  { key: 'attachments', label: '附件',   icon: Paperclip },
];

/* ── 统一资产条目 ── */
interface AssetEntry {
  id: string;
  title: string;
  subtitle?: string;
  type: 'image' | 'document' | 'attachment';
  thumbnail?: string;
  updatedAt?: string;
  navigateTo?: string;
}

/**
 * 移动端「资产」页 — 聚合用户产出物。
 *
 * Phase 1: 从现有 API 拉取视觉创作工作区 (作为图片类)。
 * Phase 2: 接入文学创作、PRD 文档、附件上传等。
 */
export default function MobileAssetsPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<AssetTab>('all');
  const [loading, setLoading] = useState(true);
  const [assets, setAssets] = useState<AssetEntry[]>([]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const entries: AssetEntry[] = [];

      // 拉取视觉创作工作区 → 图片类资产
      try {
        const res = await listVisualAgentWorkspaces();
        if (res.success && res.data?.items) {
          for (const ws of res.data.items) {
            entries.push({
              id: `va-${ws.id}`,
              title: ws.title || '未命名工作区',
              subtitle: '视觉创作',
              type: 'image',
              thumbnail: ws.coverAssets?.[0]?.url,
              updatedAt: ws.updatedAt,
              navigateTo: `/visual-agent/${ws.id}`,
            });
          }
        }
      } catch { /* ignore */ }

      // TODO Phase 2: 文学创作工作区 → document 类
      // TODO Phase 2: PRD 附件 → attachment 类
      // TODO Phase 2: 用户上传附件 → attachment 类

      entries.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      setAssets(entries);
      setLoading(false);
    })();
  }, []);

  const filtered = useMemo(() => {
    if (activeTab === 'all') return assets;
    const typeMap: Record<AssetTab, string> = { all: '', images: 'image', documents: 'document', attachments: 'attachment' };
    return assets.filter((a) => a.type === typeMap[activeTab]);
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
              <button
                key={asset.id}
                onClick={() => asset.navigateTo && navigate(asset.navigateTo)}
                className="flex flex-col rounded-xl overflow-hidden text-left transition-all active:scale-[0.97]"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
              >
                {/* 缩略图 */}
                <div
                  className="w-full aspect-[4/3] flex items-center justify-center"
                  style={{ background: 'rgba(255,255,255,0.02)' }}
                >
                  {asset.thumbnail ? (
                    <img
                      src={asset.thumbnail}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <Image size={24} style={{ color: 'rgba(255,255,255,0.12)' }} />
                  )}
                </div>
                {/* 信息 */}
                <div className="p-2.5">
                  <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {asset.title}
                  </div>
                  {asset.subtitle && (
                    <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {asset.subtitle}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
