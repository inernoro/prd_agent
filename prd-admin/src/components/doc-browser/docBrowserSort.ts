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
