export type LibraryShareViewMode = 'read' | 'galaxy' | 'universe';

export interface SharedWikilinkEntry {
  id: string;
  title: string;
  isFolder?: boolean;
}

export interface SharedWikilinkTarget {
  entryId?: string;
  title?: string;
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
