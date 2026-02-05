/**
 * 通用配置管理对话框基础组件
 *
 * 设计原则：
 * - 支持 N 栏布局，由调用者定义每栏内容
 * - 统一处理"我的"/"海鲜市场"标签切换
 * - 统一处理搜索、排序、分类筛选
 * - 调用者提供每栏的渲染函数和数据加载逻辑
 *
 * 使用示例：
 * - 文学创作：3栏（提示词、风格图、水印）
 * - 视觉创作：1栏（水印）
 */

import React, { useState, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Search, TrendingUp, Clock, Globe, User, Store } from 'lucide-react';

// ============ 类型定义 ============

export type ViewMode = 'mine' | 'marketplace';
export type SortOption = 'hot' | 'new';

/** 单栏配置 */
export interface ConfigColumn<TMarketplaceItem = unknown> {
  /** 唯一标识 */
  key: string;
  /** 栏标题 */
  title: string;
  /** 海鲜市场筛选标签 */
  filterLabel: string;

  // ---- "我的" 视图 ----
  /** 渲染"我的"内容区域 */
  renderMineContent: (ctx: MineContentContext) => React.ReactNode;
  /** 标题右侧操作按钮（如"新增配置"） */
  titleAction?: React.ReactNode;

  // ---- "海鲜市场" 视图 ----
  /** 加载海鲜市场数据，返回 items 数组 */
  loadMarketplace?: (params: { keyword?: string; sort: SortOption }) => Promise<TMarketplaceItem[]>;
  /** 渲染海鲜市场卡片 */
  renderMarketplaceCard?: (item: TMarketplaceItem, ctx: MarketplaceCardContext) => React.ReactNode;
}

/** "我的"内容渲染上下文 */
export interface MineContentContext {
  saving: boolean;
  setSaving: (v: boolean) => void;
  /** 切换到"我的"视图（用于 Fork 后切换） */
  switchToMine: () => void;
  /** 触发重新加载"我的"数据（由调用者实现） */
  reloadMine?: () => void;
}

/** 海鲜市场卡片渲染上下文 */
export interface MarketplaceCardContext {
  saving: boolean;
  forkingId: string | null;
  onFork: (id: string, forkFn: () => Promise<boolean>) => Promise<void>;
}

/** 对话框句柄 */
export interface ConfigManagementDialogHandle {
  open: () => void;
  close: () => void;
  /** 切换到指定视图 */
  setViewMode: (mode: ViewMode) => void;
}

/** 对话框 Props */
export interface ConfigManagementDialogBaseProps {
  /** 栏配置数组 */
  columns: ConfigColumn<any>[];
  /** 对话框标题（"我的"视图时） */
  mineTitle?: string;
  /** 对话框标题（"海鲜市场"视图时） */
  marketplaceTitle?: string;
  /** 对话框描述（"我的"视图时） */
  mineDescription?: string;
  /** 对话框描述（"海鲜市场"视图时） */
  marketplaceDescription?: string;
  /** 最大宽度 */
  maxWidth?: number;
  /** 是否在"我的"视图显示分隔线（多栏时默认 true） */
  showColumnDividers?: boolean;
  /** "我的"数据加载函数（打开/切换到"我的"时调用） */
  onLoadMine?: () => Promise<void>;
  /** 是否显示海鲜市场标签（默认 true，如果所有栏都没有 loadMarketplace 则自动隐藏） */
  showMarketplaceTab?: boolean;
}

// ============ 常量 ============

const VIEW_TABS: { key: ViewMode; label: string; icon: React.ReactNode }[] = [
  { key: 'mine', label: '我的', icon: <User size={14} /> },
  { key: 'marketplace', label: '海鲜市场', icon: <Globe size={14} /> },
];

const SORT_OPTIONS: { key: SortOption; label: string; icon: React.ReactNode }[] = [
  { key: 'hot', label: '热门', icon: <TrendingUp size={12} /> },
  { key: 'new', label: '最新', icon: <Clock size={12} /> },
];

