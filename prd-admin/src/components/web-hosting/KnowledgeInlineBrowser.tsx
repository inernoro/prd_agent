import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Clock3, Library, Search } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import {
  MAX_KNOWLEDGE_ENTRY_SELECTIONS,
  createLatestRequestGate,
  knowledgeEntrySelectionKey,
  toggleKnowledgeEntrySelection,
  type KnowledgeEntrySelection,
} from '@/components/knowledge/KnowledgeEntryPicker';
import { listDocumentStoresWithPreview, listKnowledgeEntriesPaged } from '@/services/real/documentStore';
import type { DocumentStoreWithPreview, RecentDocumentEntry } from '@/services/contracts/documentStore';
import { formatAttachmentSize } from './designAttachments';

/**
 * 生成弹窗「引用知识库」页签里的就地浏览器（设计稿 Source-Reference：左栏知识库、右栏搜索 + 勾选）。
 *
 * 选择口径与 KnowledgeEntryPicker 是同一份：同一个 selection key、同一个 1–3 篇上限、
 * 同一个「只交身份不交正文」。区别只是这里不再弹第二层对话框，勾选直接生效。
 */

const RECENT_KEY = '__recent__';
const STORE_PAGE_SIZE = 40;
const ENTRY_PAGE_SIZE = 30;
const KEYWORD_DEBOUNCE_MS = 300;

interface Props {
  recentEntries: RecentDocumentEntry[];
  loadingRecent: boolean;
  selectedEntries: KnowledgeEntrySelection[];
  onChange: (entries: KnowledgeEntrySelection[]) => void;
  disabled?: boolean;
  onLimitReached?: () => void;
}

interface EntryRow {
  selection: KnowledgeEntrySelection;
  meta: string;
}

