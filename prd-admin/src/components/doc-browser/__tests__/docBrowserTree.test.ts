import { describe, expect, it } from 'vitest';
import { buildDocBrowserTree } from '../docBrowserTree';
import type { DocBrowserEntry } from '../DocBrowser';
const entry = (id: string, extra: Partial<DocBrowserEntry> = {}) => ({ id, title: id, isFolder: false, ...extra } as DocBrowserEntry);
describe('目录关系与可达性', () => {
  it.each([200, 1000, 5000])('%i 条文档全部可达，包括历史订阅、失效父级、自指与环', count => {
    const entries = [entry('github', { sourceType: 'github_directory' }),
      entry('a', { isFolder: true, parentId: 'b' }), entry('b', { isFolder: true, parentId: 'a' }),
      entry('self', { isFolder: true, parentId: 'self' }),
      ...Array.from({ length: count }, (_, i) => entry(String(i), i % 2 ? { parentId: 'missing' } : { metadata: { github_parent_id: 'github' } }))];
    const tree = buildDocBrowserTree(entries);
    const seen = new Set<string>();
    const queue = [...tree.rootEntries];
    while (queue.length) {
      const e = queue.pop()!;
      expect(seen.has(e.id)).toBe(false);
      seen.add(e.id);
      queue.push(...tree.childrenMap.get(e.id) ?? []);
    }
    expect(seen.size).toBe(entries.length);
    expect(tree.childrenMap.get('github')).toHaveLength(Math.ceil(count / 2));
    expect(entries[0].isFolder).toBe(false);
    expect(buildDocBrowserTree([...entries].reverse()).rootEntries.map(e => e.id).sort()).toEqual(tree.rootEntries.map(e => e.id).sort());
  });
});
