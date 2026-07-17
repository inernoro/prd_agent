export interface DocumentStoreDeepLink {
  storeId: string | null;
  entryId: string | null;
}

export function parseDocumentStoreDeepLink(search: string): DocumentStoreDeepLink {
  const params = new URLSearchParams(search);
  const storeId = params.get('store');
  return {
    storeId,
    entryId: storeId ? params.get('entry') : null,
  };
}

export function withDocumentStoreEntry(
  search: string,
  storeId: string,
  entryId: string | null | undefined,
): string {
  const params = new URLSearchParams(search);
  params.set('store', storeId);
  if (entryId) params.set('entry', entryId);
  else params.delete('entry');
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function withoutOrphanedDocumentStoreEntry(search: string): string {
  const params = new URLSearchParams(search);
  if (!params.has('store')) params.delete('entry');
  const query = params.toString();
  return query ? `?${query}` : '';
}
