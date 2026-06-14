const STORAGE_KEY = 'product-agent:favorite-product-ids';

export function readFavoriteProductIds(): Set<string> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0));
  } catch {
    return new Set();
  }
}

export function writeFavoriteProductIds(ids: Set<string>) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
}

export function toggleFavoriteProductId(productId: string): boolean {
  const next = readFavoriteProductIds();
  const added = !next.has(productId);
  if (added) next.add(productId);
  else next.delete(productId);
  writeFavoriteProductIds(next);
  return added;
}
