const STORAGE_KEY = 'product-agent:recent-customer-ids';
const MAX_RECENT = 12;

export function readRecentCustomerIds(): string[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

export function touchRecentCustomerIds(ids: string[]) {
  if (ids.length === 0) return;
  const prev = readRecentCustomerIds();
  const next = [...ids, ...prev.filter((id) => !ids.includes(id))].slice(0, MAX_RECENT);
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}
