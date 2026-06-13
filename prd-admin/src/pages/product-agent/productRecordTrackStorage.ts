/** 产品管理智能体 — 详情页「追踪」记录（sessionStorage，与产品收藏同模式） */
export type ProductRecordKind = 'requirement' | 'feature' | 'defect' | 'release' | 'initiation';

export interface TrackedProductRecord {
  key: string;
  kind: ProductRecordKind;
  productId: string;
  recordId: string;
  title: string;
  recordNo: string;
  href: string;
  trackedAt: string;
}

const STORAGE_KEY = 'product-agent:tracked-records';
export const TRACKED_RECORDS_CHANGED_EVENT = 'product-agent:tracked-records-changed';

export function buildTrackedRecordKey(kind: ProductRecordKind, productId: string, recordId: string) {
  return `${kind}:${productId}:${recordId}`;
}

export function buildProductRecordPath(kind: ProductRecordKind, productId: string, recordId: string) {
  return `/product-agent/p/${productId}/${kind}/${recordId}`;
}

export function buildProductRecordHref(kind: ProductRecordKind, productId: string, recordId: string) {
  if (typeof window === 'undefined') return buildProductRecordPath(kind, productId, recordId);
  return `${window.location.origin}${buildProductRecordPath(kind, productId, recordId)}`;
}

export function readTrackedRecords(): TrackedProductRecord[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is TrackedProductRecord => {
      if (!item || typeof item !== 'object') return false;
      const row = item as TrackedProductRecord;
      return Boolean(row.kind && row.productId && row.recordId && row.key);
    });
  } catch {
    return [];
  }
}

function writeTrackedRecords(records: TrackedProductRecord[]) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(TRACKED_RECORDS_CHANGED_EVENT));
  }
}

export function isTrackedRecord(kind: ProductRecordKind, productId: string, recordId: string): boolean {
  const key = buildTrackedRecordKey(kind, productId, recordId);
  return readTrackedRecords().some((r) => r.key === key);
}

export function toggleTrackedRecord(input: {
  kind: ProductRecordKind;
  productId: string;
  recordId: string;
  title: string;
  recordNo: string;
}): boolean {
  const key = buildTrackedRecordKey(input.kind, input.productId, input.recordId);
  const list = readTrackedRecords();
  const index = list.findIndex((r) => r.key === key);
  if (index >= 0) {
    list.splice(index, 1);
    writeTrackedRecords(list);
    return false;
  }
  list.unshift({
    key,
    kind: input.kind,
    productId: input.productId,
    recordId: input.recordId,
    title: input.title.trim() || input.recordNo,
    recordNo: input.recordNo,
    href: buildProductRecordHref(input.kind, input.productId, input.recordId),
    trackedAt: new Date().toISOString(),
  });
  writeTrackedRecords(list.slice(0, 200));
  return true;
}

export function filterByTracked<T>(
  items: T[],
  trackedOnly: boolean,
  kind: ProductRecordKind,
  resolve: (item: T) => { productId: string; recordId: string },
): T[] {
  if (!trackedOnly) return items;
  return items.filter((item) => {
    const { productId, recordId } = resolve(item);
    return isTrackedRecord(kind, productId, recordId);
  });
}
