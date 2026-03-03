import { useAssetStore, type AssetTab } from '../../stores/assetStore';

const TABS: { key: AssetTab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '图片' },
  { key: 'document', label: '文档' },
  { key: 'attachment', label: '附件' },
];

interface Props {
  stats: { image: number; document: number; attachment: number };
  total: number;
}

export default function AssetsToolbar({ stats, total }: Props) {
  const { activeTab, setActiveTab, searchQuery, setSearchQuery, sortBy, setSortBy, sortDesc, viewMode, setViewMode, refresh } = useAssetStore();

  return (
    <div className="shrink-0 border-b border-black/8 dark:border-white/8 px-4 py-2.5 flex items-center gap-3 flex-wrap">
      {/* Page title + stats */}
      <div className="flex items-center gap-3 mr-auto">
        <h2 className="text-sm font-semibold text-text-primary">我的资产</h2>
        {total > 0 && (
          <span className="text-[10px] text-text-secondary">
            {stats.image}图 · {stats.document}文档 · {stats.attachment}附件
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center bg-black/[0.04] dark:bg-white/[0.06] rounded-lg p-0.5">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              activeTab === tab.key
                ? 'bg-white dark:bg-white/15 text-text-primary shadow-sm'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative">
        <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-secondary/50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索..."
          className="w-36 pl-8 pr-2 py-1.5 rounded-lg text-xs bg-black/[0.04] dark:bg-white/[0.06] border-0 text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:ring-1 focus:ring-primary-500/30"
        />
      </div>

      {/* Sort dropdown */}
      <div className="flex items-center gap-1">
        {(['date', 'size', 'name'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSortBy(s)}
            className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
              sortBy === s
                ? 'text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-500/10'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {{ date: '时间', size: '大小', name: '名称' }[s]}
            {sortBy === s && (
              <span className="ml-0.5">{sortDesc ? '↓' : '↑'}</span>
            )}
          </button>
        ))}
      </div>

      {/* View toggle */}
      <div className="flex items-center border border-black/8 dark:border-white/8 rounded-lg overflow-hidden">
        <button
          onClick={() => setViewMode('grid')}
          className={`p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-black/[0.06] dark:bg-white/10 text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
          title="网格视图"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
          </svg>
        </button>
        <button
          onClick={() => setViewMode('list')}
          className={`p-1.5 transition-colors ${viewMode === 'list' ? 'bg-black/[0.06] dark:bg-white/10 text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
          title="列表视图"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
          </svg>
        </button>
      </div>

      {/* Refresh */}
      <button
        onClick={refresh}
        className="p-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
        title="刷新"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
        </svg>
      </button>
    </div>
  );
}