function formatDay(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日更新`;
}

export default function KnowledgeInlineBrowser({
  recentEntries,
  loadingRecent,
  selectedEntries,
  onChange,
  disabled = false,
  onLimitReached,
}: Props) {
  const [stores, setStores] = useState<DocumentStoreWithPreview[]>([]);
  const [storesLoading, setStoresLoading] = useState(true);
  const [storesError, setStoresError] = useState<string | null>(null);
  const [activeStoreId, setActiveStoreId] = useState<string>(RECENT_KEY);
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [rows, setRows] = useState<EntryRow[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const entryGateRef = useRef(createLatestRequestGate());

  const selectedKeys = useMemo(
    () => new Set(selectedEntries.map(knowledgeEntrySelectionKey)),
    [selectedEntries],
  );

  useEffect(() => {
    let active = true;
    setStoresLoading(true);
    void Promise.all([
      listDocumentStoresWithPreview(1, STORE_PAGE_SIZE, { scope: 'mine' }),
      listDocumentStoresWithPreview(1, STORE_PAGE_SIZE, { scope: 'team' }),
    ]).then(([mine, team]) => {
      if (!active) return;
      const merged = new Map<string, DocumentStoreWithPreview>();
      [mine, team].forEach((result) => {
        if (result.success) result.data.items.forEach((store) => merged.set(store.id, store));
      });
      setStores(Array.from(merged.values()));
      setStoresError(!mine.success && !team.success
        ? (mine.error?.message || '知识库暂时无法读取，请重试')
        : null);
      setStoresLoading(false);
    });
    return () => { active = false; };
  }, []);

  const activeStore = stores.find((store) => store.id === activeStoreId) ?? null;

  const loadEntries = useCallback(async () => {
    if (activeStoreId === RECENT_KEY) {
      const lowered = keyword.toLowerCase();
      setRows(recentEntries
        .filter((item) => !lowered || item.title.toLowerCase().includes(lowered))
        .map((item) => ({
          selection: { entryId: item.id, storeId: item.storeId, title: item.title, storeName: item.storeName },
          meta: [item.storeName, formatDay(item.updatedAt)].filter(Boolean).join(' · '),
        })));
      setRowsError(null);
      return;
    }
    if (!activeStore) return;
    const generation = entryGateRef.current.begin();
    setRowsLoading(true);
    setRowsError(null);
    const result = await listKnowledgeEntriesPaged(activeStore.id, {
      page: 1,
      pageSize: ENTRY_PAGE_SIZE,
      keyword: keyword || undefined,
    });
    if (!entryGateRef.current.isCurrent(generation)) return;
    if (result.success) {
      setRows(result.data.items.map((entry) => ({
        selection: { entryId: entry.id, storeId: activeStore.id, title: entry.title, storeName: activeStore.name },
        meta: [
          entry.fileSize > 0 ? formatAttachmentSize(entry.fileSize) : '',
          formatDay(entry.updatedAt),
        ].filter(Boolean).join(' · '),
      })));
    } else {
      setRows([]);
      setRowsError(result.error?.message || '知识条目暂时无法读取，请重试');
    }
    setRowsLoading(false);
  }, [activeStore, activeStoreId, keyword, recentEntries]);

  // 打字停下就筛：只认回车或失焦时，用户敲完字看到列表纹丝不动，会以为没搜到。
  useEffect(() => {
    const next = keywordInput.trim();
    if (next === keyword) return;
    const timer = window.setTimeout(() => setKeyword(next), KEYWORD_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [keyword, keywordInput]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const toggle = (entry: KnowledgeEntrySelection) => {
    if (disabled) return;
    const result = toggleKnowledgeEntrySelection(selectedEntries, entry);
    if (result.limitReached) {
      onLimitReached?.();
      return;
    }
    onChange(result.entries);
  };

  const chooseStore = (storeId: string) => {
    if (storeId === activeStoreId) return;
    entryGateRef.current.invalidate();
    setActiveStoreId(storeId);
    setKeyword('');
    setKeywordInput('');
    setRows([]);
  };

  const storeButton = (id: string, label: string, count: number | null, icon?: ReactNode) => {
    const active = id === activeStoreId;
    return (
      <button
        key={id}
        type="button"
        aria-pressed={active}
        onClick={() => chooseStore(id)}
        className="flex min-h-10 w-full items-center justify-between gap-2 rounded-[10px] px-3 py-2 text-left text-[13px] transition-colors hover-bg-soft focus-visible:outline-none focus-visible:ring-2"
        style={{
          background: active ? 'var(--selection-bg)' : undefined,
          color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
          fontWeight: active ? 600 : 400,
        }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {icon}
          <span className="truncate">{label}</span>
        </span>
        {count != null && <span className="shrink-0 text-[12px] tabular-nums text-token-muted">{count}</span>}
      </button>
    );
  };

  return (
    <div className="grid h-full min-h-0 min-w-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden md:grid-cols-[240px_minmax(0,1fr)] md:grid-rows-1">
      <div
        className="flex min-h-0 min-w-0 flex-col gap-1 overflow-y-auto p-3 max-md:max-h-40 max-md:border-b md:border-r"
        style={{ borderColor: 'var(--border-subtle)' }}
        aria-label="我能看到的知识库"
      >
        <div className="px-2 pb-1.5 pt-1 text-[12px] tracking-wide text-token-muted">我能看到的知识库</div>
        {storeButton(RECENT_KEY, '最近使用', loadingRecent ? null : recentEntries.length, <Clock3 size={13} className="shrink-0" />)}
        {storesLoading ? (
          <MapSectionLoader text="正在读取知识库" />
        ) : storesError ? (
          <p className="px-2 py-2 text-[12px]" style={{ color: 'var(--semantic-danger-text)' }}>{storesError}</p>
        ) : stores.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-token-muted">还没有可引用的知识库，可改用「直接上传」。</p>
        ) : (
          stores.map((store) => storeButton(store.id, store.name, store.documentCount))
        )}
      </div>

      <div className="flex min-h-0 min-w-0 flex-col">
        <form
          className="mx-4 mb-1.5 mt-3.5 flex h-10 shrink-0 items-center gap-2 rounded-[10px] px-3"
          style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
          onSubmit={(event) => { event.preventDefault(); setKeyword(keywordInput.trim()); }}
        >
          <Search size={15} className="shrink-0 text-token-muted" />
          <label className="sr-only" htmlFor="design-knowledge-search">搜索知识</label>
          <input
            id="design-knowledge-search"
            value={keywordInput}
            onChange={(event) => setKeywordInput(event.target.value)}
            onBlur={() => setKeyword(keywordInput.trim())}
            placeholder={activeStoreId === RECENT_KEY ? '在最近使用里搜索标题' : `搜索「${activeStore?.name ?? '当前知识库'}」`}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-token-primary outline-none placeholder:text-token-muted"
          />
        </form>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" style={{ overscrollBehavior: 'contain' }}>
          {(activeStoreId === RECENT_KEY ? loadingRecent : rowsLoading) ? (
            <MapSectionLoader text="正在读取知识条目" />
          ) : rowsError ? (
            <p className="p-4 text-center text-[12px]" style={{ color: 'var(--semantic-danger-text)' }}>{rowsError}</p>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-6 text-center">
              <Library size={22} className="text-token-muted" />
              <p className="text-[12px] text-token-muted">
                {keyword ? '没有匹配的知识，换个关键词试试。' : activeStoreId === RECENT_KEY ? '最近没有用过的知识，从左侧挑一个知识库。' : '这个知识库暂时没有可引用的条目。'}
              </p>
            </div>
          ) : (
            rows.map(({ selection, meta }) => {
              const key = knowledgeEntrySelectionKey(selection);
              const checked = selectedKeys.has(key);
              const blocked = !checked && selectedEntries.length >= MAX_KNOWLEDGE_ENTRY_SELECTIONS;
              return (
                <button
                  key={key}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  disabled={disabled}
                  onClick={() => toggle(selection)}
                  title={`${selection.storeName} / ${selection.title}`}
                  className="flex w-full items-center gap-3 rounded-[10px] px-2.5 py-3 text-left transition-colors hover-bg-soft disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2"
                  style={{
                    background: checked ? 'var(--bg-card-hover)' : undefined,
                    opacity: blocked ? 0.55 : undefined,
                  }}
                >
                  <span
                    className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px]"
                    style={{
                      background: checked ? 'var(--accent-primary)' : 'transparent',
                      border: `1.5px solid ${checked ? 'var(--accent-primary)' : 'var(--border-strong)'}`,
                      color: 'var(--accent-on-primary)',
                    }}
                  >
                    {checked && <Check size={12} strokeWidth={3} />}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className={`truncate text-[14px] ${checked ? 'font-medium' : ''} text-token-primary`}>{selection.title}</span>
                    {meta && <span className="truncate text-[12px] text-token-muted">{meta}</span>}
                  </span>
                  {checked && (
                    <span className="shrink-0 text-[12px]" style={{ color: 'var(--semantic-success-text)' }}>已选</span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
