import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, ChevronLeft, ChevronRight, Library, Search, X } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import {
  listDocumentStoresWithPreview,
  listKnowledgeEntriesPaged,
} from '@/services/real/documentStore';
import type {
  DocumentEntry,
  DocumentStoreWithPreview,
  RecentDocumentEntry,
} from '@/services/contracts/documentStore';

export const MAX_KNOWLEDGE_ENTRY_SELECTIONS = 3;
const STORE_PAGE_SIZE = 12;
const ENTRY_PAGE_SIZE = 12;

export interface KnowledgeEntrySelection {
  entryId: string;
  storeId: string;
  title: string;
  storeName: string;
}

export function knowledgeEntrySelectionKey(entry: Pick<KnowledgeEntrySelection, 'entryId' | 'storeId'>) {
  return `${entry.storeId}:${entry.entryId}`;
}

export function recentKnowledgeToSelection(entry: RecentDocumentEntry): KnowledgeEntrySelection {
  return {
    entryId: entry.id,
    storeId: entry.storeId,
    title: entry.title,
    storeName: entry.storeName,
  };
}

export function toggleKnowledgeEntrySelection(
  selected: readonly KnowledgeEntrySelection[],
  entry: KnowledgeEntrySelection,
  limit = MAX_KNOWLEDGE_ENTRY_SELECTIONS,
): { entries: KnowledgeEntrySelection[]; limitReached: boolean } {
  const key = knowledgeEntrySelectionKey(entry);
  const alreadySelected = selected.some((item) => knowledgeEntrySelectionKey(item) === key);
  if (alreadySelected) {
    return {
      entries: selected.filter((item) => knowledgeEntrySelectionKey(item) !== key),
      limitReached: false,
    };
  }
  if (selected.length >= limit) return { entries: [...selected], limitReached: true };
  return { entries: [...selected, entry], limitReached: false };
}

export function createLatestRequestGate() {
  let generation = 0;
  return {
    begin: () => ++generation,
    isCurrent: (requestGeneration: number) => requestGeneration === generation,
    invalidate: () => { generation += 1; },
  };
}

export function knowledgeSelectionContextChanged(currentId: string | null, nextId: string) {
  return currentId !== nextId;
}

export function resolveKnowledgeSearchAction(
  currentKeyword: string,
  currentPage: number,
  nextKeyword: string,
  loading: boolean,
): 'change' | 'reload' | 'noop' {
  if (currentPage !== 1 || currentKeyword !== nextKeyword) return 'change';
  return loading ? 'noop' : 'reload';
}

type StoreScope = 'mine' | 'team';

interface PagedStores {
  items: DocumentStoreWithPreview[];
  total: number;
}

interface PagedEntries {
  items: DocumentEntry[];
  total: number;
}

type StoreLoader = typeof listDocumentStoresWithPreview;
type EntryLoader = typeof listKnowledgeEntriesPaged;

interface Props {
  recentEntries: RecentDocumentEntry[];
  selectedEntries: KnowledgeEntrySelection[];
  onChange: (entries: KnowledgeEntrySelection[]) => void;
  loadingRecent?: boolean;
  disabled?: boolean;
  compact?: boolean;
  loadStores?: StoreLoader;
  loadEntries?: EntryLoader;
}

