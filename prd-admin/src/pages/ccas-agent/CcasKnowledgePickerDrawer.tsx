import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Search, BookOpen, Folder, FileText, RefreshCw, AlertCircle, ExternalLink,
  CheckCircle2, Square, ChevronDown, ChevronRight,
} from 'lucide-react';
import {
  listMyKnowledgeStores,
  listKnowledgeEntries,
} from '@/services';
import type { CcasKnowledgeStore, CcasKnowledgeEntry } from '@/services';
import { Button } from '@/components/design/Button';

/**
 * 知识库选择抽屉。
 * 复用现有 document-store（左侧导航「知识库」），不新建模块。
 *
 * 业务规则：
 *   - 列空间：当前用户拥有的全部空间，按「appKey === 'ccas-agent'」优先排序
 *   - 列条目：默认隐藏文件夹（`isFolder=true`）；空间内支持关键词搜索（标题+摘要+内容索引）
 *   - 支持整库引用与单篇引用；整库引用在后端展开成空间内文档并统一去重
 *   - 字符 → token 估算：1 token ≈ 1.5 中文字符（粗估），用于显示进度条
 */

/** 估算 token：粗略按 1.5 字符/token（中文 1，英文 ~3 字符/token，混合大致这个值） */
const CHARS_PER_TOKEN = 1.5;
/** 与后端 ReferenceTotalBudget 一致 */
const TOTAL_BUDGET_CHARS = 120000;

interface Props {
  open: boolean;
  onClose: () => void;
  /** 已选条目摘要快照（用于 PRD Tab 上显示选中文字数 + 抽屉打开时回填） */
  selectedSnapshot: SelectedEntrySnapshot[];
  onConfirm: (selected: SelectedEntrySnapshot[]) => void;
  /** 当前关联模式中文名（如「瓶箱垛」），用于自动预选有此 tag 的条目 */
  associationModeLabel?: string;
}

export interface SelectedEntrySnapshot {
  kind: 'store' | 'entry';
  entryId?: string;
  storeId: string;
  storeName: string;
  title: string;
  approxChars: number;
  documentCount?: number;
}

