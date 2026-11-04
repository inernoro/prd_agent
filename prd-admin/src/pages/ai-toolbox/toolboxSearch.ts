interface SearchableToolboxItem {
  name: string;
  description: string;
  tags: string[];
}

const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('zh-CN', { granularity: 'word' })
  : null;
const QUERY_CONNECTORS = new Set(['把', '将', '帮', '帮我', '我', '想', '要', '请', '做成', '转成', '转换成', '的', '成']);
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().trim();

/** 本地目录搜索：保留完整短语命中，同时允许多个关键词跨名称、用途与标签匹配。 */
export function searchToolboxItems<T extends SearchableToolboxItem>(items: T[], query: string): T[] {
  const normalized = normalize(query);
  if (!normalized) return items;

  const words = segmenter
    ? [...segmenter.segment(normalized)].filter((part) => part.isWordLike).map((part) => part.segment)
    : normalized.split(/\s+/);
  const keywords = [...new Set(words.filter((word) => !QUERY_CONNECTORS.has(word)))];
  const terms = keywords.length ? keywords : [normalized];

  return items
    .map((item) => {
      const name = normalize(item.name);
      const tags = item.tags.map(normalize).join(' ');
      const description = normalize(item.description);
      const text = `${name} ${tags} ${description}`;
      const exact = text.includes(normalized);
      if (!exact && !terms.every((term) => text.includes(term))) return { item, score: 0 };
      const score = (name.includes(normalized) ? 100 : 0)
        + (exact ? 20 : 0)
        + terms.reduce((total, term) => total + (name.includes(term) ? 4 : tags.includes(term) ? 2 : 1), 0);
      return { item, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);
}
