/**
 * 产品管理智能体 — 知识库模块外壳（4 Tab：知识列表 / 分类管理 / 文件夹管理 / 标签管理）。
 *
 * 单产品知识库的统一入口：find-or-create 产品 store → 顶部 Tab 切换。
 * 知识列表为默认 tab（分页 + 多维筛选 + 行操作）；三个管理 tab 治理分类/文件夹/标签。
 * 数据约定：知识统一存在产品库，条目用 versionIds 关联版本（版本中只「调取」，不新增）。
 */
import { useCallback, useEffect, useState } from 'react';
import { List, Layers, FolderTree, Tags } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getDocumentStore, updateDocumentStore, listDocumentEntries } from '@/services';
import type { DocumentStore, DocumentEntry } from '@/services/contracts/documentStore';
import { getProductKnowledgeStore, listVersions } from '@/services/real/productAgent';
import type { ProductVersion } from '../types';
import { KNOWLEDGE_CATEGORY_NAMES } from '../types';
import { KnowledgeListTab } from './KnowledgeListTab';
import { CategoryManagerTab, FolderManagerTab, TagManagerTab } from './managers';
import '../product-cards.css';

type KnowledgeTab = 'list' | 'category' | 'folder' | 'tag';

const TABS: { key: KnowledgeTab; label: string; icon: typeof List }[] = [
  { key: 'list', label: '知识列表', icon: List },
  { key: 'category', label: '分类管理', icon: Layers },
  { key: 'folder', label: '文件夹管理', icon: FolderTree },
  { key: 'tag', label: '标签管理', icon: Tags },
];

export function KnowledgeModule({ productId }: { productId: string }) {
  const [storeId, setStoreId] = useState<string | null>(null);
  const [store, setStore] = useState<DocumentStore | null>(null);
  const [versions, setVersions] = useState<ProductVersion[]>([]);
  const [allEntries, setAllEntries] = useState<DocumentEntry[]>([]);
  const [tab, setTab] = useState<KnowledgeTab>('list');
  const [loading, setLoading] = useState(true);

  // facets/管理 tab 全量数据（产品库规模可控，500 上限够用）
  const reloadAllEntries = useCallback(async (sid: string) => {
    const res = await listDocumentEntries(sid, 1, 500);
    if (res.success) setAllEntries(res.data.items);
  }, []);

  const reloadStore = useCallback(async (sid: string) => {
    const res = await getDocumentStore(sid);
    if (res.success) setStore(res.data);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      const res = await getProductKnowledgeStore(productId);
      if (!alive) return;
      if (!res.success || !res.data) { setLoading(false); return; }
      const sid = res.data.id;
      setStoreId(sid);
      const [storeRes, verRes] = await Promise.all([
        getDocumentStore(sid),
        listVersions(productId),
        reloadAllEntries(sid),
      ]);
      if (!alive) return;
      if (storeRes.success) {
        let s = storeRes.data;
        // 首次进入种子化预置分类（与旧 DocumentStoreBrowser 行为一致）
        if ((s.categories?.length ?? 0) === 0) {
          const up = await updateDocumentStore(sid, { categories: KNOWLEDGE_CATEGORY_NAMES });
          if (up.success) s = up.data;
        }
        if (alive) setStore(s);
      }
      if (verRes.success) setVersions(verRes.data.items);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [productId, reloadAllEntries]);

  // 子 tab 任何变更后的统一刷新（facets + store 分类清单）
  const handleChanged = useCallback(() => {
    if (!storeId) return;
    void reloadAllEntries(storeId);
    void reloadStore(storeId);
  }, [storeId, reloadAllEntries, reloadStore]);

  if (loading) return <MapSectionLoader text="正在准备知识库…" />;
  if (!storeId) return <div className="text-sm text-white/40 text-center py-10">知识库加载失败</div>;

  return (
    <div className="h-full min-h-0 flex flex-col gap-3 p-4">
      <div className="shrink-0 flex items-center gap-1" data-tour-id="knowledge-tabs">
        {TABS.map((t) => {
          const Icon = t.icon;
          const on = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border ${on ? 'bg-cyan-500/15 text-cyan-200 border-cyan-500/30' : 'text-white/50 border-transparent hover:bg-white/5 hover:text-white/80'}`}
            >
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {tab === 'list' && (
          <KnowledgeListTab
            storeId={storeId}
            productId={productId}
            store={store}
            versions={versions}
            allEntries={allEntries}
            onChanged={handleChanged}
          />
        )}
        {tab === 'category' && (
          <CategoryManagerTab store={store} allEntries={allEntries} onChanged={handleChanged} />
        )}
        {tab === 'folder' && (
          <FolderManagerTab storeId={storeId} allEntries={allEntries} onChanged={handleChanged} />
        )}
        {tab === 'tag' && (
          <TagManagerTab allEntries={allEntries} onChanged={handleChanged} />
        )}
      </div>
    </div>
  );
}
