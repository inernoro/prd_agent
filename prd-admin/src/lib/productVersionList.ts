import type { ApiResponse } from '@/types/api';

/** 复用既有按产品授权的列表接口；限制并发，并让过期请求停止继续派发。 */
export async function loadProductVersionList<T extends { id: string; productId: string; updatedAt: string }>(
  productIds: readonly string[],
  load: (productId: string) => Promise<ApiResponse<{ items: T[] }>>,
  options: { isCurrent: () => boolean; onProgress: (completed: number, total: number) => void },
): Promise<{ items: T[]; failedProductIds: string[] }> {
  const ids = [...new Set(productIds)];
  const items: T[] = [];
  const failedProductIds: string[] = [];
  let cursor = 0;
  let completed = 0;
  const worker = async () => {
    while (options.isCurrent() && cursor < ids.length) {
      const productId = ids[cursor++];
      try {
        const result = await load(productId);
        if (!options.isCurrent()) return;
        if (result.success) items.push(...result.data.items);
        else failedProductIds.push(productId);
      } catch {
        if (!options.isCurrent()) return;
        failedProductIds.push(productId);
      }
      options.onProgress(++completed, ids.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
  items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { items, failedProductIds };
}