// ============ 组件实现 ============

export const ConfigManagementDialogBase = forwardRef<ConfigManagementDialogHandle, ConfigManagementDialogBaseProps>(
  function ConfigManagementDialogBase(props, ref) {
    const {
      columns,
      mineTitle = '配置管理',
      marketplaceTitle = '海鲜市场',
      mineDescription,
      marketplaceDescription = '发现和下载社区分享的配置',
      maxWidth = 1200,
      showColumnDividers = columns.length > 1,
      onLoadMine,
      showMarketplaceTab: showMarketplaceTabProp,
    } = props;

    // 判断是否有海鲜市场功能
    const hasMarketplace = columns.some((col) => col.loadMarketplace);
    const showMarketplaceTab = showMarketplaceTabProp ?? hasMarketplace;

    // 状态
    const [open, setOpen] = useState(false);
    const [viewMode, setViewMode] = useState<ViewMode>('mine');
    const [searchKeyword, setSearchKeyword] = useState('');
    const [sortBy, setSortBy] = useState<SortOption>('hot');
    const [categoryFilter, setCategoryFilter] = useState<string>('all');
    const [saving, setSaving] = useState(false);
    const [forkingId, setForkingId] = useState<string | null>(null);

    // 海鲜市场数据：每栏独立存储
    const [marketplaceData, setMarketplaceData] = useState<Record<string, unknown[]>>({});
    const [marketplaceLoading, setMarketplaceLoading] = useState(false);

    // 暴露方法
    useImperativeHandle(ref, () => ({
      open: () => setOpen(true),
      close: () => setOpen(false),
      setViewMode,
    }));

    // 加载海鲜市场数据
    const loadMarketplace = useCallback(async () => {
      setMarketplaceLoading(true);
      const results: Record<string, unknown[]> = {};
      try {
        await Promise.all(
          columns.map(async (col) => {
            if (col.loadMarketplace) {
              const items = await col.loadMarketplace({ keyword: searchKeyword || undefined, sort: sortBy });
              results[col.key] = items;
            }
          })
        );
        setMarketplaceData(results);
      } finally {
        setMarketplaceLoading(false);
      }
    }, [columns, searchKeyword, sortBy]);

    // 打开时加载数据
    useEffect(() => {
      if (open) {
        if (viewMode === 'mine') {
          void onLoadMine?.();
        } else {
          void loadMarketplace();
        }
      }
    }, [open, viewMode, onLoadMine, loadMarketplace]);

    // 切换到海鲜市场时重新加载
    useEffect(() => {
      if (open && viewMode === 'marketplace') {
        void loadMarketplace();
      }
    }, [open, viewMode, searchKeyword, sortBy, loadMarketplace]);

    // Fork 操作
    const handleFork = async (id: string, forkFn: () => Promise<boolean>) => {
      setForkingId(id);
      try {
        const success = await forkFn();
        if (success) {
          setViewMode('mine');
          void onLoadMine?.();
        }
      } finally {
        setForkingId(null);
      }
    };

    // 渲染上下文
    const mineContext: MineContentContext = {
      saving,
      setSaving,
      switchToMine: () => setViewMode('mine'),
      reloadMine: onLoadMine,
    };

    const marketplaceCardContext: MarketplaceCardContext = {
      saving,
      forkingId,
      onFork: handleFork,
    };

    // 生成分类筛选选项
    const categoryOptions = [
      { key: 'all', label: '全部' },
      ...columns.filter((col) => col.loadMarketplace).map((col) => ({ key: col.key, label: col.filterLabel })),
    ];

    // 渲染"我的"视图
    const renderMineView = () => {
      return (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-full min-h-0">
          {columns.map((col, idx) => (
            <div
              key={col.key}
              className={`min-h-0 flex flex-col h-full ${showColumnDividers && idx > 0 ? 'border-l pl-4' : ''}`}
              style={showColumnDividers && idx > 0 ? { borderColor: 'var(--border-subtle)' } : undefined}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {col.title}
                </div>
                {col.titleAction}
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">{col.renderMineContent(mineContext)}</div>
            </div>
          ))}
        </div>
      );
    };

    // 渲染海鲜市场视图
    const renderMarketplaceView = () => {
      // 根据分类筛选
      const visibleColumns =
        categoryFilter === 'all' ? columns.filter((col) => col.loadMarketplace) : columns.filter((col) => col.key === categoryFilter && col.loadMarketplace);

      return (
        <div className="flex flex-col h-full min-h-0">
          {/* 搜索和筛选栏 */}
          <div className="flex items-center gap-4 mb-4 flex-shrink-0 relative z-10 flex-wrap">
            {/* 搜索框 */}
            <div className="relative flex-1 max-w-xs min-w-[200px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
              <input
                type="text"
                placeholder="搜索配置名称..."
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                className="w-full h-8 pl-9 pr-3 rounded-lg text-sm"
                style={{
                  background: 'var(--input-bg)',
                  border: '1px solid var(--border-default)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>
            {/* 分类筛选 */}
            {categoryOptions.length > 2 && (
              <div className="flex items-center gap-1">
                {categoryOptions.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setCategoryFilter(opt.key)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      categoryFilter === opt.key ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-white/5'
                    }`}
                    style={{ color: categoryFilter === opt.key ? undefined : 'var(--text-muted)' }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
            {/* 排序 */}
            <div className="flex items-center gap-1">
              {SORT_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setSortBy(opt.key)}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    sortBy === opt.key ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-white/5'
                  }`}
                  style={{ color: sortBy === opt.key ? undefined : 'var(--text-muted)' }}
                >
                  {opt.icon}
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {marketplaceLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-sm" style={{ color: 'var(--text-muted)' }}>加载中...</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0 overflow-auto">
              {visibleColumns.map((col, idx) => {
                const items = (marketplaceData[col.key] || []) as unknown[];
                return (
                  <div
                    key={col.key}
                    className={`min-h-0 flex flex-col ${idx > 0 ? 'border-l pl-4' : ''}`}
                    style={idx > 0 ? { borderColor: 'var(--border-subtle)' } : undefined}
                  >
                    <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                      {col.title}
                    </div>
                    {items.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-12 gap-3">
                        <Store size={32} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
                        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          暂无公开的{col.filterLabel}
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-3 overflow-auto">
                        {items.map((item: any) => col.renderMarketplaceCard?.(item, marketplaceCardContext))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    };

    return (
      <Dialog
        open={open}
        onOpenChange={(newOpen) => {
          setOpen(newOpen);
          if (!newOpen) {
            // 关闭时重置
            setViewMode('mine');
            setSearchKeyword('');
            setCategoryFilter('all');
          }
        }}
        title={
          <div className="flex items-center gap-2">
            {viewMode === 'mine' ? <User size={18} /> : <Globe size={18} />}
            <span>{viewMode === 'mine' ? mineTitle : marketplaceTitle}</span>
          </div>
        }
        description={viewMode === 'mine' ? mineDescription : marketplaceDescription}
        maxWidth={maxWidth}
        contentClassName="overflow-hidden !p-4"
        contentStyle={{ maxHeight: '75vh', height: '75vh' }}
        content={
          <div className="flex flex-col h-full min-h-0">
            {/* Tab 切换 */}
            {showMarketplaceTab && (
              <div className="flex items-center gap-2 mb-4 flex-shrink-0 border-b pb-3" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="flex items-center gap-2">
                  {VIEW_TABS.map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setViewMode(tab.key)}
                      className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                        viewMode === tab.key ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-white/5 text-gray-400'
                      }`}
                    >
                      {tab.icon}
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 内容区 */}
            <div className="flex-1 min-h-0">{viewMode === 'mine' ? renderMineView() : renderMarketplaceView()}</div>
          </div>
        }
      />
    );
  }
);
