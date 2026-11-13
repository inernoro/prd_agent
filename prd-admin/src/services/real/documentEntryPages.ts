import { fail, ok, type ApiResponse } from '@/types/api';
import type { DocumentEntry } from '@/services/contracts/documentStore';

export type DocumentEntryPage = {
  items: DocumentEntry[];
  total: number;
  sharedEntryIds?: string[];
  nextCursor?: string | null;
  canWrite?: boolean;
};

/** 补齐期间的界面修改优先于已发出的旧页；null 记录删除，避免后续页把它复活。 */
export function recordDocumentEntryChanges(changes: Map<string, DocumentEntry | null>, before: DocumentEntry[], after: DocumentEntry[]) {
  const previous = new Map(before.map(entry => [entry.id, entry]));
  const current = new Map(after.map(entry => [entry.id, entry]));
  for (const entry of before) if (!current.has(entry.id)) changes.set(entry.id, null);
  for (const entry of after) if (previous.get(entry.id) !== entry) changes.set(entry.id, entry);
}

export function reconcileDocumentEntries(items: DocumentEntry[], changes: Map<string, DocumentEntry | null>) {
  const merged = new Map(items.map(entry => [entry.id, entry]));
  for (const [id, entry] of changes) {
    if (entry) merged.set(id, entry);
    else merged.delete(id);
  }
  return [...merged.values()];
}

/** 不以 total 推算尾页：删除可改变计数，终点以服务端游标为准。失败保留明确错误。 */
export async function collectDocumentEntryPages(
  fetchPage: (cursor?: string) => Promise<ApiResponse<DocumentEntryPage>>,
  onFirstPage?: (page: DocumentEntryPage) => void,
): Promise<ApiResponse<DocumentEntryPage>> {
  const items = new Map<string, DocumentEntry>();
  const shared = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let total = 0;
  let canWrite: boolean | undefined;
  do {
    const result = await fetchPage(cursor);
    if (!result.success) return result;
    const page = result.data;
    total = page.total;
    canWrite = page.canWrite;
    for (const entry of page.items) items.set(entry.id, entry);
    for (const id of page.sharedEntryIds ?? []) shared.add(id);
    if (!cursor) onFirstPage?.(page);
    const next = page.nextCursor || undefined;
    if (next && (cursors.has(next) || page.items.length === 0)) {
      return fail('INVALID_PAGINATION', '文档列表未加载完整，请重试');
    }
    if (next) cursors.add(next);
    cursor = next;
  } while (cursor);
  return ok({ items: [...items.values()], total, sharedEntryIds: [...shared], canWrite });
}
