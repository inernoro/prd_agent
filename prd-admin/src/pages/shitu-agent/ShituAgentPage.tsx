import { useEffect, useMemo, useState } from 'react';
import {
  Compass, AlertCircle, Heart, AlertTriangle, FileText, Award,
  MessageSquare, BookOpen,
} from 'lucide-react';
import { getShituMeta } from '@/services';
import type { ShituCategoryKey, ShituMeta, ShituTabMeta } from '@/services';
import { TabBar } from '@/components/design/TabBar';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { ShituQaTab } from './ShituQaTab';
import { ShituKnowledgePanel } from './ShituKnowledgePanel';

type SubView = 'qa' | 'knowledge';

const CATEGORY_ICONS: Record<ShituCategoryKey, React.ReactNode> = {
  culture: <Heart className="w-4 h-4" />,
  incident: <AlertTriangle className="w-4 h-4" />,
  policy: <FileText className="w-4 h-4" />,
  award: <Award className="w-4 h-4" />,
};

export function ShituAgentPage() {
  const [meta, setMeta] = useState<ShituMeta | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [categoryKey, setCategoryKey] = useState<ShituCategoryKey>('culture');
  const [subView, setSubView] = useState<SubView>('qa');
  const [activeModel, setActiveModel] = useState<{ name?: string; platform?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setMetaLoading(true);
      const res = await getShituMeta();
      if (cancelled) return;
      if (res.success && res.data) {
        setMeta(res.data);
        setMetaError(null);
        if (res.data.tabs.length > 0) {
          setCategoryKey(res.data.tabs[0].key);
        }
      } else {
        setMetaError(res.error?.message || '元数据加载失败');
      }
      setMetaLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const activeTab = useMemo(
    () => meta?.tabs.find((t) => t.key === categoryKey) ?? meta?.tabs[0] ?? null,
    [meta, categoryKey],
  );

  const handleCategoryChange = (key: string) => {
    setCategoryKey(key as ShituCategoryKey);
    setActiveModel(null);
  };

  const categoryTabs = (meta?.tabs ?? []).map((t: ShituTabMeta) => ({
    key: t.key,
    label: t.label,
    icon: CATEGORY_ICONS[t.key],
  }));

  const subTabs = [
    { key: 'qa', label: '问答', icon: <MessageSquare className="w-4 h-4" /> },
    { key: 'knowledge', label: '知识库', icon: <BookOpen className="w-4 h-4" /> },
  ];

  return (
    <div className="h-full min-h-0 flex flex-col gap-4 px-6 py-5 overflow-hidden">
      <header className="shrink-0 flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-sky-500/10 border border-sky-400/20 flex items-center justify-center">
          <Compass className="w-5 h-5 text-sky-300" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold text-white truncate">识途</h1>
            {activeModel?.name && (
              <span className="text-[11px] text-white/40 font-mono shrink-0">
                ● {activeModel.name}
                {activeModel.platform ? ` · ${activeModel.platform}` : ''}
              </span>
            )}
          </div>
          <p className="text-xs text-white/50 truncate">
            {activeTab?.description ?? '新人文化与制度问答 — 企业文化 / 事故教训 / 规章制度 / 奖赏表彰'}
          </p>
        </div>
      </header>

      <div className="shrink-0 flex flex-col gap-2">
        {categoryTabs.length > 0 && (
          <TabBar items={categoryTabs} activeKey={categoryKey} onChange={handleCategoryChange} />
        )}
        <TabBar items={subTabs} activeKey={subView} onChange={(k) => setSubView(k as SubView)} />
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {metaLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <MapSectionLoader />
          </div>
        ) : metaError ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-sm text-red-300/80 flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              元数据加载失败：{metaError}
            </div>
          </div>
        ) : activeTab ? (
          subView === 'qa' ? (
            <ShituQaTab
              key={categoryKey}
              categoryKey={activeTab.key}
              categoryLabel={activeTab.label}
              storeId={activeTab.storeId}
              exampleQuestions={activeTab.exampleQuestions}
              onModelChange={setActiveModel}
            />
          ) : (
            <ShituKnowledgePanel
              key={`kb-${categoryKey}`}
              storeId={activeTab.storeId}
              canWrite={meta?.canManageKnowledge ?? false}
              categoryLabel={activeTab.label}
            />
          )
        ) : null}
      </div>
    </div>
  );
}
