import { fail, ok, type ApiResponse } from '@/types/api';
import type { DocumentEntry } from '@/services/contracts/documentStore';

export type DocumentEntryPage = {
  items: DocumentEntry[];
  total: number;
  sharedEntryIds?: string[];
  nextCursor?: string | null;
};

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
  do {
    const result = await fetchPage(cursor);
    if (!result.success) return result;
    const page = result.data;
    total = page.total;
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
  return ok({ items: [...items.values()], total, sharedEntryIds: [...shared] });
}