export function CcasKnowledgePickerDrawer({
  open,
  onClose,
  selectedSnapshot,
  onConfirm,
  associationModeLabel,
}: Props) {
  const [stores, setStores] = useState<CcasKnowledgeStore[]>([]);
  const [storesLoading, setStoresLoading] = useState(false);
  const [storesError, setStoresError] = useState<string | null>(null);

  const [expandedStoreIds, setExpandedStoreIds] = useState<Set<string>>(new Set());
  const [entriesByStore, setEntriesByStore] = useState<Record<string, { items: CcasKnowledgeEntry[]; loading: boolean; error: string | null }>>({});

  const [keyword, setKeyword] = useState('');

  // 本地选择状态：用 Map 保留快照（包括标题、字符数）
  const [pendingSelected, setPendingSelected] = useState<Map<string, SelectedEntrySnapshot>>(new Map());

  // 打开抽屉时回填已选
  useEffect(() => {
    if (open) {
      const m = new Map<string, SelectedEntrySnapshot>();
      selectedSnapshot.forEach((s) => m.set(selectionKey(s), normalizeSnapshot(s)));
      setPendingSelected(m);
    }
  }, [open, selectedSnapshot]);

  // 加载空间列表
  const loadStores = useCallback(async () => {
    setStoresLoading(true);
    setStoresError(null);
    const res = await listMyKnowledgeStores();
    setStoresLoading(false);
    if (res.success && res.data) {
      // 排序：appKey === ccas-agent 优先 → 私人空间 → 公开空间；同档按 updatedAt 倒序
      const sorted = [...res.data.items].sort((a, b) => {
        const aIsCcas = a.appKey === 'ccas-agent' ? 0 : 1;
        const bIsCcas = b.appKey === 'ccas-agent' ? 0 : 1;
        if (aIsCcas !== bIsCcas) return aIsCcas - bIsCcas;
        const aPub = a.isPublic ? 1 : 0;
        const bPub = b.isPublic ? 1 : 0;
        if (aPub !== bPub) return aPub - bPub;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
      setStores(sorted);
      // 默认展开第一个空间
      if (sorted.length > 0) {
        setExpandedStoreIds(new Set([sorted[0].id]));
      }
    } else {
      setStoresError(res.error?.message || '加载知识库列表失败');
    }
  }, []);

  useEffect(() => {
    if (open && stores.length === 0) loadStores();
  }, [open, stores.length, loadStores]);

  const loadEntries = useCallback(async (storeId: string, kw?: string) => {
    setEntriesByStore((prev) => ({ ...prev, [storeId]: { items: prev[storeId]?.items ?? [], loading: true, error: null } }));
    const res = await listKnowledgeEntries(storeId, kw);
    if (res.success && res.data) {
      // 隐藏文件夹
      const items = res.data.items.filter((e) => !e.isFolder);
      setEntriesByStore((prev) => ({ ...prev, [storeId]: { items, loading: false, error: null } }));
    } else {
      setEntriesByStore((prev) => ({
        ...prev,
        [storeId]: { items: prev[storeId]?.items ?? [], loading: false, error: res.error?.message || '加载条目失败' },
      }));
    }
  }, []);

  // 展开空间时按需加载
  useEffect(() => {
    expandedStoreIds.forEach((storeId) => {
      if (!entriesByStore[storeId]) loadEntries(storeId, keyword || undefined);
    });
  }, [expandedStoreIds, entriesByStore, loadEntries, keyword]);

  // 关键词变化：重新加载所有已展开空间的条目
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      expandedStoreIds.forEach((storeId) => loadEntries(storeId, keyword || undefined));
    }, 280);
    return () => clearTimeout(t);
  }, [keyword]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleStoreExpanded = useCallback((storeId: string) => {
    setExpandedStoreIds((prev) => {
      const next = new Set(prev);
      if (next.has(storeId)) next.delete(storeId);
      else next.add(storeId);
      return next;
    });
  }, []);

  const toggleStoreSelection = useCallback((store: CcasKnowledgeStore) => {
    const key = storeSelectionKey(store.id);
    setPendingSelected((prev) => {
      const next = new Map(prev);
      if (next.has(key)) {
        next.delete(key);
        return next;
      }

      // 整库引用覆盖该空间下的单篇引用，避免后端重复注入。
      for (const [selectedKey, selected] of next) {
        if (selected.kind === 'entry' && selected.storeId === store.id) {
          next.delete(selectedKey);
        }
      }
      next.set(key, {
        kind: 'store',
        storeId: store.id,
        storeName: store.name,
        title: store.name,
        approxChars: estimateStoreChars(store),
        documentCount: store.documentCount,
      });
      return next;
    });
  }, []);

  const toggleEntry = useCallback((store: CcasKnowledgeStore, entry: CcasKnowledgeEntry) => {
    setPendingSelected((prev) => {
      const next = new Map(prev);
      const key = entrySelectionKey(entry.id);
      if (next.has(key)) {
        next.delete(key);
      } else {
        // 单篇引用会取消同空间的整库引用，让用户可以从粗粒度切回精确选择。
        next.delete(storeSelectionKey(store.id));
        next.set(key, {
          kind: 'entry',
          entryId: entry.id,
          storeId: store.id,
          storeName: store.name,
          title: entry.title,
          // FileSize 是字节数，按内容字符的粗略估算：UTF-8 中文 3 字节 ≈ 1 字符；英文/markdown 1 字节 ≈ 1 字符
          // 这里取个中间值 ÷ 2，避免过度低估
          approxChars: Math.min(8000, Math.max(200, Math.round((entry.fileSize ?? 4000) / 2))),
        });
      }
      return next;
    });
  }, []);

  const totalChars = useMemo(
    () => Array.from(pendingSelected.values()).reduce((sum, s) => sum + s.approxChars, 0),
    [pendingSelected]
  );
  const totalCharsCapped = Math.min(totalChars, TOTAL_BUDGET_CHARS);
  const overBudget = totalChars > TOTAL_BUDGET_CHARS;

  const onConfirmClick = useCallback(() => {
    onConfirm(Array.from(pendingSelected.values()));
    onClose();
  }, [pendingSelected, onConfirm, onClose]);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const drawer = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        className="rounded-xl border border-white/10 bg-[#0f1014] flex flex-col shadow-2xl"
        style={{ width: '90vw', maxWidth: 980, height: '85vh', maxHeight: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="shrink-0 px-5 py-3 border-b border-white/10 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-amber-300" />
            <h2 className="text-sm font-semibold text-white">引用知识库</h2>
            <span className="text-[11px] text-white/40">
              已选 {pendingSelected.size} 个来源
            </span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10 text-white/60">
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* 搜索 + 提示 */}
        <div className="shrink-0 px-5 py-2 border-b border-white/10 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/40" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索条目标题、摘要、正文（已展开的空间会自动过滤）"
              className="w-full pl-7 pr-2 py-1.5 rounded-md bg-black/30 border border-white/15 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-amber-400/50"
            />
          </div>
          <Button variant="ghost" onClick={loadStores} className="!h-8 !px-2 !text-[11px]">
            <RefreshCw className="w-3 h-3 mr-1" /> 刷新空间
          </Button>
          <a
            href="/document-store"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-amber-300/80 hover:text-amber-300"
            title="到知识库页面新建空间或上传文档"
          >
            <ExternalLink className="w-3 h-3" /> 管理知识库
          </a>
        </div>

        {/* 提示 */}
        {associationModeLabel && (
          <div className="shrink-0 px-5 py-1.5 text-[11px] text-amber-300/70 bg-amber-500/5 border-b border-white/10">
            提示：在知识库的空间或条目上加 <code className="px-1 rounded bg-black/40">ccas-agent</code> 或
            <code className="px-1 rounded bg-black/40 ml-1">{associationModeLabel}</code> tag，会优先排在前面。
          </div>
        )}

        {/* 空间列表 + 条目 */}
        <div
          className="flex-1 px-5 py-3"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {storesLoading && stores.length === 0 ? (
            <div className="text-center text-sm text-white/40 py-12">加载中…</div>
          ) : storesError ? (
            <div className="text-center text-sm text-red-300/80 py-12 flex items-center justify-center gap-1.5">
              <AlertCircle className="w-4 h-4" /> {storesError}
            </div>
          ) : stores.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-sm text-white/50 mb-2">暂无任何知识库空间</div>
              <div className="text-xs text-white/35">
                请先到「左侧导航 → 知识库」创建一个空间，上传 .md/.docx/.pdf 文档，或者订阅 GitHub 仓库
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {stores.map((store) => {
                const isExpanded = expandedStoreIds.has(store.id);
                const entriesState = entriesByStore[store.id];
                return (
                  <section
                    key={store.id}
                    className="rounded-lg border border-white/10 bg-white/5 overflow-hidden"
                  >
                    <header
                      className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-white/5 select-none"
                      onClick={() => toggleStoreExpanded(store.id)}
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5 text-white/60" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 text-white/60" />
                      )}
                      <Folder className="w-3.5 h-3.5 text-amber-300/70 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-white truncate">{store.name}</div>
                        {store.description && (
                          <div className="text-[11px] text-white/40 truncate">{store.description}</div>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-white/45">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleStoreSelection(store);
                          }}
                          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border transition ${
                            pendingSelected.has(storeSelectionKey(store.id))
                              ? 'bg-amber-500/15 border-amber-400/40 text-amber-200'
                              : 'bg-white/5 border-white/10 text-white/55 hover:text-white/80'
                          }`}
                          title="选择整个知识库，后端会展开该空间内所有可读文档并按上下文预算注入"
                        >
                          {pendingSelected.has(storeSelectionKey(store.id)) ? (
                            <CheckCircle2 className="w-3 h-3" />
                          ) : (
                            <Square className="w-3 h-3" />
                          )}
                          整库
                        </button>
                        {store.appKey === 'ccas-agent' && (
                          <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-200/85">赋码</span>
                        )}
                        {store.isPublic && (
                          <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300/80">公开</span>
                        )}
                        <span>{store.documentCount} 条</span>
                      </div>
                    </header>

                    {isExpanded && (
                      <div className="border-t border-white/5 bg-black/20">
                        {entriesState?.loading ? (
                          <div className="px-3 py-3 text-center text-xs text-white/40">加载条目中…</div>
                        ) : entriesState?.error ? (
                          <div className="px-3 py-3 text-center text-xs text-red-300/70">
                            {entriesState.error}
                          </div>
                        ) : !entriesState?.items.length ? (
                          <div className="px-3 py-3 text-center text-xs text-white/35">该空间暂无可引用文档</div>
                        ) : (
                          <ul className="divide-y divide-white/5">
                            {entriesState.items.map((entry) => {
                              const checked = pendingSelected.has(storeSelectionKey(store.id)) || pendingSelected.has(entrySelectionKey(entry.id));
                              return (
                                <li
                                  key={entry.id}
                                  onClick={() => toggleEntry(store, entry)}
                                  className={`px-3 py-1.5 flex items-start gap-2 cursor-pointer transition ${
                                    checked ? 'bg-amber-500/8 hover:bg-amber-500/12' : 'hover:bg-white/5'
                                  }`}
                                >
                                  <div className="pt-0.5">
                                    {checked ? (
                                      <CheckCircle2 className="w-3.5 h-3.5 text-amber-400" />
                                    ) : (
                                      <Square className="w-3.5 h-3.5 text-white/40" />
                                    )}
                                  </div>
                                  <FileText className="w-3.5 h-3.5 text-white/40 shrink-0 mt-0.5" />
                                  <div className="flex-1 min-w-0">
                                    <div className="text-xs text-white truncate" title={entry.title}>
                                      {entry.title}
                                    </div>
                                    {entry.summary && (
                                      <div className="text-[11px] text-white/40 truncate">{entry.summary}</div>
                                    )}
                                    {entry.tags && entry.tags.length > 0 && (
                                      <div className="flex flex-wrap gap-1 mt-0.5">
                                        {entry.tags.slice(0, 5).map((t) => (
                                          <span
                                            key={t}
                                            className="text-[10px] px-1 rounded bg-white/5 text-white/55"
                                          >
                                            {t}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                  <div className="text-[10px] text-white/35 shrink-0 pt-0.5">
                                    ~{Math.round(((entry.fileSize ?? 4000) / 2) / 1000)}k 字
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>

        {/* 预算条 + 操作 */}
        <footer className="shrink-0 px-5 py-3 border-t border-white/10 flex flex-col gap-2">
          <div className="flex items-center justify-between text-[11px] text-white/55">
            <span>
              已选 <span className="text-white">{pendingSelected.size}</span> 个来源 · 约{' '}
              <span className={overBudget ? 'text-orange-400' : 'text-white'}>{totalChars.toLocaleString()}</span>{' '}
              字符 ≈ <span className="text-white/70">{Math.round(totalChars / CHARS_PER_TOKEN).toLocaleString()}</span>{' '}
              tokens / 上下文预算{' '}
              <span className="text-white/70">{TOTAL_BUDGET_CHARS.toLocaleString()}</span> 字符
            </span>
            {overBudget && (
              <span className="text-[10px] text-orange-300/85">超出预算的部分会按选中顺序裁剪</span>
            )}
          </div>
          <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
            <div
              className={`h-full transition-all ${overBudget ? 'bg-orange-400/70' : 'bg-amber-400/70'}`}
              style={{ width: `${Math.min(100, (totalCharsCapped / TOTAL_BUDGET_CHARS) * 100)}%` }}
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={onClose} className="!h-8 !px-3 !text-xs">
              取消
            </Button>
            <Button variant="primary" onClick={onConfirmClick} className="!h-8 !px-3 !text-xs">
              确定（{pendingSelected.size}）
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );

  return createPortal(drawer, document.body);
}
function entrySelectionKey(entryId: string) {
  return `entry:${entryId}`;
}

function storeSelectionKey(storeId: string) {
  return `store:${storeId}`;
}

function selectionKey(snapshot: SelectedEntrySnapshot) {
  return snapshot.kind === 'store'
    ? storeSelectionKey(snapshot.storeId)
    : entrySelectionKey(snapshot.entryId ?? snapshot.storeId);
}

function normalizeSnapshot(snapshot: SelectedEntrySnapshot): SelectedEntrySnapshot {
  return {
    ...snapshot,
    kind: snapshot.kind ?? 'entry',
  };
}

function estimateStoreChars(store: CcasKnowledgeStore) {
  // 整库引用的真实字符数以后端读取正文为准，这里只做抽屉里的预算提示。
  return Math.max(2000, store.documentCount * 4000);
}
