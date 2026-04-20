import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  listDocumentStoresWithPreview,
  listChangelogReportSources,
  deleteChangelogReportSource,
} from '@/services';
import type { DocumentStore } from '@/services/contracts/documentStore';
import type { ChangelogReportSource } from '@/services/real/changelog';
import { toast } from '@/lib/toast';

export const ACTIVE_SOURCE_KEY = 'weekly-reports-active-source';

interface WeeklyReportSourcesValue {
  sources: ChangelogReportSource[] | null;
  loadingSources: boolean;
  activeSource: ChangelogReportSource | null;
  activeId: string | null;
  stores: DocumentStore[];
  loadingStores: boolean;
  onSelect: (id: string) => void;
  onCreateOpen: () => void;
  onEditOpen: (src: ChangelogReportSource) => void;
  onDelete: (src: ChangelogReportSource) => Promise<void>;
  editorOpen: boolean;
  editorTarget: ChangelogReportSource | null;
  closeEditor: () => void;
  onSaved: (saved: ChangelogReportSource, isNew: boolean) => void;
}

const Ctx = createContext<WeeklyReportSourcesValue | null>(null);

export function WeeklyReportSourcesProvider({ children }: { children: ReactNode }) {
  const [sources, setSources] = useState<ChangelogReportSource[] | null>(null);
  const [loadingSources, setLoadingSources] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stores, setStores] = useState<DocumentStore[]>([]);
  const [loadingStores, setLoadingStores] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<ChangelogReportSource | null>(null);

  useEffect(() => {
    let alive = true;
    setLoadingSources(true);
    listChangelogReportSources()
      .then(res => {
        if (!alive) return;
        if (res.success) {
          setSources(res.data);
          const saved = sessionStorage.getItem(ACTIVE_SOURCE_KEY);
          const savedHit = saved && res.data.find(s => s.id === saved);
          setActiveId(savedHit ? savedHit.id : (res.data[0]?.id ?? null));
        } else {
          setSources([]);
          toast.error('加载周报来源失败', res.error?.message);
        }
      })
      .finally(() => { if (alive) setLoadingSources(false); });

    setLoadingStores(true);
    listDocumentStoresWithPreview(1, 200)
      .then(res => {
        if (!alive) return;
        if (res.success) setStores(res.data.items);
      })
      .finally(() => { if (alive) setLoadingStores(false); });

    return () => { alive = false; };
  }, []);

  const activeSource = useMemo(
    () => sources?.find(s => s.id === activeId) ?? null,
    [sources, activeId],
  );

  const onSelect = useCallback((id: string) => {
    setActiveId(id);
    sessionStorage.setItem(ACTIVE_SOURCE_KEY, id);
  }, []);

  const onCreateOpen = useCallback(() => {
    setEditorTarget(null);
    setEditorOpen(true);
  }, []);

  const onEditOpen = useCallback((src: ChangelogReportSource) => {
    setEditorTarget(src);
    setEditorOpen(true);
  }, []);

  const onDelete = useCallback(async (src: ChangelogReportSource) => {
    if (!window.confirm(`确定删除周报来源「${src.name}」？此操作不会影响知识库数据。`)) return;
    const res = await deleteChangelogReportSource(src.id);
    if (!res.success) {
      toast.error('删除失败', res.error?.message);
      return;
    }
    toast.success('已删除');
    setSources(prev => {
      const next = (prev ?? []).filter(s => s.id !== src.id);
      setActiveId(cur => {
        if (cur !== src.id) return cur;
        const fallback = next[0]?.id ?? null;
        if (fallback) sessionStorage.setItem(ACTIVE_SOURCE_KEY, fallback);
        else sessionStorage.removeItem(ACTIVE_SOURCE_KEY);
        return fallback;
      });
      return next;
    });
  }, []);

  const closeEditor = useCallback(() => setEditorOpen(false), []);

  const onSaved = useCallback((saved: ChangelogReportSource, isNew: boolean) => {
    setSources(prev => {
      const base = prev ?? [];
      if (isNew) return [...base, saved];
      return base.map(s => (s.id === saved.id ? saved : s));
    });
    if (isNew) {
      setActiveId(saved.id);
      sessionStorage.setItem(ACTIVE_SOURCE_KEY, saved.id);
    }
    setEditorOpen(false);
  }, []);

  const value: WeeklyReportSourcesValue = {
    sources,
    loadingSources,
    activeSource,
    activeId,
    stores,
    loadingStores,
    onSelect,
    onCreateOpen,
    onEditOpen,
    onDelete,
    editorOpen,
    editorTarget,
    closeEditor,
    onSaved,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWeeklyReportSources(): WeeklyReportSourcesValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWeeklyReportSources 必须在 WeeklyReportSourcesProvider 内部调用');
  return v;
}