export default function KnowledgeEntryPicker({
  recentEntries,
  selectedEntries,
  onChange,
  loadingRecent = false,
  disabled = false,
  compact = false,
  loadStores = listDocumentStoresWithPreview,
  loadEntries = listKnowledgeEntriesPaged,
}: Props) {
  const [browserOpen, setBrowserOpen] = useState(false);
  const [draftEntries, setDraftEntries] = useState<KnowledgeEntrySelection[]>([]);
  const [scope, setScope] = useState<StoreScope>('mine');
  const [storePage, setStorePage] = useState(1);
  const [stores, setStores] = useState<PagedStores>({ items: [], total: 0 });
  const [storesLoading, setStoresLoading] = useState(false);
  const [storesError, setStoresError] = useState<string | null>(null);
  const [selectedStore, setSelectedStore] = useState<DocumentStoreWithPreview | null>(null);
  const [entryPage, setEntryPage] = useState(1);
  const [entryKeywordInput, setEntryKeywordInput] = useState('');
  const [entryKeyword, setEntryKeyword] = useState('');
  const [entries, setEntries] = useState<PagedEntries>({ items: [], total: 0 });
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const storeRequestGateRef = useRef(createLatestRequestGate());
  const entryRequestGateRef = useRef(createLatestRequestGate());

  const selectedKeys = useMemo(
    () => new Set(selectedEntries.map(knowledgeEntrySelectionKey)),
    [selectedEntries],
  );
  const draftKeys = useMemo(
    () => new Set(draftEntries.map(knowledgeEntrySelectionKey)),
    [draftEntries],
  );

  const loadStorePage = useCallback(async () => {
    const requestGeneration = storeRequestGateRef.current.begin();
    setStoresLoading(true);
    setStoresError(null);
    try {
      const result = await loadStores(storePage, STORE_PAGE_SIZE, { scope });
      if (!storeRequestGateRef.current.isCurrent(requestGeneration)) return;
      if (result.success) {
        setStores({ items: result.data.items, total: result.data.total });
      } else {
        setStores({ items: [], total: 0 });
        setStoresError(result.error?.message || '知识库暂时无法读取，请重试。');
      }
    } catch {
      if (!storeRequestGateRef.current.isCurrent(requestGeneration)) return;
      setStores({ items: [], total: 0 });
      setStoresError('知识库暂时无法读取，请重试。');
    } finally {
      if (storeRequestGateRef.current.isCurrent(requestGeneration)) setStoresLoading(false);
    }
  }, [loadStores, scope, storePage]);

  const loadEntryPage = useCallback(async () => {
    if (!selectedStore) return;
    const requestGeneration = entryRequestGateRef.current.begin();
    setEntriesLoading(true);
    setEntriesError(null);
    try {
      const result = await loadEntries(selectedStore.id, {
        page: entryPage,
        pageSize: ENTRY_PAGE_SIZE,
        keyword: entryKeyword || undefined,
      });
      if (!entryRequestGateRef.current.isCurrent(requestGeneration)) return;
      if (result.success) {
        setEntries({ items: result.data.items, total: result.data.total });
      } else {
        setEntries({ items: [], total: 0 });
        setEntriesError(result.error?.message || '知识条目暂时无法读取，请重试。');
      }
    } catch {
      if (!entryRequestGateRef.current.isCurrent(requestGeneration)) return;
      setEntries({ items: [], total: 0 });
      setEntriesError('知识条目暂时无法读取，请重试。');
    } finally {
      if (entryRequestGateRef.current.isCurrent(requestGeneration)) setEntriesLoading(false);
    }
  }, [entryKeyword, entryPage, loadEntries, selectedStore]);

  useEffect(() => {
    if (!browserOpen) return;
    const requestGate = storeRequestGateRef.current;
    void loadStorePage();
    return () => requestGate.invalidate();
  }, [browserOpen, loadStorePage]);

  useEffect(() => {
    if (!browserOpen || !selectedStore) return;
    const requestGate = entryRequestGateRef.current;
    void loadEntryPage();
    return () => requestGate.invalidate();
  }, [browserOpen, loadEntryPage, selectedStore]);

  const openBrowser = () => {
    setDraftEntries([...selectedEntries]);
    setScope('mine');
    setStorePage(1);
    setSelectedStore(null);
    setEntryPage(1);
    setEntryKeywordInput('');
    setEntryKeyword('');
    setStores({ items: [], total: 0 });
    setEntries({ items: [], total: 0 });
    setStoresError(null);
    setEntriesError(null);
    setBrowserOpen(true);
  };

  const closeBrowser = () => {
    storeRequestGateRef.current.invalidate();
    entryRequestGateRef.current.invalidate();
    setBrowserOpen(false);
  };

  const toggleCommitted = (entry: KnowledgeEntrySelection) => {
    const result = toggleKnowledgeEntrySelection(selectedEntries, entry);
    if (result.limitReached) return;
    onChange(result.entries);
  };

  const toggleDraft = (entry: KnowledgeEntrySelection) => {
    const result = toggleKnowledgeEntrySelection(draftEntries, entry);
    setDraftEntries(result.entries);
  };

  const selectScope = (nextScope: StoreScope) => {
    if (!knowledgeSelectionContextChanged(scope, nextScope)) return;
    storeRequestGateRef.current.invalidate();
    entryRequestGateRef.current.invalidate();
    setScope(nextScope);
    setStorePage(1);
    setSelectedStore(null);
    setEntries({ items: [], total: 0 });
    setEntriesError(null);
  };

  const chooseStore = (store: DocumentStoreWithPreview) => {
    if (!knowledgeSelectionContextChanged(selectedStore?.id ?? null, store.id)) return;
    entryRequestGateRef.current.invalidate();
    setSelectedStore(store);
    setEntryPage(1);
    setEntryKeywordInput('');
    setEntryKeyword('');
    setEntries({ items: [], total: 0 });
    setEntriesError(null);
  };

  const searchEntries = () => {
    const nextKeyword = entryKeywordInput.trim();
    const action = resolveKnowledgeSearchAction(entryKeyword, entryPage, nextKeyword, entriesLoading);
    if (action === 'noop') return;
    if (action === 'reload') {
      void loadEntryPage();
      return;
    }
    entryRequestGateRef.current.invalidate();
    setEntryPage(1);
    setEntryKeyword(nextKeyword);
  };

  const storePageCount = Math.max(1, Math.ceil(stores.total / STORE_PAGE_SIZE));
  const entryPageCount = Math.max(1, Math.ceil(entries.total / ENTRY_PAGE_SIZE));

  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-[11px] text-token-primary">
        <span className="flex items-center gap-1.5 font-medium"><BookOpen size={13} />引用知识</span>
        <span className="text-token-muted">{selectedEntries.length}/{MAX_KNOWLEDGE_ENTRY_SELECTIONS}</span>
      </div>

      {selectedEntries.length > 0 && (
        <div className="mt-2 space-y-1" aria-label="已选择的知识">
          {selectedEntries.map((entry) => (
            <div
              key={knowledgeEntrySelectionKey(entry)}
              className="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-blue-500/40 bg-blue-500/10 px-2.5 py-1.5 text-xs"
            >
              <span className="min-w-0 truncate text-token-primary" title={`${entry.storeName} / ${entry.title}`}>
                <span className="text-token-muted">{entry.storeName}</span>
                <span aria-hidden="true"> / </span>
                {entry.title}
              </span>
              <button
                type="button"
                aria-label={`取消引用 ${entry.storeName} / ${entry.title}`}
                disabled={disabled}
                onClick={() => toggleCommitted(entry)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-token-secondary transition-colors hover-bg-soft disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className={`mt-2 flex items-center gap-2 ${compact ? 'overflow-x-auto' : 'flex-wrap'}`}>
        <Button
          type="button"
          size="xs"
          variant="secondary"
          disabled={disabled}
          onClick={openBrowser}
          className="min-h-11 shrink-0"
        >
          <Library size={13} />
          <span className="ml-1.5">浏览我的与团队知识</span>
        </Button>
        <span className="shrink-0 text-[10px] text-token-muted">也可从最近使用中快捷选择</span>
      </div>

      {loadingRecent ? (
        <div className="mt-2"><MapSectionLoader text="正在读取最近知识" /></div>
      ) : recentEntries.length === 0 ? (
        <p className="mt-2 text-[10px] text-token-muted">最近没有知识，仍可浏览我的与团队知识库。</p>
      ) : (
        <div className={`mt-2 flex gap-1.5 overflow-x-auto ${compact ? '' : 'flex-wrap sm:max-h-28 sm:overflow-y-auto'}`} aria-label="最近使用的知识">
          {recentEntries.map((item) => {
            const entry = recentKnowledgeToSelection(item);
            const selected = selectedKeys.has(knowledgeEntrySelectionKey(entry));
            return (
              <button
                key={knowledgeEntrySelectionKey(entry)}
                type="button"
                aria-pressed={selected}
                disabled={disabled || (!selected && selectedEntries.length >= MAX_KNOWLEDGE_ENTRY_SELECTIONS)}
                onClick={() => toggleCommitted(entry)}
                title={`${item.storeName} / ${item.title}`}
                className={`flex min-h-11 max-w-56 shrink-0 items-center gap-1 rounded-md border px-2 text-xs transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${selected ? 'border-blue-500 bg-blue-500/10 text-blue-500' : 'border-token-subtle text-token-secondary hover-bg-soft'}`}
              >
                <span className="truncate">{item.storeName} / {item.title}</span>
                {selected && <Check size={12} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}

      <Dialog
        open={browserOpen}
        onOpenChange={(next) => { if (!next) closeBrowser(); }}
        title="选择知识条目"
        description="按知识库浏览或搜索单篇知识。只会引用你有读取权限的条目。"
        maxWidth={920}
        zIndex={220}
        contentClassName="p-3 sm:p-5"
        contentStyle={{
          width: 'min(920px, calc(100vw - 16px))',
          maxWidth: 'calc(100vw - 16px)',
          height: 'min(700px, calc(100vh - 24px))',
        }}
        content={(
          <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="flex shrink-0 items-center gap-2 overflow-x-auto" aria-label="知识库范围">
              {([
                ['mine', '我的知识库'],
                ['team', '团队知识库'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={scope === value}
                  onClick={() => selectScope(value)}
                  className={`min-h-11 shrink-0 rounded-lg border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${scope === value ? 'border-blue-500 bg-blue-500/10 text-blue-500' : 'border-token-subtle text-token-secondary hover-bg-soft'}`}
                >
                  {label}
                </button>
              ))}
              <span className="ml-auto shrink-0 text-xs text-token-muted">已选 {draftEntries.length}/{MAX_KNOWLEDGE_ENTRY_SELECTIONS}</span>
            </div>

            {draftEntries.length > 0 && (
              <div className="flex shrink-0 gap-1.5 overflow-x-auto" aria-label="本次待确认的知识">
                {draftEntries.map((entry) => (
                  <button
                    key={knowledgeEntrySelectionKey(entry)}
                    type="button"
                    onClick={() => toggleDraft(entry)}
                    title={`取消选择 ${entry.storeName} / ${entry.title}`}
                    className="flex min-h-11 max-w-60 shrink-0 items-center gap-1.5 rounded-lg border border-blue-500/35 bg-blue-500/10 px-2.5 text-xs text-token-primary transition-colors hover:bg-blue-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  >
                    <span className="truncate">{entry.storeName} / {entry.title}</span>
                    <X size={12} className="shrink-0" />
                  </button>
                ))}
              </div>
            )}

            <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
              <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-token-subtle bg-token-nested" aria-label="知识库列表">
                <div className="shrink-0 border-b border-token-subtle px-3 py-2 text-xs font-semibold text-token-primary">
                  {scope === 'mine' ? '我的知识库' : '团队知识库'}
                </div>
                <div className="min-h-0 flex-1" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
                  {storesLoading ? (
                    <MapSectionLoader text="正在读取知识库" />
                  ) : storesError ? (
                    <div className="p-4 text-center" role="alert">
                      <p className="text-xs text-rose-500">{storesError}</p>
                      <Button className="mt-3 min-h-11" size="xs" variant="secondary" onClick={() => void loadStorePage()}>重试</Button>
                    </div>
                  ) : stores.items.length === 0 ? (
                    <div className="p-4 text-center">
                      <Library size={24} className="mx-auto text-token-muted" />
                      <p className="mt-2 text-xs text-token-muted">此范围暂时没有可浏览的知识库。</p>
                    </div>
                  ) : (
                    <div className="space-y-1 p-2">
                      {stores.items.map((store) => (
                        <button
                          key={store.id}
                          type="button"
                          aria-pressed={selectedStore?.id === store.id}
                          onClick={() => chooseStore(store)}
                          className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${selectedStore?.id === store.id ? 'bg-blue-500/10 text-blue-500' : 'text-token-secondary hover-bg-soft'}`}
                        >
                          <span className="min-w-0 truncate text-xs font-medium">{store.name}</span>
                          <span className="shrink-0 text-[10px] text-token-muted">{store.documentCount} 篇</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <Pagination
                  label="知识库"
                  page={storePage}
                  pageCount={storePageCount}
                  loading={storesLoading}
                  onPageChange={setStorePage}
                />
              </section>

              <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-token-subtle bg-token-nested" aria-label="知识条目列表">
                {selectedStore ? (
                  <>
                    <form
                      className="flex shrink-0 gap-2 border-b border-token-subtle p-2"
                      onSubmit={(event) => { event.preventDefault(); searchEntries(); }}
                    >
                      <label className="sr-only" htmlFor="knowledge-entry-picker-search">搜索当前知识库</label>
                      <div className="relative min-w-0 flex-1">
                        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-token-muted" />
                        <input
                          id="knowledge-entry-picker-search"
                          value={entryKeywordInput}
                          onChange={(event) => setEntryKeywordInput(event.target.value)}
                          placeholder={`搜索 ${selectedStore.name}`}
                          className="min-h-11 w-full rounded-lg border border-token-subtle bg-token-card pl-9 pr-3 text-base text-token-primary outline-none focus:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500 sm:text-xs"
                        />
                      </div>
                      <Button type="submit" size="xs" variant="secondary" className="min-h-11 shrink-0" disabled={entriesLoading}>
                        {entriesLoading ? <MapSpinner size={14} /> : <Search size={14} />}
                        <span className="ml-1.5">搜索</span>
                      </Button>
                    </form>
                    <div className="min-h-0 flex-1" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
                      {entriesLoading ? (
                        <MapSectionLoader text="正在读取知识条目" />
                      ) : entriesError ? (
                        <div className="p-4 text-center" role="alert">
                          <p className="text-xs text-rose-500">{entriesError}</p>
                          <Button className="mt-3 min-h-11" size="xs" variant="secondary" onClick={() => void loadEntryPage()}>重试</Button>
                        </div>
                      ) : entries.items.length === 0 ? (
                        <div className="p-4 text-center">
                          <Search size={24} className="mx-auto text-token-muted" />
                          <p className="mt-2 text-xs text-token-muted">{entryKeyword ? '没有匹配的知识条目，可换个关键词。' : '这个知识库暂时没有可引用条目。'}</p>
                        </div>
                      ) : (
                        <div className="space-y-1 p-2">
                          {entries.items.map((entry) => {
                            const selection: KnowledgeEntrySelection = {
                              entryId: entry.id,
                              storeId: selectedStore.id,
                              title: entry.title,
                              storeName: selectedStore.name,
                            };
                            const selected = draftKeys.has(knowledgeEntrySelectionKey(selection));
                            const selectionDisabled = !selected && draftEntries.length >= MAX_KNOWLEDGE_ENTRY_SELECTIONS;
                            return (
                              <button
                                key={knowledgeEntrySelectionKey(selection)}
                                type="button"
                                aria-pressed={selected}
                                disabled={selectionDisabled}
                                onClick={() => toggleDraft(selection)}
                                title={`${selectedStore.name} / ${entry.title}`}
                                className={`flex min-h-11 w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${selected ? 'border-blue-500 bg-blue-500/10' : 'border-transparent text-token-secondary hover-bg-soft'}`}
                              >
                                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${selected ? 'border-blue-500 bg-blue-500 text-white' : 'border-token-subtle'}`}>
                                  {selected && <Check size={13} />}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-xs text-token-primary">
                                  <span className="text-token-muted">{selectedStore.name}</span>
                                  <span aria-hidden="true"> / </span>
                                  {entry.title}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <Pagination
                      label="知识条目"
                      page={entryPage}
                      pageCount={entryPageCount}
                      loading={entriesLoading}
                      onPageChange={setEntryPage}
                    />
                  </>
                ) : (
                  <div className="flex min-h-52 flex-1 items-center justify-center p-6 text-center">
                    <div>
                      <BookOpen size={28} className="mx-auto text-token-muted" />
                      <p className="mt-3 text-sm font-medium text-token-primary">先选择一个知识库</p>
                      <p className="mt-1 text-xs text-token-muted">随后可浏览分页条目，或只搜索这个库里的知识。</p>
                    </div>
                  </div>
                )}
              </section>
            </div>

            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-token-subtle pt-3">
              <Button type="button" size="sm" variant="secondary" className="min-h-11" onClick={closeBrowser}>取消</Button>
              <Button
                type="button"
                size="sm"
                variant="primary"
                className="min-h-11"
                onClick={() => { onChange([...draftEntries]); closeBrowser(); }}
              >
                确认引用 {draftEntries.length} 篇
              </Button>
            </div>
          </div>
        )}
      />
    </div>
  );
}

function Pagination({
  label,
  page,
  pageCount,
  loading,
  onPageChange,
}: {
  label: string;
  page: number;
  pageCount: number;
  loading: boolean;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-t border-token-subtle px-2 py-1.5">
      <button
        type="button"
        aria-label={`上一页${label}`}
        disabled={loading || page <= 1}
        onClick={() => onPageChange(page - 1)}
        className="flex h-11 w-11 items-center justify-center rounded-lg text-token-secondary transition-colors hover-bg-soft disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <ChevronLeft size={16} />
      </button>
      <span className="text-[10px] tabular-nums text-token-muted">第 {page} / {pageCount} 页</span>
      <button
        type="button"
        aria-label={`下一页${label}`}
        disabled={loading || page >= pageCount}
        onClick={() => onPageChange(page + 1)}
        className="flex h-11 w-11 items-center justify-center rounded-lg text-token-secondary transition-colors hover-bg-soft disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
