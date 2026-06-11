/**
 * Wikilink 缓存：当前活跃知识库的 标题→条目摘要 映射。
 *
 * 用途：
 * - 鼠标悬停 `[[xxx]]` 时同步弹出预览卡（不能 await，否则会闪烁）
 * - 双链 a 渲染器从这里查目标 entryId（hash 锚里的 title → 真实 id）
 *
 * 生命周期：
 * - DocumentStorePage 加载/切换条目列表时调用 setWikilinkEntries 更新缓存
 * - 离开知识库或切到别的库不必清理；下次进新库会被覆盖
 *
 * MVP 假设：当前画面只有一个活跃库；跨库引用 v2 时需要按 storeId 分桶。
 */

export interface CachedEntry {
  entryId: string;
  title: string;
  summary?: string | null;
  updatedAt?: string;
}

const titleIndex = new Map<string, CachedEntry>();

export function setWikilinkEntries(entries: Array<{ id: string; title: string; summary?: string | null; updatedAt?: string }>): void {
  titleIndex.clear();
  for (const e of entries) {
    if (!e.title) continue;
    titleIndex.set(e.title, {
      entryId: e.id,
      title: e.title,
      summary: e.summary,
      updatedAt: e.updatedAt,
    });
  }
}

export function lookupWikilinkTitle(title: string): CachedEntry | null {
  return titleIndex.get(title) ?? null;
}

export function clearWikilinkCache(): void {
  titleIndex.clear();
}
