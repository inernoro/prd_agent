export type DocBrowserSortMode = 'default' | 'created-desc' | 'updated-desc';

export interface SortableDocBrowserEntry {
  id: string;
  title: string;
  isFolder: boolean;
  sortOrder?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface DocBrowserSortOptions {
  mode: DocBrowserSortMode;
  primaryEntryId?: string;
  pinnedEntryIds?: ReadonlySet<string>;
}

const NATURAL_TITLE_COLLATOR = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base',
});

function timestampOf(entry: SortableDocBrowserEntry, field: 'createdAt' | 'updatedAt'): number {
  const value = entry[field];
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function compareManualOrder(a: SortableDocBrowserEntry, b: SortableDocBrowserEntry): number {
  const aHasOrder = Number.isFinite(a.sortOrder);
  const bHasOrder = Number.isFinite(b.sortOrder);
  if (aHasOrder && bHasOrder && a.sortOrder !== b.sortOrder) {
    return (a.sortOrder as number) - (b.sortOrder as number);
  }
  if (aHasOrder !== bHasOrder) return aHasOrder ? -1 : 1;
  return NATURAL_TITLE_COLLATOR.compare(a.title, b.title);
}

export function compareDocBrowserEntries(
  a: SortableDocBrowserEntry,
  b: SortableDocBrowserEntry,
  options: DocBrowserSortOptions,
): number {
  const pinned = options.pinnedEntryIds ?? new Set<string>();
  const aPinned = pinned.has(a.id) || a.id === options.primaryEntryId;
  const bPinned = pinned.has(b.id) || b.id === options.primaryEntryId;
  if (aPinned !== bPinned) return aPinned ? -1 : 1;
  if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
  if (a.id === options.primaryEntryId) return -1;
  if (b.id === options.primaryEntryId) return 1;

  if (options.mode === 'created-desc') {
    const difference = timestampOf(b, 'createdAt') - timestampOf(a, 'createdAt');
    if (difference !== 0) return difference;
  } else if (options.mode === 'updated-desc') {
    const difference = timestampOf(b, 'updatedAt') - timestampOf(a, 'updatedAt');
    if (difference !== 0) return difference;
  } else {
    return compareManualOrder(a, b);
  }

  return NATURAL_TITLE_COLLATOR.compare(a.title, b.title);
}

export function sortDocBrowserEntries<T extends SortableDocBrowserEntry>(
  entries: readonly T[],
  options: DocBrowserSortOptions,
): T[] {
  return [...entries].sort((a, b) => compareDocBrowserEntries(a, b, options));
}

// ── 拖拽自定义排序（书籍顺序模式）──

export interface DocBrowserReorderUpdate {
  entryId: string;
  sortOrder: number;
}

const REORDER_STEP = 10;

/**
 * 计算把 draggedId 拖到 targetId 的 before/after 位置后需要写回的 SortOrder 更新。
 *
 * 输入 orderedSiblings 必须是「同一父级、当前视觉顺序」的非文件夹条目列表。
 * 策略：优先只给被拖条目写一个「两侧邻居中点」的 sortOrder（一次 PUT）；
 * 当邻居缺 sortOrder / 中点撞值（double 精度耗尽或相等）时，退化为整组重编号
 * （10, 20, 30…），仅返回 sortOrder 发生变化的条目。
 */
export function computeReorderUpdates<T extends SortableDocBrowserEntry>(
  orderedSiblings: readonly T[],
  draggedId: string,
  targetId: string,
  position: 'before' | 'after',
): DocBrowserReorderUpdate[] {
  if (draggedId === targetId) return [];
  const dragged = orderedSiblings.find(e => e.id === draggedId);
  const withoutDragged = orderedSiblings.filter(e => e.id !== draggedId);
  const targetIdx = withoutDragged.findIndex(e => e.id === targetId);
  if (targetIdx < 0) return [];

  const insertIdx = position === 'before' ? targetIdx : targetIdx + 1;
  const nextOrder: SortableDocBrowserEntry[] = [
    ...withoutDragged.slice(0, insertIdx),
    dragged ?? { id: draggedId, title: '', isFolder: false },
    ...withoutDragged.slice(insertIdx),
  ];

  // 快路径：两侧邻居都有可用 sortOrder（或位于头/尾）时，只写被拖条目一个中点值
  const prev = insertIdx > 0 ? withoutDragged[insertIdx - 1] : undefined;
  const next = insertIdx < withoutDragged.length ? withoutDragged[insertIdx] : undefined;
  const prevOrder = prev && Number.isFinite(prev.sortOrder) ? (prev.sortOrder as number) : undefined;
  const nextOrder2 = next && Number.isFinite(next.sortOrder) ? (next.sortOrder as number) : undefined;

  let single: number | undefined;
  if (prev === undefined && next !== undefined && nextOrder2 !== undefined) {
    single = nextOrder2 - REORDER_STEP;
  } else if (next === undefined && prev !== undefined && prevOrder !== undefined) {
    single = prevOrder + REORDER_STEP;
  } else if (prevOrder !== undefined && nextOrder2 !== undefined && prevOrder < nextOrder2) {
    const mid = (prevOrder + nextOrder2) / 2;
    if (mid > prevOrder && mid < nextOrder2) single = mid;
  }
  if (single !== undefined) {
    return dragged?.sortOrder === single ? [] : [{ entryId: draggedId, sortOrder: single }];
  }

  // 慢路径：整组按新视觉顺序重编号，只回传发生变化的条目
  const updates: DocBrowserReorderUpdate[] = [];
  nextOrder.forEach((e, idx) => {
    const want = (idx + 1) * REORDER_STEP;
    if (e.sortOrder !== want) updates.push({ entryId: e.id, sortOrder: want });
  });
  return updates;
}
