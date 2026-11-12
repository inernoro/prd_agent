import { describe, expect, it } from 'vitest';
import { buildDocBrowserTree } from '../docBrowserTree';

describe('完整目录可达性', () => {
  it.each([200, 1000, 5000])('%i 条记录含缺失父节点和环时，每条恰好可达一次', size => {
    const entries = Array.from({ length: size }, (_, i) => ({
      id: String(i), parentId: i < 10 ? undefined : String(i % 10),
    }));
    entries[0].parentId = 'missing';
    entries[1].parentId = '1';
    entries[2].parentId = '3';
    entries[3].parentId = '2';
    const { roots, childrenMap } = buildDocBrowserTree(entries);
    const visited: string[] = [];
    const pending = [...roots];
    while (pending.length) {
      const entry = pending.pop()!;
      visited.push(entry.id);
      pending.push(...(childrenMap.get(entry.id) ?? []));
      expect(visited.length).toBeLessThanOrEqual(size);
    }
    expect(visited).toHaveLength(size);
    expect(new Set(visited).size).toBe(size);
    expect(entries[2].parentId).toBe('3'); // 展示恢复不改存量关系
  });
  it('父条目在分页末尾也保持关系，不按入参顺序丢弃子条目', () => {
    const child = { id: 'child', parentId: 'subscription' };
    const parent = { id: 'subscription' };
    const tree = buildDocBrowserTree([child, parent]);
    expect(tree.roots).toEqual([parent]);
    expect(tree.childrenMap.get('subscription')).toEqual([child]);
  });
  it('兼容旧订阅目录，普通文档下的异常子条目提升到根级', () => {
    const tree = buildDocBrowserTree([
      { id: 'subscription', isFolder: false, sourceType: 'github_directory' },
      { id: 'synced', isFolder: false, parentId: 'subscription' },
      { id: 'document', isFolder: false },
      { id: 'misplaced', isFolder: false, parentId: 'document' },
    ]);
    expect(tree.childrenMap.get('subscription')?.map(e => e.id)).toEqual(['synced']);
    expect(tree.roots.map(e => e.id)).toEqual(['subscription', 'document', 'misplaced']);
  });
});
