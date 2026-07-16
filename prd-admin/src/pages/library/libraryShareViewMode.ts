import {
  sortDocBrowserEntries,
  type DocBrowserSortMode,
  type SortableDocBrowserEntry,
} from '@/components/doc-browser/docBrowserSort';

export type LibraryShareViewMode = 'read' | 'galaxy' | 'universe';
export type LibraryShareSortParam = 'book' | 'created' | 'updated';

export interface SharedWikilinkEntry {
  id: string;
  title: string;
  isFolder?: boolean;
}

export interface SharedWikilinkTarget {
  entryId?: string;
  title?: string;
}

export interface InitialSharedEntryOptions {
  entryFromUrl: string | null;
  sharedEntryId?: string;
  primaryEntryId?: string;
  sortMode: DocBrowserSortMode;
}

export function buildOwnedDocumentStorePath(storeId: string): string {
  const normalized = storeId.trim();
  if (!normalized) return '/document-store';
  const params = new URLSearchParams({ store: normalized });
  return `/document-store?${params.toString()}`;
}

export function resolveControlledSharedEntryId(
  selectedEntryId: string | undefined,
  initialSelectedId: string | undefined,
  hasEntryParam: boolean,
): string | undefined {
  if (hasEntryParam && initialSelectedId) return initialSelectedId;
  return selectedEntryId ?? initialSelectedId;
}

export function parseLibraryShareViewMode(raw: string | null, isSingleDoc: boolean): LibraryShareViewMode {
  const mode: LibraryShareViewMode = raw === 'galaxy' || raw === 'universe' ? raw : 'read';
  return isSingleDoc && mode !== 'read' ? 'read' : mode;
}

export function withLibraryShareViewMode(params: URLSearchParams, mode: LibraryShareViewMode): URLSearchParams {
  const next = new URLSearchParams(params);
  if (mode === 'read') next.delete('view');
  else next.set('view', mode);
  return next;
}

export function withLibraryShareEntry(params: URLSearchParams, entryId: string): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set('entry', entryId);
  next.delete('view');
  return next;
}

export function resolveLibraryShareSortMode(
  raw: string | null,
  hasManualOrder: boolean,
): DocBrowserSortMode {
  if (raw === 'book') return 'default';
  if (raw === 'created') return 'created-desc';
  if (raw === 'updated') return 'updated-desc';
  return hasManualOrder ? 'default' : 'created-desc';
}

export function withLibraryShareSortMode(
  params: URLSearchParams,
  mode: DocBrowserSortMode,
): URLSearchParams {
  const next = new URLSearchParams(params);
  const value: LibraryShareSortParam = mode === 'default'
    ? 'book'
    : mode === 'created-desc'
      ? 'created'
      : 'updated';
  next.set('sort', value);
  return next;
}

export function resolveInitialSharedEntryId<T extends SortableDocBrowserEntry>(
  entries: readonly T[],
  options: InitialSharedEntryOptions,
): string | undefined {
  const documents = entries.filter((entry) => !entry.isFolder);
  const deepLink = options.entryFromUrl?.trim();
  if (deepLink && documents.some((entry) => entry.id === deepLink)) return deepLink;
  if (options.sharedEntryId && documents.some((entry) => entry.id === options.sharedEntryId)) {
    return options.sharedEntryId;
  }
  if (documents.length === 0) return undefined;

  if (options.sortMode === 'default'
      && options.primaryEntryId
      && documents.some((entry) => entry.id === options.primaryEntryId)) {
    return options.primaryEntryId;
  }

  return sortDocBrowserEntries(documents, { mode: options.sortMode })[0]?.id
    ?? (options.primaryEntryId && documents.some((entry) => entry.id === options.primaryEntryId)
      ? options.primaryEntryId
      : undefined);
}

export function resolveSharedWikilinkEntryId(
  entries: SharedWikilinkEntry[],
  target: SharedWikilinkTarget,
): string | undefined {
  const documents = entries.filter((entry) => !entry.isFolder);
  const directId = target.entryId?.trim();
  if (directId && documents.some((entry) => entry.id === directId)) return directId;

  const title = target.title?.trim();
  if (!title) return undefined;
  return documents.find((entry) => entry.title === title)?.id;
}
