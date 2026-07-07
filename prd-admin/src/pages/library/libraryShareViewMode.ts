export type LibraryShareViewMode = 'read' | 'galaxy' | 'universe';

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
